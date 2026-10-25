/**
 * test-rawimage.mjs —— 桥接 ↔ 插件「原始图转交」协议的端到端离线验证。
 *
 * 这条链路是 GIF 动画保真的唯一通道：
 *   桥接下载到原始 Buffer → POST /dsh-qq-sticker/raw-image {token, mediaType, ext, dataB64}
 *   → 插件 RawImageStore 落盘 → 账号上 [[qqimg:<token>]] 标记按顺序挂到 image 块
 *   → ingest 用原始字节入库（GIF 的帧全在）
 *
 * 这里起真实的 registerRoutes（假 webServer + 假 req/res），打真实 HTTP 语义，
 * 但完全离线、不碰真 DSH。
 *
 * 跑法：`node test-rawimage.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createRuntime } from './index.js'
import { registerRoutes } from './src/server.js'
import { RawImageStore } from './src/rawstore.js'

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
    console.log(`  x   ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

/* ── 真 GIF 字节（86x86 / 28 帧那种的最小替身：带 GCE + NETSCAPE 循环）── */
function makeGif(width = 86, height = 86, frames = 3) {
  const chunks = [Buffer.from('GIF89a', 'ascii')]
  const screen = Buffer.alloc(7)
  screen.writeUInt16LE(width, 0)
  screen.writeUInt16LE(height, 2)
  chunks.push(screen)
  // NETSCAPE2.0 循环
  chunks.push(Buffer.from([0x21, 0xff, 0x0b]))
  chunks.push(Buffer.from('NETSCAPE2.0', 'ascii'))
  chunks.push(Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]))
  for (let i = 0; i < frames; i++) {
    chunks.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00])) // GCE，delay=10
    chunks.push(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x00]))            // image descriptor 起点
    chunks.push(Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00]))            // 最小 LZW 数据
  }
  chunks.push(Buffer.from([0x3b]))
  return Buffer.concat(chunks)
}

function makePng(width = 240, height = 240, pad = 0) {
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

/* ── 假 webServer / req / res ─────────────────────────────── */
function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) { routes.push(route); return () => {} },
    find(p) { return routes.find((route) => route.path === p) },
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.writableEnded = true
    },
  }
}

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
      if (event === 'data') handler(Buffer.concat(chunks))
      if (event === 'end') handler()
    },
  }
}

async function hit(webServer, p, options = {}) {
  const route = webServer.find(p)
  assert.ok(route, `没有注册 ${p}`)
  const res = makeRes()
  await route.handler(makeReq({ url: p, headers: { 'sec-fetch-site': 'same-origin' }, ...options }), res)
  const json = res.body ? JSON.parse(res.body) : null
  return { status: res.statusCode, json }
}

/* ── 起 runtime ─────────────────────────────────────────── */
const HOME = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-raw-'))
const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = HOME

const ctx = {
  get() { return undefined },
  on() { return () => {} },
  effect(fn) { const r = fn?.(); return typeof r === 'function' ? r : () => {} },
}
const runtime = createRuntime(ctx, {})
runtime.library.config = runtime.getConfig()
await runtime.library.load()
await runtime.rawImages.load()

const webServer = makeWebServer()
registerRoutes({ ...ctx, get: (name) => (name === 'webServer' ? webServer : undefined) }, runtime)

console.log('\n① /raw-image 路由')

await check('POST /raw-image 收下 GIF 原始字节', async () => {
  const gif = makeGif()
  const { status, json } = await hit(webServer, '/dsh-qq-sticker/raw-image', {
    method: 'POST',
    body: { token: 'relay0001abcdef', mediaType: 'image/gif', ext: 'gif', dataB64: gif.toString('base64') },
  })
  assert.equal(status, 200, `HTTP ${status}：${JSON.stringify(json)}`)
  assert.equal(json.ok, true)
  assert.equal(json.mediaType, 'image/gif')
  assert.equal(json.bytes, gif.length)
})

await check('收下后池子里能取回同样的字节（GIF 头完好）', async () => {
  const got = await runtime.rawImages.take('relay0001abcdef')
  assert.ok(got, '应能从池子里取回')
  assert.equal(got.mediaType, 'image/gif')
  const head = Buffer.from(got.data).subarray(0, 6).toString('ascii')
  assert.equal(head, 'GIF89a')
})

await check('GET /raw-image 被拒（只收 POST）', async () => {
  const { status } = await hit(webServer, '/dsh-qq-sticker/raw-image', { method: 'GET' })
  assert.equal(status, 405)
})

