/**
 * dsh-wechat-chat (鲸聊) — host half, fully self-contained.
 *
 * Connection scheme ported from @linxin666/dsh-remote-web-ui (the "remote
 * access" plugin) so 鲸聊 can run standalone after that plugin is disabled:
 *
 *   - PairingService: one active one-time token, device sessions keyed by a
 *     device id in an HttpOnly cookie (whale_pair), persisted to
 *     $DSH_HOME/whale-devices.json, idle-evicted (30d), max cap (4).
 *   - Desktop panel at /whale-panel (loopback-only): mints a QR that encodes
 *     <base>/wechat?pair=<token> — the base is the configured public URL or
 *     the first LAN interface literal.
 *   - /api/whale/pair/* family: issue (loopback), accept (loopback/LAN/public
 *     host fence, sets the cookie), stop/revoke (loopback), heartbeat/status.
 *   - The chat surface /wechat and /api/wechat/* gate non-loopback requests
 *     on a live device cookie (touch on every call). /wechat?pair=<token>
 *     completes the pairing and 303s to the clean chat page.
 *
 * The phone never speaks the harness chat protocol: the plugin drives a REAL
 * session on the PC (visible in the official sidebar) via ctx.sessionController
 * — create → prompt → follow → broadcast the final assistant text over SSE.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { inspectPcmWav, LocalSttManager } from './stt.js'
import { VoiceStore } from './voice.js'

export const name = 'wechat-chat'
export const inject = ['sessionController', 'webServer']

const DEFAULT_NICKNAME = '鲸聊助手'
const DEFAULT_TITLE = '鲸聊 · 手机'
// 手机端专用 agent preset：禁用交互式提问工具（ask_user_question），纯文本对话。
// 定义见 $DSH_HOME/.agent-presets/wechat-chat/agent.cordis.yml
const AGENT_PRESET = 'wechat-chat'
const COOKIE_NAME = 'whale_pair'
const TUNNEL_AUTH_COOKIE = 'whale_tunnel_auth'
const DEVICE_HEADER = 'x-whale-device'
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000
const DEFAULT_IDLE_EXPIRE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_OFFLINE_AFTER_MS = 25 * 1000
const DEFAULT_MAX_DEVICES = 4
const COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60
const MAX_BODY = 64 * 1024
// 已配对令牌的重放窗口：覆盖浏览器/WebView 对同一链接的重复导航。
const REPLAY_WINDOW_MS = 15 * 60 * 1000

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const DEVICES_FILE = join(home, 'whale-devices.json')
const SESSION_MAP_FILE = join(home, 'wechat-chat-devices.json')
const AVATAR_DIR = join(home, 'wechat-chat', 'avatars')
const CREDENTIALS_FILE = join(home, '.credentials.yaml')

const PAGE = readFileSync(fileURLToPath(new URL('./chat-page.html', import.meta.url)), 'utf8')
const PANEL = readFileSync(fileURLToPath(new URL('./panel-page.html', import.meta.url)), 'utf8')
const QRCODE_LIB = readFileSync(fileURLToPath(new URL('./qrcode.js', import.meta.url)), 'utf8')

/* ── ported: loopback / lan / fences ──────────────────────────────────── */

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

/**
 * 该地址手机能否直连：排除自动私有地址（169.254/16，未拿到 DHCP）与
 * Clash/Mihomo 等代理 TUN 使用的 198.18.0.0/15 伪地址——这些在手机上不可达。
 */
function isUsableLanAddress(address) {
  if (address.startsWith('169.254.')) return false
  const [a, b] = address.split('.').map(Number)
  if (a === 198 && (b === 18 || b === 19)) return false
  return true
}

function isProxyTunnelInterface(name) {
  return /^(mihomo|clash|sing-?box|tun|wintun|tap)/i.test(String(name || '').trim())
}

function lanIPv4Addresses() {
  return Object.values(networkInterfaces()).flat()
    .filter(iface => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .filter(iface => !isProxyTunnelInterface(iface.name) && isUsableLanAddress(iface.address))
    .map(iface => iface.address)
}

/**
 * Browser-trust fence ported from remote-web-ui routes.ts: the Host must be
 * ours (loopback or a trusted literal/public host) and browser markers same-origin.
 */
function isTrustedApiRequest(request, trustedHosts) {
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL(`http://${host}`) } catch { return false }
  const hostname = hostUrl.hostname
  const trusted = isLoopbackRequest(request) || trustedHosts.some(entry => {
    const entryUrl = new URL(`http://${entry}`)
    return entryUrl.port === '' ? entryUrl.hostname === hostname : entryUrl.host === hostUrl.host
  })
  if (!trusted) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function publicHostOf(url) {
  if (typeof url !== 'string' || url === '') return undefined
  try { return new URL(url).host } catch { return undefined }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function readCookie(header, name) {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function writeJson(res, status, value, extraHeaders) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  })
  res.end(JSON.stringify(value))
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (raw.trim() === '') return resolve({})
        resolve(JSON.parse(raw))
      } catch { resolve(null) }
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { req.removeAllListeners('data'); resolve(null); return }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('error', () => resolve(null))
  })
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, tooLarge: true })
        req.removeAllListeners('data')
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }))
    req.on('error', () => finish({ ok: false, error: true }))
    req.setTimeout?.(30_000, () => finish({ ok: false, timeout: true }))
  })
}

