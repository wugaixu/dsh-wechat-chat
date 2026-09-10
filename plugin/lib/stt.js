import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { once } from 'node:events'
import { unzipSync } from 'fflate'

export const STT_MANIFEST = Object.freeze({
  runtimeTag: 'b4938',
  runtimeUrl: 'https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-bin-x64.zip',
  runtimeSha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
  runtimeMaxBytes: 16 * 1024 * 1024,
  runtimeExeName: 'whisper-cli.exe',
  runtimeExeSha256: '800a0fd754afa75e109c7248286ad735670fb6b23d92ca5d12604647ef638a65',
  modelRevision: '5359861c739e955e79d9a303bcbc70fb988958b1',
  modelUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin',
  modelSha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  modelBytes: 487_601_967,
})

const MAX_WAV_BYTES = 2_100_000
const MAX_SECONDS = 60

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(path)
    input.on('data', chunk => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolveHash(hash.digest('hex')))
  })
}

export async function downloadPinned(url, destination, expectedHash, maxBytes, expectedBytes, onProgress, signal) {
  const response = await fetch(url, { redirect: 'follow', signal, headers: { 'user-agent': 'dsh-wechat-chat/1.3' } })
  if (!response.ok || response.body === null) throw new Error(`下载失败：HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length')) || 0
  if (declared > maxBytes) throw new Error('下载文件超过安全大小限制')
  const temp = `${destination}.${process.pid}.${randomUUID()}.partial`
  mkdirSync(dirname(destination), { recursive: true })
  const output = createWriteStream(temp, { flags: 'wx', mode: 0o600 })
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  let received = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) throw new Error('下载文件超过安全大小限制')
      hash.update(value)
      if (!output.write(Buffer.from(value))) await once(output, 'drain')
      onProgress?.(received, declared || expectedBytes || 0)
    }
    output.end()
    await once(output, 'finish')
    if (expectedBytes && received !== expectedBytes) throw new Error(`下载大小不符：${received}`)
    const actualHash = hash.digest('hex')
    if (actualHash !== expectedHash) throw new Error(`下载校验失败：SHA-256 ${actualHash}`)
    renameSync(temp, destination)
  } catch (error) {
    output.destroy()
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw error
  }
}

export function safeZipEntry(root, name) {
  const destination = resolve(root, name)
  const prefix = resolve(root) + sep
  return destination.startsWith(prefix) && !name.includes('\0')
}

function findFile(root, wanted) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(path, wanted)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === wanted.toLowerCase()) return path
  }
  return undefined
}

export function inspectPcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_WAV_BYTES) throw new Error('WAV 文件大小无效')
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是有效的 WAV 文件')
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw new Error('WAV RIFF 长度无效')
  let offset = 12
  let format
  let data
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    if (end > buffer.length) throw new Error('WAV 数据不完整')
    if (id === 'fmt ' && size >= 16) {
      format = {
        codec: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bits: buffer.readUInt16LE(start + 14),
      }
    } else if (id === 'data') data = { start, size }
    offset = end + (size % 2)
  }
  if (!format || !data) throw new Error('WAV 缺少 fmt 或 data 区块')
  if (format.codec !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bits !== 16 || format.blockAlign !== 2 || format.byteRate !== 32000) {
    throw new Error('仅支持 16kHz、16-bit、单声道 PCM WAV')
  }
  if (data.size < 3200 || data.size % 2 !== 0) throw new Error('录音过短或数据无效')
  const durationMs = Math.round(data.size / format.byteRate * 1000)
  if (durationMs > MAX_SECONDS * 1000 + 250) throw new Error(`录音不能超过 ${MAX_SECONDS} 秒`)
  return { durationMs, dataBytes: data.size }
}

export class LocalSttManager {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir
    this.runtimeDir = join(baseDir, 'runtime', STT_MANIFEST.runtimeTag)
    this.modelDir = join(baseDir, 'models')
    this.tempDir = join(baseDir, 'tmp')
    this.modelPath = join(this.modelDir, 'ggml-small.bin')
    this.exePath = undefined
    this.phase = 'idle'
    this.progress = 0
    this.error = undefined
    this.busy = false
    this.verified = false
    this.installAbort = undefined
    this.child = undefined
    this.threads = Math.max(1, Math.min(12, Number(options.threads) || 8))
    this.timeoutMs = Math.max(options.allowUnsafeTimeout ? 10 : 30_000, Math.min(300_000, Number(options.timeoutMs) || 120_000))
    this.spawnImpl = options.spawn || spawn
    this.refreshPaths()
    this.sweepTemp()
    // Verify integrity on construction so ready() reflects a confirmed-good state.
    void this.verifyInstalled().then(ok => { this.verified = ok })
  }

  refreshPaths() {
    this.exePath = existsSync(this.runtimeDir) ? findFile(this.runtimeDir, 'whisper-cli.exe') : undefined
  }

  sweepTemp() {
    try { rmSync(this.tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
    mkdirSync(this.tempDir, { recursive: true })
  }

  ready() {
    return this.verified && this.exePath !== undefined && existsSync(this.exePath) && existsSync(this.modelPath)
  }

  info() {
    return {
      supported: process.platform === 'win32' && process.arch === 'x64',
      ready: this.ready(),
      phase: this.phase,
      progress: this.progress,
      busy: this.busy,
      model: 'whisper-small-multilingual',
      maxSeconds: MAX_SECONDS,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  async verifyInstalled() {
    this.refreshPaths()
    if (!this.exePath || !existsSync(this.modelPath)) return false
    const modelStat = statSync(this.modelPath)
    if (modelStat.size !== STT_MANIFEST.modelBytes) return false
    if ((await sha256File(this.modelPath)) !== STT_MANIFEST.modelSha256) return false
    const exeStat = statSync(this.exePath)
    if (exeStat.size < 100_000) return false
    if ((await sha256File(this.exePath)) !== STT_MANIFEST.runtimeExeSha256) return false
    return true
  }

  startInstall() {
    if (this.ready() || this.installAbort !== undefined) return false
    const ac = new AbortController()
    this.installAbort = ac
    this.phase = 'downloading-runtime'
    this.progress = 0
    this.error = undefined
    void this.install(ac.signal).catch(error => {
      if (ac.signal.aborted) {
        this.phase = 'idle'
        this.error = '安装已取消'
      } else {
        this.phase = 'failed'
        this.error = error instanceof Error ? error.message : String(error)
      }
    }).finally(() => { this.installAbort = undefined })
    return true
  }

  cancelInstall() {
    if (!this.installAbort) return false
    this.installAbort.abort()
    return true
  }

  async install(signal) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前仅支持 Windows x64')
    mkdirSync(this.baseDir, { recursive: true })
    const staging = join(this.baseDir, `.install-${randomUUID()}`)
    mkdirSync(staging, { recursive: true })
    try {
      const zipPath = join(staging, 'runtime.zip')
      await downloadPinned(STT_MANIFEST.runtimeUrl, zipPath, STT_MANIFEST.runtimeSha256, STT_MANIFEST.runtimeMaxBytes, 0, (done, total) => {
        this.phase = 'downloading-runtime'
        this.progress = total > 0 ? Math.round(done / total * 10) : 1
      }, signal)
      signal.throwIfAborted()
      const extracted = join(staging, 'runtime')
      mkdirSync(extracted, { recursive: true })
      const entries = unzipSync(new Uint8Array(readFileSync(zipPath)))
      for (const [entryName, bytes] of Object.entries(entries)) {
        if (!safeZipEntry(extracted, entryName)) throw new Error('运行库压缩包包含不安全路径')
        if (entryName.endsWith('/')) continue
        const destination = resolve(extracted, entryName)
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, Buffer.from(bytes), { mode: 0o700 })
      }
      if (!findFile(extracted, 'whisper-cli.exe')) throw new Error('运行库缺少 whisper-cli.exe')
      rmSync(this.runtimeDir, { recursive: true, force: true })
      mkdirSync(dirname(this.runtimeDir), { recursive: true })
      renameSync(extracted, this.runtimeDir)
      this.refreshPaths()

      this.phase = 'downloading-model'
      const modelStaging = join(staging, 'ggml-small.bin')
      await downloadPinned(STT_MANIFEST.modelUrl, modelStaging, STT_MANIFEST.modelSha256, STT_MANIFEST.modelBytes + 1024, STT_MANIFEST.modelBytes, (done, total) => {
        this.phase = 'downloading-model'
        this.progress = 10 + Math.round(done / total * 90)
      }, signal)
      signal.throwIfAborted()
      mkdirSync(this.modelDir, { recursive: true })
      rmSync(this.modelPath, { force: true })
      renameSync(modelStaging, this.modelPath)
      this.progress = 100
      this.phase = 'ready'
      this.error = undefined
      this.verified = await this.verifyInstalled()
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  async transcribe(buffer, language = 'zh') {
    const wav = inspectPcmWav(buffer)
    if (!this.ready()) throw Object.assign(new Error('本地语音模型尚未安装'), { code: 'not-ready' })
    if (this.busy) throw Object.assign(new Error('语音识别正忙，请稍后重试'), { code: 'busy' })
    this.busy = true
    const id = randomUUID()
    const inputPath = join(this.tempDir, `${id}.wav`)
    const outputPrefix = join(this.tempDir, id)
    const outputPath = `${outputPrefix}.txt`
    writeFileSync(inputPath, buffer, { mode: 0o600 })
    const started = Date.now()
    try {
      const args = ['-m', this.modelPath, '-f', inputPath, '-l', language === 'en' ? 'en' : language === 'auto' ? 'auto' : 'zh', '-otxt', '-of', outputPrefix, '-np', '-t', String(this.threads)]
      await new Promise((resolveRun, reject) => {
        const child = this.spawnImpl(this.exePath, args, { cwd: dirname(this.exePath), windowsHide: true, stdio: 'ignore', shell: false })
        this.child = child
        let settled = false
        const finish = (error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.child = undefined
          error ? reject(error) : resolveRun()
        }
        const timer = setTimeout(() => {
          try { child.kill() } catch { /* ignore */ }
          if (process.platform === 'win32' && Number.isInteger(child.pid)) {
            try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }) } catch { /* ignore */ }
          }
          finish(Object.assign(new Error('本地语音识别超时'), { code: 'timeout' }))
        }, this.timeoutMs)
        child.once('error', error => finish(error))
        child.once('exit', code => finish(code === 0 ? undefined : new Error(`语音识别进程退出：${code}`)))
      })
      if (!existsSync(outputPath)) throw new Error('语音识别没有产生结果')
      const text = readFileSync(outputPath, 'utf8').replace(/\r/g, '').trim()
      if (text === '') throw Object.assign(new Error('没有识别到语音内容'), { code: 'no-speech' })
      return { text: text.slice(0, 40_000), durationMs: wav.durationMs, elapsedMs: Date.now() - started }
    } finally {
      this.busy = false
      for (const path of [inputPath, outputPath]) try { unlinkSync(path) } catch { /* ignore */ }
    }
  }

  dispose() {
    this.cancelInstall()
    if (this.child) {
      try { this.child.kill() } catch { /* ignore */ }
      this.child = undefined
    }
    this.sweepTemp()
  }
}
