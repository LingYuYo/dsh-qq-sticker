/**
 * test-panel-host.mjs —— 面板 Host 侧（jobs / actions / server）的离线断言。
 *
 * 覆盖 `sticker-ui-contract.md` §7.6 列出的全部点，**不联网、不碰真 DSH**：
 *   · jobs：立即可返回 running、同 kind 单飞、完成后 done + 进度满、抛错 → error、超 10 条丢最旧；
 *   · actions：clear 缺 confirm 拒绝、cleanup 默认试运行不动库、delete_oldest 保底留存、
 *     organize 用假 vision 按页调用并累计；
 *   · server：假 ctx 里注册出的路由与契约 §1/§2/§4/§5 一致、/state 含 jobs/limits、
 *     POST /action 跨站 403、未知 kind 400。
 *
 * 跑法：`node test-panel-host.mjs`
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createJobs } from './src/jobs.js'
import { createActions } from './src/actions.js'
import { registerRoutes, ROUTE_PREFIX } from './src/server.js'
import { DEFAULTS, readConfig } from './src/config.js'
import { Library } from './src/library.js'
import { emptyState } from './src/gate.js'
import { sha1 } from './src/util.js'

let pass = 0
let fail = 0
let skipped = 0
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

/** 最小合法 PNG（尺寸可控 + 填充字节区分不同图）。 */
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

/** 等一个条件（最多 timeoutMs），用于"任务跑到 done"。 */
async function waitFor(fn, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(10)
  }
  return fn()
}

/** 临时数据目录（用完删）。 */
const tempDirs = []
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-'))
  tempDirs.push(dir)
  try {
    return await fn(dir)
  } finally {
    /* 统一在文件末尾清理（避免 Windows 上删除时被占用） */
  }
}

/** 配置对象（与 index.js 里 getConfig() 同形）。 */
function cfgOf(patch = {}) {
  return readConfig({ ...DEFAULTS, ...patch })
}

// ════════════════════════════════════════════════════════════ 1. jobs

console.log('== jobs（契约 §3）')

await check('start 立即返回 running，不等 runner 跑完', async () => {
  const jobs = createJobs({ log: () => {} })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const started = jobs.start('demo', '演示任务', async () => { await gate; return { ok: true } })
  assert.equal(started.ok, true, 'start 应返回 ok:true')
  assert.equal(started.job.status, 'running', 'start 返回时状态必须是 running（不能 await runner）')
  assert.equal(started.job.kind, 'demo')
  assert.equal(started.job.label, '演示任务')
  assert.equal(started.job.endedAt, 0)
  assert.deepEqual(started.job.progress, { done: 0, total: 0, label: '' })
  assert.equal(started.job.result, null)
  assert.equal(started.job.error, null)
  assert.match(started.job.id, /^job-/, 'job.id 应形如 job-xxxxxx')
  release()
  await waitFor(() => jobs.list()[0].status === 'done')
})

await check('同 kind 二次 start → already-running（带 job），且只有一个在跑', async () => {
  const jobs = createJobs({ log: () => {} })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const first = jobs.start('organize', '一键整理打标', async () => { await gate; return {} })
  const second = jobs.start('organize', '一键整理打标', async () => ({}))
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-running')
  assert.equal(second.job.id, first.job.id, '应返回正在跑的那个 job')
  // 不同 kind 可以并行
  const other = jobs.start('report', '生成报表', async () => ({ report: 'ok' }))
  assert.equal(other.ok, true, '不同 kind 不该被单飞挡住')
  release()
  await waitFor(() => jobs.list().every((job) => job.status === 'done'))
})

await check('运行中 progress 回调生效；完成后 status=done、进度补满、result 落位', async () => {
  const jobs = createJobs({ log: () => {} })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  jobs.start('organize', '一键整理打标', async (progress) => {
    progress(1, 4, '已看 1/4 张')
    await sleep(5)
    progress(2, 4, '已看 2/4 张')
    await gate
    return { tried: 4, tagged: 2 }
  })
  const seen = await waitFor(() => {
    const job = jobs.list()[0]
    return job.progress.done === 2 ? job : undefined
  })
  assert.equal(seen.status, 'running', '进度回调期间任务应还是 running')
  assert.equal(seen.progress.label, '已看 2/4 张')
  release()
  const done = await waitFor(() => jobs.list()[0].status === 'done' && jobs.list()[0])
  assert.equal(done.status, 'done')
  assert.deepEqual(done.progress, { done: 4, total: 4, label: '已看 2/4 张' }, 'done 后 done 应补到 total')
  assert.deepEqual(done.result, { tried: 4, tagged: 2 })
  assert.equal(done.error, null)
  assert.ok(done.endedAt >= done.startedAt, 'endedAt 应有值且不早于 startedAt')
})

await check('runner 抛错 → status=error，error=message，不留 running', async () => {
  const jobs = createJobs({ log: () => {} })
  jobs.start('cleanup', '清理无意义图', async () => { throw new Error('磁盘炸了') })
  const done = await waitFor(() => jobs.list()[0].status === 'error' && jobs.list()[0])
  assert.equal(done.status, 'error')
  assert.equal(done.error, '磁盘炸了')
  assert.equal(done.result, null)
  // 错误任务不占单飞锁：同 kind 还能再起
  const again = jobs.start('cleanup', '清理无意义图', async () => ({ dryRun: true }))
  assert.equal(again.ok, true, '失败任务应释放单飞锁')
  await waitFor(() => jobs.list()[0].status === 'done')
})

await check('超过 10 条丢最旧（新在前）', async () => {
  const jobs = createJobs({ log: () => {} })
  const ids = []
  for (let index = 0; index < 11; index++) {
    const started = jobs.start(`kind-${index}`, `任务 ${index}`, async () => ({ index }))
    ids.push(started.job.id)
    await waitFor(() => jobs.list()[0].status !== 'running')
  }
  const list = jobs.list()
  assert.equal(list.length, 10, `列表最多留 10 条，实际 ${list.length}`)
  assert.equal(list[0].id, ids[10], '最新一条应在最前')
  assert.ok(!list.some((job) => job.id === ids[0]), '最旧的一条应被丢掉')
})

