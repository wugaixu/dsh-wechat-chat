import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { TunnelManager } from '../lib/index.js'

/** 起一个临时 HTTP 服务，模拟 cloudflared 的本地 /ready 端点。 */
function readyServer(payload) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url !== '/ready') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('没有 metrics 端口时不阻塞出码（按可用处理）', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  assert.equal(await manager.connectorReadyConnections(), 1)
})

test('连接器已就绪时返回就绪连接数', async () => {
  const { server, port } = await readyServer({ status: 200, readyConnections: 4 })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    manager.metricsPort = port
    assert.equal(await manager.connectorReadyConnections(), 4)
  } finally { server.close() }
})

test('连接器未就绪或端点不可达时返回 0', async () => {
  const { server, port } = await readyServer({ status: 200, readyConnections: 0 })
  try {
    const manager = new TunnelManager('http://127.0.0.1:1')
    manager.metricsPort = port
    assert.equal(await manager.connectorReadyConnections(), 0)
  } finally { server.close() }

  const dead = new TunnelManager('http://127.0.0.1:1')
  dead.metricsPort = 9 // 关闭的端口
  assert.equal(await dead.connectorReadyConnections(), 0)
})

test('info 仅在拿到地址后暴露 connected', () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  assert.deepEqual(manager.info(), { phase: 'stopped' })
  manager.url = 'https://example.trycloudflare.com'
  manager.connected = true
  assert.deepEqual(manager.info(), {
    phase: 'stopped',
    url: 'https://example.trycloudflare.com',
    connected: true,
  })
  manager.stop()
  assert.equal(manager.connected, false)
  assert.deepEqual(manager.info(), { phase: 'stopped' })
})

test('连接器掉线只标记未就绪，短时间不换地址', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  let rebuilds = 0
  manager.fail = () => { rebuilds += 1 }
  manager.scheduleReady = () => {}
  manager.url = 'https://stable-name.trycloudflare.com'
  manager.phase = 'running'
  manager.connected = true
  manager.connectorReadyConnections = async () => 0
  for (let i = 0; i < 10; i += 1) await manager.runReadyCheck()
  assert.equal(manager.connected, false)
  assert.equal(rebuilds, 0, '宽限期内保持同一地址，手机无需重新扫码')
  assert.equal(manager.url, 'https://stable-name.trycloudflare.com')
})

test('长时间连不上 Cloudflare 才重建隧道', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  let rebuilds = 0
  manager.fail = () => { rebuilds += 1 }
  manager.scheduleReady = () => {}
  manager.url = 'https://stuck-name.trycloudflare.com'
  manager.phase = 'running'
  manager.connected = true
  manager.readySince = Date.now() - 61_000
  manager.connectorReadyConnections = async () => 0
  await manager.runReadyCheck()
  assert.equal(rebuilds, 1)
  assert.equal(manager.connected, false)
})

test('连接器恢复后就绪状态回归且地址不变', async () => {
  const manager = new TunnelManager('http://127.0.0.1:1')
  manager.scheduleReady = () => {}
  manager.url = 'https://recovers.trycloudflare.com'
  manager.phase = 'running'
  manager.connected = false
  manager.readySince = Date.now() - 30_000
  manager.connectorReadyConnections = async () => 2
  await manager.runReadyCheck()
  assert.equal(manager.connected, true)
  assert.equal(manager.readySince, undefined)
  assert.equal(manager.url, 'https://recovers.trycloudflare.com')
})
