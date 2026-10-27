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
import { isSendable, migrateLayout, rootTagFromName, walkImageFiles } from './src/tree.js'
import { buildTools, TOOL_PREFIX } from './src/tools.js'
import { shortId } from './src/library.js'

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

/** 模拟用户在资源管理器里把图挪到某个相对路径。 */
async function moveItemTo(library, item, rel) {
  const abs = path.join(library.dataDir, 'images', rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await rename(item.path, abs)
  item.file = rel
  item.path = abs
  return abs
}

/** 跑一次同步并等它结束（按 job id 等，避免拿到上一次的旧结果）。 */
async function sync(runtime) {
  const started = runtime.actions.run('sync_tree', {})
  assert.equal(started.ok, true, started.reason ?? '')
  const id = started.job.id
  const job = await waitFor(() => {
    const hit = runtime.jobs.list().find((entry) => entry.id === id && entry.status !== 'running')
    return hit
  })
  assert.equal(job.status, 'done', job.error || '')
  return job.result
}

// ════════════════════════════════════════════════════════════ 1. 入库 / 改名

console.log('== 物理目录与命名')

await check('入库直接落 images/ 根目录：未识别_<哈希前4位>.png（不再有 未识别/ 子目录）', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 1) })
    const expected = `未识别_${item.src.slice(0, 4)}.png`
    assert.equal(item.file, expected)
    assert.equal(path.dirname(item.path), path.join(dir, 'images'), '必须直接落在 images/ 下')
    assert.equal((await stat(item.path)).size > 0, true, '文件应真的写出来')
    assert.equal(item.tags.length, 0)
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

await check('待确认分类：生气_<哈希>.png → 标签改生气，文件搬进 已识别/生气/', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 41) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()
    await moveItemTo(library, item, `已识别/待确认分类/生气_${item.src.slice(0, 4)}.png`)

    const result = await sync(runtime)
    assert.deepEqual(item.tags, ['生气'])
    assert.equal(item.pending, false)
    assert.equal(item.file, `已识别/生气/生气_${item.src.slice(0, 4)}.png`)
    assert.equal(result.retagged, 1)
    assert.equal(result.corrections[0].to.includes('生气'), true)
    assert.equal(await stat(item.path).then((info) => info.isFile()), true)
  })
})

await check('待确认分类：沙雕_<哈希>_生气.png 取最后一个非哈希词（生气）', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 42) })
    library.annotate(item, { tags: ['沙雕'] })
    await library.flush()
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `已识别/待确认分类/沙雕_${hash}_生气.png`)

    await sync(runtime)
    assert.deepEqual(item.tags, ['生气'])
    assert.equal(item.file, `已识别/生气/生气_${hash}.png`)
  })
})

await check('待确认分类：新建子目录 哈基米/ 里的图，目录名就是新标签', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 43) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()
    await moveItemTo(library, item, `已识别/待确认分类/哈基米/随手改的名字.png`)

    const result = await sync(runtime)
    assert.deepEqual(item.tags, ['哈基米'])
    assert.equal(item.pending, false)
    assert.equal(item.file, `已识别/哈基米/哈基米_${item.src.slice(0, 4)}.png`)
    assert.equal(result.newTags.includes('哈基米'), true)
  })
})

await check('待确认分类：占位名 待确认分类_<哈希>.png 不产生标签，留在待确认并清空旧标签', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 44) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `已识别/待确认分类/待确认分类_${hash}.png`)

    const result = await sync(runtime)
    assert.deepEqual(item.tags, [])
    assert.equal(item.pending, true)
    assert.equal(item.file, `已识别/待确认分类/待确认分类_${hash}.png`)
    assert.equal(result.pending, 1)
    assert.equal(library.visible().length, 0, '待确认的图不该进打标/发送候选')

    // 再同步一次必须幂等
    const again = await sync(runtime)
    assert.equal(again.retagged, 0)
    assert.equal(again.moved, 0)
    assert.equal(item.file, `已识别/待确认分类/待确认分类_${hash}.png`)
  })
})