await check('get(id) 返回副本，改不到内部状态', async () => {
  const jobs = createJobs({ log: () => {} })
  const started = jobs.start('report', '生成报表', async () => ({ report: 'x' }))
  const found = jobs.get(started.job.id)
  assert.ok(found, 'get 应能按 id 找到')
  assert.equal(found.kind, 'report')
  found.status = 'done'
  assert.equal(jobs.list()[0].status, 'running', '改副本不能影响内部状态')
  assert.equal(jobs.get('job-nope'), undefined)
  await waitFor(() => jobs.list()[0].status === 'done')
})

// ════════════════════════════════════════════════════════════ 2. actions

console.log('\n== actions（契约 §4）')

/**
 * 造一个最小 runtime + 库。
 * @param {object} [options]
 * @param {object} [options.cfg] 配置
 * @param {(items:Array, opts:object)=>Promise<object>} [options.recognizeBatch] 假 vision
 */
async function makeRuntime({ cfg = cfgOf(), recognizeBatch, collector, library } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-rt-'))
  tempDirs.push(dir)
  const lib = library ?? new Library({ dataDir: dir, config: cfg })
  await lib.load()
  const state = emptyState()
  const visionCalls = []
  const runtime = {
    dataDir: dir,
    state: () => state,
    getConfig: () => cfg,
    library: lib,
    log: () => {},
    toolNames: [],
    vision: {
      available: () => ({ ok: true }),
      recognizeBatch: async (items, opts) => {
        visionCalls.push({ items: items.map((item) => sha1(Buffer.from(item.file))), opts })
        if (recognizeBatch) return recognizeBatch(items, opts)
        return { tried: items.length, tagged: items.length, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: Boolean(opts?.dryRun), errors: [] }
      },
    },
    collector: collector ?? {
      brief: () => ({ enabled: false, nextRunAt: 0 }),
      collectTopUsed: async () => ({ ok: true, considered: 3, collected: 1, already: 2, failed: 0, stopReason: '' }),
    },
    ingestor: { snapshot: () => ({ queued: 0, draining: false }) },
    settler: { snapshot: () => ({ pending: 0, lastBaseRewardAt: 0 }) },
  }
  runtime.jobs = createJobs({ log: () => {} })
  runtime.actions = createActions({ runtime, jobs: runtime.jobs, log: () => {} })
  return { runtime, lib, dir, visionCalls }
}

/** 等某个 kind 的任务结束（done 或 error），返回最终 job。 */
async function waitJob(runtime, kind) {
  const done = await waitFor(() => {
    const job = runtime.jobs.list().find((entry) => entry.kind === kind && entry.status !== 'running')
    return job
  })
  return done
}

await check('clear：缺 confirm 直接拒绝（同步抛 400），任务不启动', async () => {
  const { runtime, lib } = await makeRuntime()
  await lib.ingest({ bytes: makePng(24, 24) })
  // actions.run 是**同步**抛（server 再转 400），所以用 assert.throws 而不是 rejects
  assert.throws(() => runtime.actions.run('clear', {}), (error) => {
    assert.match(error.message, /清空库需要二次确认/)
    assert.equal(error.statusCode, 400, '应带 statusCode=400 让 server 直接转 400')
    return true
  })
  assert.throws(() => runtime.actions.run('clear', { confirm: 'clear' }), /清空库需要二次确认/, '小写 confirm 也要拒绝')
  assert.throws(() => runtime.actions.run('clear', { confirm: 1 }), /清空库需要二次确认/, '非字符串 confirm 也要拒绝')
  assert.equal(runtime.jobs.list().length, 0, '被拒绝的 clear 不该产生任务')
  assert.equal(lib.items.length, 1, '库里那张图不该被动')
})

await check('clear：confirm="CLEAR" 才真的清空（逐条删 + prune + flush）', async () => {
  const { runtime, lib, dir } = await makeRuntime()
  for (let index = 0; index < 3; index++) await lib.ingest({ bytes: makePng(24, 24, index + 1) })
  assert.equal(lib.items.length, 3)
  const started = runtime.actions.run('clear', { confirm: 'CLEAR' })
  assert.equal(started.ok, true)
  assert.equal(started.job.status, 'running', '清空也是异步 job（契约要求所有动作走 jobs）')
  const done = await waitJob(runtime, 'clear')
  assert.equal(done.status, 'done')
  assert.deepEqual(
    { removed: done.result.removed, failed: done.result.failed, after: done.result.after },
    { removed: 3, failed: 0, after: 0 },
  )
  assert.equal(lib.items.length, 0, '库应清空')
  assert.equal(done.progress.total, 3, 'progress.total 应是清空前的条数')
  const { readdir } = await import('node:fs/promises')
  const images = await readdir(path.join(dir, 'images'))
  assert.deepEqual(images, [], `images/ 目录应清空，实际还有 ${images.join(',')}`)
})

await check('cleanup：默认 dryRun=true（只报告，不动库）', async () => {
  const { runtime, lib } = await makeRuntime()
  const { shortId } = await import('./src/library.js')
  const ingested = []
  for (let index = 0; index < 3; index++) ingested.push(await lib.ingest({ bytes: makePng(24, 24, index + 11) }))
  // 造一张「无意义且达标」的图 → 应被 cleanup 算进 meaningless
  const victim = ingested[0].item
  lib.annotate(victim, { tags: ['无意义'] })
  victim.tagFails = 2
  lib.touch()
  const before = lib.items.length
  const bytesBefore = lib.totalBytes()
  runtime.actions.run('cleanup', {})
  const done = await waitJob(runtime, 'cleanup')
  assert.equal(done.status, 'done')
  assert.equal(done.result.dryRun, true, '默认必须是试运行')
  assert.equal(done.result.meaningless, 1, `dryRun 应报出 1 张无意义，实际 ${done.result.meaningless}`)
  assert.ok(done.result.detail.includes('要删的是这些'), 'dryRun 的 detail 应列出将删的编号')
  assert.equal(lib.items.length, before, '试运行不能删任何东西')
  assert.equal(lib.totalBytes(), bytesBefore, '试运行不能释放任何字节')
  assert.equal(done.progress.total, before, 'cleanup 的 progress.total = 库条目数')
  assert.ok(done.progress.done > 0, 'cleanup 要逐条报进度')
  void shortId
})

