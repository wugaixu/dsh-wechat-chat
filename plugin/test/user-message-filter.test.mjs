import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在导入插件之前指定 DSH_HOME，避免测试读写真实设备文件。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'whale-human-msg-home-'))
const { isHumanUserMessage } = await import('../lib/index.js')

test('手机上的人发的消息保留', () => {
  assert.equal(isHumanUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), true)
  // user-rpc 提交（prompt 的真实来源）同样带 kind: 'user'
  assert.equal(isHumanUserMessage({ source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' } }), true)
})

test('0.2 注入的运行环境快照不当作聊天内容', () => {
  assert.equal(isHumanUserMessage({
    content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
    source: { kind: 'runtime-context' },
  }), false)
})

test('AGENTS.md / 技能清单等 system-reminder 注入被过滤', () => {
  for (const kind of ['system-prompt', 'model-selection', 'tool-registry', 'user-approval', 'compact-checkpoint', 'schedule', 'goal']) {
    assert.equal(isHumanUserMessage({ content: [], source: { kind } }), false, kind + ' 应被过滤')
  }
})

test('没有来源字段的旧运行时保持原行为（照常显示）', () => {
  assert.equal(isHumanUserMessage({ content: [{ type: 'text', text: 'hi' }] }), true)
  assert.equal(isHumanUserMessage({ source: {} }), true)
  assert.equal(isHumanUserMessage(undefined), true)
  assert.equal(isHumanUserMessage({ source: null }), true)
})

test.after(() => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