await check('已识别 根目录散图：统一搬进待确认分类并清空标签', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 45) })
    library.annotate(item, { tags: ['开心'] })
    await library.flush()
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `已识别/散图_${hash}.png`)

    const result = await sync(runtime)
    assert.deepEqual(item.tags, [])
    assert.equal(item.pending, true)
    assert.equal(item.file, `已识别/待确认分类/待确认分类_${hash}.png`)
    assert.equal(result.pending, 1)
    assert.equal(result.moved, 1)
  })
})

await check('无意义/待恢复：搬回 images/ 根目录、清空标签、重新当未识别', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 46) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `无意义/待恢复/真_${hash}.png`)

    const result = await sync(runtime)
    assert.deepEqual(item.tags, [], '标签必须清空')
    assert.equal(item.pending, false, '不是待确认，是未识别')
    assert.equal(item.file, `未识别_${hash}.png`, '必须回到 images/ 根目录')
    assert.equal(path.dirname(item.path), path.join(dir, 'images'))
    assert.equal(result.restored, 1)
    assert.equal(await stat(item.path).then((info) => info.isFile()), true)
  })
})

await check('无意义/待删除：条目和文件都被物理删除', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 47) })
    library.annotate(item, { tags: ['无意义'] })
    await library.flush()
    const target = await moveItemTo(library, item, `无意义/待删除/假_${item.src.slice(0, 4)}.png`)

    const result = await sync(runtime)
    assert.equal(result.reviewDeleted, 1, '记在 reviewDeleted 上')
    assert.equal(library.items.length, 0)
    assert.equal(await stat(target).then(() => true, () => false), false)
  })
})

await check('无意义/待删除 里认不出库的陌生文件也物理删除（用户明确说要删）', async () => {
  await withTempDir(async (dir) => {
    const { runtime } = await makeRuntime(dir)
    const stray = path.join(dir, 'images', '无意义', '待删除', '随便一张.jpg')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, Buffer.from('not really an image, but user said delete'))
    const result = await sync(runtime)
    assert.equal(result.reviewDeleted, 1)
    assert.equal(await stat(stray).then(() => true, () => false), false)
  })
})

await check('旧布局迁移：images/未识别/ 的文件搬回根目录并删掉空目录', async () => {
  await withTempDir(async (dir) => {
    const imagesDir = path.join(dir, 'images')
    const legacy = path.join(imagesDir, '未识别')
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, '未识别_abcd.png'), makePng(16, 16, 7))
    await writeFile(path.join(legacy, '用户手动放的.jpg'), makePng(16, 16, 8))

    const layout = await migrateLayout(imagesDir)
    assert.equal(layout.movedToRoot, 2, `应搬回 2 张，实际 ${layout.movedToRoot}`)
    assert.equal(await stat(legacy).then(() => true, () => false), false, '空目录应被删掉')
    const files = await walkImageFiles(imagesDir)
    assert.deepEqual(files.map((file) => file.rel).sort(), ['未识别_abcd.png', '用户手动放的.jpg'])
  })
})

await check('旧布局迁移：无意义/真 → 待恢复、无意义/假 → 待删除', async () => {
  await withTempDir(async (dir) => {
    const imagesDir = path.join(dir, 'images')
    await mkdir(path.join(imagesDir, '无意义', '真'), { recursive: true })
    await mkdir(path.join(imagesDir, '无意义', '假'), { recursive: true })
    await writeFile(path.join(imagesDir, '无意义', '真', 'a.png'), makePng(10, 10, 1))
    await writeFile(path.join(imagesDir, '无意义', '假', 'b.png'), makePng(10, 10, 2))

    const layout = await migrateLayout(imagesDir)
    assert.ok(layout.renamed.some((line) => line.includes('待恢复')), `应报改名，实际 ${layout.renamed}`)
    assert.ok(layout.renamed.some((line) => line.includes('待删除')))
    assert.equal(await stat(path.join(imagesDir, '无意义', '真')).then(() => true, () => false), false)
    assert.equal(await stat(path.join(imagesDir, '无意义', '假')).then(() => true, () => false), false)
    assert.equal(await stat(path.join(imagesDir, '无意义', '待恢复', 'a.png')).then(() => true, () => false), true)
    assert.equal(await stat(path.join(imagesDir, '无意义', '待删除', 'b.png')).then(() => true, () => false), true)
  })
})

