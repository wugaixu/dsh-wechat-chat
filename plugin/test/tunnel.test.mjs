import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { TunnelManager } from '../lib/index.js'

/** 启动一个临时 HTTP 服务，用于模拟隧道公网侧的响应。 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

test('probe treats a reachable tunnel as healthy', async () => {
  const { server, url } = await listen((req, res) => {
    assert.equal(req.url, '/__whale/login')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<title>鲸聊安全登录</title>')
  })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    manager.url = url
    assert.equal(await manager.probe(), true)
  } finally {
    server.close()
  }
})

test('probe rejects Cloudflare 5xx edge errors', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(530, { 'content-type': 'text/html' })
    res.end('error 1033')
  })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    manager.url = url
    assert.equal(await manager.probe(), false)
  } finally {
    server.close()
  }
})

test('probe rejects an unreachable or unknown tunnel host', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  assert.equal(await manager.probe(), false, 'no url means not healthy')
  manager.url = 'http://127.0.0.1:9'
  assert.equal(await manager.probe(), false, 'closed port means not healthy')
})

test('probe accepts redirect responses from a healthy gateway', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(303, { location: '/__whale/login' })
    res.end()
  })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    manager.url = url
    assert.equal(await manager.probe(), true)
  } finally {
    server.close()
  }
})

test('info exposes health only once a public url exists', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  assert.deepEqual(manager.info(), { phase: 'stopped' })
  manager.url = 'https://example.trycloudflare.com'
  manager.healthy = true
  assert.deepEqual(manager.info(), {
    phase: 'stopped',
    url: 'https://example.trycloudflare.com',
    healthy: true,
  })
  manager.stop()
  assert.equal(manager.healthy, false)
  assert.deepEqual(manager.info(), { phase: 'stopped' })
})

test('repeated probe failures keep the same tunnel instead of churning the url', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  let rebuilds = 0
  manager.fail = () => { rebuilds += 1 }
  manager.scheduleProbe = () => {} // 测试中不排定后台定时器
  manager.url = 'https://stable-name.trycloudflare.com'
  manager.phase = 'running'
  manager.healthy = true
  manager.probe = async () => false
  for (let i = 0; i < 10; i += 1) await manager.runProbe()
  assert.equal(manager.healthy, false, 'marked unhealthy')
  assert.equal(rebuilds, 0, 'still within the rebuild grace window: url stays stable')
  assert.equal(manager.url, 'https://stable-name.trycloudflare.com', 'address is reused')
  assert.equal(manager.probeFailures, 10)
})

test('a long outage eventually rebuilds the tunnel', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  let rebuilds = 0
  manager.fail = () => { rebuilds += 1 }
  manager.scheduleProbe = () => {}
  manager.url = 'https://stuck-name.trycloudflare.com'
  manager.phase = 'running'
  manager.healthy = true
  manager.unhealthySince = Date.now() - 121_000 // 已持续不可达超过阈值
  manager.probe = async () => false
  await manager.runProbe()
  assert.equal(rebuilds, 1)
  assert.equal(manager.healthy, false)
})

test('a recovered probe restores health without changing the address', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  manager.scheduleProbe = () => {}
  manager.url = 'https://recovers.trycloudflare.com'
  manager.phase = 'running'
  manager.healthy = false
  manager.unhealthySince = Date.now() - 60_000
  manager.probe = async () => true
  await manager.runProbe()
  assert.equal(manager.healthy, true)
  assert.equal(manager.unhealthySince, undefined, 'grace timer cleared after recovery')
  assert.equal(manager.probeFailures, 0)
  assert.equal(manager.url, 'https://recovers.trycloudflare.com', 'same address reused, no re-scan needed')
})