await check('cleanup：dryRun=false 才真删，并在 result.after 反映新条数', async () => {
  const { runtime, lib } = await makeRuntime()
  const ingested = []
  for (let index = 0; index < 3; index++) ingested.push(await lib.ingest({ bytes: makePng(24, 24, index + 21) }))
  const victim = ingested[1].item
  lib.annotate(victim, { tags: ['无意义'] })
  victim.tagFails = 2
  lib.touch()
  runtime.actions.run('cleanup', { dryRun: false })
  const done = await waitJob(runtime, 'cleanup')
  assert.equal(done.status, 'done')
  assert.equal(done.result.dryRun, false)
  assert.equal(lib.items.length, 2, `应真的删掉 1 张，实际剩 ${lib.items.length}`)
  assert.equal(done.result.after, 2, 'result.after 应是删完后的条数')
  assert.ok(done.result.freedMB >= 0)
})

await check('delete_oldest：保底留存生效（库不够时最多删到 keep）', async () => {
  const cfg = cfgOf({ maintenance: { ...DEFAULTS.maintenance, deleteOldestKeep: 3, deleteOldestCount: 25 } })
  const { runtime, lib } = await makeRuntime({ cfg })
  for (let index = 0; index < 5; index++) await lib.ingest({ bytes: makePng(24, 24, index + 31) })
  assert.equal(lib.items.length, 5)
  runtime.actions.run('delete_oldest', { count: 5 })
  const done = await waitJob(runtime, 'delete_oldest')
  assert.equal(done.status, 'done')
  assert.equal(done.result.deleted, 2, `保底留存 3 张 → 5 张里最多删 2 张，实际删了 ${done.result.deleted}`)
  assert.equal(lib.items.length, 3, '库里应剩 3 张（kept）')
  assert.equal(done.result.kept, 3)
  assert.ok(done.result.detail.includes('保底留存'), `detail 应说明保底：${done.result.detail}`)
  assert.equal(done.result.ids.length, 2, 'ids 应列出删掉的编号')
})

await check('delete_oldest：dryRun=true 只报不删（真有可删目标时也不动手）', async () => {
  // keep=0 才让 3 张里真有 2 张可删 —— 否则默认 keep=10 会让 victims 空掉，用例变成假通过
  const cfg = cfgOf({ maintenance: { ...DEFAULTS.maintenance, deleteOldestKeep: 0 } })
  const { runtime, lib } = await makeRuntime({ cfg })
  for (let index = 0; index < 3; index++) await lib.ingest({ bytes: makePng(24, 24, index + 41) })
  runtime.actions.run('delete_oldest', { count: 2, dryRun: true })
  const done = await waitJob(runtime, 'delete_oldest')
  assert.equal(done.result.dryRun, true)
  assert.equal(done.result.deleted, 2, '试运行也要如实报「会删 2 张」')
  assert.equal(done.result.ids.length, 2, '试运行也要列出会删哪些')
  assert.equal(lib.items.length, 3, '试运行不能删（库仍是 3 张）')
})

await check('organize：假 vision 按 page 调用并累计结果', async () => {
  const cfg = cfgOf({ vision: { ...DEFAULTS.vision, organizeBatchSize: 2 } })
  const rows = []
  const { runtime, lib, visionCalls } = await makeRuntime({
    cfg,
    recognizeBatch: async (items, opts) => {
      rows.push({ count: items.length, dryRun: opts?.dryRun })
      return {
        tried: items.length,
        tagged: items.length,
        meaningless: 0,
        failures: 0,
        deleted: [],
        suspicious: false,
        dryRun: Boolean(opts?.dryRun),
        errors: [],
      }
    },
  })
  for (let index = 0; index < 5; index++) await lib.ingest({ bytes: makePng(24, 24, index + 51) })
  // 5 张都是「无标签/备注/文字」→ 全部是候选
  runtime.actions.run('organize', { limit: 5 })
  // runner 在微任务里跑：total 要等它自己报第一句「准备识别 N 张」才有，不能同步断言
  const withTotal = await waitFor(() => {
    const job = runtime.jobs.list()[0]
    return job.progress.total > 0 ? job : undefined
  })
  assert.equal(withTotal.progress.total, 5, 'organize 应先把候选总数报进 progress.total')
  const done = await waitJob(runtime, 'organize')
  assert.equal(done.status, 'done')
  // page 大小 2 → 5 张分 3 页（2+2+1）
  assert.deepEqual(rows.map((row) => row.count), [2, 2, 1], `应按 organizeBatchSize 分页，实际 ${JSON.stringify(rows)}`)
  assert.equal(visionCalls.length, 3, 'vision 应被调 3 次')
  assert.deepEqual(done.result, {
    tried: 5, tagged: 5, meaningless: 0, failures: 0, deleted: 0, suspicious: false, dryRun: false,
    // persisted=true 表示"真的写进库了"（dryRun=false）。UI 靠它区分
    // 「打标了」和「只是试运行、其实没写」（真机踩过这个歧义）。
    persisted: true, detail: '',
  })
  assert.deepEqual(done.progress, { done: 5, total: 5, label: '已看 5/5 张' }, '进度应报满并带「已看 x/y 张」')
})

await check('organize：limit 夹到 1..60，dryRun 透传给 vision', async () => {
  const { runtime, lib, visionCalls } = await makeRuntime()
  for (let index = 0; index < 3; index++) await lib.ingest({ bytes: makePng(24, 24, index + 61) })
  runtime.actions.run('organize', { limit: 0, dryRun: true })
  await waitJob(runtime, 'organize')
  assert.equal(visionCalls[0].opts.dryRun, true, 'dryRun 应透传给 recognizeBatch')
  const candidates = visionCalls.reduce((sum, call) => sum + call.items.length, 0)
  assert.ok(candidates >= 1 && candidates <= 3, `limit=0 应夹到 1，实际看了 ${candidates} 张`)
})