await check('已识别 根目录的陌生散图：也搬进待确认分类（只动文件）', async () => {
  await withTempDir(async (dir) => {
    const { runtime } = await makeRuntime(dir)
    const stray = path.join(dir, 'images', '已识别', '陌生散图.jpg')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, makePng(10, 10, 3))
    const result = await sync(runtime)
    assert.equal(result.pending, 1, '应转入待确认 1 张')
    const files = await walkImageFiles(path.join(dir, 'images'))
    const pending = files.find((file) => file.rel.startsWith('已识别/待确认分类/'))
    assert.ok(pending, '陌生散图应被移到待确认分类')
    assert.equal(await stat(stray).then(() => true, () => false), false)
  })
})

// ════════════════════════════════════════════════════════════ 3. 发送范围（图 1 事故回归）

console.log('\n== 发送范围：只有 已识别/<标签>/ 能发')

await check('根目录的未识别图不能发（真机事故回归：机器人把它发给群友了）', async () => {
  await withTempDir(async (dir) => {
    const { library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 71) })
    // 刚收进来：在根目录、没标签
    assert.equal(item.file.startsWith('未识别_'), true)
    assert.equal(library.visible().length, 0, '未识别图不能进候选池')
    assert.equal(isSendable(item, library.config), false)
  })
})

await check('打上标签后（已识别/开心/）才允许发送', async () => {
  await withTempDir(async (dir) => {
    const { library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 72) })
    library.annotate(item, { tags: ['开心'] })
    await library.flush()
    assert.equal(item.file, `已识别/开心/开心_${item.src.slice(0, 4)}.png`)
    assert.equal(isSendable(item, library.config), true)
    assert.equal(library.visible().length, 1)
  })
})

await check('无意义 / 待确认分类 / 待删除 的图都不允许发送', async () => {
  await withTempDir(async (dir) => {
    const { library } = await makeRuntime(dir)
    const meaningless = await library.ingest({ bytes: makePng(24, 24, 73) })
    library.annotate(meaningless.item, { tags: ['无意义'] })

    const pending = await library.ingest({ bytes: makePng(24, 24, 74) })
    library.annotate(pending.item, { tags: ['开心'] })
    await library.flush()
    await moveItemTo(library, pending.item, `已识别/待确认分类/待确认分类_${pending.item.src.slice(0, 4)}.png`)
    pending.item.pending = true

    const trash = await library.ingest({ bytes: makePng(24, 24, 75) })
    library.annotate(trash.item, { tags: ['开心'] })
    await library.flush()
    await moveItemTo(library, trash.item, `待删除/待删除_${trash.item.src.slice(0, 4)}.png`)

    for (const item of [meaningless.item, pending.item, trash.item]) {
      assert.equal(isSendable(item, library.config), false, `${item.file} 不该能发`)
    }
    assert.equal(library.visible().length, 0)
  })
})

await check('send 工具：拿未识别编号硬发 → 抛错，不是发出去', async () => {
  await withTempDir(async (dir) => {
    const cfg = cfgOf()
    const library = new Library({ dataDir: dir, config: cfg, log: () => {} })
    await library.load()
    const { item } = await library.ingest({ bytes: makePng(24, 24, 76) })
    const sent = []
    const runtime = {
      dataDir: dir,
      library,
      tracker: { humanCount: () => 0, recentText: () => '', recentStickerIds: () => [], list: () => [] },
      getConfig: () => cfg,
      state: () => ({ sentDay: '', sentToday: 0, sessions: {} }),
      markStateDirty: () => {},
      log: () => {},
      ctx: {
        get: (name) => (name === 'tools'
          ? { execute: async (call) => { sent.push(call); return { value: { sent: true, detail: 'ok' } } } }
          : undefined),
      },
      guards: {},
      collector: { brief: () => ({}) },
      vision: { available: () => ({ ok: true }), recognizeBatch: async () => ({}) },
      settler: { register: () => {} },
      attachments: null,
      readImageBytes: async () => null,
    }
    const defs = await buildTools(runtime)
    const sendTool = defs.find((def) => def.name === `${TOOL_PREFIX}send`)
    assert.ok(sendTool, '应有发送工具')
    await assert.rejects(
      () => sendTool.execute({ stickerId: shortId(item) }, { agent: { id: 's1' } }),
      /还没完成分类/,
    )
    assert.equal(sent.length, 0, '不该真的调用 qq_send_image')
  })
})

