import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在导入插件之前指定 DSH_HOME，避免测试读写真实设备文件。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'whale-pair-home-'))
const { PairingService } = await import('../lib/index.js')

const config = { tokenTtlMs: 10 * 60 * 1000, maxDevices: 4, idleExpireMs: 30 * 24 * 60 * 60 * 1000 }

test('口令配对：首次接受成功并下发设备', () => {
  const service = new PairingService(config)
  const { token } = service.issue()
  const result = service.accept(token, 'UA-1')
  assert.equal(result.ok, true)
  assert.match(result.deviceId, /^[a-f0-9]{32}$/)
  service.stop()
})

test('配对导航重复提交时幂等：重放返回同一设备，不新建凭据', () => {
  const service = new PairingService(config)
  const { token } = service.issue()
  const first = service.accept(token, 'Mozilla/5.0 (Linux; Android 16; wv)')
  const second = service.accept(token, 'Mozilla/5.0 (Linux; Android 16; wv)')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true, '重复导航不应报 invalid')
  assert.equal(second.deviceId, first.deviceId, '必须复用同一设备凭据')
  assert.equal(second.replayed, true)
  assert.equal(service.deviceCount(), 1, '重放不得新增设备')
  service.stop()
})

test('未知或伪造令牌仍然拒绝', () => {
  const service = new PairingService(config)
  service.issue()
  assert.deepEqual(service.accept('0'.repeat(32), 'UA'), { ok: false, code: 'invalid' })
  service.stop()
})

test('停止配对后连重放也失效', () => {
  const service = new PairingService(config)
  const { token } = service.issue()
  assert.equal(service.accept(token, 'UA').ok, true)
  service.stop()
  assert.deepEqual(service.accept(token, 'UA'), { ok: false, code: 'invalid' })
})

test('过期令牌不可接受', () => {
  const service = new PairingService({ ...config, tokenTtlMs: 1 })
  const { token } = service.issue()
  const wait = Date.now() + 5
  while (Date.now() < wait) { /* spin briefly */ }
  assert.deepEqual(service.accept(token, 'UA'), { ok: false, code: 'invalid' })
  service.stop()
})

test('设备数达上限时按创建时间淘汰最旧设备', () => {
  const service = new PairingService({ ...config, maxDevices: 2 })
  const ids = []
  for (let i = 0; i < 3; i += 1) {
    const { token } = service.issue()
    const result = service.accept(token, `UA-${i}`)
    assert.equal(result.ok, true)
    ids.push(result.deviceId)
  }
  assert.equal(service.deviceCount(), 2)
  assert.equal(service.hasDevice(ids[0]), false, '最旧设备被淘汰')
  assert.equal(service.hasDevice(ids[2]), true, '最新设备保留')
  service.stop()
})

test.after(() => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
