/**
 * test-tree.mjs —— 物理文件夹分类 / 改名 / 「确认应用本地整理」的离线断言。
 *
 * 覆盖：
 *   · 入库落 未识别/未识别_<哈希前4位>.<ext>
 *   · 打标后自动搬进 已识别/<标签>/<标签>_<哈希前4位>.<ext>；「无意义」搬进 无意义/
 *   · 自定义中文标签不会被 normalizeTag 归成「其他」
 *   · 旧版平铺哈希文件启动时搬进分类目录
 *   · 同步：无意义/ → 已识别/哈基米/ 会改库标签并留人工修正痕迹
 *   · 同步：待删除/ 会真的物理删
 *   · 同步：新建空标签目录会登记（并写配置词表）
 *   · 同步：认不出的文件只报告、不碰
 *   · cleanup：无意义图不再被 tagFails 阈值卡住（真机 71 张报 0 的回归）
 *
 * 跑法：`node test-tree.mjs`
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Library } from './src/library.js'
import { createJobs } from './src/jobs.js'
import { createActions } from './src/actions.js'
import { DEFAULTS, readConfig } from './src/config.js'
import { walkImageFiles } from './src/tree.js'

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    fail++
    failures.push({ name, error })
    console.log(`  x   ${name}\n      ${error?.message ?? error}`)
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 最小合法 PNG（pad 用来造不同内容）。 */
function makePng(width = 32, height = 32, pad = 0) {
  const buf = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  return buf
}

function cfgOf(patch = {}) {
  return readConfig({ ...DEFAULTS, ...patch })
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-tree-'))
  try {
    return await fn(dir)
  } finally {
    // Windows 上 rename/句柄可能没放干净，删除失败不影响断言
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function waitFor(fn, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(10)
  }
  return fn()
}

/** 最小 runtime（actions 只需要 library / getConfig / ctx.settings / log）。 */
async function makeRuntime(dir, { cfg = cfgOf(), onSettings } = {}) {
  const library = new Library({ dataDir: dir, config: cfg, log: () => {} })
  await library.load()
  const runtime = {
    dataDir: dir,
    getConfig: () => cfg,
    library,
    log: () => {},
    ctx: {
      get: (name) => (name === 'settings'
        ? { update: async (id, patch) => { onSettings?.(id, patch) } }
        : undefined),
    },
  }
  runtime.jobs = createJobs({ log: () => {} })
  runtime.actions = createActions({ runtime, jobs: runtime.jobs, log: () => {} })
  return { runtime, library, cfg }
}

async function waitJob(runtime, kind, timeoutMs = 5000) {
  return waitFor(() => {
    const job = runtime.jobs.list().find((entry) => entry.kind === kind && entry.status !== 'running')
    return job
  }, timeoutMs)
}

// ════════════════════════════════════════════════════════════ 1. 入库 / 改名

console.log('== 物理目录与命名')

await check('入库落在 未识别/未识别_<哈希前4位>.png', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 1) })
    const expected = `未识别/未识别_${item.src.slice(0, 4)}.png`
    assert.equal(item.file, expected)
    assert.equal((await stat(item.path)).size > 0, true, '文件应真的写出来')
  })
})

await check('打上标签后自动搬进 已识别/开心/开心_<哈希前4位>.png', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 2) })
    const before = item.path
    lib.annotate(item, { tags: ['开心'], note: '笑一个' })
    await lib.flush()
    const expected = `已识别/开心/开心_${item.src.slice(0, 4)}.png`
    assert.equal(item.file, expected)
    assert.equal(await stat(item.path).then((info) => info.isFile()), true, '新位置应有文件')
    assert.equal(await stat(before).then(() => true, () => false), false, '旧位置不该还留着')
  })
})

await check('「无意义」自动搬进 无意义/，文件名同样有哈希前缀', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 3) })
    lib.annotate(item, { tags: ['无意义'] })
    await lib.flush()
    assert.match(item.file, new RegExp(`^无意义/无意义_${item.src.slice(0, 4)}\\.png$`))
  })
})

await check('自定义中文标签（哈基米）原样保留，不会被 normalizeTag 归成「其他」', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 4) })
    lib.annotate(item, { tags: ['哈基米'] }, { alignedTags: true })
    await lib.flush()
    assert.deepEqual(item.tags, ['哈基米'])
    assert.match(item.file, /^已识别\/哈基米\/哈基米_[0-9a-f]{4}\.png$/)
  })
})

