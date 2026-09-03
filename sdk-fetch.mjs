// Fetch Android SDK packages directly (bypasses broken sdkmanager networking).
import { writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const OUT = 'C:/Users/Administrator/.dsh/android-toolchain/sdk-pkgs'
const BASE = 'https://dl.google.com/android/repository/'
mkdirSync(OUT, { recursive: true })

const xml = await (await fetch(BASE + 'repository2-3.xml')).text()
console.log('manifest bytes', xml.length)

function blockOf(path) {
  const startTag = `<remotePackage path="${path}">`
  const i = xml.indexOf(startTag)
  if (i < 0) return null
  const end = xml.indexOf('</remotePackage>', i)
  return xml.slice(i, end)
}

const wanted = ['platform-tools', 'platforms;android-35', 'build-tools;35.0.0']
for (const path of wanted) {
  const block = blockOf(path)
  if (block === null) { console.log(path, 'NOT FOUND'); continue }
  // find windows archive: iterate over <archive> sections with host-os
  let picked = null
  let generic = null
  const re = /<archive>([\s\S]*?)<\/archive>/g
  let m
  while ((m = re.exec(block)) !== null) {
    const sec = m[1]
    const os = /<host-os>([^<]+)<\/host-os>/.exec(sec)
    const url = /<url>([^<]+)<\/url>/.exec(sec)
    const sha = /<checksum[^>]*>([0-9a-f]+)<\/checksum>/.exec(sec)
    if (!url) continue
    const entry = { url: new URL(url[1], BASE).href, sha: sha ? sha[1] : null }
    if (os && os[1] === 'windows') { picked = entry; break }
    if (!os) generic = generic || entry
  }
  if (!picked && generic) picked = generic
  if (!picked) { console.log(path, 'no usable archive'); continue }
  const name = path.replace(/[^a-z0-9.-]+/gi, '_') + '.zip'
  console.log('downloading', path, picked.url)
  const buf = Buffer.from(await (await fetch(picked.url)).arrayBuffer())
  if (picked.sha) {
    const got = createHash('sha1').update(buf).digest('hex')
    console.log('sha1', got === picked.sha ? 'OK' : 'MISMATCH expected ' + picked.sha)
  }
  writeFileSync(`${OUT}/${name}`, buf)
  console.log('saved', name, buf.length)
}
console.log('done')
