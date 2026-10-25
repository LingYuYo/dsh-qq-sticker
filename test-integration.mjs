/**
 * 集成用例：用**假 Cordis ctx** 跑一遍插件装配与事件流。
 *
 * 与 test-offline.mjs 的分工：
 *   · test-offline  测纯逻辑（库/闸/评分/解析）；
 *   · 这个文件  测**接线**：apply → agent/created → 工具注册 → session/event 收图
 *     → prompt context 注册 → agent/disposed 清理 → state/库落盘。
 *
 * 仍然不联网、不 spawn、不碰真 DSH：所有宿主服务都是最小假实现。
 *
 * 跑：`node test-integration.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply, resolveDataDir } from './index.js'
import { DEFAULTS } from './src/config.js'
import { TOOL_NAMES } from './src/tools.js'
import { emptyState } from './src/gate.js'
import { sha1 } from './src/util.js'
import { dimensionsOf } from './src/library.js'

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

/**
 * 假 Cordis ctx。
 *
 * 提供插件真正会用到的那几个面：get()（服务查找）、on()（事件）、effect()（生命周期）、
 * timer.interval()。services 里可以塞 agents/attachments/llm/sessions/sessionPersistence。
 */
function makeCtx(services = {}) {
  const handlers = new Map()
  const effects = []
  const disposers = []
  return {
    services,
    handlers,
    effects,
    disposers,
    get(name) { return this.services[name] },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      const dispose = () => {
        const current = handlers.get(event) ?? []
        const idx = current.indexOf(handler)
        if (idx >= 0) current.splice(idx, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    effect(fn, label) {
      const result = typeof fn === 'function' ? fn() : undefined
      const dispose = typeof result === 'function' ? result : () => { }
      effects.push({ label, dispose })
      return dispose
    },
    timer: {
      interval(callback, delay) {
        const id = setInterval(callback, delay)
        id.unref?.()
        return () => clearInterval(id)
      },
    },
    /** 触发某事件的所有监听器。 */
    emit(event, ...args) {
      for (const handler of this.handlers.get(event) ?? []) {
        try { handler(...args) } catch (error) { console.log(`    (handler ${event} 抛错：${error?.message})`) }
      }
    },
    /** 全部清理（模拟插件卸载）。 */
    async teardown() {
      for (const item of [...effects].reverse()) {
        try { item.dispose?.() } catch { /* ignore */ }
      }
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* ignore */ }
      }
    },
  }
}

/** 假 agent：带自己的 ctx（有 tools.register 与 systemPrompt.context）。 */
function makeAgent({ id = 'session-1', preset = 'qq-chat', ctx } = {}) {
  const registered = []
  const contexts = []
  const agentDisposers = []
  const agentCtx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            registered.push(definition)
            const dispose = () => {
              const idx = registered.indexOf(definition)
              if (idx >= 0) registered.splice(idx, 1)
            }
            agentDisposers.push(dispose)
            return dispose
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          context(spec) {
            contexts.push(spec)
            const dispose = () => {
              const idx = contexts.indexOf(spec)
              if (idx >= 0) contexts.splice(idx, 1)
            }
            agentDisposers.push(dispose)
            return dispose
          },
        }
      }
      if (name === 'agentPresets') {
        return { composedPreset: (agentContext) => (agentContext === this ? preset : undefined) }
      }
      return ctx?.get?.(name)
    },
    tools: null,
  }
  agentCtx.tools = agentCtx.get('tools')
  const agent = {
    id,
    session: { header: { id, agentPreset: preset, cwd: 'D:\\work' } },
    ctx: agentCtx,
  }
  return { agent, registered, contexts, disposers: agentDisposers }
}