await check('collect：调 collector.collectTopUsed({reason:"panel"})，result 按契约', async () => {
  let seen = null
  const { runtime } = await makeRuntime({
    collector: {
      brief: () => ({ enabled: false, nextRunAt: 0 }),
      collectTopUsed: async (opts) => {
        seen = opts
        return { ok: true, considered: 7, collected: 2, already: 4, failed: 1, stopReason: '候选不够' }
      },
    },
  })
  runtime.actions.run('collect', {})
  const done = await waitJob(runtime, 'collect')
  assert.equal(done.status, 'done')
  assert.deepEqual(seen, { reason: 'panel' }, '必须带 reason: panel')
  assert.deepEqual(done.result, { ok: true, considered: 7, collected: 2, already: 4, failed: 1, stopReason: '候选不够' })
})

await check('collect：collector 返回 ok:false → job 变 error', async () => {
  const { runtime } = await makeRuntime({
    collector: {
      brief: () => ({ enabled: false, nextRunAt: 0 }),
      collectTopUsed: async () => ({ ok: false, reason: '宿主没有提供读取会话消息的通道' }),
    },
  })
  runtime.actions.run('collect', {})
  const done = await waitJob(runtime, 'collect')
  assert.equal(done.status, 'error')
  assert.match(done.error, /收集没跑起来/)
})

await check('report：走 jobs 且同步给出报表文本', async () => {
  const { runtime, lib } = await makeRuntime()
  await lib.ingest({ bytes: makePng(24, 24, 71) })
  runtime.actions.run('report', {})
  const done = await waitJob(runtime, 'report')
  assert.equal(done.status, 'done')
  assert.match(done.result.report, /表情库：1 张/, 'report 应是 library.reportText()')
})

await check('未知 kind / 空 kind → 同步抛带 statusCode=400 的错误', async () => {
  const { runtime } = await makeRuntime()
  assert.throws(() => runtime.actions.run('nope', {}), (error) => {
    assert.equal(error.statusCode, 400)
    assert.match(error.message, /未知动作/)
    return true
  })
  assert.throws(() => runtime.actions.run('', {}), /未知动作/)
  assert.throws(() => runtime.actions.run(undefined, {}), /未知动作/)
  assert.equal(runtime.jobs.list().length, 0)
})

await check('kinds 清单包含契约 §4 的 6 个 kind（v2 追加 backup）', async () => {
  const { runtime } = await makeRuntime()
  const kinds = runtime.actions.kinds.map((entry) => entry.kind).sort()
  // v1 的 6 个必须都在；v2 之后允许继续追加，所以用 includes 而不是全等
  for (const required of ['cleanup', 'clear', 'collect', 'delete_oldest', 'organize', 'report']) {
    assert.ok(kinds.includes(required), `缺少 kind：${required}，实际：${kinds.join(',')}`)
  }
  assert.ok(kinds.includes('backup'), `v2 应包含 backup，实际：${kinds.join(',')}`)
})

await check('同 kind 并发：第二次 run 得到 already-running（不重复起任务）', async () => {
  const { runtime, lib } = await makeRuntime({
    recognizeBatch: async (items, opts) => {
      await sleep(30)
      return { tried: items.length, tagged: items.length, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: Boolean(opts?.dryRun), errors: [] }
    },
  })
  await lib.ingest({ bytes: makePng(24, 24, 81) })
  const first = runtime.actions.run('organize', {})
  const second = runtime.actions.run('organize', {})
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-running')
  await waitJob(runtime, 'organize')
})

// ════════════════════════════════════════════════════════════ 3. server

console.log('\n== server（契约 §1/§2/§4/§5）')

/** 假 webServer：记录注册的路由。 */
function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** 假 ctx：get() 给服务，effect() 立即执行并记录 label，on() 只收不触发。 */
function makeCtx(services = {}) {
  const effects = []
  return {
    services,
    effects,
    get(name) { return services[name] },
    on() { return () => {} },
    effect(fn, label) {
      const dispose = (typeof fn === 'function' ? fn() : undefined) ?? (() => {})
      effects.push({ label, dispose })
      return dispose
    },
  }
}

/** 假 res：收集状态码/头/body。 */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? {}
    },
    end(body) {
      res.body = String(body ?? '')
      res.writableEnded = true
    },
  }
  return res
}

/** 假 req：EventEmitter + method/headers；带 body 时按 chunk 发出去。 */
async function callRoute(route, { method = 'GET', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = headers
  if (typeof req.destroy !== 'function') req.destroy = () => {}
  const res = makeRes()
  const pending = Promise.resolve(route.handler(req, res))
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    req.emit('data', Buffer.from(text, 'utf8'))
  }
  req.emit('end')
  await pending
  // handler 内部的异步 catch 链（Promise.resolve(handler).catch）要等一拍
  await sleep(5)
  return res
}

/** 造一个能挂路由的 runtime（真 Library + 假 demás 部件）。 */
async function makeServerRuntime({ cfg = cfgOf(), webServer } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-srv-'))
  tempDirs.push(dir)
  const lib = new Library({ dataDir: dir, config: cfg })
  await lib.load()
  const state = emptyState()
  const runtime = {
    dataDir: dir,
    log: () => {},
    toolNames: ['qq_ext_sticker_pick', 'qq_ext_sticker_send'],
    state: () => state,
    getConfig: () => cfg,
    library: lib,
    reportFile: path.join(dir, 'report.txt'),
    collector: { brief: () => ({ enabled: true, everyHours: 12, nextRunAt: 0, nextRunInMin: 0, lastRunAt: 0, lastResult: null }) },
    ingestor: { snapshot: () => ({ queued: 0, draining: false }) },
    settler: { snapshot: () => ({ pending: 0, lastBaseRewardAt: 0 }) },
    vision: { available: () => ({ ok: true, reason: '' }), recognizeBatch: async () => ({}) },
  }
  runtime.jobs = createJobs({ log: () => {} })
  runtime.actions = createActions({ runtime, jobs: runtime.jobs, log: () => {} })
  const ctx = makeCtx({ webServer, settings: makeSettings(cfg) })
  const dispose = registerRoutes(ctx, runtime)
  return { runtime, lib, dir, ctx, webServer, dispose, dirPath: dir }
}

