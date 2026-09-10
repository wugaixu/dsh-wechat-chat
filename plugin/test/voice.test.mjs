import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceStore } from '../lib/voice.js'

function tempStore(options) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-voice-'))
  return { dir, store: new VoiceStore(dir, options) }
}

test('语音条：写入音频并返回 pending 记录', () => {
  const { dir, store } = tempStore()
  try {
    const id = store.add({ sessionKey: 'k1', wav: Buffer.from('RIFF....WAVE') })
    assert.match(id, /^[a-f0-9]{16}$/)
    assert.equal(existsSync(store.filePath(id)), true, '音频已落盘')
    const list = store.list('k1')
    assert.equal(list.length, 1)
    assert.equal(list[0].id, id)
    assert.equal(list[0].status, 'pending')
    assert.equal(list[0].available, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语音条：更新转写结果并区分会话', () => {
  const { dir, store } = tempStore()
  try {
    const a = store.add({ sessionKey: 'k1', wav: Buffer.alloc(8) })
    const b = store.add({ sessionKey: 'k2', wav: Buffer.alloc(8) })
    store.update(a, { status: 'sent', transcript: '你好', durationMs: 1500 })
    const listA = store.list('k1')
    assert.equal(listA.length, 1)
    assert.equal(listA[0].status, 'sent')
    assert.equal(listA[0].transcript, '你好')
    assert.equal(store.list('k2').length, 1)
    assert.equal(store.list('k2')[0].status, 'pending')
    assert.notEqual(a, b)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语音条 id 必须是纯十六进制，杜绝路径穿越', () => {
  const { dir, store } = tempStore()
  try {
    assert.equal(store.filePath('../../etc/passwd'), undefined)
    assert.equal(store.filePath('abc/def'), undefined)
    assert.equal(store.filePath('ZZZZZZZZZZZZZZZZ'), undefined)
    assert.equal(store.filePath(''), undefined)
    assert.equal(store.filePath(store.newId()) !== undefined, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语音条：超过保留期后音频与记录一起清理', () => {
  const { dir, store } = tempStore({ retentionMs: 1000 })
  try {
    const fresh = store.add({ sessionKey: 'k1', wav: Buffer.alloc(8) })
    const stale = store.add({ sessionKey: 'k1', wav: Buffer.alloc(8) })
    // 把其中一条改成 10 秒前
    store.index[stale].ts = Date.now() - 10_000
    store.prune()
    assert.equal(existsSync(store.filePath(stale)), false, '过期音频已删除')
    const ids = store.list('k1').map(item => item.id)
    assert.deepEqual(ids, [fresh])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语音条：索引文件损坏时不影响启动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-voice-bad-'))
  try {
    writeFileSync(join(dir, 'index.json'), '{ not json')
    const store = new VoiceStore(dir)
    assert.deepEqual(store.list('k1'), [], '损坏索引按空处理')
    const id = store.add({ sessionKey: 'k1', wav: Buffer.alloc(4) })
    assert.equal(store.list('k1').length, 1)
    assert.match(id, /^[a-f0-9]{16}$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语音条：带 BOM 的索引也能读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-voice-bom-'))
  try {
    writeFileSync(join(dir, 'index.json'), '\uFEFF' + JSON.stringify({ aaaaaaaaaaaaaaaa: { sessionKey: 'k1', ts: Date.now(), status: 'sent' } }))
    const store = new VoiceStore(dir)
    assert.equal(store.list('k1').length, 1, 'BOM 不应导致索引被当成空')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
