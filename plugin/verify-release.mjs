// 发布自检：验证 npm 打包白名单 + host 模块可被 DSH loader 正确解析。
// 纯 Node 实现（不派生子进程），零运行时依赖，无网络请求。
// 用法：npm run verify（在 plugin/ 目录下）
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'

const root = fileURLToPath(new URL('.', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1. 递归列出目录下所有文件（相对路径，正斜杠）
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const p = join(dir, entry.name)
    return entry.isDirectory() ? walk(p) : [p]
  })
}
function rel(p) {
  return relative(root, p).replaceAll('\\', '/')
}

// 2. 计算 npm 会打包的文件集：恒含 package.json + files 白名单 + README/LICENSE
const patterns = pkg.files ?? []
const wanted = new Set(['package.json'])
for (const pat of patterns) {
  if (pat.endsWith('/')) {
    for (const f of walk(join(root, pat))) wanted.add(rel(f))
  } else {
    wanted.add(pat)
  }
}

// 3. 断言每个期望文件都存在，且没有任何 node_modules / *.tgz 泄漏
const missing = [...wanted].filter(f => !existsSync(join(root, f)))
if (missing.length) throw new Error(`打包缺少文件: ${missing.join(', ')}`)
const allFiles = walk(root).map(rel)
const leaked = allFiles.filter(f => f.includes('node_modules') || f.endsWith('.tgz'))
if (leaked.length) throw new Error(`打包泄漏了不应包含的文件: ${leaked.join(', ')}`)
console.log(`pack ok: ${[...wanted].sort().join(', ')}`)

// 4. 语法检查 client 半区（纯脚本，不执行只 parse；host 半区是 ESM，在下一步 import 时解析）
new Script(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), { filename: 'client.js' })
console.log('syntax ok: lib/client.js')

// 5. 导入 host 模块，断言导出（name / inject / apply）
const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
if (typeof mod.name !== 'string' || mod.name.length === 0) throw new Error('host 模块缺少 name 导出')
if (!Array.isArray(mod.inject)) throw new Error('host 模块的 inject 不是数组')
if (typeof mod.apply !== 'function') throw new Error('host 模块的 apply 不是函数')

console.log(`verify ok: ${pkg.name}@${pkg.version} — name=${mod.name}, inject=[${mod.inject.join(', ')}], apply=function`)