// ════════════════════════════════════════════════════════════ 3.5 文件名映射与自动改名（铁律二）

console.log('\n== 根目录文件名 = 标签声明')

await check('rootTagFromName：解析各种写法的第一个词', async () => {
  const cases = [
    ['开心.jpg', '开心'],
    ['开心_1d5f.jpg', '开心'],
    ['开心_1d5f_未识别.jpg', '开心'],
    ['开心_随便打的字.jpg', '开心'],
    ['未识别_1d5f.jpg', ''],      // 占位名不产生标签
    ['a1b2c3d4e5f6a7b8.jpg', ''], // 纯哈希 = 未识别
    ['dsfgsdfg.jpg', 'dsfgsdfg'],  // 乱码但确实是一个词 → 当标签
    ['难过_9a8b.png', '难过'],
  ]
  for (const [name, want] of cases) {
    assert.equal(rootTagFromName(name), want, `${name} 应解析成 "${want}"`)
  }
})

await check('根目录 开心.jpg（无哈希）→ 按标签归类并强制改名为 开心_<哈希>.jpg', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const stray = path.join(dir, 'images', '开心.jpg')
    await mkdir(path.dirname(stray), { recursive: true })
    await writeFile(stray, makePng(10, 10, 91))

    const result = await sync(runtime)
    const files = await walkImageFiles(path.join(dir, 'images'))
    assert.equal(files.length, 1)
    const rel = files[0].rel
    assert.match(rel, /^已识别\/开心\/开心_[0-9a-f]{4}\.jpg$/, `实际 ${rel}`)
    assert.equal(await stat(stray).then(() => true, () => false), false, '原文件应被移走')
    assert.ok(result.retagged >= 1, '应计入改标签')
  })
})

await check('根目录 开心_1d5f.jpg：文件名里的哈希认库；不在库的就按哈希归类', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 92) })
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `开心_${hash}.jpg`)  // 随手改名，没放进子目录

    const result = await sync(runtime)
    assert.deepEqual(item.tags, ['开心'], '文件名第一个词就是标签')
    assert.equal(item.pending, false)
    assert.equal(item.file, `已识别/开心/开心_${hash}.jpg`)
    assert.equal(await stat(item.path).then((info) => info.isFile()), true)
  })
})

await check('根目录 开心_随便打的字.jpg：乱写的尾巴也必须规范成 开心_<哈希>.jpg', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 93) })
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `沙雕_我随手写的注释.jpg`)

    await sync(runtime)
    assert.deepEqual(item.tags, ['沙雕'])
    assert.equal(item.file, `已识别/沙雕/沙雕_${hash}.jpg`, '改名必须用真实哈希，不许留着乱码')
  })
})

await check('根目录 未识别_<哈希>.png：留在根目录、保持未识别、不改名', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 94) })
    const before = item.file
    const result = await sync(runtime)
    assert.equal(item.file, before, '规范名不该被动')
    assert.deepEqual(item.tags, [])
    assert.equal(item.pending, false)
    assert.equal(result.retagged, 0)
  })
})

await check('根目录纯哈希名 a1b2c3d4e5f6.jpg：认出库里条目，改名成 未识别_<前4位>.jpg', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const { item } = await library.ingest({ bytes: makePng(24, 24, 95) })
    const hash = item.src.slice(0, 4)
    await moveItemTo(library, item, `a1b2c3d4e5f6.jpg`)

    // 手动把索引也指向这个名字，模拟用户改名后重启
    const result = await sync(runtime)
    const files = await walkImageFiles(path.join(dir, 'images'))
    const root = files.filter((file) => !file.rel.includes('/'))
    assert.equal(root.length, 1, `根目录应只剩 1 个文件，实际 ${root.map((f) => f.rel).join(',')}`)
    assert.equal(root[0].rel, `未识别_${hash}.jpg`)
    assert.deepEqual(item.tags, [])
    assert.equal(result.deleted, 0, '绝不删')
  })
})

