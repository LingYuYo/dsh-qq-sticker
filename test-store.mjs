import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { resolveStore, dataDirChange } from './src/store.js'
import { readConfig, normalizeAbsolutePath } from './src/config.js'

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail++
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-store-'))
const logs = []
const log = (level, message) => logs.push({ level, message })

/** 造一个"有数据的旧目录"。 */
async function seedDir(dir) {
  await mkdir(path.join(dir, 'images'), { recursive: true })
  await writeFile(path.join(dir, 'library.json'), JSON.stringify({ version: 1, items: [{ file: 'a.jpg' }] }))
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 1, sentToday: 3 }))
  await writeFile(path.join(dir, 'schedule.json'), JSON.stringify({ nextRunAt: 1 }))
  await writeFile(path.join(dir, 'images', 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))
  await writeFile(path.join(dir, 'images', 'b.gif'), Buffer.from('GIF89a'))
}

console.log('\n① 空配置 → 默认目录')

await check('没配 dataDir 时用默认目录，不搬迁', async () => {
  const fallback = path.join(ROOT, 'default-a')
  const result = await resolveStore({ config: readConfig({}), log, defaultDir: fallback })
  assert.equal(result.dataDir, fallback)
  assert.equal(result.source, 'default')
  assert.equal(result.migrated, false)
})

await check('配置了相对路径 → 归一化时被拒，回落默认', async () => {
  const fallback = path.join(ROOT, 'default-b')
  const cfg = readConfig({ store: { dataDir: 'relative/emoji' } })
  assert.equal(cfg.store.dataDir, '', '相对路径应在归一化阶段被清空')
  const result = await resolveStore({ config: cfg, log, defaultDir: fallback })
  assert.equal(result.dataDir, fallback)
})

console.log('\n② 配置了绝对路径')

await check('新目录为空 → 搬迁 index/state/schedule + 全部图片', async () => {
  const from = path.join(ROOT, 'src-1')
  const to = path.join(ROOT, 'dst-1')
  await seedDir(from)
  const cfg = readConfig({ store: { dataDir: to } })
  const result = await resolveStore({ config: cfg, log, defaultDir: from })
  assert.equal(result.dataDir, to, '应切到新目录')
  assert.equal(result.source, 'config')
  assert.equal(result.migrated, true, '应发生搬迁')

  // 文件都在
  const index = JSON.parse(await readFile(path.join(to, 'library.json'), 'utf8'))
  assert.equal(index.items.length, 1)
  const images = await readdir(path.join(to, 'images'))
  assert.deepEqual(images.sort(), ['a.jpg', 'b.gif'])
  // 内容逐字节一致
  const original = await readFile(path.join(from, 'images', 'a.jpg'))
  const copied = await readFile(path.join(to, 'images', 'a.jpg'))
  assert.deepEqual(copied, original)
})

await check('搬迁保留旧目录（不删，避免丢数据）', async () => {
  const from = path.join(ROOT, 'src-2')
  const to = path.join(ROOT, 'dst-2')
  await seedDir(from)
  await resolveStore({ config: readConfig({ store: { dataDir: to } }), log, defaultDir: from })
  const images = await readdir(path.join(from, 'images'))
  assert.equal(images.length, 2, '旧目录图片应保留')
})

await check('新目录非空 → 直接切过去，不覆盖用户数据', async () => {
  const from = path.join(ROOT, 'src-3')
  const to = path.join(ROOT, 'dst-3')
  await seedDir(from)
  await mkdir(to, { recursive: true })
  await writeFile(path.join(to, 'library.json'), JSON.stringify({ version: 1, items: [{ file: 'zzz.jpg' }] }))
  const result = await resolveStore({ config: readConfig({ store: { dataDir: to } }), log, defaultDir: from })
  assert.equal(result.dataDir, to)
  assert.equal(result.migrated, false, '非空目录不应搬迁')
  const index = JSON.parse(await readFile(path.join(to, 'library.json'), 'utf8'))
  assert.equal(index.items[0].file, 'zzz.jpg', '不应覆盖已有索引')
})

await check('目标目录只有 backups/ → 仍视为空，会搬迁', async () => {
  const from = path.join(ROOT, 'src-4')
  const to = path.join(ROOT, 'dst-4')
  await seedDir(from)
  await mkdir(path.join(to, 'backups'), { recursive: true })
  await writeFile(path.join(to, 'backups', 'old.zip'), 'x')
  const result = await resolveStore({ config: readConfig({ store: { dataDir: to } }), log, defaultDir: from })
  assert.equal(result.migrated, true, 'backups 不算库数据')
  const images = await readdir(path.join(to, 'images'))
  assert.equal(images.length, 2)
})

await check('目标路径是文件 → 退回默认并记 warn', async () => {
  const from = path.join(ROOT, 'src-5')
  const to = path.join(ROOT, 'dst-5-file')
  await seedDir(from)
  await writeFile(to, 'i am a file')
  logs.length = 0
  const result = await resolveStore({ config: readConfig({ store: { dataDir: to } }), log, defaultDir: from })
  assert.equal(result.dataDir, from, '应退回默认')
  assert.equal(result.source, 'default')
  assert.ok(logs.some((entry) => entry.level === 'warn'), '应记一条 warn')
  assert.match(result.note, /不是目录/)
})

await check('配置与默认相同 → 不搬迁、不报错', async () => {
  const dir = path.join(ROOT, 'same-1')
  await seedDir(dir)
  const result = await resolveStore({ config: readConfig({ store: { dataDir: dir } }), log, defaultDir: dir })
  assert.equal(result.dataDir, dir)
  assert.equal(result.migrated, false)
})

await check('首次启动：旧目录什么都没有也能干净返回', async () => {
  const from = path.join(ROOT, 'empty-src')
  const to = path.join(ROOT, 'empty-dst')
  await mkdir(from, { recursive: true })
  const result = await resolveStore({ config: readConfig({ store: { dataDir: to } }), log, defaultDir: from })
  assert.equal(result.dataDir, to)
  assert.equal(result.migrated, true)
  // images 目录应被建出来
  const images = await readdir(path.join(to, 'images'))
  assert.deepEqual(images, [])
})

console.log('\n③ 路径归一化边界')

await check('Windows 盘符 / UNC / POSIX 都保留', () => {
  assert.equal(normalizeAbsolutePath('D:\\Emoji'), 'D:\\Emoji')
  assert.equal(normalizeAbsolutePath('D:/Emoji'), 'D:/Emoji')
  assert.equal(normalizeAbsolutePath('D:\\'), 'D:\\')
  assert.equal(normalizeAbsolutePath('/home/x'), '/home/x')
  assert.equal(normalizeAbsolutePath('\\\\server\\share'), '\\\\server\\share')
  assert.equal(normalizeAbsolutePath('rel/path'), '')
  assert.equal(normalizeAbsolutePath(''), '')
})

await check('dataDirChange 能识别改动并提示需重启', () => {
  const before = readConfig({ store: { dataDir: 'D:\\a' } })
  const after = readConfig({ store: { dataDir: 'D:\\b' } })
  assert.equal(dataDirChange(before, after).changed, true)
  assert.equal(dataDirChange(before, after).needsRestart, true)
  assert.equal(dataDirChange(before, before).changed, false)
})

await rm(ROOT, { recursive: true, force: true }).catch(() => {})

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) {
    console.log(`\n· ${item.name}`)
    console.log(String(item.error?.stack ?? item.error).split('\n').slice(0, 6).join('\n'))
  }
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