/** 假附件服务：内存里存图，readImage 按 ref 取回。尺寸按真实图片解析（与真服务同语义）。 */
function makeAttachments() {
  const store = new Map()
  let seq = 0
  return {
    store,
    imageLimits: { maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 10, maxMessageImageBytes: 20 * 1024 * 1024, maxImagePixels: 40_000_000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveImage({ data, mediaType, name }) {
      const attachmentId = `sha256:${sha1(Buffer.from(data))}`
      store.set(attachmentId, { data, mediaType, name })
      seq++
      const ext = mediaType === 'image/gif' ? 'gif' : 'png'
      const dim = dimensionsOf(Buffer.from(data), ext)
      return {
        attachmentId,
        mediaType,
        bytes: data.length,
        width: dim.width,
        height: dim.height,
        name: name ?? `img-${seq}`,
      }
    },
    async readImage(ref) {
      const hit = store.get(ref.attachmentId)
      if (!hit) throw new Error(`没有这个附件：${ref?.attachmentId}`)
      return { ref: { ...ref, mediaType: hit.mediaType, bytes: hit.data.length }, data: hit.data }
    },
    async validateImage() { },
    imageHostPath() { return undefined },
    async readImageRequest() { throw new Error('not implemented in fake') },
  }
}

/** 假 llm：记录请求，返回固定 JSON（模拟识图）。 */
function makeLlm({ reply } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    async prepareCall({ provider, model }) {
      return {
        config: { provider, model },
        retryPolicy: {},
        stream(options) { return makeLlm().stream(options) },
      }
    },
    async *stream(options) {
      calls.push(options)
      const text = reply ?? '[]'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (const ch of String(text).match(/.{1,8}/gs) ?? []) {
        yield { type: 'text-delta', index: 0, text: ch }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const tempDirs = []
async function withPlugin(fn, { services = {}, config = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-it-'))
  tempDirs.push(dir)
  // 插件从 $DSH_HOME 推数据目录 → 用临时 DSH_HOME 把它指到沙箱
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  const ctx = makeCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
    ...services,
  })
  try {
    const result = apply(ctx, { ...DEFAULTS, ...config })
    // 等初始化（库/state 是异步读盘）
    await sleep(120)
    return await fn({ ctx, result, runtime: result.runtime, dataDir: resolveDataDir(), dir })
  } finally {
    await ctx.teardown()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

console.log('== 装配 / 生命周期')

await check('apply 返回 runtime 与 tools 快照', async () => {
  await withPlugin(async ({ result }) => {
    assert.ok(result.runtime, '应返回 runtime')
    assert.equal(typeof result.tools, 'function')
    assert.ok(Array.isArray(result.tools()))
  })
})

await check('初始状态：数据目录建在 $DSH_HOME/plugin-data 下，库为空', async () => {
  await withPlugin(async ({ runtime, dataDir, dir }) => {
    assert.ok(dataDir.startsWith(dir), `数据目录应在临时 DSH_HOME 下：${dataDir}`)
    const fs = await import('node:fs/promises')
    const entries = await fs.readdir(dataDir)
    assert.ok(entries.includes('images'), `应建好 images 目录，实际 ${entries.join(',')}`)
    const { result } = { result: { runtime } }
    assert.equal(result.runtime.library.size, 0)
  }, {})
})

await check('agent/created：非 qq-chat 的会话不注册任何工具', async () => {
  await withPlugin(async ({ ctx }) => {
    const { agent, registered, contexts } = makeAgent({ preset: 'minimal' })
    ctx.emit('agent/created', { agent, source: 'user' })
    await sleep(120)
    assert.equal(registered.length, 0, '非目标 preset 不该注册工具')
    assert.equal(contexts.length, 0, '非目标 preset 不该注册 context')
  })
})

await check('agent/created：qq-chat 会话注册 11 个工具 + 1 个 required context', async () => {
  await withPlugin(async ({ ctx }) => {
    const { agent, registered, contexts } = makeAgent({ preset: 'qq-chat' })
    ctx.emit('agent/created', { agent, source: 'user' })
    await sleep(200)
    assert.equal(registered.length, 11, `应注册 11 个工具，实际 ${registered.length}`)
    const names = registered.map((def) => def.name).sort()
    assert.deepEqual(names, [...TOOL_NAMES].sort())
    for (const def of registered) {
      assert.match(def.name, /^qq_ext_sticker_//* test-prefix */)
    }
    assert.equal(contexts.length, 1, '应注册 1 个候选 context')
    const spec = contexts[0]
    assert.equal(spec.required, true, 'context 必须 required:true（否则会被 complete 人设挤掉）')
    assert.equal(spec.name, 'dsh-qq-sticker/candidates')
    assert.equal(typeof spec.text, 'function')
  })
})

await check('候选 context 的 text() 真的能算出文本（库空时为空串）', async () => {
  await withPlugin(async ({ ctx }) => {
    const { agent, contexts } = makeAgent({ preset: 'qq-chat' })
    ctx.emit('agent/created', { agent })
    await sleep(200)
    const spec = contexts[0]
    assert.equal(spec.text(), '', '空库不应注入任何文本')
  })
})

await check('agent/disposed：清掉工具与 context 注册', async () => {
  await withPlugin(async ({ ctx }) => {
    const { agent, registered, contexts } = makeAgent({ preset: 'qq-chat' })
    ctx.emit('agent/created', { agent })
    await sleep(200)
    assert.equal(registered.length, 11)
    ctx.emit('agent/disposed', { agent })
    await sleep(20)
    assert.equal(registered.length, 0, 'agent 退役后工具应被注销')
    assert.equal(contexts.length, 0, 'agent 退役后 context 应被注销')
  })
})

console.log('\n== session/event：实时收图')

await check('一条带图的 user/message 会被收进库', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    const attachments = makeAttachments()
    ctx.services.attachments = attachments
    runtime.attachments = attachments
    const bytes = makePng(48, 48, 999)
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'x.png' })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看这个 [图片]' },
            { type: 'image', attachment: ref },
          ],
          source: { kind: 'user' },
        },
      },
    })
    // 后台收图是异步的，等它落库
    for (let i = 0; i < 40 && runtime.library.size === 0; i++) await sleep(50)
    assert.equal(runtime.library.size, 1, '图应被收进库')
    const item = runtime.library.items[0]
    assert.equal(item.ext, 'png')
    assert.equal(item.width, 48)
    assert.equal(item.height, 48)
    assert.equal(item.sessionId, 'session-1')
    assert.match(item.srcHint, /看这个/)
  })
})