/** 假 settings 服务：记录 update 调用并回写配置。 */
function makeSettings(cfg) {
  const calls = []
  return {
    calls,
    async update(ns, patch) {
      calls.push({ ns, patch })
      // 模拟 settings 的层合并：把 patch 里的段写进内存配置
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && cfg[key] && typeof cfg[key] === 'object') {
          Object.assign(cfg[key], value)
        } else {
          cfg[key] = value
        }
      }
    },
  }
}

await check('registerRoutes：注册出的路径与契约一致（6 个 exact 路径覆盖 7 条逻辑路由）', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  // webServer.register 是 per-path 的（同 path 重复注册会抛 duplicate），
  // 所以 /config 的 GET 与 POST 共用一条注册、在 handler 里按方法分发。
  const paths = webServer.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    `${ROUTE_PREFIX}/action`,
    `${ROUTE_PREFIX}/config`,
    `${ROUTE_PREFIX}/open-path`,
    `${ROUTE_PREFIX}/raw-image`,
    `${ROUTE_PREFIX}/report`,
    `${ROUTE_PREFIX}/state`,
  ], `注册路径不对：${paths.join(',')}`)
  for (const route of webServer.routes) {
    assert.equal(route.kind, 'exact', `${route.path} 应该是 exact 路由`)
    assert.equal(typeof route.handler, 'function')
  }
  // 7 条逻辑路由：state GET / report GET / config GET / config POST / action POST / raw-image POST / open-path POST
  const routeOf = (p) => webServer.routes.find((route) => route.path === p)
  assert.equal(typeof routeOf(`${ROUTE_PREFIX}/state`), 'object')
  assert.equal(typeof routeOf(`${ROUTE_PREFIX}/report`), 'object')
  assert.equal(typeof routeOf(`${ROUTE_PREFIX}/config`), 'object')
  assert.equal(typeof routeOf(`${ROUTE_PREFIX}/action`), 'object')
  dispose()
  assert.equal(webServer.routes.length, 0, 'disposer 应注销全部路由')
})

await check('GET /state：含 jobs/limits/dataDir，且原有字段一个不少', async () => {
  const webServer = makeWebServer()
  const { runtime, lib, dispose } = await makeServerRuntime({ webServer })
  await lib.ingest({ bytes: makePng(40, 40, 91) })
  const stateRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/state`)
  const res = await callRoute(stateRoute, { method: 'GET', headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.headers['content-type'], /application\/json/)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  // 契约 §1 要求的原有字段（"必须保留原有全部字段，只允许新增"）
  for (const key of ['ok', 'enabled', 'library', 'limits', 'send', 'collect', 'ingest', 'reward', 'vision', 'tools', 'dataDir', 'jobs']) {
    assert.ok(Object.hasOwn(body, key), `/state 缺字段 ${key}`)
  }
  assert.deepEqual(body.limits, { maxCount: 500, maxTotalMB: 200, maxItemMB: 6 })
  assert.equal(body.dataDir, runtime.dataDir)
  assert.ok(Array.isArray(body.jobs), 'jobs 应是数组')
  assert.equal(body.vision.reason, '', 'vision.reason 恒为字符串')
  assert.equal(body.library.freedMB, Number((lib.totalBytes() / 1048576).toFixed(1)))
  // jobs 里能看到刚启动的任务
  runtime.actions.run('report', {})
  await sleep(20)
  const res2 = await callRoute(stateRoute, { method: 'GET', headers: {} })
  const body2 = JSON.parse(res2.body)
  assert.ok(body2.jobs.length >= 1, '启动过任务后 /state.jobs 应有记录')
  assert.equal(body2.jobs[0].kind, 'report')
  dispose()
})

await check('GET /state：非 GET/HEAD 一律 405（只读路由保持旧行为）', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const stateRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/state`)
  const res = await callRoute(stateRoute, { method: 'POST' })
  assert.equal(res.statusCode, 405)
  assert.deepEqual(JSON.parse(res.body), { ok: false, reason: 'method not allowed' })
  dispose()
})

await check('GET /config：返回 readConfig() 归一化后的完整对象', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const configRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/config`)
  const res = await callRoute(configRoute, { method: 'GET' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  for (const section of ['enabled', 'debug', 'library', 'collect', 'vision', 'send', 'prompt', 'maintenance']) {
    assert.ok(Object.hasOwn(body.config, section), `config 缺段 ${section}`)
  }
  assert.equal(body.config.send.frequency, 'occasional')
  assert.equal(body.config.vision.organizeBatchSize, 4)
  dispose()
})

await check('POST /config：paths 两段 → 段内其它字段不丢（避免浅合并冲掉整段）', async () => {
  const webServer = makeWebServer()
  const { runtime, ctx, dispose } = await makeServerRuntime({ webServer })
  const configRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/config`)
  const settings = ctx.get('settings')
  const res = await callRoute(configRoute, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: { path: ['send', 'frequency'], value: 'normal' },
  })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(settings.calls.length, 1, '应调一次 settings.update')
  assert.equal(settings.calls[0].ns, 'qq-sticker')
  const patch = settings.calls[0].patch
  assert.equal(patch.send.frequency, 'normal')
  // 段内其它字段必须还在（契约 §5 的 ...当前段）
  for (const key of Object.keys(DEFAULTS.send)) {
    assert.ok(Object.hasOwn(patch.send, key), `patch.send 丢了字段 ${key}`)
  }
  assert.equal(body.config.send.frequency, 'normal', '返回的是写入后的 readConfig()')
  assert.equal(runtime.getConfig().send.dailyLimit, DEFAULTS.send.dailyLimit, '其它字段值不变')
  dispose()
})

