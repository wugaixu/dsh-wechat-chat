// 发布自检：真实 npm pack、干净安装、host 导入与浏览器脚本语法检查。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'dsh-wechat-verify-'))

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath
  const command = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', windowsHide: true })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
  if (command.status !== 0) throw new Error(`npm ${args[0]} 失败:\n${command.stderr || command.stdout}`)
  return command.stdout
}

try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', temp], root))
  if (!Array.isArray(packed) || !packed[0]?.filename) throw new Error('npm pack 没有返回产物')
  const files = (packed[0].files || []).map(item => item.path.replaceAll('\\', '/'))
  const required = ['package.json', 'lib/index.js', 'lib/stt.js', 'lib/client.js', 'lib/chat-page.html', 'lib/panel-page.html', 'cordis.patch.yml', 'docs/local-voice.md', 'README.md', 'README.en.md', 'LICENSE']
  const missing = required.filter(path => !files.includes(path))
  if (missing.length) throw new Error(`发布包缺少文件: ${missing.join(', ')}`)
  const leaked = files.filter(path => path.includes('node_modules/') || path.endsWith('.tgz') || path.includes('secrets.properties'))
  if (leaked.length) throw new Error(`发布包泄漏文件: ${leaked.join(', ')}`)
  console.log(`pack ok: ${files.join(', ')}`)

  for (const file of ['client.js']) new Script(readFileSync(join(root, 'lib', file), 'utf8'), { filename: file })
  for (const file of ['chat-page.html', 'panel-page.html']) {
    const html = readFileSync(join(root, 'lib', file), 'utf8')
    const match = html.match(/<script>\s*(?:__QRCODE_LIB__)?\s*([\s\S]*?)<\/script>/)
    if (!match) throw new Error(`${file} 缺少内联脚本`)
    new Script(match[1], { filename: `${file}.inline.js` })
  }
  console.log('syntax ok: client and inline page scripts')

  const consumer = join(temp, 'consumer')
  const tarball = join(temp, packed[0].filename)
  mkdirSync(consumer, { recursive: true })
  npm(['init', '-y'], consumer)
  npm(['install', '--ignore-scripts', '--no-package-lock', tarball], consumer)
  const installedRoot = join(consumer, 'node_modules', pkg.name)
  if (!existsSync(join(installedRoot, 'lib', 'stt.js'))) throw new Error('干净安装缺少 stt.js')
  const mod = await import(pathToFileURL(join(installedRoot, 'lib', 'index.js')).href)
  if (typeof mod.name !== 'string' || !Array.isArray(mod.inject) || typeof mod.apply !== 'function') throw new Error('host 导出不完整')
  console.log(`verify ok: ${pkg.name}@${pkg.version} — clean install import succeeded`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