function extractText(msg) {
  if (!msg || !Array.isArray(msg.content)) return ''
  const parts = []
  for (const b of msg.content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

const ASSISTANT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#07c160"/><path d="M28 44c0-11 9-20 20-20s20 9 20 20v2c8 1 14 8 14 16 0 9-7 16-16 16-3 0-5.5-.8-7.8-2.2-3.3 1.4-6.8 2.2-10.2 2.2-13.3 0-24-10.7-24-24 0-5.9 2.2-11.2 5.7-15.3 3-4.3 4.3-6.4 4.3-9.5V42z" fill="#ffffff"/><circle cx="40" cy="42" r="3" fill="#07c160"/><circle cx="54" cy="42" r="3" fill="#07c160"/></svg>`
const USER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#e2e2e2"/><circle cx="48" cy="36" r="16" fill="#b8b8b8"/><path d="M18 84c4-18 16-26 30-26s26 8 30 26z" fill="#b8b8b8"/></svg>`

/* ── pairing state machine (ported from remote-web-ui pairing.ts) ─────── */

export class PairingService {
  constructor(config) {
    this.config = config
    this.tokens = new Map()
    this.devices = new Map()
    // 已成功消费的令牌 → 设备，短时间内允许重放同一结果（幂等）。
    // 浏览器/WebView 可能对同一配对链接发起两次导航（重复提交/重试），
    // 若第二次直接判 invalid，已经把用户带进聊天的结果会被引导页覆盖。
    this.recentlyAccepted = new Map()
    this.stopped = false
    this.tokenSerial = 0
    this.dirty = false
    this.loadPersisted()
  }

  loadPersisted() {
    try {
      const saved = JSON.parse(readFileSync(DEVICES_FILE, 'utf8'))
      if (typeof saved !== 'object' || saved === null) return
      for (const [deviceId, session] of Object.entries(saved)) {
        if (typeof deviceId !== 'string' || typeof session !== 'object' || session === null) continue
        const { createdAt, lastSeenAt, userAgent } = session
        if (typeof createdAt !== 'number' || typeof lastSeenAt !== 'number') continue
        this.devices.set(deviceId, {
          createdAt,
          lastSeenAt,
          ...(typeof userAgent === 'string' ? { userAgent: sanitizeUserAgent(userAgent) } : {}),
        })
      }
      this.clampToMax()
      if (this.evictIdle()) this.persist()
    } catch { /* start empty */ }
  }

  clampToMax() {
    if (this.devices.size <= this.config.maxDevices) return
    const ordered = [...this.devices.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)
    for (const [id] of ordered.slice(0, this.devices.size - this.config.maxDevices)) this.devices.delete(id)
  }

  evictIdle() {
    const now = Date.now()
    let removed = false
    for (const [id, session] of [...this.devices]) {
      if (now - session.lastSeenAt > this.config.idleExpireMs) {
        this.devices.delete(id)
        removed = true
      }
    }
    return removed
  }

  persist() {
    try {
      mkdirSync(dirname(DEVICES_FILE), { recursive: true })
      const temp = `${DEVICES_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      const payload = {}
      for (const [id, session] of this.devices) payload[id] = session
      writeFileSync(temp, JSON.stringify(payload), { mode: 0o600 })
      try { renameSync(temp, DEVICES_FILE) } catch { writeFileSync(DEVICES_FILE, JSON.stringify(payload)) }
      this.dirty = false
    } catch (err) {
      console.error('wechat-chat: failed to persist paired devices', err)
    }
  }

  issue() {
    const now = Date.now()
    // 允许多枚令牌并存（局域网/公网二维码各一枚）；先清掉已过期的。
    for (const [t, r] of this.tokens) {
      if (now > r.expiresAt) this.tokens.delete(t)
    }
    // 软上限：超过 16 枚时淘汰最旧
    while (this.tokens.size >= 16) {
      let oldest = null
      for (const [t, r] of this.tokens) {
        if (oldest === null || r.issuedAt < oldest.issuedAt) oldest = { t, issuedAt: r.issuedAt }
      }
      if (oldest === null) break
      this.tokens.delete(oldest.t)
    }
    const token = randomBytes(16).toString('hex')
    this.stopped = false
    this.tokenSerial += 1
    this.tokens.set(token, { id: `t${this.tokenSerial}`, issuedAt: now, expiresAt: now + this.config.tokenTtlMs })
    return { token, expiresAt: now + this.config.tokenTtlMs }
  }

  accept(token, userAgent) {
    const record = this.tokens.get(token)
    if (record === undefined || this.stopped || Date.now() > record.expiresAt) {
      // 令牌已被消费但仍在重放窗口内：返回同一个设备，保证配对导航幂等。
      const replay = this.recentlyAccepted.get(token)
      if (replay !== undefined && !this.stopped && Date.now() <= replay.replayUntil
          && this.devices.has(replay.deviceId)) {
        return { ok: true, deviceId: replay.deviceId, replayed: true }
      }
      return { ok: false, code: 'invalid' }
    }
    // 成功配对前先原子消费令牌，防止同一二维码在有效期内被重放。
    this.tokens.delete(token)
    const deviceId = randomBytes(16).toString('hex')
    const now = Date.now()
    if (this.devices.size >= this.config.maxDevices) {
      let oldest
      for (const [id, session] of this.devices) {
        if (oldest === undefined || session.createdAt < oldest.createdAt) oldest = { id, createdAt: session.createdAt }
      }
      if (oldest !== undefined) this.devices.delete(oldest.id)
    }
    const label = sanitizeUserAgent(userAgent)
    this.devices.set(deviceId, {
      createdAt: now,
      lastSeenAt: now,
      ...(label !== undefined ? { userAgent: label } : {}),
    })
    this.rememberAccepted(token, deviceId, now)
    this.persist()
    return { ok: true, deviceId }
  }

  /** 记录刚消费的令牌，供重复导航在短时间内取回同一设备（不新建凭据）。 */
  rememberAccepted(token, deviceId, now) {
    this.recentlyAccepted.set(token, { deviceId, replayUntil: now + REPLAY_WINDOW_MS })
    for (const [t, r] of this.recentlyAccepted) {
      if (now > r.replayUntil) this.recentlyAccepted.delete(t)
    }
    while (this.recentlyAccepted.size > 32) {
      const oldest = this.recentlyAccepted.keys().next().value
      this.recentlyAccepted.delete(oldest)
    }
  }

  stop() {
    this.tokens.clear()
    this.devices.clear()
    this.recentlyAccepted.clear()
    this.persist()
    this.stopped = true
  }

  revoke(deviceId) {
    if (this.stopped) return false
    if (!this.devices.delete(deviceId)) return false
    this.persist()
    return true
  }

  touchDevice(deviceId) {
    const session = this.liveSession(deviceId)
    if (session === undefined) return false
    session.lastSeenAt = Date.now()
    this.dirty = true
    return true
  }

  heartbeat(deviceId) {
    return this.touchDevice(deviceId)
  }

  sweep() {
    if (this.evictIdle() || this.dirty) this.persist()
  }

  hasDevice(deviceId) {
    return this.liveSession(deviceId) !== undefined
  }

  liveSession(deviceId) {
    if (this.stopped) return undefined
    const session = this.devices.get(deviceId)
    if (session === undefined) return undefined
    if (Date.now() - session.lastSeenAt > this.config.idleExpireMs) {
      this.devices.delete(deviceId)
      this.persist()
      return undefined
    }
    return session
  }

  deviceCount() {
    return this.devices.size
  }
}

function sanitizeUserAgent(raw) {
  if (raw === undefined) return undefined
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  if (cleaned === '') return undefined
  return cleaned.length <= 180 ? cleaned : cleaned.slice(0, 180)
}

/* ── password-protected public gateway ────────────────────────────────── */

function constantTimeTextEqual(left, right) {
  const a = createHash('sha256').update(String(left), 'utf8').digest()
  const b = createHash('sha256').update(String(right), 'utf8').digest()
  return timingSafeEqual(a, b)
}

export function hashTunnelPassword(password) {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

function verifyTunnelPassword(password, encoded) {
  const parts = typeof encoded === 'string' ? encoded.split('$') : []
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    const actual = scryptSync(password, salt, expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch { return false }
}

function safeNextPath(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/wechat'
  return value
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

function readFormBody(req, maxBytes = 8192) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { finish(null); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { finish(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) } catch { finish(null) }
    })
    req.on('error', () => finish(null))
  })
}

function loginPage(next, error = '') {
  const message = error === '' ? '' : `<div class="error">${escapeHtml(error)}</div>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>鲸聊安全登录</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#ededed;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#191919}.card{width:min(90vw,380px);padding:32px 24px;background:#fff;border-radius:14px;box-shadow:0 8px 32px #0002}.logo{width:58px;height:58px;margin:0 auto 14px;display:grid;place-items:center;border-radius:16px;background:#07c160;color:#fff;font-size:31px}h1{margin:0;text-align:center;font-size:22px}.sub{margin:8px 0 24px;text-align:center;color:#777;font-size:14px}.error{margin:0 0 12px;padding:9px 11px;border-radius:7px;background:#fff0f0;color:#c62828;font-size:14px}input{width:100%;height:46px;padding:0 13px;border:1px solid #ccc;border-radius:8px;font-size:16px;outline:none}input:focus{border-color:#07c160}button{width:100%;height:46px;margin-top:14px;border:0;border-radius:8px;background:#07c160;color:#fff;font-size:16px;font-weight:600}</style></head><body><main class="card"><div class="logo">鲸</div><h1>鲸聊安全登录</h1><p class="sub">请输入电脑端设置的公网访问密码</p>${message}<form method="post" action="/__whale/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><input name="password" type="password" autocomplete="current-password" maxlength="256" autofocus required placeholder="访问密码"><button type="submit">登录</button></form></main></body></html>`
}

export class TunnelAuthGateway {
  constructor(upstreamPort, passwordHash) {
    this.upstreamPort = upstreamPort
    this.passwordHash = passwordHash
    this.secret = randomBytes(32)
    this.authValue = createHmac('sha256', this.secret).update('whale-tunnel-auth-v1').digest('base64url')
    this.server = undefined
    this.failures = new Map()
    this.recent = [] // 最近经过公网网关的请求，用于本机排查「手机扫码没反应」
  }

  /** 记录一次公网请求的结果（只看路径/动作，不记录密码或 Cookie 值）。 */
  record(method, pathname, action, req) {
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 90) : ''
    this.recent.push({
      at: new Date().toISOString(),
      method,
      path: String(pathname).slice(0, 200),
      action,
      host: typeof req.headers.host === 'string' ? req.headers.host.slice(0, 120) : '',
      ua,
    })
    if (this.recent.length > 40) this.recent.splice(0, this.recent.length - 40)
  }

  isAuthorized(req) {
    if (this.passwordHash === '') return true
    const value = readCookie(req.headers.cookie, TUNNEL_AUTH_COOKIE)
    return typeof value === 'string' && constantTimeTextEqual(value, this.authValue)
  }

  setPasswordHash(passwordHash) {
    this.passwordHash = passwordHash
    this.secret = randomBytes(32)
    this.authValue = createHmac('sha256', this.secret).update('whale-tunnel-auth-v1').digest('base64url')
    this.failures.clear()
  }

  clientKey(req) {
    const cf = req.headers['cf-connecting-ip']
    return typeof cf === 'string' && cf !== '' ? cf.slice(0, 80) : (req.socket.remoteAddress || 'unknown')
  }

  allowAttempt(req) {
    const key = this.clientKey(req)
    const now = Date.now()
    const record = this.failures.get(key)
    if (!record) return true
    if (now < record.lockedUntil) return false
    if (now - record.since > 60_000) {
      this.failures.delete(key)
      return true
    }
    return record.count < 8
  }

  recordFailure(req) {
    const key = this.clientKey(req)
    const now = Date.now()
    const old = this.failures.get(key)
    const record = !old || now - old.since > 60_000 ? { since: now, count: 0, lockedUntil: 0 } : old
    record.count += 1
    if (record.count >= 8) record.lockedUntil = now + 60_000
    this.failures.set(key, record)
    if (this.failures.size > 1024) {
      const oldest = [...this.failures.entries()].sort((a, b) => a[1].since - b[1].since).slice(0, 256)
      for (const [oldKey] of oldest) this.failures.delete(oldKey)
    }
  }

  clearFailures(req) {
    this.failures.delete(this.clientKey(req))
  }

  isAllowedPath(pathname) {
    return pathname === '/wechat'
      || pathname.startsWith('/api/wechat/')
      || pathname === '/api/whale/pair/accept'
      || pathname === '/api/whale/pair/heartbeat'
      || pathname === '/api/whale/pair/status'
  }

  async handle(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://gateway.invalid')
    if (requestUrl.pathname === '/__whale/login') {
      const action = (req.method || 'GET') === 'GET' ? 'login-page' : 'login-submit'
      this.record(req.method || 'GET', requestUrl.pathname, action, req)
      await this.handleLogin(req, res, requestUrl)
      return
    }
    if (!this.isAllowedPath(requestUrl.pathname)) {
      this.record(req.method || 'GET', requestUrl.pathname, 'blocked-path', req)
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('not found')
      return
    }
    if (!this.isAuthorized(req)) {
      if ((req.method || 'GET') === 'GET' && requestUrl.pathname === '/wechat') {
        // 直接内联返回登录页（200），不再 303 跳到 /__whale/login：
        // 实测在受限网络下手机能发出第一个请求，但随后的跳转请求会被重置，
        // 于是浏览器停在错误页、用户永远看不到密码框。少一次往返即可避开。
        const next = safeNextPath(req.url || '/wechat')
        this.record(req.method || 'GET', requestUrl.pathname, 'password-inline', req)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
        res.end(loginPage(next))
      } else {
        this.record(req.method || 'GET', requestUrl.pathname, 'password-required-401', req)
        writeJson(res, 401, { ok: false, code: 'tunnel-password-required' })
      }
      return
    }
    this.record(req.method || 'GET', requestUrl.pathname, 'proxied', req)
    this.proxy(req, res)
  }

  async handleLogin(req, res, requestUrl) {
    if (this.passwordHash === '') {
      res.writeHead(303, { location: safeNextPath(requestUrl.searchParams.get('next') || '/wechat'), 'cache-control': 'no-store' })
      res.end()
      return
    }
    if ((req.method || 'GET') === 'GET') {
      const next = safeNextPath(requestUrl.searchParams.get('next') || '/wechat')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
      res.end(loginPage(next))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    const form = await readFormBody(req)
    const next = safeNextPath(form && form.get('next'))
    if (!this.allowAttempt(req)) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60' })
      res.end(loginPage(next, '尝试次数过多，请一分钟后再试'))
      return
    }
    const supplied = form && form.get('password')
    if (typeof supplied !== 'string' || !verifyTunnelPassword(supplied, this.passwordHash)) {
      this.recordFailure(req)
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(loginPage(next, '密码错误'))
      return
    }
    this.clearFailures(req)
    res.writeHead(303, {
      location: next,
      'cache-control': 'no-store',
      'set-cookie': `${TUNNEL_AUTH_COOKIE}=${this.authValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`,
    })
    res.end()
  }

  proxy(req, res) {
    const headers = { ...req.headers }
    delete headers.connection
    delete headers['proxy-connection']
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: this.upstreamPort,
      method: req.method,
      path: req.url,
      headers,
    }, (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers }
      delete responseHeaders.connection
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('upstream unavailable')
    })
    req.pipe(upstream)
  }

  start() {
    if (this.server !== undefined) return Promise.reject(new Error('gateway already started'))
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('gateway error')
        })
      })
      this.server = server
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('无法取得安全网关端口')); return }
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
  }

  stop() {
    if (this.server !== undefined) {
      try { this.server.close() } catch { /* best effort */ }
      this.server = undefined
    }
    this.failures.clear()
  }
}

