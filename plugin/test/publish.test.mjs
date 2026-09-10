import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'whale-publish-home-'))
const { tunnelNamePublished } = await import('../lib/index.js')

/** 模拟一个 DoH JSON 端点。 */
function dohServer(payload, status = 200) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/dns-json' })
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/resolve` }))
  })
}

test('域名已发布（Status=0 且有 A 记录）判定为已发布', async () => {
  const { server, url } = await dohServer({
    Status: 0,
    Answer: [{ name: 'x.trycloudflare.com', type: 1, data: '104.16.230.132' }],
  })
  try {
    assert.equal(await tunnelNamePublished('x.trycloudflare.com', [url]), true)
  } finally { server.close() }
})

test('NXDOMAIN 判定为未发布（手机解析会失败）', async () => {
  const { server, url } = await dohServer({ Status: 3, Answer: [] })
  try {
    assert.equal(await tunnelNamePublished('dead.trycloudflare.com', [url]), false)
  } finally { server.close() }
})

test('只有 CNAME 而无 A 记录时不算已发布', async () => {
  const { server, url } = await dohServer({
    Status: 0,
    Answer: [{ name: 'x.trycloudflare.com', type: 5, data: 'y.cloudflare.net' }],
  })
  try {
    assert.equal(await tunnelNamePublished('x.trycloudflare.com', [url]), false)
  } finally { server.close() }
})

test('第一个解析器失败时回退到下一个', async () => {
  const { server, url } = await dohServer({ Status: 3, Answer: [] })
  const good = await dohServer({ Status: 0, Answer: [{ type: 1, data: '104.16.1.1' }] })
  try {
    assert.equal(await tunnelNamePublished('x.trycloudflare.com', [url, good.url]), true)
  } finally { server.close(); good.server.close() }
})

test('全部解析器不可用 / 非法输入都算未发布', async () => {
  assert.equal(await tunnelNamePublished('x.trycloudflare.com', ['http://127.0.0.1:9/resolve']), false)
  assert.equal(await tunnelNamePublished('', ['http://127.0.0.1:9/resolve']), false)
  assert.equal(await tunnelNamePublished(undefined, ['http://127.0.0.1:9/resolve']), false)
})

test('返回非 JSON 或 HTTP 错误时算未发布', async () => {
  const broken = await dohServer('<html>nope</html>')
  const err = await dohServer({ Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] }, 500)
  try {
    assert.equal(await tunnelNamePublished('x.trycloudflare.com', [broken.url]), false)
    assert.equal(await tunnelNamePublished('x.trycloudflare.com', [err.url]), false)
  } finally { broken.server.close(); err.server.close() }
})

test.after(() => {
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
})
