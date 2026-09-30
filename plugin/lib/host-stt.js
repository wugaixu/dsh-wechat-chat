/**
 * DSH 内置语音识别的适配层。
 *
 * 官方语音输入 bundle（@deepseek-ai/dsh-experimental-voice-input-bundle）在宿主里提供
 * `ctx.speechToText` 服务，由 sensevoice provider 在本机 CPU 上跑 SenseVoiceSmall ONNX
 * （sherpa-onnx，由 DSH 自己管理运行时与模型缓存）。桌面端默认就带着这个 bundle，模型
 * 存在 `$DSH_HOME/speech-to-text/sensevoice/`，和聊天页麦克风按钮共用同一份。
 *
 * 本类的对外接口与 lib/stt.js 的 LocalSttManager 保持一致（ready/info/startInstall/
 * cancelInstall/transcribe/dispose），这样 index.js 里换引擎不需要改调用点。
 * 拿不到服务时（0.1.x、没装该 bundle 的 profile）`available()` 返回 false，调用方回退
 * 到 whisper.cpp。
 *
 * 注意：这里依然是**本机推理**，只是换了引擎（SenseVoice INT8 约 230 MB，比 whisper
 * small 的 496 MB 小，且中文本就更好）。要走云端识别需要另写 provider。
 */
import { inspectPcmWav } from './stt.js'

/**
 * 把已经通过校验的 WAV 重建成规范 44 字节头。
 *
 * 手机/安卓侧录出来的 WAV 常常带 18 字节 `fmt `（含 cbSize）或别的附加区块，
 * whisper.cpp 不看这些，但 DSH 侧的 validateWave 只认规范布局，会直接报
 * "Invalid speech WAV"。这里按 data 区块的实际内容重建头部，消掉这一整类差异。
 * @param buffer - 原始 WAV 字节（会先做 16k/单声道/PCM16 校验）。
 * @returns `{ wav, durationMs, dataBytes }`。
 */
export function canonicalizePcmWav(buffer) {
  const info = inspectPcmWav(buffer)
  let offset = 12
  let dataStart = -1
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'data') { dataStart = start; dataSize = size; break }
    offset = start + size + (size % 2)
  }
  if (dataStart < 0 || dataSize <= 0) throw new Error('WAV 缺少 data 区块')
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return {
    wav: Buffer.concat([header, buffer.subarray(dataStart, dataStart + dataSize)]),
    durationMs: info.durationMs,
    dataBytes: info.dataBytes,
  }
}

/** provider 的 preparation 阶段 → 面板认识的阶段名。 */
const PHASE_MAP = Object.freeze({
  unprepared: 'idle',
  checking: 'checking',
  downloading: 'downloading-model',
  verifying: 'verifying',
  loading: 'loading',
  waking: 'loading',
  ready: 'ready',
  standby: 'ready',
  failed: 'failed',
  cancelling: 'idle',
  cancelled: 'idle',
})

/** 正在准备中的阶段：这些阶段里重复点「安装」应当被拒。 */
const BUSY_PHASES = new Set(['checking', 'downloading', 'verifying', 'loading', 'waking', 'cancelling'])

