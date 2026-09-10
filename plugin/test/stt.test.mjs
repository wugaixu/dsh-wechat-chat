import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadPinned, inspectPcmWav, LocalSttManager, safeZipEntry } from '../lib/stt.js'

function wav(seconds = 1, sampleRate = 16000) {
  const pcmBytes = Math.round(seconds * sampleRate * 2)
  const out = Buffer.alloc(44 + pcmBytes)
  out.write('RIFF', 0); out.writeUInt32LE(36 + pcmBytes, 4); out.write('WAVE', 8)
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(pcmBytes, 40)
  return out
}

test('strictly validates supported PCM WAV', () => {
  assert.deepEqual(inspectPcmWav(wav()), { durationMs: 1000, dataBytes: 32000 })
  assert.throws(() => inspectPcmWav(wav(1, 44100)), /16kHz/)
  assert.throws(() => inspectPcmWav(wav(61)), /大小无效|60 秒/)
  const truncated = wav(); truncated.writeUInt32LE(999999, 40)
  assert.throws(() => inspectPcmWav(truncated), /不完整/)
})

test('rejects ZIP traversal destinations', () => {
  const root = join(tmpdir(), 'safe-root')
  assert.equal(safeZipEntry(root, 'Release/whisper-cli.exe'), true)
  assert.equal(safeZipEntry(root, '../outside.exe'), false)
  assert.equal(safeZipEntry(root, '/outside.exe'), false)
})

test('pinned download verifies checksum and removes bad partials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-download-'))
  try {
    const destination = join(dir, 'ok.bin')
    const hash = createHash('sha256').update('abc').digest('hex')
    await downloadPinned('data:application/octet-stream;base64,YWJj', destination, hash, 10, 3)
    assert.equal(readFileSync(destination, 'utf8'), 'abc')
    await assert.rejects(downloadPinned('data:application/octet-stream;base64,YWJj', join(dir, 'bad.bin'), '0'.repeat(64), 10, 3), /校验失败/)
    assert.deepEqual(readdirSync(dir).sort(), ['ok.bin'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('transcriber rejects concurrency and cleans temporary files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-busy-'))
  let child
  const manager = new LocalSttManager(dir, { spawn: () => (child = Object.assign(new EventEmitter(), { kill() {} })) })
  manager.ready = () => true
  manager.exePath = join(dir, 'whisper-cli.exe')
  const first = manager.transcribe(wav())
  await assert.rejects(manager.transcribe(wav()), error => error.code === 'busy')
  child.emit('exit', 1)
  await assert.rejects(first, /进程退出/)
  assert.equal(manager.busy, false)
  assert.deepEqual(readdirSync(manager.tempDir), [])
  rmSync(dir, { recursive: true, force: true })
})

test('transcriber enforces timeout and cleans temporary files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-timeout-'))
  let killed = false
  const manager = new LocalSttManager(dir, {
    timeoutMs: 20,
    allowUnsafeTimeout: true,
    spawn: () => Object.assign(new EventEmitter(), { kill() { killed = true } }),
  })
  manager.ready = () => true
  manager.exePath = join(dir, 'whisper-cli.exe')
  await assert.rejects(manager.transcribe(wav()), error => error.code === 'timeout')
  assert.equal(killed, true)
  assert.equal(manager.busy, false)
  assert.deepEqual(readdirSync(manager.tempDir), [])
  rmSync(dir, { recursive: true, force: true })
})