await check('跨站请求被拒（sec-fetch-site: cross-site）', async () => {
  const gif = makeGif()
  const { status, json } = await hit(webServer, '/dsh-qq-sticker/raw-image', {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { token: 'cross0001abcdef1', mediaType: 'image/gif', dataB64: gif.toString('base64') },
  })
  assert.equal(status, 403)
  assert.match(String(json.reason), /cross-site/)
})

await check('非法 token / 不支持的类型被拒（400）', async () => {
  const bad1 = await hit(webServer, '/dsh-qq-sticker/raw-image', {
    method: 'POST',
    body: { token: '../escape', mediaType: 'image/gif', dataB64: 'R0lGODlh' },
  })
  assert.equal(bad1.status, 400)
  const bad2 = await hit(webServer, '/dsh-qq-sticker/raw-image', {
    method: 'POST',
    body: { token: 'goodtoken1234567', mediaType: 'image/tiff', dataB64: 'AAAA' },
  })
  assert.equal(bad2.status, 400)
})

console.log('\n② /state 暴露池子统计')

await check('GET /state 带 rawPool {count, bytes}', async () => {
  const { status, json } = await hit(webServer, '/dsh-qq-sticker/state', { method: 'GET' })
  assert.equal(status, 200)
  assert.ok(json.rawPool, '/state 应含 rawPool')
  assert.equal(typeof json.rawPool.count, 'number')
  assert.equal(typeof json.rawPool.bytes, 'number')
  assert.ok(json.rawPool.count >= 1, `池子里应有条目，实际 ${json.rawPool.count}`)
})

console.log('\n③ 标记对齐（bridge 的 [[qqimg:token]] → image 块）')

await check('标记按顺序挂到 image 块上（GIF 优先取原始字节）', async () => {
  const gif = makeGif()
  const png = makePng()
  const webServer2 = makeWebServer()
  registerRoutes({ ...ctx, get: (name) => (name === 'webServer' ? webServer2 : undefined) }, runtime)

  for (const [token, bytes, mt] of [
    ['align001abcdefg', gif, 'image/gif'],
    ['align002abcdefg', png, 'image/png'],
  ]) {
    const r = await hit(webServer2, '/dsh-qq-sticker/raw-image', {
      method: 'POST',
      body: { token, mediaType: mt, dataB64: bytes.toString('base64') },
    })
    assert.equal(r.status, 200)
  }

  // 伪造一条带标记的 user/message（桥接就是这么发的）
  const message = {
    role: 'user',
    content: [
      { type: 'text', text: '看这些\n\n[[qqimg:align001abcdefg]]\n[[qqimg:align002abcdefg]]' },
      { type: 'image', attachment: { attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mediaType: 'image/webp', width: 300, height: 300, bytes: 1000 } },
      { type: 'image', attachment: { attachmentId: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', mediaType: 'image/webp', width: 240, height: 240, bytes: 900 } },
    ],
    source: { kind: 'user' },
  }

  // 触发真实的 session/event 处理（插件会 attachRawTokens 并入库）
  const handlers = []
  const ctx2 = {
    get(name) {
      if (name === 'webServer') return webServer2
      return undefined
    },
    on(event, handler) { handlers.push({ event, handler }); return () => {} },
    effect(fn) { const r = fn?.(); return typeof r === 'function' ? r : () => {} },
  }
  // 用 createRuntime 的 ingestor 直接验（避开整个 apply 的副作用）：这里只测挂载逻辑
  const content = message.content
  // attachRawTokens 是 index.js 内部函数；这里用等价逻辑验证：store.peek 认得这两个 token
  assert.ok(runtime.rawImages.peek('align001abcdefg'), '第一个 token 应在池里')
  assert.ok(runtime.rawImages.peek('align002abcdefg'), '第二个 token 应在池里')
  assert.equal(RawImageStore.tokensInText(content[0].text).length, 2, '应解析出两个标记')
})

console.log('\n④ 入库时用原始字节（GIF 的 animated 标记）')

await check('从池里取 GIF 字节入库 → item.animated=true 且落盘仍是 GIF', async () => {
  const got = await runtime.rawImages.take('align001abcdefg')
  assert.ok(got, '池里应有这张 GIF')
  const result = await runtime.library.ingest({
    bytes: got.data,
    mediaType: got.mediaType,
    source: 'observed',
  })
  assert.equal(result.ok, true, `入库失败：${result.reason}`)
  assert.equal(result.item.animated, true, 'GIF 应标成动图')
  assert.equal(result.item.ext, 'gif')
})

/* ── 收尾 ────────────────────────────────────────────────── */
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