await check('超大照片（stickerOnly 下）不会被收', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    const attachments = makeAttachments()
    ctx.services.attachments = attachments
    runtime.attachments = attachments
    // 上限已从 640px 放宽到 1920px：这里用 2400px 才构成"照片"
    const ref = await attachments.saveImage({ data: makePng(2400, 2000), mediaType: 'image/png', name: 'photo.png' })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } } },
    })
    await sleep(250)
    assert.equal(runtime.library.size, 0, '大图不该被当成表情收进来')
  })
})

await check('放宽后 1920px 内的图会被收（以前 640px 上限会误杀）', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    const attachments = makeAttachments()
    ctx.services.attachments = attachments
    runtime.attachments = attachments
    const ref = await attachments.saveImage({ data: makePng(1800, 1700), mediaType: 'image/png', name: 'big-sticker.png' })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'image', attachment: ref }], source: { kind: 'user' } } },
    })
    await sleep(250)
    assert.equal(runtime.library.size, 1, '1920px 内的图应该被收进来')
  })
})

await check('collect.enabled=false 时完全不收图', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    const attachments = makeAttachments()
    ctx.services.attachments = attachments
    runtime.attachments = attachments
    runtime.library.config = runtime.getConfig()
    const ref = await attachments.saveImage({ data: makePng(32, 32, 7), mediaType: 'image/png', name: 'x.png' })
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'image', attachment: ref }] } },
    })
    await sleep(200)
    assert.equal(runtime.library.size, 0)
  }, { config: { collect: { ...DEFAULTS.collect, enabled: false } } })
})

await check('会话窗口会记住人类消息（活跃度用）', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    ctx.emit('session/event', { id: 'session-1' }, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
    })
    assert.equal(runtime.tracker.humanCount('session-1'), 1)
  })
})

console.log('\n== 工具执行（真实调用链）')

await check('pick → send：完整走通（发送走假 qq_send_image）', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    // 先塞一张图进库
    const { item } = await runtime.library.ingest({ bytes: makePng(64, 64, 5) })
    runtime.library.annotate(item, { tags: ['开心'], note: '笑一个' })
    await runtime.library.flush()

    // 假 tools 服务：qq_send_image 返回成功
    const sent = []
    ctx.services.tools = {
      async execute(input) {
        sent.push(input)
        return { isError: false, value: { queued: true, sent: true, id: 'op-1', detail: '已发送图片（via=file）' }, content: [] }
      },
    }
    const agent = { id: 'session-1', session: { header: { id: 'session-1', agentPreset: 'qq-chat' } }, ctx: makeAgent({ preset: 'qq-chat' }).ctx }
    const defs = await runtime.toolsPromise ?? (async () => runtime.toolDefs)()
    const pick = (runtime.toolDefs.length ? runtime.toolDefs : await waitFor(async () => runtime.toolDefs.length > 0 && runtime.toolDefs))
    const pickDef = pick.find((def) => def.name === 'qq_ext_sticker_pick')
    const sendDef = pick.find((def) => def.name === 'qq_ext_sticker_send')
    const candidates = await pickDef.execute({ limit: 3 }, { agent })
    assert.equal(candidates.candidates.length, 1)
    const id = candidates.candidates[0].id

    const result = await sendDef.execute({ stickerId: id }, { agent, signal: AbortSignal.timeout(5000) })
    assert.equal(result.sent, true)
    assert.equal(sent.length, 1, '应调用一次 qq_send_image')
    assert.equal(sent[0].name, 'qq_send_image')
    assert.match(sent[0].arguments.file, /^file:\/\//)
    // 记账生效
    assert.equal(item.sentCount, 1)
    assert.equal(runtime.state().sentToday, 1)
  })
})