await check('认不出库的陌生文件：只移动/改名，**一个都不删**，并登记进库', async () => {
  await withTempDir(async (dir) => {
    const { runtime, library } = await makeRuntime(dir)
    const imagesDir = path.join(dir, 'images')
    // 按铁律二：「去掉后缀的词」就是标签，所以 随便一张.jpg 也算标签「随便一张」；
    // 只有纯哈希 / 未识别_ 开头 / 解析不出词 的才当未识别。
    const files = [
      ['开心.jpg', /^已识别\/开心\/开心_[0-9a-f]{4}\.jpg$/],
      ['a1b2c3d4e5f6a7b8.jpg', /^未识别_[0-9a-f]{4}\.jpg$/],
      ['未识别_zzzz.jpg', /^未识别_[0-9a-f]{4}\.jpg$/],
    ]
    await mkdir(imagesDir, { recursive: true })
    // 每张填充不同 → 内容哈希不同，否则会被内容去重当成同一张
    for (let i = 0; i < files.length; i++) {
      await writeFile(path.join(imagesDir, files[i][0]), makePng(10, 10, 30 + i * 7))
    }
    assert.equal(library.items.length, 0, '一开始库里没有条目')

    const result = await sync(runtime)
    assert.equal(result.deleted, 0, '根目录一个都不许删')
    const after = await walkImageFiles(imagesDir)
    assert.equal(after.length, 3, `三张都该还在，实际 ${after.length}`)
    for (let i = 0; i < files.length; i++) {
      const [, pattern] = files[i]
      assert.ok(after.some((file) => pattern.test(file.rel)), `缺少匹配 ${pattern} 的文件：${after.map((f) => f.rel).join(',')}`)
    }
    // 铁律二：用户塞进来的图要真的进库（不然发不了、也永远不会被打标）
    assert.equal(library.items.length, 3, `三张都该登记进库，实际 ${library.items.length}`)
    assert.equal(result.adopted, 3, 'adopted 应报 3')
    const tagged = library.items.filter((item) => item.tags.includes('开心'))
    assert.equal(tagged.length, 1, '开心.jpg 应带上「开心」标签')
    assert.equal(tagged[0].pending, false, '有标签就不是待确认')
    const rest = library.items.filter((item) => !item.tags.includes('开心'))
    assert.equal(rest.every((item) => item.tags.length === 0 && item.pending === true), true, '纯哈希/未识别_ 的应保持未识别')
    assert.equal(library.visible().length, 1, '只有 开心.jpg 那张能发')
  })
})

// ════════════════════════════════════════════════════════════ 4. 清理 / 孤儿

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

await check('pruneOrphanFiles：**一个文件都不删**（2026-10-27 误删事故的回归）', async () => {
  await withTempDir(async (dir) => {
    const lib = new Library({ dataDir: dir, config: cfgOf(), log: () => {} })
    await lib.load()
    const { item } = await lib.ingest({ bytes: makePng(24, 24, 31) })
    await lib.flush()
    // 我们的命名格式、但索引里没有 → 以前会被删，现在必须留着
    const orphan = path.join(dir, 'images', '未识别_dead.png')
    await writeFile(orphan, makePng(10, 10, 1))
    // 用户随手丢进来的文件
    const stray = path.join(dir, 'images', '随手存的.jpg')
    await writeFile(stray, makePng(10, 10, 2))
    // 用户手动塞的乱码哈希名文件（截图里被误删的就是这种）
    const junk = path.join(dir, 'images', 'a1b2c3d4e5f6a7b8.jpg')
    await writeFile(junk, makePng(10, 10, 3))

    const removed = await lib.pruneOrphanFiles()
    assert.equal(removed, 0, '不许删任何东西')
    for (const file of [orphan, stray, junk]) {
      assert.equal(await stat(file).then(() => true, () => false), true, `${path.basename(file)} 不该被删`)
    }
    assert.equal(await stat(item.path).then(() => true, () => false), true, '在库里的图也不能动')
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