/** 从宿主 context 取服务；函数式探测，缺服务或换了 API 都返回 undefined。 */
export function dshSpeechService(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('speechToText') : undefined
    if (service === undefined || service === null) return undefined
    if (typeof service.resolve !== 'function' || typeof service.transcribe !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/**
 * 是否有可用的 DSH 内置识别服务。`engine` 配置为 `whisper` 时调用方应直接跳过本引擎。
 * @param ctx - 宿主 context。
 * @returns 可用的服务实例或 undefined。
 */
export function createDshSttEngine(ctx, options = {}) {
  return new DshSttEngine(dshSpeechService(ctx), options)
}

export class DshSttEngine {
  constructor(service, options = {}) {
    this.service = service
    this.providerId = typeof options.providerId === 'string' && options.providerId !== '' ? options.providerId : undefined
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000
    this.maxSeconds = Number.isFinite(options.maxSeconds) ? options.maxSeconds : 60
    this.busy = false
    this.error = undefined
  }

  available() {
    return this.service !== undefined
  }

  /** 当前 provider id：显式配置优先，否则用注册表的默认选择。 */
  selectedId() {
    if (this.providerId !== undefined) return this.providerId
    try {
      return this.service?.snapshot?.()?.selection?.providerId
    } catch {
      return undefined
    }
  }

  /** 当前 provider 的注册信息（含 languages / preparation）。 */
  providerView() {
    try {
      const snapshot = this.service?.snapshot?.()
      const id = this.selectedId()
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      return providers.find((entry) => entry !== null && typeof entry === 'object' && entry.id === id)
        ?? providers[0]
    } catch {
      return undefined
    }
  }

  /** 模型已校验（ready）或已缓存待唤醒（standby）都算就绪。 */
  ready() {
    const phase = this.providerView()?.preparation?.phase
    return phase === 'ready' || phase === 'standby'
  }

  /** 面板/手机端读的状态；字段与 LocalSttManager.info() 对齐，额外带 engine 与 modelName。 */
  info() {
    const provider = this.providerView()
    const preparation = provider?.preparation ?? {}
    const phase = PHASE_MAP[preparation.phase] ?? 'idle'
    const total = Number(preparation.totalBytes)
    const done = Number(preparation.completedBytes)
    const progress = Number.isFinite(total) && total > 0 && Number.isFinite(done)
      ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
      : 0
    return {
      engine: 'dsh',
      supported: this.available(),
      ready: this.ready(),
      phase,
      progress,
      busy: this.busy,
      model: 'dsh-sensevoice',
      modelName: typeof provider?.name === 'string' ? provider.name : 'SenseVoiceSmall',
      maxSeconds: this.maxSeconds,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /**
   * 开始（或加入）DSH 自己的准备任务：它会去下载/校验模型，进度从 info() 读。
   * @returns 是否真的发起了准备；已经在准备或已就绪时为 false。
   */
  startInstall() {
    if (!this.available()) return false
    const preparation = this.providerView()?.preparation ?? {}
    if (this.ready() || BUSY_PHASES.has(preparation.phase)) return false
    const id = this.selectedId()
    if (typeof id !== 'string' || id === '') return false
    this.error = undefined
    try {
      this.service.prepare(id)
      return true
    } catch (error) {
      this.error = (error && error.message) || '无法开始准备语音模型'
      return false
    }
  }

  /** 取消正在进行的准备；返回是否发起了取消。 */
  cancelInstall() {
    if (!this.available()) return false
    const preparation = this.providerView()?.preparation ?? {}
    if (!BUSY_PHASES.has(preparation.phase)) return false
    const id = this.selectedId()
    if (typeof id !== 'string' || id === '') return false
    Promise.resolve()
      .then(() => this.service.cancelPreparation(id))
      .catch(() => { /* 取消失败不改变状态语义 */ })
    return true
  }

  /** provider 支持的语言提示（如 auto/zh/en/yue/ja/ko）。 */
  supportedLanguages() {
    const languages = this.providerView()?.languages
    return Array.isArray(languages) && languages.length > 0 ? languages : ['auto', 'zh', 'en']
  }

  /**
   * 转写一段规范的 16 kHz 单声道 PCM16 WAV。
   * @param buffer - 完整 WAV 字节。
   * @param language - `zh` / `en` / `auto`；provider 不支持时退到 auto。
   * @returns `{ text, durationMs, elapsedMs }`，与 LocalSttManager 一致。
   */
  async transcribe(buffer, language = 'zh') {
    const { wav, durationMs } = canonicalizePcmWav(buffer)
    if (!this.available()) throw Object.assign(new Error('这台电脑没有 DSH 内置语音识别服务'), { code: 'not-supported' })
    if (BUSY_PHASES.has(this.providerView()?.preparation?.phase)) {
      throw Object.assign(new Error('语音识别模型正在准备中，请稍后再试'), { code: 'not-ready' })
    }
    if (!this.ready()) throw Object.assign(new Error('DSH 内置语音模型还没有准备好'), { code: 'not-ready' })
    const languages = this.supportedLanguages()
    const wanted = language === 'en' ? 'en' : language === 'auto' ? 'auto' : 'zh'
    const chosen = languages.includes(wanted) ? wanted : (languages.includes('auto') ? 'auto' : undefined)
    this.busy = true
    const started = Date.now()
    try {
      const spec = this.service.resolve({
        audio: wav,
        ...chosen === undefined ? {} : { language: chosen },
      })
      const result = await this.service.transcribe(spec, AbortSignal.timeout(this.timeoutMs))
      const text = String(result?.text ?? '').replace(/\r/g, '').trim()
      if (text === '') throw Object.assign(new Error('没有识别到语音内容'), { code: 'no-speech' })
      const audioSeconds = Number(result?.audioSeconds)
      return {
        text: text.slice(0, 40000),
        durationMs: Number.isFinite(audioSeconds) && audioSeconds > 0 ? Math.round(audioSeconds * 1000) : durationMs,
        elapsedMs: Date.now() - started,
      }
    } finally {
      this.busy = false
    }
  }

  /** 什么都不用收：模型与工作进程归 DSH 宿主所有。 */
  dispose() {}
}
