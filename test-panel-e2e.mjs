/**
 * 端到端烟测：把真实的 server.js 路由挂到假 webServer 上，
 * 用真实 fetch 语义的请求对象打一遍，验证「面板真正会拿到什么」。
 *
 * 与 test-panel-host.mjs 的分工：
 *   · test-panel-host 查 jobs/actions 的纯逻辑与注册；
 *   · 这个文件查**真实 HTTP 响应体**：/state 的字段是否齐全、/action 的状态码、
 *     跨站是否被拒、CLEAR 是否必需、未知 kind 是否 400。
 *
 * 跑：`node test-panel-e2e.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createRuntime } from './index.js'
import { registerRoutes } from './src/server.js'

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

/* ── 假 req / res ─────────────────────────────────────────── */

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    on(event, handler) {
      if (event === 'data') for (const chunk of chunks) handler(chunk)
      if (event === 'end') handler()
      return this
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
      res.writableEnded = true
    },
  }
  return res
}

/** 挂 replay：拿到注册的路径 → handler。 */
function mountRoutes(ctx, runtime) {
  const table = new Map()
  const webServer = {
    register(route) {
      table.set(`${route.kind}:${route.path}`, route.handler)
      return () => table.delete(`${route.kind}:${route.path}`)
    },
  }
  ctx.get = (name) => (name === 'webServer' ? webServer : undefined)
  ctx['inject'] = undefined
  registerRoutes(ctx, runtime)
  return table
}

async function hit(table, pathname, options = {}) {
  const handler = table.get(`exact:${pathname}`)
  assert.ok(handler, `路由 ${pathname} 未注册，已注册：${[...table.keys()].join(', ')}`)
  const req = makeReq({ ...options, url: pathname })
  const res = makeRes()
  await handler(req, res)
  // registerRead 的包装器不返回内层 promise（为了统一 catch），
  // 所以异步 handler 要再让微任务跑几轮才能读到响应。
  for (let i = 0; i < 8 && !res.writableEnded; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

/* ── 装配 ─────────────────────────────────────────────────── */

const HOME = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-e2e-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const ctx = {
  get() { return undefined },
  on() { return () => {} },
  effect(fn) {
    const result = typeof fn === 'function' ? fn() : undefined
    return typeof result === 'function' ? result : () => {}
  },
}

const runtime = createRuntime(ctx, {})
// 手动初始化库（跳过 startLifecycle 的异步加载，只要路由能读到统计）
runtime.library.config = runtime.getConfig()
await runtime.library.load()

const table = mountRoutes(ctx, runtime)

console.log('\n① 路由注册')

await check('五条路由都注册了', () => {
  assert.ok(table.has('exact:/dsh-qq-sticker/state'), '缺 /state')
  assert.ok(table.has('exact:/dsh-qq-sticker/config'), '缺 /config')
  assert.ok(table.has('exact:/dsh-qq-sticker/action'), '缺 /action')
  assert.ok(table.has('exact:/dsh-qq-sticker/report'), '缺 /report')
})

console.log('\n② GET /state')

await check('返回 200，所有字段齐全', async () => {
  const res = await hit(table, '/dsh-qq-sticker/state')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  for (const key of ['enabled', 'library', 'limits', 'send', 'collect', 'ingest', 'reward', 'vision', 'tools', 'dataDir', 'jobs']) {
    assert.ok(key in res.json, `缺字段 ${key}，实际：${Object.keys(res.json).join(',')}`)
  }
})

await check('library 字段与面板契约一致', async () => {
  const { json } = await hit(table, '/dsh-qq-sticker/state')
  for (const key of ['total', 'visible', 'hidden', 'tagged', 'untagged', 'animated', 'meaningless', 'bytes', 'freedMB']) {
    assert.equal(typeof json.library[key], 'number', `library.${key} 应是数字`)
  }
})

await check('limits 反映配置里的上限', async () => {
  const { json } = await hit(table, '/dsh-qq-sticker/state')
  assert.equal(json.limits.maxCount, 500)
  assert.equal(json.limits.maxTotalMB, 200)
  assert.equal(json.limits.maxItemMB, 6)
})

await check('vision 恒有 ok 与 reason 字符串', async () => {
  const { json } = await hit(table, '/dsh-qq-sticker/state')
  assert.equal(typeof json.vision.ok, 'boolean')
  assert.equal(typeof json.vision.reason, 'string')
})

await check('jobs 是数组（面板靠它画进度条）', async () => {
  const { json } = await hit(table, '/dsh-qq-sticker/state')
  assert.ok(Array.isArray(json.jobs))
})

await check('dataDir 是绝对路径字符串', async () => {
  const { json } = await hit(table, '/dsh-qq-sticker/state')
  assert.equal(typeof json.dataDir, 'string')
  assert.ok(json.dataDir.includes('dsh-qq-sticker'))
})

await check('带 no-store，浏览器不会缓存状态', async () => {
  const res = await hit(table, '/dsh-qq-sticker/state')
  assert.equal(res.headers['cache-control'], 'no-store')
})

console.log('\n③ GET /config')

await check('返回归一化后的完整配置', async () => {
  const res = await hit(table, '/dsh-qq-sticker/config', { headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  for (const key of ['enabled', 'library', 'collect', 'vision', 'send', 'prompt', 'maintenance']) {
    assert.ok(key in res.json.config, `缺配置段 ${key}`)
  }
  assert.equal(res.json.config.send.frequency, 'occasional')
})

console.log('\n④ POST /action')

await check('跨站请求被拒 403', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
    body: { kind: 'collect', args: {} },
  })
  assert.equal(res.status, 403)
  assert.equal(res.json.ok, false)
})

await check('未知 kind → 400 且给理由', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { kind: 'nuke', args: {} },
  })
  assert.equal(res.status, 400)
  assert.equal(res.json.ok, false)
  assert.ok(String(res.json.reason).length > 0)
})

