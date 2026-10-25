/**
 * 契约一致性检查：client.js 用到的每个字段，Host 的 /state 是不是真的给了。
 *
 * 做法：起真实 runtime + 真实路由，取一次 /state，然后跟 client.js 源码里
 * `data.xxx` / `job.xxx` / `result.xxx` 的读取做交叉比对。
 *
 * 跑：`node test-contract.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

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

/* ── 起真实 runtime ──────────────────────────────────────── */

const HOME = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-contract-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const { createRuntime } = await import(pathToFileURL(path.join(HERE, 'index.js')).href)
const { registerRoutes } = await import(pathToFileURL(path.join(HERE, 'src', 'server.js')).href)

const ctx = {
  get() { return undefined },
  on() { return () => {} },
  effect(fn) { const r = fn?.(); return typeof r === 'function' ? r : () => {} },
}
const runtime = createRuntime(ctx, {})
runtime.library.config = runtime.getConfig()
await runtime.library.load()

const table = new Map()
const webServer = { register(route) { table.set(`exact:${route.path}`, route.handler); return () => {} } }
registerRoutes({ ...ctx, get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)

const handler = table.get('exact:/dsh-qq-sticker/state')
const res = {
  statusCode: 0, headers: {}, body: '', writableEnded: false, headersSent: false,
  writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true; return this },
  end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true },
}
await handler({ method: 'GET', url: '/dsh-qq-sticker/state', headers: {} }, res)
const STATE = JSON.parse(res.body)

const clientSource = await readFile(path.join(HERE, 'client.js'), 'utf8')

/* ── ① /state 的顶层字段 ─────────────────────────────────── */

console.log('\n① /state 字段与 client 期望比对')

await check('/state 顶层字段齐全', () => {
  const required = ['ok', 'enabled', 'library', 'limits', 'send', 'collect', 'ingest', 'reward', 'vision', 'tools', 'dataDir', 'jobs']
  const missing = required.filter((key) => !(key in STATE))
  assert.deepEqual(missing, [], `缺：${missing.join(', ')}`)
})

await check('client 读的每个 library 字段 Host 都给了', () => {
  // client 里出现的 data.library.xxx / library.xxx
  const used = new Set([...clientSource.matchAll(/library\.([a-zA-Z]+)/g)].map((m) => m[1]))
  const skip = new Set(['maxCount', 'maxTotalMB', 'maxItemMB', 'blockedIds', 'hiddenIds'])
  const missing = [...used].filter((key) => !skip.has(key) && !(key in STATE.library))
  assert.deepEqual(missing, [], `client 用到但 /state.library 没给的：${missing.join(', ')}`)
  console.log(`      （client 读 library 的 ${used.size} 个字段，跳过配置段的 ${skip.size} 个）`)
})

await check('client 读的每个 send / collect / ingest / vision 字段都有', () => {
  // 只比对 /state 这一层的读取；配置段的 `send.minIntervalSec` 之类走的是
  // get('send.xxx') 路径取值，不是 data.send.xxx，不能混进来。
  const groups = {
    send: STATE.send,
    collect: STATE.collect,
    ingest: STATE.ingest,
    vision: STATE.vision,
  }
  const missing = []
  for (const [group, value] of Object.entries(groups)) {
    // data.<group>.<field> 形式（state 读取）
    const used = new Set(
      [...clientSource.matchAll(new RegExp(`data\\??\\.${group}\\??\\.([a-zA-Z]+)`, 'g'))].map((m) => m[1]),
    )
    for (const key of used) {
      if (!(key in value)) missing.push(`${group}.${key}`)
    }
  }
  // nextRunInMin 在 host 用 Math.round 给，确认是数字
  assert.equal(typeof STATE.collect.nextRunInMin, 'number')
  assert.deepEqual(missing, [], `缺：${missing.join(', ')}`)
})

await check('vision.reason 恒为字符串（client 直接塞进 DOM）', () => {
  assert.equal(typeof STATE.vision.reason, 'string')
  assert.equal(typeof STATE.vision.ok, 'boolean')
})

await check('limits 三个字段都是数字（client 拿来算容量条百分比）', () => {
  for (const key of ['maxCount', 'maxTotalMB', 'maxItemMB']) {
    assert.equal(typeof STATE.limits[key], 'number', `limits.${key} 应是 number`)
    assert.ok(STATE.limits[key] > 0)
  }
})

/* ── ② job 形状 ──────────────────────────────────────────── */

console.log('\n② job 形状与 client 的 JobPanel 比对')

await check('跑一个 report，job 对象字段与 JobPanel 读的一致', async () => {
  // 直接走 actions/jobs（不经过 HTTP 层）：这一条只验 job 形状，
  // 传输层的行为归 test-panel-e2e.mjs 管。
  const started = runtime.actions.run('report', {})
  assert.equal(started.ok, true, `启动失败：${JSON.stringify(started)}`)
  assert.ok(started.job, '应立刻返回 job')
  assert.equal(started.job.kind, 'report')
  assert.equal(started.job.status, 'running', '刚启动应是 running（面板靠它画进度条）')

  // runner 是 Promise.resolve().then() 起的，让它跑完（report 很快）
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))

  const jobs = runtime.jobs.list()
  assert.ok(jobs.length >= 1, 'jobs 里应有刚启动的任务')
  const job = jobs[0]
  // JobPanel 读这些：
  for (const key of ['id', 'kind', 'label', 'status', 'startedAt', 'endedAt', 'progress', 'result', 'error']) {
    assert.ok(key in job, `job 缺字段 ${key}，实际：${Object.keys(job).join(',')}`)
  }
  assert.ok(['running', 'done', 'error'].includes(job.status))
  assert.equal(typeof job.progress.done, 'number')
  assert.equal(typeof job.progress.total, 'number')
  assert.equal(typeof job.progress.label, 'string')
})

await check('result 引用的是副本，外部改动不会污染任务表', () => {
  const list = runtime.jobs.list()
  if (list.length === 0) return
  const first = list[0]
  if (first.progress) first.progress.done = 99999
  const again = runtime.jobs.list()
  assert.notEqual(again[0]?.progress?.done, 99999, 'snapshot 应是深拷贝')
})

/* ── ③ 动作 kind 对齐 ────────────────────────────────────── */

console.log('\n③ 动作 kind 与 client 的 ACTIONS 对齐')

await check('client 的 5 个 kind + clear，Host 全部认识', () => {
  const clientKinds = new Set([...clientSource.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]))
  // ACTIONS 里的 kind + 显式调用的 clear
  const expected = ['organize', 'cleanup', 'collect', 'delete_oldest', 'report']
  for (const kind of expected) {
    assert.ok(clientKinds.has(kind), `client ACTIONS 里缺 ${kind}，实际：${[...clientKinds].join(',')}`)
  }
  // Host 端 kinds
  const hostKinds = new Set(runtime.actions.kinds.map((entry) => entry.kind))
  for (const kind of [...expected, 'clear']) {
    assert.ok(hostKinds.has(kind), `Host actions 不认识 ${kind}，实际：${[...hostKinds].join(',')}`)
  }
})

await check('client 调 clear 时传的 confirm 字面量与 Host 要求一致', () => {
  assert.match(clientSource, /onRun\('clear', \{ confirm: 'CLEAR' \}\)/, 'client 应传 confirm: CLEAR')
  assert.match(clientSource, /requireText: 'CLEAR'/, '弹窗也应要求键入 CLEAR')
})

/* ── 收尾 ─────────────────────────────────────────────────── */

if (savedHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = savedHome
await rm(HOME, { recursive: true, force: true }).catch(() => {})

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
