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

test('probe marks the tunnel unhealthy after repeated failures and rebuilds', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(530)
    res.end('error 1033')
  })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    let failures = 0
    manager.fail = () => { failures += 1 }
    manager.scheduleProbe = () => {} // 测试中不排定后台定时器
    manager.url = url
    manager.phase = 'running'
    manager.healthy = true
    // 连做三次失败探测：前两次只置为不健康，第三次触发重建。
    manager.probe = async () => false
    for (let i = 0; i < 3; i += 1) await manager.runProbe()
    assert.equal(manager.healthy, false)
    assert.equal(failures, 1)
    assert.equal(manager.probeFailures, 3)
  } finally {
    server.close()
  }
})
