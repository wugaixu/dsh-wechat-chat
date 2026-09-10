import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 语音条音频默认保留 7 天，过期自动清理（含文件与索引记录）。 */
export const VOICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const VOICE_ID_RE = /^[a-f0-9]{16,32}$/
const MAX_RECORDS = 2000

export class VoiceStore {
  constructor(baseDir, options = {}) {
    this.dir = baseDir
    this.indexFile = join(baseDir, 'index.json')
    this.retentionMs = Number.isFinite(options.retentionMs) ? options.retentionMs : VOICE_RETENTION_MS
    mkdirSync(this.dir, { recursive: true })
    this.index = this.loadIndex()
    this.prune()
  }

  loadIndex() {
    try {
      // 容错：外部工具可能写出带 BOM 的 UTF-8。
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8').replace(/^\uFEFF/, ''))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch { return {} }
  }

  saveIndex() {
    try {
      const temp = `${this.indexFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(this.index), { mode: 0o600 })
      renameSync(temp, this.indexFile)
    } catch { /* best effort */ }
  }

  /** 校验 id，避免任何路径穿越；非法 id 一律拒绝。 */
  static isVoiceId(id) {
    return typeof id === 'string' && VOICE_ID_RE.test(id)
  }

  filePath(id) {
    if (!VoiceStore.isVoiceId(id)) return undefined
    return join(this.dir, `${id}.wav`)
  }

  newId() {
    return randomBytes(8).toString('hex')
  }

  /** 写入一段语音：落盘音频 + 建立 pending 记录。 */
  add({ sessionKey, wav }) {
    const id = this.newId()
    writeFileSync(this.filePath(id), wav, { mode: 0o600 })
    this.index[id] = {
      sessionKey: String(sessionKey),
      ts: Date.now(),
      status: 'pending',
    }
    this.prune()
    this.saveIndex()
    return id
  }

  update(id, patch) {
    const record = this.index[id]
    if (record === undefined) return undefined
    Object.assign(record, patch)
    this.saveIndex()
    return record
  }

  /** 该会话的全部语音条（按时间升序）；音频是否仍存在一并返回。 */
  list(sessionKey) {
    const key = String(sessionKey)
    return Object.entries(this.index)
      .filter(([, record]) => record && record.sessionKey === key)
      .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))
      .map(([id, record]) => ({
        id,
        ts: record.ts || 0,
        durationMs: record.durationMs || 0,
        status: record.status || 'pending',
        ...(typeof record.transcript === 'string' ? { transcript: record.transcript } : {}),
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
        available: existsSync(this.filePath(id)),
      }))
  }

  /** 删除超过保留期的音频与记录。 */
  prune(now = Date.now()) {
    let changed = false
    const entries = Object.entries(this.index)
    for (const [id, record] of entries) {
      if (!record || now - (record.ts || 0) > this.retentionMs) {
        const file = this.filePath(id)
        if (file !== undefined) { try { unlinkSync(file) } catch { /* already gone */ } }
        delete this.index[id]
        changed = true
      }
    }
    // 硬上限：极端情况下按时间淘汰最旧（避免索引无限增长）
    const rest = Object.entries(this.index)
    if (rest.length > MAX_RECORDS) {
      rest.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))
      for (const [id] of rest.slice(0, rest.length - MAX_RECORDS)) {
        const file = this.filePath(id)
        if (file !== undefined) { try { unlinkSync(file) } catch { /* ignore */ } }
        delete this.index[id]
        changed = true
      }
    }
    if (changed) this.saveIndex()
    return changed
  }
}