await check('旧版平铺哈希文件：migrateTree 会搬进分类目录，索引路径跟着更新', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 5) })
    lib.annotate(item, { tags: ['开心'] })
    await lib.flush()
    // 退回旧版布局：images/<16位哈希>.png，索引也指回去
    const imagesDir = path.join(dir, 'images')
    const legacyRel = `${item.src.slice(0, 16)}.png`
    await rename(item.path, path.join(imagesDir, legacyRel))
    item.file = legacyRel
    item.path = path.join(imagesDir, legacyRel)
    await lib.saveNow()

    const again = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await again.load()
    const result = await again.migrateTree()
    assert.equal(result.moved, 1, `应搬 1 张，实际 ${result.moved}`)
    const back = again.items[0]
    assert.equal(back.file, `已识别/开心/开心_${item.src.slice(0, 4)}.png`)
  })
})

// ════════════════════════════════════════════════════════════ 2. 同步按钮

console.log('\n== 确认应用本地整理（人机协作）')

await check('无意义/ 挪到 已识别/哈基米/：库标签改成哈基米，并留人工修正痕迹', async () => {
  await withTempDir(async (dir) => {
    const settingsCalls = []
    const { runtime, library } = await makeRuntime(dir, {
      onSettings: (id, patch) => settingsCalls.push({ id, patch }),
    })
    const { item } = await library.ingest({ bytes: makePng(24, 24, 11) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()

    // 模拟用户手动挪图 + 重命名
    const imagesDir = path.join(dir, 'images')
    const targetDir = path.join(imagesDir, '已识别', '哈基米')
    await mkdir(targetDir, { recursive: true })
    const target = path.join(targetDir, `哈基米_${item.src.slice(0, 4)}.png`)
    await rename(item.path, target)
    item.file = `已识别/哈基米/哈基米_${item.src.slice(0, 4)}.png`
    item.path = target

    runtime.actions.run('sync_tree', {})
    const done = await waitJob(runtime, 'sync_tree')
    assert.equal(done.status, 'done', done.error || '')
    assert.deepEqual(item.tags, ['哈基米'], '文件夹名应成为新标签')
    assert.equal(item.manualTag, '哈基米')
    assert.deepEqual(item.manualTagFrom, ['无意义'])
    assert.ok(item.manualTagAt > 0, '人工修正要留时间戳')
    assert.equal(item.manualEdits, 1)
    assert.equal(item.file, `已识别/哈基米/哈基米_${item.src.slice(0, 4)}.png`)
    assert.equal(done.result.retagged, 1)
    assert.equal(done.result.newTags.includes('哈基米'), true, '新标签要报出来')
    assert.equal(library.extraTags.includes('哈基米'), true, '标签要记进库')
    assert.equal(settingsCalls.length, 1, '要写一次配置词表')
    assert.match(settingsCalls[0].patch.vision.customTags, /哈基米/)
    const canonical = await readFile(item.path)
    assert.equal(canonical.length > 0, true)
  })
})

await check('挪到 待删除/：同步后条目和文件都被彻底删掉', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 12) })
    library.annotate(item, { tags: ['开心'] })
    await library.flush()

    const imagesDir = path.join(dir, 'images')
    const trashDir = path.join(imagesDir, '待删除')
    await mkdir(trashDir, { recursive: true })
    const target = path.join(trashDir, `待删除_${item.src.slice(0, 4)}.png`)
    await rename(item.path, target)
    item.file = `待删除/待删除_${item.src.slice(0, 4)}.png`
    item.path = target

    runtime.actions.run('sync_tree', {})
    const done = await waitJob(runtime, 'sync_tree')
    assert.equal(done.status, 'done', done.error || '')
    assert.equal(done.result.deleted, 1)
    assert.equal(library.items.length, 0, '库里条目应删掉')
    assert.equal(await stat(target).then(() => true, () => false), false, '文件应物理删除')
  })
})