/* ── auto-tunnel (ported from remote-web-ui tunnel.ts; free Cloudflare quick tunnel) ── */

let cloudflaredMod = null
async function loadCloudflared() {
  if (cloudflaredMod !== null) return cloudflaredMod
  const mod = await import('cloudflared')
  cloudflaredMod = (mod && mod.default) ?? mod
  return cloudflaredMod
}

// cloudflared 二进制放到 node_modules 之外运行，避免 pnpm 重装插件时锁文件
const CLOUDFLARED_BIN = join(home, 'wechat-chat', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')

// 连接器就绪轮询间隔：查 cloudflared 本地 /ready，判断是否已注册到 Cloudflare 边缘。
const TUNNEL_READY_INTERVAL_MS = 1_500
// 连接器持续未能就绪多久后重建隧道（重建会换地址，尽量少换）。
const TUNNEL_REBUILD_AFTER_MS = 60_000

/** 找一个空闲的回环端口，交给 cloudflared 作为本地 metrics/ready 端口。 */
function freeLoopbackPort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(0))
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = address && typeof address === 'object' ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function ensureCloudflaredBin(cf) {
  if (!existsSync(CLOUDFLARED_BIN)) {
    mkdirSync(dirname(CLOUDFLARED_BIN), { recursive: true })
    const src = typeof cf.bin === 'string' ? cf.bin : ''
    if (src !== '' && existsSync(src)) {
      copyFileSync(src, CLOUDFLARED_BIN)
    } else {
      await cf.install(CLOUDFLARED_BIN)
    }
  }
  // 让 cloudflared 包使用数据目录里的二进制
  if (typeof cf.use === 'function') cf.use(CLOUDFLARED_BIN)
  return CLOUDFLARED_BIN
}

export class TunnelManager {
  constructor(target) {
    this.target = target
    this.phase = 'stopped'
    this.url = undefined
    this.error = undefined
    // 连接器就绪状态（本地 /ready），用于快速判定能否出码
    this.connected = false
    this.readyFailures = 0
    this.readyTimer = undefined
    this.readySince = undefined
    this.metricsPort = undefined
    this.handle = undefined
    this.timers = []
    this.generation = 0
    this.stopping = false
    this.listeners = new Set()
  }

