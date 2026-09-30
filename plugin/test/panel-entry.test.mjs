import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const clientSource = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/** 一个够用的假 DOM：只实现入口按钮和叠加层真正用到的部分。 */
function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    type: '',
    textContent: '',
    style: { cssText: '' },
    children: [],
    listeners: {},
    parentNode: null,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null },
    removeAttribute(name) { delete this.attrs[name] },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler) },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      child.parentNode = null
    },
    click() { for (const handler of this.listeners.click ?? []) handler({ key: 'Enter' }) },
  }
  return element
}

/** 载入 client 半区，返回 { exports, window, document, byId }。 */
function loadClient({ protocol, fetchImpl } = {}) {
  const byId = new Map()
  const body = makeElement('body')
  const document = {
    body,
    title: '',
    createElement: (tag) => {
      const element = makeElement(tag)
      // 真实 DOM 里 `el.id = x` 也会更新 id 属性，这里同样登记进 getElementById。
      Object.defineProperty(element, 'id', {
        get() { return this.attrs.id ?? '' },
        set(value) { this.attrs.id = String(value); byId.set(this.attrs.id, this) },
        enumerable: true,
      })
      const originalSet = element.setAttribute.bind(element)
      element.setAttribute = (name, value) => {
        originalSet(name, value)
        if (name === 'id') byId.set(String(value), element)
      }
      return element
    },
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const opened = []
  const context = {
    console,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl ?? (() => Promise.reject(new Error('no fetch in this test'))),
    document,
    window: {
      location: { protocol: protocol ?? 'http:' },
      open: (url, target) => { opened.push({ url, target }); return null },
    },
    require: (name) => (name === 'react' ? { createElement: (type, props, ...kids) => ({ type, props, kids }) } : {}),
  }
  context.window.document = document
  context.window.__ModuleLoader__ = { load: (entry) => { context.__entry = entry } }
  context.__entry = null
  vm.createContext(context)
  vm.runInContext(clientSource, context, { filename: 'client.js' })
  const exports = context.__entry.factory(context.require)
  return { exports, window: context.window, document, body, byId, opened };
}

test('普通 Web：侧栏入口在新标签页打开 /whale-panel（原行为）', () => {
  const env = loadClient({ protocol: 'http:' })
  env.exports.openPanel()
  assert.deepEqual(env.opened, [{ url: '/whale-panel', target: '_blank' }])
  assert.equal(env.byId.has('dsh-wechat-chat-panel'), false)
})

test('桌面端：window.open 会被壳拒绝，改为应用内同源 iframe 叠加层', () => {
  const env = loadClient({ protocol: 'dsh-app:' })
  env.exports.openPanel()
  assert.deepEqual(env.opened, [], '桌面端不得再调用 window.open')
  const host = env.byId.get('dsh-wechat-chat-panel')
  assert.ok(host, '叠加层已挂载')
  assert.equal(host.parentNode, env.body)
  const frame = env.byId.get('dsh-wechat-chat-panel-frame')
  assert.ok(frame, '叠加层里有 iframe')
  assert.equal(frame.getAttribute('src'), '/whale-panel')
  assert.equal(frame.parentNode, host)
})

test('桌面端：再点一次图标即关闭（toggle），不会叠出第二层', () => {
  const env = loadClient({ protocol: 'dsh-app:' })
  env.exports.openPanel()
  const first = env.byId.get('dsh-wechat-chat-panel')
  assert.ok(first, '第一次点击打开')
  env.exports.openPanel()
  assert.equal(first.parentNode, null, '第二次点击关闭')
  assert.deepEqual(env.body.children, [])
  env.exports.openPanel()
  assert.ok(env.byId.get('dsh-wechat-chat-panel'), '第三次点击重新打开')
  assert.equal(env.body.children.filter((c) => c.id === 'dsh-wechat-chat-panel').length, 1, '始终只有一层')
})

test('桌面端：返回按钮在工具条最左侧，点击后移除叠加层', () => {
  const env = loadClient({ protocol: 'dsh-app:' })
  env.exports.openPanel()
  const host = env.byId.get('dsh-wechat-chat-panel')
  const bar = host.children[0]
  const back = bar.children[0]
  assert.equal(back.tagName, 'BUTTON')
  assert.match(back.textContent, /返回/)
  back.click()
  assert.equal(host.parentNode, null, '关闭后从 DOM 上摘掉')
  assert.deepEqual(env.body.children, [])
})

test('桌面端：入口按钮点击走同一条路（组件 onClick = openPanel）', () => {
  const env = loadClient({ protocol: 'dsh-app:' })
  const element = env.exports.Entry()
  element.props.onClick()
  assert.ok(env.byId.get('dsh-wechat-chat-panel'), '点按钮即打开面板')
})

test('桌面端：壳没有转发时退化为取回 HTML 写进 srcdoc', async () => {
  const env = loadClient({
    protocol: 'dsh-app:',
    fetchImpl: () => Promise.resolve({ ok: true, text: () => Promise.resolve('<html><title>鲸聊 · 配对</title></html>') }),
  })
  env.exports.openPanel()
  const frame = env.byId.get('dsh-wechat-chat-panel-frame')
  // 没有 load 事件（壳不转发），叠加层在超时后自行兜底。
  await new Promise((resolve) => setTimeout(resolve, 2700))
  assert.equal(frame.getAttribute('src'), null, 'src 被换成 srcdoc')
  assert.match(frame.getAttribute('srcdoc') ?? '', /鲸聊 · 配对/)
})