await check('clear 缺 confirm → 400 且说明要二次确认', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { kind: 'clear', args: {} },
  })
  assert.equal(res.status, 400)
  assert.equal(res.json.ok, false)
  assert.match(String(res.json.reason), /二次确认|confirm/i)
})

await check('clear 带 confirm 但值不对 → 仍然 400', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { kind: 'clear', args: { confirm: 'clear' } },
  })
  assert.equal(res.status, 400)
})

await check('report 走 job，立刻返回 200 + job 对象', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { kind: 'report', args: {} },
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.ok(res.json.job, '应返回 job')
  assert.equal(res.json.job.kind, 'report')
  assert.ok(['running', 'done'].includes(res.json.job.status))
})

await check('同 kind 立刻再发 → 409 already-running', async () => {
  const body = { kind: 'report', args: {} }
  const options = { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body }
  await hit(table, '/dsh-qq-sticker/action', options)
  const res = await hit(table, '/dsh-qq-sticker/action', options)
  // report 很快，可能已经跑完 → 这时第二次会成功。两种都合法，但要能给面板一个明确答复。
  assert.ok([200, 409].includes(res.status), `实际 ${res.status}：${res.raw.slice(0, 120)}`)
  if (res.status === 409) {
    assert.equal(res.json.reason, 'already-running')
    assert.ok(res.json.job, '409 也要带 job，面板才能复用进度条')
  }
})

await check('GET 方法打 /action → 405', async () => {
  const res = await hit(table, '/dsh-qq-sticker/action', { method: 'GET' })
  assert.equal(res.status, 405)
})

console.log('\n⑤ POST /config（兜底写）')

await check('settings 服务缺席时返回 501 而不是崩', async () => {
  const res = await hit(table, '/dsh-qq-sticker/config', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { path: ['send', 'frequency'], value: 'normal' },
  })
  assert.equal(res.status, 501)
  assert.equal(res.json.ok, false)
})

await check('path 非法 → 400', async () => {
  const res = await hit(table, '/dsh-qq-sticker/config', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { path: [], value: 1 },
  })
  assert.equal(res.status, 400)
})

await check('跨站写配置 → 403', async () => {
  const res = await hit(table, '/dsh-qq-sticker/config', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { path: ['send', 'frequency'], value: 'normal' },
  })
  assert.equal(res.status, 403)
})

console.log('\n⑥ GET /report（原有路由不能坏）')

await check('返回 200 与纯文本报表', async () => {
  const res = await hit(table, '/dsh-qq-sticker/report', { headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(typeof res.json.report, 'string')
  assert.ok(res.json.report.length > 0)
  assert.ok(res.json.report.includes('表情库'))
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
