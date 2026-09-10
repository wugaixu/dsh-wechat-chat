import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'whale-session-home-'))
const { pickReusableSession } = await import('../lib/index.js')

test('复用最近创建的鲸聊会话', () => {
  const newest = pickReusableSession({
    old: { sessionId: 'session-a', agentPreset: 'wechat-chat', createdAt: 1000 },
    recent: { sessionId: 'session-b', agentPreset: 'wechat-chat', createdAt: 5000 },
    middle: { sessionId: 'session-c', agentPreset: 'wechat-chat', createdAt: 3000 },
  })
  assert.equal(newest.sessionId, 'session-b')
})

test('忽略非本预设、缺 sessionId 或被删除的记录', () => {
  assert.equal(pickReusableSession({}), undefined)
  assert.equal(pickReusableSession(undefined), undefined)
  assert.equal(pickReusableSession({ x: { sessionId: 'session-x', agentPreset: 'default', createdAt: 9999 } }), undefined)
  assert.equal(pickReusableSession({ x: { agentPreset: 'wechat-chat', createdAt: 9999 } }), undefined)
  assert.equal(pickReusableSession({ x: null }), undefined)
})

test('createdAt 缺失时仍能选出可用会话', () => {
  const picked = pickReusableSession({ x: { sessionId: 'session-x', agentPreset: 'wechat-chat' } })
  assert.equal(picked.sessionId, 'session-x')
})

test('真实映射形态（含重配对设备）选择最近的会话', () => {
  const picked = pickReusableSession({
    '2628b58d-42f2-49a0-bb0a-8084cb782fea': {
      sessionId: 'session-967f93ad-3be5-4be7-847d-5d83ab6cace7',
      agentPreset: 'wechat-chat',
      createdAt: 1788495046232,
    },
    'a1b2c3d4e5f60718293a4b5c6d7e8f90': {
      sessionId: 'session-newer',
      agentPreset: 'wechat-chat',
      createdAt: 1788500000000,
    },
  })
  assert.equal(picked.sessionId, 'session-newer')
})

test.after(() => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