await check('POST /config：settings 服务不可用 → 501', async () => {
  const webServer = makeWebServer()
  const { ctx, dispose } = await makeServerRuntime({ webServer })
  ctx.services.settings = undefined
  const configRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/config`)
  const res = await callRoute(configRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { path: ['enabled'], value: false },
  })
  assert.equal(res.statusCode, 501)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.match(body.reason, /设置服务不可用/)
  dispose()
})

await check('POST /config：settings.update 抛错 → 500（契约 §4「任何异常 → 500」）', async () => {
  const webServer = makeWebServer()
  const { ctx, dispose } = await makeServerRuntime({ webServer })
  // 参数合法，但写失败（真实场景：revision 冲突 / schema 不认字段 / 写盘失败）
  ctx.services.settings = {
    async update() { throw new Error('revision 冲突') },
  }
  const configRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/config`)
  const res = await callRoute(configRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { path: ['send', 'frequency'], value: 'normal' },
  })
  assert.equal(res.statusCode, 500, `写失败应是 500，实际 ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.match(body.reason, /写配置失败/)
  dispose()
})

await check('POST /config：path 非法 → 400', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const configRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/config`)
  for (const bad of [{ path: [] }, { path: ['a', 'b', 'c'] }, { path: 'send.frequency' }, {}]) {
    const res = await callRoute(configRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { ...bad, value: 1 },
    })
    assert.equal(res.statusCode, 400, `path=${JSON.stringify(bad.path)} 应 400`)
  }
  dispose()
})

await check('POST /action：合法请求 → 200 + job（running）', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const actionRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/action`)
  const res = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: { kind: 'report', args: {} },
  })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(body.job, '响应应带 job')
  assert.match(body.job.id, /^job-/)
  assert.equal(body.job.kind, 'report')
  assert.equal(res.headers['cache-control'], 'no-store')
  dispose()
})

await check('POST /action：跨站请求（sec-fetch-site: cross-site）→ 403', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const actionRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/action`)
  const res = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: { kind: 'report', args: {} },
  })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { ok: false, reason: 'cross-site request refused' })
  dispose()
})

await check('POST /action：未知 kind → 400；缺 confirm 的 clear → 400', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const actionRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/action`)
  const unknown = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { kind: 'nope', args: {} },
  })
  assert.equal(unknown.statusCode, 400)
  const unknownBody = JSON.parse(unknown.body)
  assert.equal(unknownBody.ok, false)
  assert.match(unknownBody.reason, /未知动作/)

  const noConfirm = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { kind: 'clear', args: {} },
  })
  assert.equal(noConfirm.statusCode, 400)
  assert.match(JSON.parse(noConfirm.body).reason, /清空库需要二次确认/)
  dispose()
})

await check('POST /action：方法不对 → 405；坏 JSON → 400；超大 body → 413', async () => {
  const webServer = makeWebServer()
  const { dispose } = await makeServerRuntime({ webServer })
  const actionRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/action`)

  const getRes = await callRoute(actionRoute, { method: 'GET' })
  assert.equal(getRes.statusCode, 405)
  assert.deepEqual(JSON.parse(getRes.body), { ok: false, reason: 'method not allowed' })

  const badJson = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ kind: ',
  })
  assert.equal(badJson.statusCode, 400)
  assert.match(JSON.parse(badJson.body).reason, /不是合法 JSON/)

  const huge = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'report', args: { pad: 'x'.repeat(70 * 1024) } }),
  })
  assert.equal(huge.statusCode, 413, `超大 body 应 413，实际 ${huge.statusCode}`)
  dispose()
})