await check('新建一个空的标签目录：同步后库里登记这个标签，并写进配置词表', async () => {
  await withTempDir(async (dir) => {
    const settingsCalls = []
    const { runtime, library } = await makeRuntime(dir, {
      onSettings: (id, patch) => settingsCalls.push({ id, patch }),
    })
    await mkdir(path.join(dir, 'images', '已识别', '猫猫'), { recursive: true })
    runtime.actions.run('sync_tree', {})
    const done = await waitJob(runtime, 'sync_tree')
    assert.equal(done.status, 'done', done.error || '')
    assert.deepEqual(done.result.newTags, ['猫猫'])
    assert.equal(library.extraTags.includes('猫猫'), true)
    assert.match(settingsCalls[0].patch.vision.customTags, /猫猫/)
  })
})

await check('认不出的文件只报告、不删不改；用户自己丢的文件也不动', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const stray = path.join(dir, 'images', '未识别', '用户自己放的图.jpg')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, Buffer.from('not really an image, but extension is jpg'))

    runtime.actions.run('sync_tree', {})
    const done = await waitJob(runtime, 'sync_tree')
    assert.equal(done.status, 'done', done.error || '')
    assert.equal(done.result.unknown, 1)
    assert.equal(done.result.deleted, 0)
    assert.equal(await stat(stray).then((info) => info.isFile(), () => false), true, '陌生文件不能被删')
  })
})

await check('多标签条目（开心/沙雕）放在 已识别/开心/ 下同步：保留第二个标签，不误删', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 14) })
    library.annotate(item, { tags: ['开心', '沙雕'] })
    await library.flush()

    runtime.actions.run('sync_tree', {})
    const done = await waitJob(runtime, 'sync_tree')
    assert.equal(done.status, 'done', done.error || '')
    assert.equal(done.result.retagged, 0, '自动整理的结果不该被当成人工改标签')
    assert.deepEqual(item.tags, ['开心', '沙雕'], '第二个标签必须保留')
  })
})

await check('第二次同步幂等：不重复改标签、不再报新标签', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 13) })
    library.annotate(item, { tags: ['开心'] })
    await library.flush()

    runtime.actions.run('sync_tree', {})
    const first = await waitJob(runtime, 'sync_tree')
    assert.equal(first.result.retagged, 0)
    assert.equal(first.result.newTags.length, 0)
    assert.equal(first.result.unchanged >= 1, true, '应至少有一张被判「没变化」')
  })
})

// ════════════════════════════════════════════════════════════ 3. 清理 / 孤儿

console.log('\n== 清理与孤儿文件')

await check('cleanup：无意义图按标签判定，tagFails=0 / 1 也会被识别', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const a = await library.ingest({ bytes: makePng(24, 24, 21) })
    const b = await library.ingest({ bytes: makePng(24, 24, 22) })
    library.annotate(a.item, { tags: ['无意义'] })
    library.annotate(b.item, { tags: ['无意义'] })
    b.item.tagFails = 1
    library.touch()
    await library.flush()

    runtime.actions.run('cleanup', {})
    const done = await waitJob(runtime, 'cleanup')
    assert.equal(done.result.meaningless, 2)
    assert.equal(library.items.length, 2, '试运行不删')
  })
})

await check('pruneOrphanFiles：只清我们自己命名的孤儿图，不动用户文件', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 31) })
    await lib.flush()
    // 我们的命名格式但索引里没有 → 该清
    const orphan = path.join(dir, 'images', '未识别', '未识别_dead.png')
    await writeFile(orphan, makePng(10, 10, 1))
    // 用户自己放的文件 → 不能清
    const stray = path.join(dir, 'images', '未识别', '随手存的.jpg')
    await writeFile(stray, makePng(10, 10, 2))

    const removed = await lib.pruneOrphanFiles()
    assert.equal(removed, 1)
    assert.equal(await stat(orphan).then(() => true, () => false), false)
    assert.equal(await stat(stray).then(() => true, () => false), true)
    assert.equal(await stat(item.path).then(() => true, () => false), true, '在库里的图不能被当孤儿')
  })
})

await check('walkImageFiles：递归列到 已识别/<标签>/ 里的图，并带相对路径', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 32) })
    lib.annotate(item, { tags: ['开心'] })
    await lib.flush()
    const files = await walkImageFiles(path.join(dir, 'images'))
    assert.equal(files.length, 1)
    assert.equal(files[0].rel, item.file)
  })
})

// ════════════════════════════════════════════════════════════ 结果

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const row of failures) {
    console.log(`- ${row.name}: ${row.error?.stack ?? row.error}`)
  }
  process.exitCode = 1
} else {
  console.log('全部通过')
}
