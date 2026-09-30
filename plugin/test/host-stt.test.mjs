import test from 'node:test'
import assert from 'node:assert/strict'
import { DshSttEngine, canonicalizePcmWav, createDshSttEngine, dshSpeechService } from '../lib/host-stt.js'

/** 一个最小可用的 16 kHz 单声道 PCM16 WAV（0.1 秒静音）。 */
function silentWav(samples = 1600, { extendedFmt = false } = {}) {
  const data = Buffer.alloc(samples * 2)
  const fmtSize = extendedFmt ? 18 : 16
  const headerSize = 12 + 8 + fmtSize + 8
  const header = Buffer.alloc(headerSize)
  header.write('RIFF', 0)
  header.writeUInt32LE(headerSize - 8 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(fmtSize, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  if (extendedFmt) header.writeUInt16LE(0, 36) // cbSize：安卓侧常见的 18 字节 fmt
  header.write('data', headerSize - 8)
  header.writeUInt32LE(data.length, headerSize - 4)
  return Buffer.concat([header, data])
}

function fakeService({ phase = 'standby', languages = ['auto', 'zh', 'en'], snapshot, result } = {}) {
  const calls = { resolve: [], transcribe: 0, prepare: [], cancel: [] }
  const service = {
    calls,
    snapshot: () => snapshot ?? {
      providers: [{ id: 'sensevoice-local', name: 'SenseVoiceSmall (INT8)', languages, preparation: { phase } }],
      selection: { providerId: 'sensevoice-local', language: 'auto' },
    },
    resolve: (request) => { calls.resolve.push(request); return { provider: { info: { id: 'sensevoice-local' } }, audio: request.audio, language: request.language } },
    transcribe: async () => { calls.transcribe += 1; return result ?? { text: '你好', audioSeconds: 1.25, inferenceSeconds: 0.4 } },
    prepare: (id) => { calls.prepare.push(id) },
    cancelPreparation: async (id) => { calls.cancel.push(id) },
  }
  return service
}

test('拿不到服务时判定为不可用', () => {
  assert.equal(dshSpeechService({ get: () => undefined }), undefined)
  assert.equal(dshSpeechService({ get: () => ({}) }), undefined)
  assert.equal(dshSpeechService({ get: () => { throw new Error('boom') } }), undefined)
  const engine = createDshSttEngine({ get: () => undefined })
  assert.equal(engine.available(), false)
  assert.equal(engine.info().supported, false)
  assert.equal(engine.startInstall(), false)
})

test('standby（模型已缓存待唤醒）也算就绪', () => {
  const engine = new DshSttEngine(fakeService({ phase: 'standby' }))
  assert.equal(engine.available(), true)
  assert.equal(engine.ready(), true)
  assert.equal(engine.info().ready, true)
  assert.equal(engine.info().engine, 'dsh')
  assert.equal(engine.info().model, 'dsh-sensevoice')
  assert.equal(engine.info().modelName, 'SenseVoiceSmall (INT8)')
})

test('未准备时给出可安装状态与下载进度', async () => {
  const downloading = new DshSttEngine(fakeService({
    snapshot: {
      providers: [{ id: 'sensevoice-local', languages: ['zh'], preparation: { phase: 'downloading', completedBytes: 25, totalBytes: 100 } }],
      selection: { providerId: 'sensevoice-local' },
    },
  }))
  assert.equal(downloading.ready(), false)
  const info = downloading.info()
  assert.equal(info.phase, 'downloading-model')
  assert.equal(info.progress, 25)
  assert.equal(downloading.startInstall(), false, '下载中重复点安装应被拒')
  assert.equal(downloading.cancelInstall(), true, '下载中可以取消')
  // 取消是 fire-and-forget，等一个微任务再断言
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(downloading.service.calls.cancel, ['sensevoice-local'])
})

test('未准备时 startInstall 调 DSH 的 prepare', () => {
  const service = fakeService({ phase: 'unprepared' })
  const engine = new DshSttEngine(service)
  assert.equal(engine.startInstall(), true)
  assert.deepEqual(service.calls.prepare, ['sensevoice-local'])
  assert.equal(engine.cancelInstall(), false, '空闲时没有可取消的任务')
})

test('transcribe 走 resolve+transcribe，并把 audioSeconds 换算成 durationMs', async () => {
  const service = fakeService()
  const engine = new DshSttEngine(service)
  const wav = silentWav()
  const result = await engine.transcribe(wav, 'zh')
  assert.equal(result.text, '你好')
  assert.equal(result.durationMs, 1250)
  assert.equal(service.calls.transcribe, 1)
  assert.equal(service.calls.resolve.length, 1)
  assert.equal(service.calls.resolve[0].language, 'zh')
  assert.equal(Buffer.isBuffer(service.calls.resolve[0].audio), true)
  assert.equal(engine.info().busy, false)
})

test('provider 不支持所选语言时退回 auto', async () => {
  const service = fakeService({ languages: ['auto', 'zh'] })
  const engine = new DshSttEngine(service)
  await engine.transcribe(silentWav(), 'en')
  assert.equal(service.calls.resolve[0].language, 'auto')
})

test('模型没准备好时拒绝转写（不启动下载）', async () => {
  const service = fakeService({ phase: 'unprepared' })
  const engine = new DshSttEngine(service)
  await assert.rejects(() => engine.transcribe(silentWav(), 'zh'), /还没有准备好/)
  assert.equal(service.calls.transcribe, 0)
})

test('识别结果为空时抛 no-speech', async () => {
  const service = fakeService({ result: { text: '   ', audioSeconds: 0.5 } })
  const engine = new DshSttEngine(service)
  await assert.rejects(() => engine.transcribe(silentWav(), 'zh'), (error) => error.code === 'no-speech')
})

test('非法 WAV 在调用服务之前就被拒绝', async () => {
  const service = fakeService()
  const engine = new DshSttEngine(service)
  await assert.rejects(() => engine.transcribe(Buffer.from('not a wav'), 'zh'))
  assert.equal(service.calls.transcribe, 0)
})

test('18 字节 fmt（安卓常见）会被重建成规范 44 字节头再交给 DSH', async () => {
  const extended = silentWav(1600, { extendedFmt: true })
  assert.equal(extended.readUInt32LE(16), 18)
  const { wav, durationMs } = canonicalizePcmWav(extended)
  assert.equal(wav.readUInt32LE(16), 16, 'fmt 区块被规范化为 16 字节')
  assert.equal(wav.toString('ascii', 36, 40), 'data')
  assert.equal(wav.length, 44 + 3200)
  assert.equal(durationMs, 100)

  const service = fakeService()
  const engine = new DshSttEngine(service)
  await engine.transcribe(extended, 'zh')
  const sent = service.calls.resolve[0].audio
  assert.equal(sent.readUInt32LE(16), 16, '交给 DSH 的是规范头')
  assert.equal(sent.length, wav.length)
})