await check('POST /action：同 kind 已在跑 → 409 + reason=already-running', async () => {
  const webServer = makeWebServer()
  const { runtime, dispose } = await makeServerRuntime({ webServer })
  // 塞一个不会马上结束的 organize：用假 vision 拖住
  runtime.vision.recognizeBatch = async (items) => {
    await sleep(50)
    return { tried: items.length, tagged: 0, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: false, errors: [] }
  }
  const { shortId } = await import('./src/library.js')
  void shortId
  await runtime.library.ingest({ bytes: makePng(24, 24, 101) })
  const actionRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/action`)
  const first = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { kind: 'organize', args: {} },
  })
  assert.equal(first.statusCode, 200)
  const second = await callRoute(actionRoute, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { kind: 'organize', args: {} },
  })
  assert.equal(second.statusCode, 409)
  const body = JSON.parse(second.body)
  assert.equal(body.ok, false)
  assert.equal(body.reason, 'already-running')
  assert.ok(body.job, '409 也要带上正在跑的 job')
  await waitFor(() => runtime.jobs.list()[0].status !== 'running', 3000)
  dispose()
})

await check('GET /report：原有只读报表仍可用', async () => {
  const webServer = makeWebServer()
  const { lib, dispose } = await makeServerRuntime({ webServer })
  await lib.ingest({ bytes: makePng(24, 24, 111) })
  const reportRoute = webServer.routes.find((route) => route.path === `${ROUTE_PREFIX}/report`)
  const res = await callRoute(reportRoute, { method: 'GET' })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.match(body.report, /表情库：1 张/)
  dispose()
})

await check('没有 webServer 时 registerRoutes 不炸、只记一条 info', async () => {
  const logs = []
  const runtime = { log: (level, message) => logs.push({ level, message }) }
  const dispose = registerRoutes(makeCtx({}), runtime)
  assert.equal(typeof dispose, 'function')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'info')
  assert.match(logs[0].message, /没有 webServer/)
  dispose()
})

await check('inject 方式挂载：webServer 未发布时先不注册，发布了再注册（真机 404 的修法）', async () => {
  // 用 index.js 的 startLifecycle 走一遍（它会按 ctx 是否带 inject 选择挂载方式）
  const { startLifecycle, createRuntime } = await import('./index.js')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-lc-'))
  tempDirs.push(dir)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const services = {}
    const pendingInject = []
    const webServer = makeWebServer()
    const ctx = {
      services,
      effects: [],
      get(name) { return services[name] },
      on() { return () => {} },
      effect(fn, label) {
        const dispose = (typeof fn === 'function' ? fn() : undefined) ?? (() => {})
        this.effects.push({ label, dispose })
        return dispose
      },
      // 真 Cordis 的 inject：回调挂起，等 webServer 提供后再跑
      inject(deps, callback) {
        pendingInject.push({ deps, callback })
      },
    }
    const runtime = createRuntime(ctx, { ...DEFAULTS })
    startLifecycle(ctx, runtime)
    await sleep(50)
    assert.equal(pendingInject.length, 1, '应通过 inject 挂载（而不是在 apply 期直接取服务）')
    assert.deepEqual(pendingInject[0].deps, ['webServer'], 'inject 的依赖只能是 webServer')
    assert.equal(webServer.routes.length, 0, 'webServer 还没发布时不该有路由')

    // 现在"发布" webServer：inject 回调拿 scoped ctx 跑
    services.webServer = webServer
    const scoped = { get: (name) => services[name], effect: ctx.effect.bind(ctx) }
    pendingInject[0].callback(scoped)
    assert.equal(webServer.routes.length, 6, `发布后应注册 6 条路径，实际 ${webServer.routes.length}`)
    const paths = webServer.routes.map((route) => route.path).sort()
    assert.ok(paths.includes(`${ROUTE_PREFIX}/state`), `应有 state 路由，实际 ${paths.join(',')}`)
    assert.ok(paths.includes(`${ROUTE_PREFIX}/action`), '应有 action 路由')

    // runtime 上 jobs / actions 都装配好了
    assert.equal(typeof runtime.jobs?.list, 'function', 'createRuntime 应装配 jobs')
    assert.equal(typeof runtime.actions?.run, 'function', 'createRuntime 应装配 actions')
    await ctx.effects.reverse().forEach((entry) => { try { entry.dispose?.() } catch { /* ignore */ } })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

await check('离线假 ctx（没有 inject）退回 ctx.effect 挂载，不炸', async () => {
  const { startLifecycle, createRuntime } = await import('./index.js')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-lc2-'))
  tempDirs.push(dir)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const webServer = makeWebServer()
    const ctx = makeCtx({ webServer })
    const runtime = createRuntime(ctx, { ...DEFAULTS })
    startLifecycle(ctx, runtime)
    await sleep(50)
    assert.equal(webServer.routes.length, 6, `假 ctx 应立即注册 6 条路径，实际 ${webServer.routes.length}`)
    await ctx.effects.reverse().forEach((entry) => { try { entry.dispose?.() } catch { /* ignore */ } })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

// ════════════════════════════════════════════════════════════ 4. 真实 HTTP

console.log('\n== 真实 HTTP（真 socket + fetch，验证 headers/状态码/JSON 在真协议上是对的）')

await check('真 HTTP：契约 §1/§2/§4/§5 的状态码与响应体全部符合', async () => {
  // 起一个真 http server，把 registerRoutes 挂上去，用 fetch 打真实请求。
  // 为什么要有这一层：进程内的假 req/res 测不出「超限时 destroy socket 会让客户端
  // 拿不到 413」这类真协议问题（2026-10-25 正是这么发现的）。
  const http = await import('node:http')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-http-'))
  tempDirs.push(dir)
  const cfg = cfgOf()
  const lib = new Library({ dataDir: dir, config: cfg })
  await lib.load()
  await lib.ingest({ bytes: makePng(24, 24, 121) })
  const state = emptyState()
  const settingsCalls = []

  const runtime = {
    dataDir: dir,
    log: () => {},
    toolNames: ['qq_ext_sticker_pick'],
    state: () => state,
    getConfig: () => cfg,
    library: lib,
    reportFile: path.join(dir, 'report.txt'),
    collector: { brief: () => ({ enabled: true, everyHours: 12, nextRunAt: 0, nextRunInMin: 0, lastRunAt: 0, lastResult: null }) },
    ingestor: { snapshot: () => ({ queued: 0, draining: false }) },
    settler: { snapshot: () => ({ pending: 0, lastBaseRewardAt: 0 }) },
    vision: { available: () => ({ ok: false, reason: '当前宿主没有可用的 LLM 调用通道' }), recognizeBatch: async () => ({}) },
  }
  runtime.jobs = createJobs({ log: () => {} })
  runtime.actions = createActions({ runtime, jobs: runtime.jobs, log: () => {} })

  const table = new Map()
  const webServer = {
    register(route) { table.set(route.path, route.handler); return () => table.delete(route.path) },
  }
  const settingsStub = {
    async update(ns, patch) {
      settingsCalls.push({ ns, patch })
      Object.assign(cfg.send, patch.send ?? {})
    },
  }
  registerRoutes(makeCtx({ webServer, settings: settingsStub }), runtime)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const handler = table.get(url.pathname)
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, reason: 'not found' }))
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  try {
    // §1
    let res = await fetch(`${base}/state`)
    let body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(body.limits, { maxCount: 500, maxTotalMB: 200, maxItemMB: 6 })
    assert.equal(body.dataDir, dir)
    assert.ok(Array.isArray(body.jobs))
    for (const key of ['enabled', 'library', 'send', 'collect', 'ingest', 'reward', 'vision', 'tools']) {
      assert.ok(Object.hasOwn(body, key), `/state 缺原有字段 ${key}`)
    }
    assert.equal(typeof body.vision.reason, 'string')

    // §2
    res = await fetch(`${base}/config`)
    body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.config.send.frequency, 'occasional')

    // §4 接受
    res = await post('/action', { kind: 'report', args: {} })
    body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.job.status, 'running')
    const jobId = body.job.id
    await sleep(150)
    res = await fetch(`${base}/state`)
    body = await res.json()
    const job = body.jobs.find((entry) => entry.id === jobId)
    assert.equal(job?.status, 'done', '任务应出现在 /state.jobs 并变成 done')
    assert.equal(typeof job.result?.report, 'string')

    // §4 409（用一个慢 organize 占住单飞）
    runtime.vision.recognizeBatch = async (items) => {
      await sleep(200)
      return { tried: items.length, tagged: 0, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: false, errors: [] }
    }
    assert.equal((await post('/action', { kind: 'organize', args: {} })).status, 200)
    res = await post('/action', { kind: 'organize', args: {} })
    body = await res.json()
    assert.equal(res.status, 409)
    assert.equal(body.reason, 'already-running')
    assert.ok(body.job)
    await sleep(400)

    // §4 403 / 400 / 405 / 413
    assert.equal((await post('/action', { kind: 'report' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
    assert.equal((await fetch(`${base}/state`, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 200,
      '只读路由不该拦跨站（保持旧行为）')
    assert.equal((await post('/action', { kind: 'nope' })).status, 400)
    res = await post('/action', { kind: 'clear', args: {} })
    body = await res.json()
    assert.equal(res.status, 400)
    assert.match(body.reason, /二次确认/)
    assert.equal((await fetch(`${base}/action`, { method: 'GET' })).status, 405)
    assert.equal((await post('/action', '{bad')).status, 400)
    // 超大 body：真协议下必须能拿到 413（不能被 destroy socket 掐成 socket error）
    assert.equal((await post('/action', { pad: 'x'.repeat(70 * 1024) })).status, 413)

    // §5
    res = await post('/config', { path: ['send', 'frequency'], value: 'normal' })
    body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.config.send.frequency, 'normal')
    assert.equal(settingsCalls.length, 1)
    assert.equal(settingsCalls[0].ns, 'qq-sticker')
    assert.ok(Object.keys(settingsCalls[0].patch.send).length >= 10, 'patch 必须带全段字段')

    // clear 真清空
    assert.equal((await post('/action', { kind: 'clear', args: { confirm: 'CLEAR' } })).status, 200)
    await sleep(200)
    res = await fetch(`${base}/state`)
    body = await res.json()
    assert.equal(body.library.total, 0, '清空后库应为 0')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// ════════════════════════════════════════════════════════════ 5. 真 Cordis：404 的端到端复现

console.log('\n== 真 Cordis（webServer 晚于插件发布 —— 最初 404 的根因）')

await check('真 Cordis：旧写法复现 404；新写法等 webServer 发布后注册 6 条路由', async () => {
  // 找不到真 Cordis 就跳过（与 test-cordis-regression.mjs 同一套指路方式）。
  const { existsSync } = await import('node:fs')
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const candidates = [
    process.env.DSH_CORDIS_DIR,
    path.join(here, 'node_modules'),
    'C:/Users/1/Documents/deepseek-harness/default-workspace/plugins/dsh-qq-guard/node_modules',
    'D:/DeepSeekHarness_workarea/Work/.recon/harness/node_modules',
  ].filter(Boolean)
  let cordisDir = ''
  for (const dir of candidates) {
    if (existsSync(path.join(dir, '@deepseek-ai', 'cordis', 'lib', 'index.js'))) { cordisDir = dir; break }
  }
  if (!cordisDir) {
    skipped++
    console.log('  -   真 Cordis 不可用，跳过（设 DSH_CORDIS_DIR=<node_modules 路径> 再跑）')
    return
  }
  const cordisUrl = `file:///${path.join(cordisDir, '@deepseek-ai', 'cordis', 'lib', 'index.js').replace(/\\/g, '/').replace(/^\/+/, '')}`
  const { Context, Service } = await import(cordisUrl)
  const { apply: pluginApply, createRuntime: makeRt, inject: pluginInject } = await import('./index.js')

  /** 路由表记录器：两个实现分别记录到自己的数组里。 */
  const makeServerClass = (sink) => class extends Service {
    constructor(inner) { super(inner, 'webServer') }
    register(route) {
      sink.push(route.path)
      return () => {
        const index = sink.indexOf(route.path)
        if (index >= 0) sink.splice(index, 1)
      }
    }
  }
  const WANT = [`${ROUTE_PREFIX}/state`, `${ROUTE_PREFIX}/report`, `${ROUTE_PREFIX}/config`, `${ROUTE_PREFIX}/raw-image`, `${ROUTE_PREFIX}/open-path`, `${ROUTE_PREFIX}/action`]

  // 临时数据目录（createRuntime 会往 $DSH_HOME 下建库）
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-panel-cordis-'))
  tempDirs.push(dir)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    /** 假 tools 服务类（Cordis 的 ctx.plugin 要的是**类**，不是实例）。 */
    class FakeTools extends Service {
      constructor(inner) { super(inner, 'tools') }
      register() { return () => {} }
    }

    // ── A：旧写法（apply 期直接 safeService 取服务）→ 复现 404 ──
    const routesOld = []
    const OldServer = makeServerClass(routesOld)
    const ctxOld = new Context()
    ctxOld.plugin(FakeTools)
    await sleep(80)
    ctxOld.plugin({
      name: 'old-style',
      inject: ['tools'],
      apply(inner) {
        const runtime = makeRt(inner, {})
        inner.effect(() => registerRoutes(inner, runtime), 'old: routes')
      },
    })
    await sleep(150)
    ctxOld.plugin(OldServer)
    await sleep(250)
    assert.equal(routesOld.length, 0, '旧写法在 webServer 晚发布时会漏挂路由（这就是 404 的成因）')

    // ── B：现在的写法 ──
    const routesNew = []
    const NewServerA = makeServerClass(routesNew)
    const NewServerB = makeServerClass(routesNew)
    const ctx = new Context()
    ctx.plugin(FakeTools)
    await sleep(80)
    const fiber = ctx.plugin({ name: 'new-style', apply: pluginApply, inject: pluginInject })
    await fiber
    await sleep(150)
    assert.equal(routesNew.length, 0, 'webServer 还没发布时不该抢跑挂路由')

    const fiberA = ctx.plugin(NewServerA)
    await fiberA
    await sleep(300)
    assert.deepEqual([...routesNew].sort(), [...WANT].sort(), `webServer 发布后应注册 6 条路由，实际 ${routesNew.join(',')}`)

    // ── C：换 webServer 实现 → inject 回调重跑，路由搬到新服务 ──
    fiberA.dispose()
    await sleep(200)
    assert.equal(routesNew.length, 0, '旧 webServer 卸载时路由应随之注销')
    const fiberB = ctx.plugin(NewServerB)
    await fiberB
    await sleep(300)
    assert.deepEqual([...routesNew].sort(), [...WANT].sort(), 'webServer 换实现后 inject 回调应重跑、路由重新注册')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

// ───────────────────────────────────────────────────────────── 收尾

for (const dir of tempDirs) {
  try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}${skipped > 0 ? `｜跳过 ${skipped}` : ''}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`- ${item.name}: ${item.error?.message ?? item.error}`)
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