await check('send：额度用满时抛可读错误（带"别重试"引导）', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    const { item } = await runtime.library.ingest({ bytes: makePng(64, 64, 6) })
    ctx.services.tools = { async execute() { return { isError: false, value: { sent: true, detail: 'ok' } } } }
    // 把今日额度用满
    runtime.state().sentDay = todayOf()
    runtime.state().sentToday = 5
    runtime.state().sessions['session-1'] = {
      day: todayOf(), sentToday: 30, lastAt: 0, sentTotal: 30, lastStickerAt: 0, recentIds: [], recentAt: [],
    }
    const agent = { id: 'session-1', ctx: makeAgent({ preset: 'qq-chat' }).ctx }
    const defs = await waitFor(async () => runtime.toolDefs.length > 0 && runtime.toolDefs)
    const sendDef = defs.find((def) => def.name === 'qq_ext_sticker_send')
    const { shortId } = await import('./src/library.js')
    const id = shortId(item)
    await assert.rejects(
      () => sendDef.execute({ stickerId: id }, { agent }),
      /用文字回应|不要重试/,
    )
  }, { config: { send: { ...DEFAULTS.send, frequency: 'rare', dailyLimit: 5, globalIntervalSec: 0, minIntervalSec: 0 } } })
})

await check('list：返回库内容行', async () => {
  await withPlugin(async ({ runtime }) => {
    const { item } = await runtime.library.ingest({ bytes: makePng(40, 40, 8) })
    runtime.library.annotate(item, { tags: ['无奈'], note: '摊手', text: '算了' })
    const defs = await waitFor(async () => runtime.toolDefs.length > 0 && runtime.toolDefs)
    const listDef = defs.find((def) => def.name === 'qq_ext_sticker_list')
    const out = await listDef.execute({ limit: 10 }, {})
    assert.equal(out.total, 1)
    assert.equal(out.shown, 1)
    assert.match(out.lines[0], /无奈/)
    assert.match(out.lines[0], /算了/)
  })
})

await check('tag：写标签并做闭合词表对齐', async () => {
  await withPlugin(async ({ runtime }) => {
    const { item } = await runtime.library.ingest({ bytes: makePng(40, 40, 9) })
    const defs = await waitFor(async () => runtime.toolDefs.length > 0 && runtime.toolDefs)
    const tagDef = defs.find((def) => def.name === 'qq_ext_sticker_tag')
    const out = await tagDef.execute({
      stickerId: (await import('./src/library.js')).shortId(item),
      tags: ['高兴'],       // 别名 → 开心
      note: '笑一个',
      text: '哈哈',
    }, {})
    assert.deepEqual(out.tags, ['开心'])
    assert.equal(item.note, '笑一个')
  })
})

await check('stats：报表文本包含库概况', async () => {
  await withPlugin(async ({ runtime }) => {
    await runtime.library.ingest({ bytes: makePng(40, 40, 10) })
    const defs = await waitFor(async () => runtime.toolDefs.length > 0 && runtime.toolDefs)
    const statsDef = defs.find((def) => def.name === 'qq_ext_sticker_stats')
    const out = await statsDef.execute({}, {})
    assert.match(out.report, /表情库：1 张/)
    assert.match(out.report, /没有互动统计|带动气氛/)
  })
})

console.log('\n== 落盘')

await check('库与 state 会写进 plugin-data 目录', async () => {
  await withPlugin(async ({ runtime, dataDir }) => {
    await runtime.library.ingest({ bytes: makePng(40, 40, 11) })
    runtime.state().sentDay = '2026-10-25'
    runtime.state().sentToday = 3
    runtime.markStateDirty()
    await runtime.library.flush()
    await runtime.flushState()
    const libRaw = JSON.parse(await readFile(path.join(dataDir, 'library.json'), 'utf8'))
    assert.equal(libRaw.items.length, 1)
    assert.equal(libRaw.version, 1)
    const stateRaw = JSON.parse(await readFile(path.join(dataDir, 'state.json'), 'utf8'))
    assert.equal(stateRaw.sentToday, 3)
  })
})

console.log('\n== 卸载')

await check('卸载时 flush 不抛错（不留下未处理的 rejection）', async () => {
  await withPlugin(async ({ ctx, runtime }) => {
    await runtime.library.ingest({ bytes: makePng(20, 20, 12) })
    await ctx.teardown()
    await sleep(50)
  })
})

// ───────────────────────────────────────────────────────────── 辅助

function todayOf() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 轮询等一个条件（最多 2s），返回最终值。 */
async function waitFor(fn, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(25)
  }
  return fn()
}

// 收尾：清临时目录
for (const dir of tempDirs) {
  try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`- ${item.name}: ${item.error?.message ?? item.error}`)
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