  onPhase(fn) {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  info() {
    return {
      phase: this.phase,
      ...(this.url !== undefined ? { url: this.url } : {}),
      ...(this.url !== undefined ? { connected: this.connected } : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    }
  }

  /**
   * 连接器是否已注册到 Cloudflare 边缘 —— 查 cloudflared 本地 /ready。
   * 这是"手机能不能连上"的权威且极快的信号（毫秒级、不受本机代理影响）。
   */
  async connectorReadyConnections() {
    // 没拿到本地 metrics 端口时无法判定，按"可用"处理，避免误挡出码
    if (this.metricsPort === undefined || this.metricsPort <= 0) return 1
    try {
      const res = await fetch(`http://127.0.0.1:${this.metricsPort}/ready`, {
        signal: AbortSignal.timeout(2_000),
        headers: { 'user-agent': 'dsh-wechat-chat-health' },
      })
      if (!res.ok) return 0
      const body = await res.json()
      const count = Number(body && body.readyConnections)
      return Number.isFinite(count) && count > 0 ? count : 0
    } catch {
      return 0
    }
  }

  scheduleReady(delayMs) {
    clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => { void this.runReadyCheck() }, delayMs)
  }

  async runReadyCheck() {
    if (this.stopping || this.phase !== 'running') return
    const count = await this.connectorReadyConnections()
    if (this.stopping || this.phase !== 'running') return
    if (count > 0) {
      this.readyFailures = 0
      this.readySince = undefined
      if (!this.connected) { this.connected = true; this.emit() }
      this.scheduleReady(10_000)
      return
    }
    this.readyFailures += 1
    if (this.connected) { this.connected = false; this.emit() }
    if (this.readySince === undefined) this.readySince = Date.now()
    // 连接器长时间注册不上边缘才重建（本地判定，不依赖公网探测）
    if (Date.now() - this.readySince >= TUNNEL_REBUILD_AFTER_MS) {
      this.fail('隧道连接器无法注册到 Cloudflare，正在重建')
      return
    }
    this.scheduleReady(TUNNEL_READY_INTERVAL_MS)
  }

  emit() {
    const info = this.info()
    for (const fn of this.listeners) {
      try { fn(info) } catch { /* keep emitting */ }
    }
  }

  start() {
    if (this.phase === 'starting' || this.phase === 'running') return
    this.teardown()
    this.stopping = false
    this.generation += 1
    void this.attempt()
  }

  stop() {
    this.teardown()
    this.url = undefined
    this.error = undefined
    this.connected = false
    this.readyFailures = 0
    this.readySince = undefined
    this.setPhase('stopped')
  }

  dispose() {
    this.stop()
  }

  async attempt() {
    if (this.stopping) return
    const gen = this.generation
    this.setPhase('starting')
    try {
      const cf = await loadCloudflared()
      await ensureCloudflaredBin(cf)
      if (this.stopping || gen !== this.generation) return
      // 固定一个本地 metrics 端口，便于用 /ready 毫秒级判断连接器是否就绪
      this.metricsPort = await freeLoopbackPort()
      const options = { '--no-autoupdate': true, '--protocol': 'http2' }
      if (this.metricsPort > 0) options['--metrics'] = `127.0.0.1:${this.metricsPort}`
      const handle = cf.Tunnel.quick(this.target, options)
      this.handle = handle
      const urlTimer = setTimeout(() => { this.fail('等待隧道地址超时') }, 30_000)
      this.timers.push(urlTimer)
      handle.on('url', (value) => {
        if (this.handle !== handle) return
        clearTimeout(urlTimer)
        this.url = value
        this.error = undefined
        this.connected = false
        this.readyFailures = 0
        this.readySince = undefined
        this.setPhase('running')
        this.scheduleReady(500)
      })
      handle.on('exit', () => {
        if (this.handle !== handle) return
        if (this.stopping) return
        this.fail('隧道进程意外退出')
      })
      handle.on('error', (value) => {
        if (this.handle !== handle || this.phase !== 'starting') return
        this.error = value instanceof Error ? value.message : String(value)
      })
    } catch (err) {
      if (this.stopping || gen !== this.generation) return
      this.fail(`无法获取 cloudflared 二进制：${(err && err.message) || String(err)}`)
    }
  }

  fail(message) {
    if (this.stopping) return
    this.url = undefined
    this.error = message
    this.connected = false
    this.readyFailures = 0
    this.readySince = undefined
    clearTimeout(this.readyTimer)
    if (this.handle !== undefined) {
      try { this.handle.stop() } catch { /* best effort */ }
      this.handle = undefined
    }
    this.setPhase('failed')
    const retry = setTimeout(() => {
      if (!this.stopping && this.phase === 'failed') void this.attempt()
    }, 10_000)
    this.timers.push(retry)
  }

  teardown() {
    this.stopping = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    clearTimeout(this.readyTimer)
    this.readyTimer = undefined
    if (this.handle !== undefined) {
      try { this.handle.stop() } catch { /* best effort */ }
      this.handle = undefined
    }
  }

  setPhase(phase) {
    this.phase = phase
    this.emit()
  }
}

/* ── session-map persistence ──────────────────────────────────────────── */

function loadSessionMap() {
  try {
    // 容错：外部工具可能写出带 BOM 的 UTF-8，JSON.parse 会直接抛错，
    // 于是整个映射被当成空 → 重新新建会话。先剥掉 BOM 再解析。
    return JSON.parse(readFileSync(SESSION_MAP_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch { return {} }
}

/**
 * 从会话映射里挑出可复用的会话（本插件预设、且最近创建的那条）。
 * 用于重装 App / 换设备导致 client 变化时，仍然接着用同一个对话。
 */
export function pickReusableSession(map) {
  let newest
  for (const record of Object.values(map || {})) {
    if (!record || record.agentPreset !== AGENT_PRESET || typeof record.sessionId !== 'string') continue
    if (newest === undefined || (record.createdAt || 0) > (newest.createdAt || 0)) newest = record
  }
  return newest
}

function persistSessionMap(map) {
  try {
    mkdirSync(dirname(SESSION_MAP_FILE), { recursive: true })
    writeFileSync(SESSION_MAP_FILE, JSON.stringify(map))
  } catch (err) {
    console.error('wechat-chat: failed to persist session map', err)
  }
}

/* ── 手机端隐藏消息（删除仅影响本机视图，电脑端会话不动） ────────────── */

const HIDDEN_FILE = join(home, 'wechat-chat-hidden.json')

function loadHidden() {
  try { return JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')) } catch { return {} }
}

function persistHidden(hidden) {
  try {
    mkdirSync(dirname(HIDDEN_FILE), { recursive: true })
    writeFileSync(HIDDEN_FILE, JSON.stringify(hidden))
  } catch (err) {
    console.error('wechat-chat: failed to persist hidden ids', err)
  }
}

function hiddenIdsOf(key) {
  const hidden = loadHidden()
  const arr = hidden[key]
  return Array.isArray(arr) ? arr : []
}

/* ── 聊天对象昵称（可修改，持久化） ─────────── */

const NICKNAME_FILE = join(home, 'wechat-chat-settings.json')

function loadChatSettings() {
  try {
    const value = JSON.parse(readFileSync(NICKNAME_FILE, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function persistChatSettings(patch) {
  try {
    mkdirSync(dirname(NICKNAME_FILE), { recursive: true })
    const value = { ...loadChatSettings(), ...patch }
    writeFileSync(NICKNAME_FILE, JSON.stringify(value), { mode: 0o600 })
    return true
  } catch (err) {
    console.error('wechat-chat: failed to persist settings', err)
    return false
  }
}

function loadNickname() {
  const value = loadChatSettings().nickname
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 30) : undefined
}

function persistNickname(name) {
  persistChatSettings({ nickname: name })
}

function loadTunnelPasswordState() {
  const settings = loadChatSettings()
  const present = Object.prototype.hasOwnProperty.call(settings, 'tunnelPasswordHash')
  const value = settings.tunnelPasswordHash
  const passwordHash = typeof value === 'string' && (value === '' || value.startsWith('scrypt$')) ? value : ''
  return { present, passwordHash }
}

function persistTunnelPasswordHash(passwordHash) {
  return persistChatSettings({ tunnelPasswordHash: passwordHash, tunnelPassword: undefined })
}

/* ── DeepSeek 余额 ──────────────────────────────────────────────────────── */

/** 从 $DSH_HOME/.credentials.yaml 读取 DEEPSEEK_API_KEY（简单正则，避免引入 yaml 依赖）。 */
function readDeepSeekKey() {
  try {
    const txt = readFileSync(CREDENTIALS_FILE, 'utf8')
    const m = /DEEPSEEK_API_KEY:\s*([^\s]+)/.exec(txt)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

let balanceCache = { at: 0, value: null }
/** 拉取 DeepSeek 开放平台余额，60 秒缓存。 */
async function fetchDeepSeekBalance() {
  const now = Date.now()
  if (balanceCache.value !== null && now - balanceCache.at < 60 * 1000) return balanceCache.value
  const key = readDeepSeekKey()
  if (!key) return null
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    })
    if (!resp.ok) return null
    const data = await resp.json()
    const infos = data && data.balance_infos
    if (Array.isArray(infos) && infos.length > 0) {
      const value = { currency: infos[0].currency || 'CNY', balance: String(infos[0].total_balance ?? '0') }
      balanceCache = { at: now, value }
      return value
    }
    return null
  } catch { return null }
}

/* ── plugin ───────────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const defaultNickname = config.nickname || DEFAULT_NICKNAME
  const sessionTitle = config.title || DEFAULT_TITLE
  // 默认复用已有对话：重装 App 或换设备后 client 变化时，不再新建会话。
  const reuseSession = config.reuseSession !== false
  const provider = config.provider || 'deepseek-official'
  const model = config.model || 'deepseek-v4-flash'
  const reasoningEffort = config.reasoningEffort || 'low'
  const service = new PairingService({
    tokenTtlMs: config.tokenTtlMs || DEFAULT_TOKEN_TTL_MS,
    idleExpireMs: config.idleExpireMs || DEFAULT_IDLE_EXPIRE_MS,
    offlineAfterMs: config.offlineAfterMs || DEFAULT_OFFLINE_AFTER_MS,
    maxDevices: config.maxDevices || DEFAULT_MAX_DEVICES,
  })
  const publicBaseUrl = typeof config.publicBaseUrl === 'string' && config.publicBaseUrl !== ''
    ? config.publicBaseUrl
    : undefined
  const autoTunnel = config.autoTunnel === true
  const configuredTunnelPassword = typeof config.tunnelPassword === 'string' ? config.tunnelPassword : ''
  const storedPassword = loadTunnelPasswordState()
  let tunnelPasswordHash = storedPassword.passwordHash
  // 兼容旧配置：仅在从未写入交互式设置时迁移一次。显式关闭（空哈希）不会在重启后被旧配置重新开启。
  if (!storedPassword.present && configuredTunnelPassword !== '') {
    tunnelPasswordHash = hashTunnelPassword(configuredTunnelPassword)
    persistTunnelPasswordHash(tunnelPasswordHash)
    console.warn('wechat-chat: 已把旧 tunnelPassword 迁移为 scrypt 哈希；请从 cordis.patch.yml 删除明文字段')
  }
  const webPort = Number.isFinite(ctx.webServer.port) ? ctx.webServer.port : 3080

  // Free Cloudflare quick tunnel. When a password is configured, cloudflared
  // targets a loopback-only gateway that authenticates first and exposes only
  // the Whale Chat routes — never the rest of the DSH Web application.
  let tunnelBase = undefined
  const tunnel = new TunnelManager(`http://127.0.0.1:${webPort}`)
  // 即使暂未设置密码，也始终通过路径白名单网关，避免暴露整个 DSH Web。
  const authGateway = new TunnelAuthGateway(webPort, tunnelPasswordHash)
  const stt = new LocalSttManager(join(home, 'wechat-chat', 'stt'), config.stt || {})
  // 语音条音频：保留 7 天后自动清理（含索引记录）。
  const voice = new VoiceStore(join(home, 'wechat-chat', 'voice'))
  const voiceLanguage = config.stt && ['auto', 'zh', 'en'].includes(config.stt.language) ? config.stt.language : 'zh'
  tunnel.onPhase((info) => {
    tunnelBase = info.phase === 'running' && typeof info.url === 'string' && info.url !== '' ? info.url : undefined
  })

  const running = new Map() // deviceKey -> { ac, sessionId }
  const streams = new Map() // deviceId -> Set<{res, closed, keep}>
  const eventQueues = new Map() // deviceKey -> { seq, events: [{seq, payload}] }
  let voiceUploadActive = false // 上传串行化：同时只缓冲一段录音，限制内存占用

  const lanHosts = () => lanIPv4Addresses()
  const trustedHosts = () => {
    const hosts = lanHosts()
    const publicHost = publicHostOf(publicBaseUrl)
    if (publicHost !== undefined) hosts.push(publicHost)
    const tunnelHost = publicHostOf(tunnelBase)
    if (tunnelHost !== undefined) hosts.push(tunnelHost)
    return hosts
  }
  const loopbackFence = (req) => isLoopbackRequest(req)
  const lanFence = (req) => isTrustedApiRequest(req, trustedHosts())

  const deviceIdOf = (req) => {
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME)
    if (cookie) return cookie
    const header = req.headers[DEVICE_HEADER]
    if (typeof header === 'string' && header !== '') return header
    return undefined
  }

  /** Non-loopback /api/wechat gate: a live device cookie is the access control. */
  const gateOk = (req, queryDevice) => {
    if (isLoopbackRequest(req)) return true
    const credential = deviceIdOf(req)
    if (credential !== undefined && queryDevice !== undefined && credential !== queryDevice) return false
    const id = credential || queryDevice
    if (id === undefined) return false
    return service.touchDevice(id)
  }

  function broadcast(device, payload) {
    // 事件缓冲：轮询（poll）拉取用，隧道下可靠
    let q = eventQueues.get(device)
    if (!q) { q = { seq: 0, events: [] }; eventQueues.set(device, q) }
    q.seq += 1
    q.events.push({ seq: q.seq, payload })
    if (q.events.length > 500) q.events.splice(0, q.events.length - 500)
    // SSE 直连（回环/调试用）
    const set = streams.get(device)
    if (!set || set.size === 0) return
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const s of [...set]) {
      if (s.closed) continue
      try { s.res.write(frame) } catch { s.closed = true }
    }
  }

  async function ensureSession(key) {
    const map = loadSessionMap()
    const existing = map[key]
    // 复用同一会话（预设一致时）：跨扫码/换公网地址保留历史。
    if (existing && existing.sessionId && existing.agentPreset === AGENT_PRESET) {
      return { sessionId: existing.sessionId, map }
    }
    // 未命中时复用本插件最近创建的会话，避免重装 App / 换设备后不断新建对话。
    if (reuseSession) {
      const newest = pickReusableSession(map)
      if (newest !== undefined) {
        map[key] = { sessionId: newest.sessionId, agentPreset: AGENT_PRESET, createdAt: Date.now() }
        persistSessionMap(map)
        console.log(`wechat-chat: reusing existing session ${newest.sessionId} for key ${String(key).slice(0, 8)}`)
        return { sessionId: newest.sessionId, map }
      }
    }
    // 旧会话用的是标准预设（含交互式提问工具），重建为新预设；旧会话仍留在电脑侧边栏。
    const value = await ctx.sessionController.create({ agentPreset: AGENT_PRESET })
    const sessionId = value && value.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('无法在电脑上创建会话')
    try { await ctx.sessionController.rename({ sessionId, title: sessionTitle }) } catch { /* optional */ }
    try {
      await ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort })
      console.log(`wechat-chat: session model set ${provider}/${model} effort=${reasoningEffort}`)
    } catch (err) {
      console.error('wechat-chat: selectModel failed:', (err && err.message) || err)
    }
    map[key] = { sessionId, agentPreset: AGENT_PRESET, createdAt: Date.now() }
    persistSessionMap(map)
    return { sessionId, map }
  }

  async function getHistory(sessionId) {
    const ac = new AbortController()
    const out = []
    try {
      const it = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, ac.signal)
      for await (const frame of it) {
        ac.abort()
        if (frame.type !== 'snapshot' || !Array.isArray(frame.records)) return out
        for (const rec of frame.records) {
          const ev = rec && rec.event
          if (!ev) continue
          if (ev.type === 'user/message') {
            const text = extractText(ev.data)
            if (text) out.push({ id: 's' + ev.seq, role: 'user', text })
          } else if (ev.type === 'assistant/message') {
            const text = extractText(ev.data && ev.data.message)
            if (text) out.push({ id: 's' + ev.seq, role: 'assistant', text })
          }
        }
        return out.slice(-100)
      }
    } catch { /* aborted */ }
    return out
  }

  async function runTurn(device, sessionId, text) {
    const ac = new AbortController()
    running.set(device, { ac, sessionId })
    let sentAssistant = false
    let done = false
    const watchdog = setTimeout(() => { ac.abort() }, 15 * 60 * 1000)
    broadcast(device, { type: 'busy', value: true })
    broadcast(device, { type: 'status', text: '正在思考' })
    try {
      await ctx.sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      }, ac.signal)
      const it = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, ac.signal)
      for await (const frame of it) {
        if (frame.type !== 'event') continue
        const ev = frame.event
        if (!ev || typeof ev.type !== 'string') continue
        switch (ev.type) {
          case 'turn/start':
            broadcast(device, { type: 'status', text: '正在思考' })
            break
          case 'user/message': {
            const text = extractText(ev.data)
            if (text) broadcast(device, { type: 'user', text, id: 's' + ev.seq })
            break
          }
          case 'tool/call': {
            const toolName = ev.data && ev.data.name
            broadcast(device, { type: 'status', text: toolName ? `正在使用工具：${toolName}` : '正在使用工具' })
            break
          }
          case 'assistant/message': {
            const out = extractText(ev.data && ev.data.message)
            if (out) { sentAssistant = true; broadcast(device, { type: 'assistant', text: out, id: 's' + ev.seq }) }
            break
          }
          case 'turn/end': {
            const reason = ev.data && ev.data.reason
            const kind = reason && reason.kind
            if (kind === 'error') broadcast(device, { type: 'error', message: (reason && reason.message) || '处理出错了' })
            else if (kind === 'blocked') broadcast(device, { type: 'error', message: '回复被安全策略阻止' })
            else if (kind === 'max-tokens') broadcast(device, { type: 'error', message: '回复达到长度上限' })
            else if (kind === 'completed' && !sentAssistant) broadcast(device, { type: 'assistant', text: '（无文本回复）' })
            done = true
            break
          }
        }
        if (done) break
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        broadcast(device, { type: 'error', message: (err && err.message) || '处理失败' })
      }
    } finally {
      clearTimeout(watchdog)
      running.delete(device)
      broadcast(device, { type: 'busy', value: false })
    }
  }

  /* ── 语音条：后台串行识别，完成后自动作为用户消息送入真实会话 ─────── */

  let voiceQueue = Promise.resolve()

  function enqueueVoice(job) {
    voiceQueue = voiceQueue.then(() => processVoice(job)).catch(() => { /* 单条失败不阻塞后续 */ })
    return voiceQueue
  }

  async function processVoice({ id, wav, sessionKey }) {
    try {
      const result = await stt.transcribe(wav, voiceLanguage)
      const text = result.text.trim()
      if (text === '') throw Object.assign(new Error('没有识别到语音内容'), { code: 'no-speech' })
      voice.update(id, { status: 'transcribed', transcript: text, durationMs: result.durationMs })
      if (running.has(sessionKey)) {
        voice.update(id, { status: 'failed', error: '上一轮回复还在进行，本条未发送' })
        return
      }
      const { sessionId } = await ensureSession(sessionKey)
      // 电脑会话里显示转写文字并标注来源（用户要求可看出这是语音）。
      voice.update(id, { status: 'sent' })
      void runTurn(sessionKey, sessionId, `【语音】${text}`)
    } catch (error) {
      voice.update(id, { status: 'failed', error: (error && error.message) || '语音识别失败' })
    }
  }

  /* ── routes ─────────────────────────────────────────────────────────── */

  const cookieHeader = (deviceId) => ({
    'set-cookie': [
      `${COOKIE_NAME}=${deviceId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}`,
    ],
  })

  /** The QR link base: active tunnel URL first, then the configured public
   *  base, then the first LAN literal. */
  const pairBase = () => {
    if (autoTunnel && tunnelBase !== undefined) return tunnelBase
    if (publicBaseUrl !== undefined) return publicBaseUrl
    const lan = lanIPv4Addresses()
    const port = Number.isFinite(ctx.webServer.port) ? ctx.webServer.port : undefined
    if (lan.length === 0 || port === undefined) return undefined
    return `http://${lan[0]}:${String(port)}`
  }

  const handlePage = async (req, res) => {
    const url = new URL(req.url || '/', 'http://wechat.invalid')
    const pairToken = url.searchParams.get('pair')
    const client = url.searchParams.get('client') || ''
    const render = (deviceId, pairErr) => PAGE
      .replace('__WECHAT_DEVICE_VALUE__', () => JSON.stringify(deviceId))
      .replace('__WECHAT_PAIR_ERR_VALUE__', () => JSON.stringify(pairErr))
      .replace('__WECHAT_CLIENT_VALUE__', () => JSON.stringify(client))
    // 导航式配对：/wechat?pair=<token> 校验后下发设备 Cookie，再重定向到不含令牌的干净地址。
    if (typeof pairToken === 'string' && pairToken !== '') {
      const ra = (req.socket && req.socket.remoteAddress) || '?'
      console.log(`wechat-chat: pair accept from ${ra} host=${req.headers.host || '?'} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`)
      if (!lanFence(req)) {
        console.log(`wechat-chat: pair accept REFUSED (fence) from ${ra} host=${req.headers.host || '?'}`)
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const ua = req.headers['user-agent']
      const result = service.accept(pairToken, typeof ua === 'string' ? ua : undefined)
      if (!result.ok) {
        console.log(`wechat-chat: pair accept FAILED code=${result.code}`)
        // 令牌失效/过期：下发引导页并带提示，刷新二维码重扫即可
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(render('', result.code))
        return
      }
      console.log(`wechat-chat: pair accept OK device=${result.deviceId.slice(0, 8)}…`)
      const cleanLocation = client !== '' ? `/wechat?client=${encodeURIComponent(client)}` : '/wechat'
      res.writeHead(303, {
        location: cleanLocation,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...cookieHeader(result.deviceId),
      })
      res.end()
      return
    }
    const device = url.searchParams.get('device') || deviceIdOf(req) || ''
    console.log(`wechat-chat: /wechat served to ${(req.socket && req.socket.remoteAddress) || '?'} host=${req.headers.host || '?'} device=${device ? device.slice(0, 8) : 'none'} client=${client ? client.slice(0, 8) : 'none'}`)
    // App（WebView）自带扫码引导页：未配对时直接 403，让它回落到本地引导页，
    // 避免再弹出一个多余的服务端「连接电脑上的鲸聊」页面。
    if (device === '' && /;\s*wv\)/.test(String(req.headers['user-agent'] || ''))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('unpaired')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(render(device, ''))
  }

  /** Desktop pairing panel: QR + link + stop. Loopback-only. */
  const handlePanel = async (req, res) => {
    if (!loopbackFence(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden: panel is local-only')
      return
    }
    const passwordEnabled = tunnelPasswordHash !== ''
    const html = PANEL
      .replace('__QRCODE_LIB__', () => QRCODE_LIB)
      .replace('__TUNNEL_PASSWORD_SUB__', passwordEnabled ? '，并启用密码保护' : '')
      .replace('__TUNNEL_PASSWORD_HINT__', passwordEnabled ? '首次扫码先输入公网登录密码，再完成配对。' : '一次扫码即完成配对。')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  const handleWhaleApi = async (req, res) => {
    const url = new URL(req.url || '/', 'http://wechat.invalid')
    const pathname = url.pathname

    if (pathname === '/api/whale/pair/security') {
      if (!loopbackFence(req)) { writeJson(res, 403, { ok: false, code: 'forbidden' }); return }
      if (req.method === 'GET') {
        writeJson(res, 200, { ok: true, passwordEnabled: tunnelPasswordHash !== '', minimumLength: 8 })
        return
      }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, code: 'method-not-allowed' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const password = body && typeof body.password === 'string' ? body.password : null
      if (password === null || password.length > 256 || (password !== '' && password.length < 8)) {
        writeJson(res, 400, { ok: false, code: 'bad-password', error: '密码至少 8 位；留空仅用于明确关闭密码保护' })
        return
      }
      const passwordHash = password === '' ? '' : hashTunnelPassword(password)
      if (!persistTunnelPasswordHash(passwordHash)) {
        writeJson(res, 500, { ok: false, code: 'persist-failed', error: '无法保存密码设置' })
        return
      }
      tunnelPasswordHash = passwordHash
      authGateway.setPasswordHash(passwordHash)
      writeJson(res, 200, { ok: true, passwordEnabled: password !== '', sessionsInvalidated: true })
      return
    }

    if (pathname === '/api/whale/stt/status') {
      if (!loopbackFence(req) || req.method !== 'GET') { writeJson(res, req.method === 'GET' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      writeJson(res, 200, { ok: true, stt: stt.info() })
      return
    }

    if (pathname === '/api/whale/stt/install') {
      if (!loopbackFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      const started = stt.startInstall()
      writeJson(res, started ? 202 : 409, { ok: started, stt: stt.info(), ...(started ? {} : { error: stt.ready() ? '离线模型已经安装' : '安装已在进行中' }) })
      return
    }

    if (pathname === '/api/whale/stt/cancel') {
      if (!loopbackFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      writeJson(res, 200, { ok: true, cancelled: stt.cancelInstall(), stt: stt.info() })
      return
    }

    if (pathname === '/api/whale/pair/issue') {
      if (!loopbackFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      // 只走公网：隧道优先，其次手动 publicBaseUrl
      const base = (autoTunnel && tunnelBase !== undefined) ? tunnelBase : (publicBaseUrl || undefined)
      if (base === undefined) {
        writeJson(res, 409, { ok: false, code: 'tunnel-required', error: '公网隧道未就绪或未配置公网地址' })
        return
      }
      // 连接器未注册到 Cloudflare 边缘时才拒绝（本地判定，毫秒级）；
      // 公网探测慢且受本机代理影响，仅作为面板上的参考信息，不阻塞出码。
      if (base === tunnelBase && !tunnel.connected) {
        writeJson(res, 409, { ok: false, code: 'tunnel-not-connected', error: '公网隧道还在连接 Cloudflare，请稍候几秒', tunnel: tunnel.info() })
        return
      }
      const { token, expiresAt } = service.issue()
      writeJson(res, 200, {
        ok: true,
        mode: 'public',
        token,
        expiresAt,
        url: `${base}/wechat?pair=${token}`,
        ...(publicBaseUrl !== undefined ? { publicBaseUrl } : {}),
        tunnel: tunnel.info(),
      })
      return
    }

    if (pathname === '/api/whale/pair/accept') {
      if (!lanFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const token = body && typeof body.token === 'string' ? body.token : ''
      if (token === '') { writeJson(res, 400, { ok: false, code: 'bad-payload' }); return }
      const ua = req.headers['user-agent']
      const result = service.accept(token, typeof ua === 'string' ? ua : undefined)
      if (!result.ok) {
        writeJson(res, 404, { ok: false, code: result.code })
        return
      }
      writeJson(res, 200, { ok: true, deviceId: result.deviceId }, cookieHeader(result.deviceId))
      return
    }

    if (pathname === '/api/whale/pair/stop') {
      if (!loopbackFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      service.stop()
      writeJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/whale/pair/revoke') {
      if (!loopbackFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const deviceId = body && typeof body.deviceId === 'string' ? body.deviceId : ''
      if (deviceId === '') { writeJson(res, 400, { ok: false, code: 'bad-payload' }); return }
      writeJson(res, 200, { ok: true, revoked: service.revoke(deviceId) })
      return
    }

    if (pathname === '/api/whale/pair/heartbeat') {
      if (!lanFence(req) || req.method !== 'POST') { writeJson(res, req.method === 'POST' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      const deviceId = readCookie(req.headers.cookie, COOKIE_NAME)
      if (deviceId === undefined || !service.heartbeat(deviceId)) {
        writeJson(res, 401, { ok: false, code: 'unpaired' })
        return
      }
      writeJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/whale/pair/tunnel') {
      if (!loopbackFence(req) || req.method !== 'GET') { writeJson(res, req.method === 'GET' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      writeJson(res, 200, { ok: true, autoTunnel, tunnel: tunnel.info(), deviceCount: service.deviceCount() })
      return
    }

    // 排查用：最近经过公网网关的请求（仅本机可读，不含密码与 Cookie 值）。
    if (pathname === '/api/whale/tunnel/log') {
      if (!loopbackFence(req) || req.method !== 'GET') { writeJson(res, req.method === 'GET' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      writeJson(res, 200, { ok: true, requests: authGateway.recent })
      return
    }

    if (pathname === '/api/whale/pair/status') {
      if (!lanFence(req) || req.method !== 'GET') { writeJson(res, req.method === 'GET' ? 403 : 405, { ok: false, code: 'forbidden' }); return }
      const deviceId = readCookie(req.headers.cookie, COOKIE_NAME)
      const paired = deviceId !== undefined && service.hasDevice(deviceId)
      writeJson(res, 200, {
        ok: true,
        paired,
        lanAvailable: lanIPv4Addresses().length > 0,
        lanAddresses: lanIPv4Addresses(),
        ...(paired ? { deviceCount: service.deviceCount() } : {}),
      })
      return
    }

    writeJson(res, 404, { ok: false, code: 'not-found' })
  }

  const handleWechatApi = async (req, res) => {
    const url = new URL(req.url || '/', 'http://wechat.invalid')
    const pathname = url.pathname
    const queryDevice = url.searchParams.get('device') || undefined
    const client = url.searchParams.get('client') || undefined
    const credentialDevice = deviceIdOf(req) || undefined
    const device = credentialDevice || queryDevice
    // 会话键优先用 App 内持久化的 client：设备 id 每次重新配对都会变，
    // 只有 client 能跨扫码/换公网地址稳定指向同一个对话。
    const key = client || device || undefined

    if (pathname === '/api/wechat/avatar/other' || pathname === '/api/wechat/avatar/me') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const who = pathname.endsWith('/other') ? 'other' : 'me'
      for (const ext of ['png', 'svg', 'jpg', 'jpeg', 'webp']) {
        const file = join(AVATAR_DIR, `${who}.${ext}`)
        if (existsSync(file)) {
          const types = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
          res.writeHead(200, { 'content-type': types[ext], 'cache-control': 'no-cache' })
          res.end(readFileSync(file))
          return
        }
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' })
      res.end(who === 'other' ? ASSISTANT_SVG : USER_SVG)
      return
    }

    if (pathname === '/api/wechat/avatar/upload') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const body = await readJsonBody(req, 16 * 1024 * 1024)
      const side = body && (body.side === 'me' || body.side === 'other') ? body.side : null
      const data = body && typeof body.data === 'string' ? body.data : ''
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data)
      if (!side || m === null) { writeJson(res, 400, { ok: false, error: '无效的图片数据' }); return }
      try {
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length > 8 * 1024 * 1024) { writeJson(res, 400, { ok: false, error: '图片过大' }); return }
        mkdirSync(AVATAR_DIR, { recursive: true })
        // 删除同侧旧头像，避免旧文件优先级更高
        for (const old of ['png', 'svg', 'jpg', 'jpeg', 'webp']) {
          const f = join(AVATAR_DIR, `${side}.${old}`)
          try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
        }
        writeFileSync(join(AVATAR_DIR, `${side}.${ext}`), buf)
        writeJson(res, 200, { ok: true, side })
      } catch (err) {
        writeJson(res, 500, { ok: false, error: (err && err.message) || '保存失败' })
      }
      return
    }

    if (pathname === '/api/wechat/background') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const f = join(AVATAR_DIR, `background.${ext}`)
        if (existsSync(f)) {
          const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
          res.writeHead(200, { 'content-type': types[ext], 'cache-control': 'no-cache' })
          res.end(readFileSync(f))
          return
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no background')
      return
    }

    if (pathname === '/api/wechat/background/upload') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const body = await readJsonBody(req, 16 * 1024 * 1024)
      const data = body && typeof body.data === 'string' ? body.data : ''
      const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data)
      if (m === null) { writeJson(res, 400, { ok: false, error: '无效的图片数据' }); return }
      try {
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
        const buf = Buffer.from(m[2], 'base64')
        if (buf.length > 16 * 1024 * 1024) { writeJson(res, 400, { ok: false, error: '图片过大' }); return }
        mkdirSync(AVATAR_DIR, { recursive: true })
        for (const old of ['png', 'jpg', 'jpeg', 'webp']) {
          const f = join(AVATAR_DIR, `background.${old}`)
          try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
        }
        writeFileSync(join(AVATAR_DIR, `background.${ext}`), buf)
        writeJson(res, 200, { ok: true })
      } catch (err) {
        writeJson(res, 500, { ok: false, error: (err && err.message) || '保存失败' })
      }
      return
    }

    if (pathname === '/api/wechat/background/delete') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        const f = join(AVATAR_DIR, `background.${ext}`)
        try { if (existsSync(f)) unlinkSync(f) } catch { /* ignore */ }
      }
      writeJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/wechat/balance') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const b = await fetchDeepSeekBalance()
      if (b) writeJson(res, 200, { ok: true, balance: b.balance, currency: b.currency })
      else writeJson(res, 200, { ok: false })
      return
    }

    if (pathname === '/api/wechat/voice/send') {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, code: 'method-not-allowed' }); return }
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!device || !key) { writeJson(res, 400, { ok: false, code: 'missing-device', error: '缺少设备凭据' }); return }
      const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (type !== 'audio/wav' && type !== 'audio/x-wav') { writeJson(res, 415, { ok: false, code: 'unsupported-format', error: '仅支持 PCM WAV 录音' }); return }
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > 2_100_000) { writeJson(res, 413, { ok: false, code: 'too-large', error: '录音不能超过 60 秒' }); return }
      if (voiceUploadActive) { writeJson(res, 429, { ok: false, code: 'upload-busy', error: '正在处理上一段录音，请稍后重试' }); return }
      voiceUploadActive = true
      let job
      try {
        const body = await readRawBody(req, 2_100_000)
        if (!body.ok) {
          const status = body.tooLarge ? 413 : body.timeout ? 408 : 400
          writeJson(res, status, { ok: false, code: body.tooLarge ? 'too-large' : body.timeout ? 'upload-timeout' : 'bad-upload', error: '录音上传失败' })
          return
        }
        let wav
        try {
          wav = inspectPcmWav(body.buffer)
        } catch (err) {
          writeJson(res, 400, { ok: false, code: 'bad-audio', error: (err && err.message) || '录音格式无效' })
          return
        }
        const id = voice.add({ sessionKey: key, wav: body.buffer })
        voice.update(id, { durationMs: wav.durationMs })
        job = { id, wav: body.buffer, deviceId: device, sessionKey: key }
        // 先让手机立刻拿到语音条 id 用于渲染，再后台串行识别并自动送入电脑会话。
        writeJson(res, 200, { ok: true, id, durationMs: wav.durationMs, status: 'pending' })
      } finally {
        voiceUploadActive = false
      }
      if (job !== undefined) enqueueVoice(job)
      return
    }

    if (pathname.startsWith('/api/wechat/voice/') && req.method === 'GET') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const id = pathname.slice('/api/wechat/voice/'.length)
      const file = voice.filePath(id)
      if (file === undefined || !existsSync(file)) { writeJson(res, 404, { ok: false, code: 'not-found' }); return }
      try {
        const data = readFileSync(file)
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(data.length),
          'cache-control': 'private, max-age=86400',
        })
        res.end(data)
      } catch {
        writeJson(res, 500, { ok: false, code: 'read-failed' })
      }
      return
    }

    // 语音条状态：手机轮询它来更新「识别中 / 已发送 / 失败」与转写文字。
    if (pathname === '/api/wechat/voices') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!key) { writeJson(res, 400, { ok: false, code: 'missing-device' }); return }
      writeJson(res, 200, { ok: true, voice: voice.list(key) })
      return
    }

    if (pathname === '/api/wechat/state') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!device) { writeJson(res, 200, { ok: true, paired: false }); return }
      let hasBg = false
      for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
        if (existsSync(join(AVATAR_DIR, `background.${ext}`))) { hasBg = true; break }
      }
      const out = {
        ok: true, paired: true, nickname: (loadNickname() || defaultNickname), busy: running.has(key),
        avatarOther: '/api/wechat/avatar/other', avatarMe: '/api/wechat/avatar/me',
        ...(hasBg ? { background: '/api/wechat/background' } : {}),
        stt: stt.info(),
        hiddenIds: hiddenIdsOf(key),
      }
      try {
        const { sessionId } = await ensureSession(key)
        out.history = await getHistory(sessionId)
      } catch (err) {
        out.error = (err && err.message) || '会话不可用'
      }
      writeJson(res, 200, out)
      return
    }

    if (pathname === '/api/wechat/send') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!device) { writeJson(res, 400, { ok: false, error: '缺少设备凭据' }); return }
      if (running.has(key)) { writeJson(res, 409, { ok: false, error: '上一轮回复还在进行，请稍候' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const text = (body && typeof body.text === 'string' ? body.text : '').slice(0, 40000).trim()
      if (text === '') { writeJson(res, 400, { ok: false, error: '消息不能为空' }); return }
      let sessionId
      try {
        ;({ sessionId } = await ensureSession(key))
      } catch (err) {
        writeJson(res, 500, { ok: false, error: (err && err.message) || '无法创建会话' })
        return
      }
      writeJson(res, 200, { ok: true })
      void runTurn(key, sessionId, text)
      return
    }

    if (pathname === '/api/wechat/hide') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!key) { writeJson(res, 400, { ok: false, error: '缺少设备凭据' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const ids = body && Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && x !== '') : []
      if (ids.length === 0) { writeJson(res, 400, { ok: false, error: '没有要删除的消息' }); return }
      const hidden = loadHidden()
      const set = new Set(Array.isArray(hidden[key]) ? hidden[key] : [])
      for (const id of ids) set.add(id)
      hidden[key] = [...set].slice(-2000)
      persistHidden(hidden)
      writeJson(res, 200, { ok: true, hiddenIds: hidden[key] })
      return
    }

    if (pathname === '/api/wechat/nickname') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!key) { writeJson(res, 400, { ok: false, error: '缺少设备凭据' }); return }
      const body = await readJsonBody(req, MAX_BODY)
      const name = body && typeof body.nickname === 'string' ? body.nickname.trim().slice(0, 30) : ''
      if (name === '') { writeJson(res, 400, { ok: false, error: '昵称不能为空' }); return }
      persistNickname(name)
      writeJson(res, 200, { ok: true, nickname: name })
      return
    }

    if (pathname === '/api/wechat/cancel') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      const turn = running.get(key)
      if (!turn) { writeJson(res, 200, { ok: true }); return }
      try { turn.ac.abort() } catch { /* done */ }
      try { await ctx.sessionController.cancel({ sessionId: turn.sessionId }) } catch { /* best effort */ }
      writeJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/wechat/poll') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!key) { writeJson(res, 400, { ok: false, error: '缺少设备凭据' }); return }
      const since = Number(url.searchParams.get('since')) || 0
      const q = eventQueues.get(key)
      const events = q ? q.events.filter(e => e.seq > since).map(e => e.payload) : []
      writeJson(res, 200, { ok: true, seq: q ? q.seq : 0, busy: running.has(key), events })
      return
    }

    if (pathname === '/api/wechat/events') {
      if (!gateOk(req, queryDevice)) { writeJson(res, 403, { ok: false, code: 'unpaired' }); return }
      if (!key) { writeJson(res, 400, { ok: false, error: '缺少设备凭据' }); return }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const stream = { res, closed: false, keep: null }
      const close = () => {
        if (stream.closed) return
        stream.closed = true
        if (stream.keep !== null) clearInterval(stream.keep)
        const set = streams.get(key)
        if (set) { set.delete(stream); if (set.size === 0) streams.delete(key) }
      }
      stream.keep = setInterval(() => {
        if (stream.closed) { clearInterval(stream.keep); return }
        try { stream.res.write(': ping\n\n') } catch { close() }
      }, 25000)
      res.on('close', close)
      req.on('close', close)
      if (!streams.has(key)) streams.set(key, new Set())
      streams.get(key).add(stream)
      try {
        stream.res.write(`data: ${JSON.stringify({ type: 'busy', value: running.has(key) })}\n\n`)
        if (running.has(key)) stream.res.write(`data: ${JSON.stringify({ type: 'status', text: '正在思考' })}\n\n`)
      } catch { close() }
      return
    }

    writeJson(res, 404, { ok: false, code: 'not-found' })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: '/wechat', handler: handlePage }),
      ctx.webServer.register({ kind: 'exact', path: '/whale-panel', handler: handlePanel }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/whale', handler: handleWhaleApi }),
      ctx.webServer.register({ kind: 'prefix', path: '/api/wechat', handler: handleWechatApi }),
    ]
    const timer = setInterval(() => { service.sweep() }, 10_000)
    timer.unref()
    let active = true
    if (autoTunnel) {
      void authGateway.start().then((gatewayTarget) => {
        if (!active) { authGateway.stop(); return }
        tunnel.target = gatewayTarget
        tunnel.start()
        console.log(`wechat-chat: 正在启动${tunnelPasswordHash !== '' ? '带密码保护的' : '受限路径的'}免费公网隧道（Cloudflare quick tunnel）…`)
      }).catch((err) => {
        console.error(`wechat-chat: 无法启动公网安全网关：${(err && err.message) || String(err)}`)
      })
    }
    return () => {
      active = false
      for (const dispose of disposers) dispose()
      clearInterval(timer)
      tunnel.dispose()
      authGateway.stop()
      stt.dispose()
    }
  }, 'wechat-chat: routes')

  if (lanIPv4Addresses().length > 0 && Number.isFinite(ctx.webServer.port)) {
    console.log(`wechat-chat: 鲸聊配对面板 http://127.0.0.1:${String(ctx.webServer.port)}/whale-panel`)
  }
}
