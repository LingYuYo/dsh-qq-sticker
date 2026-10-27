/**
 * client.js 面板的离线回归（不联网、不碰真 DSH）。
 *
 * 做法：用 vm 造一个假 browser 环境（window.__ModuleLoader__ + 假 React），
 * 把 client.js 原样加载进来，然后：
 *   · 断言槽位注册（sidebar.panellist 的 id / order / label；main 的 key）
 *   · 断言 inject 三个声明齐全
 *   · 递归展开函数组件，检查三个 Tab 的结构、动作卡、危险区、设置分区
 *   · 模拟轮询 / 动作 POST / 清空确认，断言请求形状与状态转换
 *   · 扫描 CSS：类名全部 qqs- 前缀、颜色只用 --dsw-alias-* 令牌或 color-mix
 *
 * 跑：`node test-panel-client.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

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

function section(title) {
  console.log(`\n${title}`)
}

/* ════════════════════════════════════════════════════════════
   假 React
   ────────────────────────────────────────────────────────────
   · useState / useRef 按「组件路径 + hook 序号」持久化，跨多次渲染保留；
   · useEffect 带 dep 比较，同一路径同一序号 dep 不变就不重跑 (unmount 时跑 cleanup)；
   · createElement 只产普通对象，函数组件的展开由 expand() 负责。
   ════════════════════════════════════════════════════════════ */

const hookStore = new Map()      // `${path}#${index}` → 值 / ref 对象
const effectStore = new Map()    // `${path}#${index}` → { deps, cleanup }
let renderPath = 'root'
let cursor = 0
let pendingEffects = []

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 0 ? (props?.children ?? []) : children },
    $$key: props?.key,
  }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const slot = `${renderPath}#${cursor++}`
    if (!hookStore.has(slot)) hookStore.set(slot, typeof initial === 'function' ? initial() : initial)
    const setter = (next) => {
      const current = hookStore.get(slot)
      hookStore.set(slot, typeof next === 'function' ? next(current) : next)
    }
    return [hookStore.get(slot), setter]
  },
  useEffect(fn, deps) {
    const slot = `${renderPath}#${cursor++}`
    pendingEffects.push({ slot, fn, deps })
  },
  useRef(initial) {
    const slot = `${renderPath}#${cursor++}`
    if (!hookStore.has(slot)) hookStore.set(slot, { current: initial })
    return hookStore.get(slot)
  },
  useMemo(fn) { cursor++; return fn() },
  useCallback(fn) { cursor++; return fn },
}

/** 展开函数组件，得到纯 HTML 节点树。 */
function expand(node, path = 'root', depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}.${index}`, depth + 1))
  if (depth > 60) throw new Error('组件展开过深（可能递归）')

  if (typeof node.type === 'function') {
    const name = node.type.name || 'anon'
    const childPath = `${path}/${name}`
    const savedPath = renderPath
    const savedCursor = cursor
    renderPath = childPath
    cursor = 0
    let rendered
    try {
      rendered = node.type(node.props)
    } finally {
      renderPath = savedPath
      cursor = savedCursor
    }
    return expand(rendered, childPath, depth + 1)
  }

  // 普通 HTML 节点：递归展开 children
  if (node.props?.children !== undefined) {
    return {
      ...node,
      props: {
        ...node.props,
        children: expand(node.props.children, `${path}/*`, depth + 1),
      },
    }
  }
  return node
}

/** 先展开，再把 effect 跑一遍（只跑 dep 变了的）。 */
function renderTree(component, props) {
  pendingEffects = []
  const tree = expand(React.createElement(component, props))
  for (const { slot, fn, deps } of pendingEffects) {
    const prev = effectStore.get(slot)
    const same = prev && deps !== undefined
      && Array.isArray(prev.deps) && prev.deps.length === deps.length
      && prev.deps.every((value, index) => value === deps[index])
    if (same) continue
    try { prev?.cleanup?.() } catch { /* ignore */ }
    const cleanup = fn()
    effectStore.set(slot, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined })
  }
  return tree
}

/** 深度查找节点（要处理嵌套数组：h(div, props, arrayOfChildren) 会留一层数组）。 */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  const children = node.props?.children
  if (children !== undefined) findAll(children, predicate, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}

const classOf = (node) => String(node?.props?.className ?? '')
/** 类名可能是多个 token（'qqs-row qqs-row-block'），按 token 判断而不是全等。 */
const hasToken = (node, token) => classOf(node).split(/\s+/).includes(token)
const allClassTokens = (tree) => findAll(tree, (node) => node.props?.className)
  .flatMap((node) => classOf(node).split(/\s+/).filter(Boolean))

/* ════════════════════════════════════════════════════════════
   假浏览器 + 假 fetch
   ════════════════════════════════════════════════════════════ */

const fetchLog = []
const actionJobs = []
let fetchMode = 'ok'      // 'ok' | 'state-fail'

const STATE = {
  ok: true,
  enabled: true,
  library: { total: 12, visible: 10, hidden: 2, tagged: 7, untagged: 5, animated: 1, meaningless: 2, bytes: 3145728, freedMB: 3 },
  limits: { maxCount: 500, maxTotalMB: 200, maxItemMB: 6 },
  send: { frequency: 'occasional', dailyLimit: 40, usedToday: 3, sentTotal: 88 },
  collect: {
    enabled: true, everyHours: 12, nextRunAt: Date.now() + 3600_000, nextRunInMin: 60,
    lastRunAt: Date.now() - 7200_000,
    // ⚠️ 真实形状是对象（collect.js 的 summarizeResult），不是字符串。
    //    这条数据专门用来防「String(对象) 渲染成 [object Object]」的回归。
    lastResult: { ok: true, at: Date.now() - 7200_000, collected: 4, already: 2, failed: 0, considered: 9, stopReason: '' },
  },
  ingest: { queued: 0, draining: false },
  reward: { pending: 0, lastBaseRewardAt: 0 },
  vision: { ok: true, reason: '' },
  tools: ['qq_ext_sticker_pick', 'qq_ext_sticker_send', 'qq_ext_sticker_organize'],
  dataDir: 'C:\\Users\\1\\.dsh\\plugin-data\\dsh-qq-sticker',
  // v2 新增字段：概览页会读它们，缺了就是白屏或 [undefined]
  store: {
    dataDir: 'C:\\Users\\1\\.dsh\\plugin-data\\dsh-qq-sticker',
    defaultDataDir: 'C:\\Users\\1\\.dsh\\plugin-data\\dsh-qq-sticker',
    configured: '', custom: false, note: '',
  },
  backup: {
    enabled: true, at: '06:00',
    nextRunAt: Date.now() + 3600_000, nextRunInMin: 60,
    lastRunAt: 0, backups: [],
  },
  proactive: {
    enabled: true, mode: 'serial', probability: 0.25, stickerOnly: true,
    embedMode: false, maxPerTurn: 1, idleTurns: 2, model: '',
    expectedPerDay: 50,
    battle: {
      joinEnabled: true, joinWindowSec: 30, joinThreshold: 3,
      burstEnabled: true, burstCount: 2, burstProbability: 0.2,
      teamEnabled: false, teamBudgetPerDay: 10,
    },
    gif: { normalizeOnSend: false, marked: 0, lastMarkedAt: 0 },
  },
  rawPool: { count: 2, bytes: 82000 },
  jobs: [],
}

const CONFIG = {
  enabled: true,
  debug: false,
  library: { maxCount: 500, maxTotalMB: 200, maxItemMB: 6, blockedIds: '', hiddenIds: '' },
  collect: { enabled: true, everyHours: 12, windowMin: 30, topHours: 24, topCount: 10, maxPerHour: 10, stickerOnly: true, stickerMaxDim: 1920, stickerMaxBytes: 10485760 },
  vision: { recognizeOnIngest: true, ingestBudgetPerDay: 20, autoTagAfterScan: true, organizeBatchSize: 4, organizeMaxAttempts: 2, organizeOnTagFail: 'delete', providerId: '', model: '' },
  send: { frequency: 'occasional', minIntervalSec: 30, globalIntervalSec: 15, dailyLimit: 40, keepRecentCount: 5, showTextInContext: true, sendAsSticker: true, subType: 1, imagePosition: 'after', adminOnly: true, adminIds: '' },
  prompt: { encourage: 3, maxCandidates: 8, candidatesLevel: 'compact', blockOtherSticker: true },
  maintenance: { deleteOldestCount: 25, deleteOldestKeep: 10 },
  // v2 段：设置页会读它们
  store: { dataDir: '' },
  proactive: {
    enabled: false, mode: 'serial', probability: 0.25, stickerOnly: true,
    embedMode: false, maxPerTurn: 1, idleTurns: 2, model: '',
  },
  battle: {
    joinEnabled: true, joinWindowSec: 30, joinThreshold: 3,
    burstEnabled: true, burstCount: 2, burstProbability: 0.2,
    teamEnabled: false, teamBudgetPerDay: 10,
  },
  backup: { enabled: false, at: '06:00', dir: '', keep: 7, deflate: false },
  gif: { normalizeOnSend: false },
}

/** 模型目录：给「视觉模型 / 意图分析模型」的真下拉用。 */
const CATALOG = {
  default: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
  routableProviders: ['opencode-go', 'trae'],
  groups: [
    {
      id: 'opencode-go', name: 'opencode-go',
      models: [
        { id: 'deepseek-v4-flash-vision-exp', name: 'deepseek-v4-flash-vision-exp' },
        { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
      ],
    },
    { id: 'trae', name: 'TRAE (字节)', models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] },
  ],
}

/** Host Schema 信封：拿一份够用的 refs 树，顶层 dict 决定「界面认不认得这个段」。 */
function makeSchemaEnvelope(topKeys) {
  const keys = topKeys ?? Object.keys(CONFIG)
  const dict = {}
  let uid = 100
  for (const key of keys) dict[key] = uid++
  return { uid: 999, refs: { 999: { type: 'object', meta: { default: {} }, dict } } }
}

const fakeDocument = {
  visibilityState: 'visible',
  head: {
    children: [],
    appendChild(node) { this.children.push(node) },
    removeChild(node) { this.children = this.children.filter((item) => item !== node) },
  },
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '', remove() {} }
  },
}

const sandbox = {
  window: { __ModuleLoader__: { load: ({ id, factory }) => { fakeLoadId = id; clientModule = factory(() => React) } } },
  document: fakeDocument,
  console: { ...console, error: () => {}, warn: () => {} },
  setTimeout: (fn, ms) => {
    const id = timers.length + 1
    timers.push({ fn, ms, cancelled: false, id })
    return id
  },
  clearTimeout: (id) => { const timer = timers[id - 1]; if (timer) timer.cancelled = true },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async (url, init) => {
    const target = String(url)
    fetchLog.push({ url: target, method: init?.method ?? 'GET', body: init?.body, signal: init?.signal })
    if (target.endsWith('/state')) {
      if (fetchMode === 'state-fail') return { ok: false, status: 500, json: async () => ({ ok: false, reason: 'boom' }) }
      return { ok: true, status: 200, json: async () => STATE }
    }
    if (target.endsWith('/config')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, config: CONFIG }) }
    }
    if (target.endsWith('/action')) {
      const body = JSON.parse(init.body)
      const job = {
        id: `job-${actionJobs.length + 1}`,
        kind: body.kind,
        label: body.kind,
        status: 'running',
        startedAt: Date.now(),
        endedAt: 0,
        progress: { done: 0, total: 0, label: '' },
        result: null,
        error: null,
      }
      actionJobs.push({ kind: body.kind, args: body.args, job })
      return { ok: true, status: 200, json: async () => ({ ok: true, job }) }
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) }
  },
  AbortController,
  Date, Math, JSON, Number, String, Array, Object, Map, Set, Promise, Error, RegExp,
  parseFloat, parseInt, isNaN, Infinity,
}

let fakeLoadId = ''
let clientModule
const timers = []

vm.createContext(sandbox)
vm.runInContext(SOURCE, sandbox, { filename: 'client.js' })

/* ════════════════════════════════════════════════════════════
   假 ctx
   ════════════════════════════════════════════════════════════ */

function makeCtx({ withRemote = true, describe = 'ok', withSession = true, schemaTopKeys, mutateReply } = {}) {
  const registrations = []
  const effects = []
  const mutations = []
  const eventHandlers = new Map()

  const ctx = {
    get() { return undefined },
    on(event, handler) {
      const list = eventHandlers.get(event) ?? []
      list.push(handler)
      eventHandlers.set(event, list)
      return () => {}
    },
    effect(fn, label) {
      effects.push(label)
      const result = typeof fn === 'function' ? fn() : undefined
      return typeof result === 'function' ? result : () => {}
    },
    inject(deps, callback) {
      if (typeof callback === 'function') callback(ctx)
      return () => {}
    },
    slots: {
      inject(owner, callback) {
        effects.push(`inject:${owner}`)
        const dispose = typeof callback === 'function' ? callback() : undefined
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        registrations.push({ kind: 'slot', options, component })
        return () => {}
      },
    },
  }

  if (withRemote) {
    ctx.remote = {
      settings: {
        describe: async () => {
          if (describe === 'fail') return { ok: false, error: { code: 'denied', message: 'permission denied' } }
          if (describe === 'missing-ns') {
            return { ok: true, value: { namespaces: [{ ns: 'other', revision: 1, value: {} }] } }
          }
          return {
            ok: true,
            value: {
              namespaces: [
                { ns: 'other', revision: 1, value: {} },
                {
                  ns: 'qq-sticker', revision: 7, value: CONFIG,
                  schema: makeSchemaEnvelope(schemaTopKeys),
                },
              ],
            },
          }
        },
        mutate: async (ns, ops, revision) => {
          mutations.push({ ns, ops, revision })
          if (mutateReply) return mutateReply(ns, ops, revision)
          return { ok: true, value: { revision: revision + 1 } }
        },
      },
    }
    // inject 里声明了 remote.session，模型目录靠它
    if (withSession) {
      ctx.remote.session = {
        modelCatalog: async () => ({ ok: true, value: CATALOG }),
      }
    }
  }

  return { ctx, registrations, effects, mutations, eventHandlers }
}

/** 拿到 main 的槽位注册。 */
function mountMain(options = {}) {
  const env = makeCtx(options)
  clientModule.apply(env.ctx)
  const main = env.registrations.find((entry) => entry.kind === 'slot' && entry.options.name === 'main')
  assert.ok(main, '应注册 main 槽位')
  return { ...env, main, props: main.options.inject() }
}

/**
 * 渲染面板并等异步数据落地。
 *
 * 轮询 effect 里是 async fetch：第一次渲染拿到的是 loading 快照，
 * fetch resolve 后假 React 不会自动重渲染，所以要手动多渲一次。
 * 这里统一做「渲染 → 等微任务 → 再渲染」，直到 /state 数据出现在 props 上。
 */
async function renderPanelSettled(mount, rounds = 4) {
  hookStore.clear()
  effectStore.clear()
  fetchLog.length = 0
  let tree = renderTree(mount.main.component, mount.props)
  for (let i = 0; i < rounds; i++) {
    await settle(8)
    tree = renderTree(mount.main.component, mount.props)
  }
  await settle(8)
  return tree
}

/** 只渲染不等待（用于测初次 loading 态）。 */
function renderPanel(mount) {
  hookStore.clear()
  effectStore.clear()
  fetchLog.length = 0
  return renderTree(mount.main.component, mount.props)
}

const TAB_LABELS = {
  status: '概览',
  actions: '操作',
  config: '设置',
}

/** 点某个 Tab 后重新渲染（数据已就绪）。 */
async function openTab(tabId) {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  const tab = findAll(tree, (node) => node.props?.role === 'tab')
    .find((node) => textOf(node) === TAB_LABELS[tabId])
  assert.ok(tab, `应有「${TAB_LABELS[tabId]}」这个 Tab`)
  tab.props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  return { mount, tree }
}

/** 让微任务跑完（fetch 是 async 的）。 */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve))
}

/* ════════════════════════════════════════════════════════════
   ① 模块加载
   ════════════════════════════════════════════════════════════ */

section('① 模块加载')

await check('client.js 通过 __ModuleLoader__ 注册，id 是包名', () => {
  assert.equal(fakeLoadId, '@local/dsh-qq-sticker')
  assert.ok(clientModule, 'factory 应返回插件对象')
})

await check('inject 同时声明 slots / remote / remote.settings', () => {
  const inject = clientModule.inject
  assert.ok(Array.isArray(inject))
  for (const name of ['slots', 'remote', 'remote.settings']) {
    assert.ok(inject.includes(name), `inject 缺少 ${name}`)
  }
})

await check('apply 是函数', () => {
  assert.equal(typeof clientModule.apply, 'function')
})

/* ════════════════════════════════════════════════════════════
   ② 槽位注册
   ════════════════════════════════════════════════════════════ */

section('② 槽位注册')

await check('注册了 sidebar.panellist：id=qq-sticker、order=27、label「QQ 表情包库」', () => {
  const { ctx, registrations } = makeCtx()
  clientModule.apply(ctx)
  const sidebar = registrations.find((entry) => entry.options?.name === 'sidebar.panellist')
  assert.ok(sidebar, '应注册 sidebar.panellist')
  assert.equal(sidebar.options.id, 'qq-sticker')
  assert.equal(sidebar.options.order, 27)
  assert.equal(sidebar.options.label(), 'QQ 表情包库')
  assert.equal(typeof sidebar.component, 'function')
})

await check('注册了 main，key 与侧边栏 id 一致（否则按钮点不开面板）', () => {
  const { ctx, registrations } = makeCtx()
  clientModule.apply(ctx)
  const main = registrations.find((entry) => entry.options?.name === 'main')
  const sidebar = registrations.find((entry) => entry.options?.name === 'sidebar.panellist')
  assert.ok(main)
  assert.equal(main.options.key, 'qq-sticker')
  assert.equal(main.options.key, sidebar.options.id)
})

await check('main 的 inject 提供 remoteForm（getSnapshot/subscribe/mutate）', () => {
  const { ctx, registrations } = makeCtx()
  clientModule.apply(ctx)
  const main = registrations.find((entry) => entry.options?.name === 'main')
  const props = main.options.inject()
  assert.ok(props.remoteForm, '应注入 remoteForm')
  for (const method of ['getSnapshot', 'subscribe', 'mutate']) {
    assert.equal(typeof props.remoteForm[method], 'function', `remoteForm.${method} 应是函数`)
  }
})

await check('样式通过 ctx.effect 注册到 head，带 plugin 标记', () => {
  const { ctx } = makeCtx()
  fakeDocument.head.children.length = 0
  clientModule.apply(ctx)
  assert.ok(fakeDocument.head.children.length > 0, '应往 head 插 <style>')
  const style = fakeDocument.head.children.find((node) => node.dataset.plugin === '@local/dsh-qq-sticker')
  assert.ok(style, 'style 应带 data-plugin 标记，便于卸载时定位')
  assert.ok(style.textContent.length > 2000, `样式不应为空，实际 ${style.textContent.length} 字符`)
})

await check('侧边栏图标是 svg，active 影响描边粗细', () => {
  const { ctx, registrations } = makeCtx()
  clientModule.apply(ctx)
  const icon = registrations.find((entry) => entry.options?.name === 'sidebar.panellist').component
  const idle = icon({ size: 20, active: false })
  assert.equal(idle.type, 'svg')
  assert.equal(idle.props.width, 20)
  assert.equal(idle.props.strokeWidth, 1.7)
  assert.ok(idle.props['aria-hidden'], '图标应对读屏隐藏')
  const active = icon({ size: 24, active: true })
  assert.equal(active.props.width, 24)
  assert.equal(active.props.strokeWidth, 1.85)
})

/* ════════════════════════════════════════════════════════════
   ③ 面板壳与三个 Tab
   ════════════════════════════════════════════════════════════ */

section('③ 面板壳与三个 Tab')

await check('根节点 qqs-root，含 header 与 3 个 Tab', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  assert.equal(tree.props.className, 'qqs-root')
  const tabs = findAll(tree, (node) => node.props?.role === 'tab')
  assert.equal(tabs.length, 3, `应有 3 个 Tab，实际 ${tabs.length}`)
  assert.deepEqual(tabs.map(textOf), ['概览', '操作', '设置'])
  assert.ok(findAll(tree, (node) => classOf(node) === 'qqs-title').length === 1, '应有标题')
})

await check('tablist / tab / tabpanel 无障碍结构齐全', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const list = findAll(tree, (node) => node.props?.role === 'tablist')
  assert.equal(list.length, 1)
  assert.ok(list[0].props['aria-label'])
  const panel = findAll(tree, (node) => node.props?.role === 'tabpanel')
  assert.equal(panel.length, 1)
  assert.ok(panel[0].props['aria-labelledby'])
  const selected = findAll(tree, (node) => node.props?.role === 'tab' && node.props['aria-selected'] === 'true')
  assert.equal(selected.length, 1, '同一时刻只有一个 Tab 被选中')
  assert.equal(textOf(selected[0]), '概览')
})

await check('头部显示在线状态、总张数与今日发送数', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const sub = findAll(tree, (node) => classOf(node) === 'qqs-sub')[0]
  const text = textOf(sub)
  assert.ok(text.includes('在线'), `实际：${text}`)
  assert.ok(text.includes('12 张'), `应显示 12 张，实际：${text}`)
  assert.ok(text.includes('今日已发 3 次'), `应显示今日发送，实际：${text}`)
})

/* ════════════════════════════════════════════════════════════
   ④ 概览页
   ════════════════════════════════════════════════════════════ */

section('④ 概览页')

await check('四张统计卡：总张数 / 占用容量 / 今日发送 / 下次收集', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const values = findAll(tree, (node) => classOf(node) === 'qqs-stat-value').map(textOf)
  const labels = findAll(tree, (node) => classOf(node) === 'qqs-stat-label').map(textOf)
  assert.equal(values.length, 4, `应有 4 张统计卡，实际 ${values.length}：${JSON.stringify(labels)}`)
  assert.deepEqual(labels, ['库里的表情', '占用容量', '今日发送', '下次自动收集'])
  assert.ok(values[0].includes('12'), `总张数应为 12，实际 ${values[0]}`)
  assert.ok(values[3].includes('小时'), `下次收集应显示时长，实际 ${values[3]}`)
})

await check('容量条 role=progressbar，aria 值合法', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const bars = findAll(tree, (node) => node.props?.role === 'progressbar')
  assert.ok(bars.length >= 1, '应有容量进度条')
  const bar = bars[0]
  assert.equal(bar.props['aria-valuemin'], 0)
  assert.equal(bar.props['aria-valuemax'], 100)
  assert.ok(Number(bar.props['aria-valuenow']) >= 0)
  assert.ok(Number(bar.props['aria-valuenow']) <= 100)
})

await check('组成徽章：已打标 7 / 待打标 5 / 判无意义 2', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  // 带 tone 的 chip 类是 'qqs-chip qqs-chip-ok'，用 token 包含判断而不是全等
  const chips = findAll(tree, (node) => classOf(node).split(/\s+/).includes('qqs-chip')).map(textOf)
  assert.ok(chips.some((text) => text.includes('已打标') && text.includes('7')), `实际：${JSON.stringify(chips)}`)
  assert.ok(chips.some((text) => text.includes('待打标') && text.includes('5')))
  assert.ok(chips.some((text) => text.includes('判无意义') && text.includes('2')))
  assert.ok(chips.some((text) => text.includes('动图')))
  assert.ok(chips.some((text) => text.includes('已隐藏')))
})

await check('运行状态行：视觉通道 / 收图队列 / 上次收集 / 开关', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  for (const label of ['视觉识别通道', '收图链路', '上次自动收集', '插件开关']) {
    assert.ok(rows.includes(label), `缺少「${label}」，实际：${JSON.stringify(rows)}`)
  }
})

await check('v2 状态行：主动发图 / 斗图 / 定时备份', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  for (const label of ['主动发图', '斗图', '定时备份']) {
    assert.ok(rows.includes(label), `缺少「${label}」，实际：${JSON.stringify(rows)}`)
  }
  const text = textOf(tree)
  assert.ok(text.includes('概率 0.25'), `应回显触发概率，实际片段：${text.slice(0, 300)}`)
  // 斗图那行要把三个开关的状态都列出来
  assert.ok(text.includes('跟队形'), '应显示跟队形状态')
  assert.ok(text.includes('不团战'), '团战默认关，应显示不团战')
})

await check('上次收集结果显示成人话，不是 [object Object]', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const text = textOf(tree)
  assert.ok(!text.includes('[object Object]'), 'lastResult 是对象，直接 String() 会渲染成 [object Object]')
  // 数据里 collected: 4 / already: 2，应渲染成一句摘要
  const resultRow = findAll(tree, (node) => classOf(node) === 'qqs-row')
    .find((node) => textOf(node).includes('上次自动收集'))
  assert.ok(resultRow, '应有上次自动收集这一行')
  const descText = textOf(resultRow)
  assert.ok(descText.includes('收了 4 张'), `应显示收了 4 张，实际：${descText}`)
  assert.ok(descText.includes('跳过已入库 2 张'), `应显示跳过数，实际：${descText}`)
})

await check('显示数据目录（便于排障）', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const text = textOf(tree)
  assert.ok(text.includes('plugin-data'), `应显示数据目录，实际：${text.slice(0, 200)}`)
})

await check('列出模型工具，去掉 qq_ext_sticker_ 前缀显示', async () => {
  const mount = mountMain()
  const tree = await renderPanelSettled(mount)
  await settle()
  const codes = findAll(tree, (node) => classOf(node) === 'qqs-code').map(textOf)
  assert.ok(codes.includes('pick'), `实际：${JSON.stringify(codes)}`)
  assert.ok(codes.includes('send'))
  assert.ok(codes.includes('organize'))
})

await check('「去处理」按钮能跳到操作页', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  const goto = findAll(tree, (node) => textOf(node) === '去处理')[0]
  assert.ok(goto, '概览应有「去处理」按钮')
  goto.props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const titles = findAll(tree, (node) => classOf(node) === 'qqs-action-title').map(textOf)
  assert.ok(titles.includes('一键整理打标'), '应跳到操作页')
})

/* ════════════════════════════════════════════════════════════
   ⑤ 操作页
   ════════════════════════════════════════════════════════════ */

section('⑤ 操作页')

await check('六张动作卡：整理 / 清理 / 收集 / 删最早 / 报表 / 备份', async () => {
  const { tree } = await openTab('actions')
  const titles = findAll(tree, (node) => classOf(node) === 'qqs-action-title').map(textOf)
  assert.deepEqual(titles, ['一键整理打标', '清理无意义图', '立即收集', '删除最早的图', '生成报表', '立即备份'])
})

await check('每张卡有描述与主按钮', async () => {
  const { tree } = await openTab('actions')
  const descs = findAll(tree, (node) => classOf(node) === 'qqs-action-desc').map(textOf)
  assert.equal(descs.length, 6, `应有 6 段描述，实际 ${descs.length}`)
  assert.ok(descs[0].includes('视觉模型'), '整理卡应说明会调用视觉模型')
  assert.ok(descs[5].includes('zip'), '备份卡应说明会打成 zip')
})

await check('操作页有「确认应用本地整理」大按钮，点击 POST kind=sync_tree', async () => {
  actionJobs.length = 0
  const { tree } = await openTab('actions')
  const button = findAll(tree, (node) => node.type === 'button' && textOf(node) === '确认应用本地整理')[0]
  assert.ok(button, '操作页应有「确认应用本地整理」按钮')
  assert.equal(button.props.style?.width, '100%', '按钮应占满整行（大按钮）')
  await button.props.onClick()
  await settle()
  const hit = actionJobs.find((entry) => entry.kind === 'sync_tree')
  assert.ok(hit, `应 POST sync_tree，实际：${JSON.stringify(actionJobs.map((e) => e.kind))}`)
  assert.equal(hit.args.dryRun, undefined, '正式同步不该带 dryRun')
})

await check('整理/清理/删最早各有「试运行」开关，默认打开', async () => {
  const { tree } = await openTab('actions')
  const switches = findAll(tree, (node) => node.props?.role === 'switch' && node.props['aria-label'] === '试运行')
  assert.equal(switches.length, 3, `应有 3 个试运行开关，实际 ${switches.length}`)
  for (const item of switches) assert.equal(item.props['aria-checked'], 'true', '试运行应默认开启')
})

await check('整理与删最早有张数输入，带范围约束', async () => {
  const { tree } = await openTab('actions')
  const numbers = findAll(tree, (node) => node.props?.type === 'number')
  assert.ok(numbers.length >= 2, `应有至少 2 个数字输入，实际 ${numbers.length}`)
  assert.equal(numbers[0].props.min, 1)
  assert.equal(numbers[0].props.max, 60)
  assert.equal(numbers[1].props.min, 1)
  assert.equal(numbers[1].props.max, 500)
})

await check('危险区：写明清空不可撤销，并显示当前张数', async () => {
  const { tree } = await openTab('actions')
  const zones = findAll(tree, (node) => classOf(node) === 'qqs-danger-card')
  assert.equal(zones.length, 1)
  const text = textOf(zones[0])
  assert.ok(text.includes('清空表情库'))
  assert.ok(text.includes('不可撤销'), '必须写明不可撤销')
  assert.ok(text.includes('12'), '应显示将删除的张数')
})

await check('清空库按钮点开弹窗，需键入 CLEAR 才能确认', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '操作').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()

  // 点「清空整个库」：只认 button，否则会先命中包着它的外层 div
  const openBtn = findAll(tree, (node) => node.type === 'button' && textOf(node) === '清空整个库')[0]
  assert.ok(openBtn, '应有清空按钮')
  assert.equal(typeof openBtn.props.onClick, 'function', '按钮应可点击')
  openBtn.props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()

  const dialog = findAll(tree, (node) => node.props?.role === 'dialog')
  assert.equal(dialog.length, 1, '应弹确认框')
  assert.ok(textOf(dialog[0]).includes('永久删除'))

  // 确认按钮此刻必须禁用
  const confirmBtn = findAll(dialog[0], (node) => node.type === 'button' && textOf(node) === '永久删除')[0]
  assert.ok(confirmBtn, '应有确认按钮')
  assert.equal(confirmBtn.props.disabled, true, '未输入确认词时必须禁用')

  // 输入 CLEAR 后才可点
  const input = findAll(dialog[0], (node) => node.type === 'input')[0]
  assert.ok(input, '应有确认词输入框')
  assert.equal(input.props.placeholder, 'CLEAR')
  input.props.onChange({ target: { value: 'CLEAR' } })
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const dialog2 = findAll(tree, (node) => node.props?.role === 'dialog')[0]
  const confirm2 = findAll(dialog2, (node) => node.type === 'button' && textOf(node) === '永久删除')[0]
  assert.equal(confirm2.props.disabled, false, '输入 CLEAR 后应可确认')
})

await check('确认清空后 POST /action，body 带 kind=clear 与 confirm=CLEAR', async () => {
  actionJobs.length = 0
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '操作').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  findAll(tree, (node) => node.type === 'button' && textOf(node) === '清空整个库')[0].props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const dialog = findAll(tree, (node) => node.props?.role === 'dialog')[0]
  findAll(dialog, (node) => node.type === 'input')[0].props.onChange({ target: { value: 'CLEAR' } })
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const dialog2 = findAll(tree, (node) => node.props?.role === 'dialog')[0]
  const confirm = findAll(dialog2, (node) => node.type === 'button' && textOf(node) === '永久删除')[0]
  await confirm.props.onClick()
  await settle()
  assert.ok(actionJobs.length >= 1, '应发出动作请求')
  const hit = actionJobs.find((entry) => entry.kind === 'clear')
  assert.ok(hit, `应 POST clear，实际：${JSON.stringify(actionJobs.map((e) => e.kind))}`)
  assert.equal(hit.args.confirm, 'CLEAR')
})

await check('点「立即收集」POST kind=collect，不带 dryRun', async () => {
  actionJobs.length = 0
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '操作').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const btn = findAll(tree, (node) => node.type === 'button' && textOf(node) === '开始收集')[0]
  assert.ok(btn, '应有「开始收集」按钮')
  await btn.props.onClick()
  await settle()
  const hit = actionJobs.find((entry) => entry.kind === 'collect')
  assert.ok(hit, `应 POST collect，实际：${JSON.stringify(actionJobs)}`)
  assert.equal(hit.args.dryRun, undefined, '收集没有试运行概念')
})

await check('试运行勾选会体现在 organize 的 args.dryRun', async () => {
  actionJobs.length = 0
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '操作').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const btn = findAll(tree, (node) => node.type === 'button' && textOf(node) === '开始整理')[0]
  await btn.props.onClick()
  await settle()
  const hit = actionJobs.find((entry) => entry.kind === 'organize')
  assert.ok(hit, `应 POST organize，实际：${JSON.stringify(actionJobs.map((e) => e.kind))}`)
  assert.equal(hit.args.dryRun, true, '默认试运行应为 true')
  assert.equal(hit.args.limit, 12, '默认张数 12')
})

/* ════════════════════════════════════════════════════════════
   ⑥ 设置页
   ════════════════════════════════════════════════════════════ */

section('⑥ 设置页')

await check('分类标题正确（v2 扩到 7 段）', async () => {
  const { tree } = await openTab('config')
  const heads = findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
  assert.equal(heads.length, 7, `应有 7 个分类，实际 ${heads.length}`)
  const titles = findAll(tree, (node) => classOf(node) === 'qqs-sec-title').map(textOf)
  assert.deepEqual(titles, [
    '发送设置', '收集设置', '视觉打标',
    '主动发图', '斗图与连发', '定时备份',
    '高级设置',
  ])
})

await check('常用项全部平铺：频率 / 单群间隔 / 全局间隔 / 每日上限', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  for (const label of ['配图频率', '单群间隔', '全局间隔', '每日上限']) {
    assert.ok(rows.includes(label), `缺少「${label}」，实际：${JSON.stringify(rows)}`)
  }
})

await check('收集设置露出：自动收集开关 + 每小时上限', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('自动收集'))
  assert.ok(rows.includes('每小时上限'))
})

await check('视觉打标露出：识别开关 + provider ID + 模型 ID', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('收录时识图'))
  assert.ok(rows.includes('视觉模型 provider'))
  assert.ok(rows.includes('视觉模型 ID'))
})

await check('频率是下拉框，四个档位', async () => {
  const { tree } = await openTab('config')
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.ok(selects.length >= 1, '应有下拉框')
  const freqSelect = selects[0]
  const options = findAll(freqSelect, (node) => node.type === 'option').map(textOf)
  assert.deepEqual(options, ['很少', '偶尔', '一般', '经常'])
  assert.equal(freqSelect.props.value, 'occasional')
})

await check('「高级设置」默认收起，不把全部配置平铺出来', async () => {
  const { tree } = await openTab('config')
  const heads = findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
  const advanced = heads.find((node) => textOf(node).includes('高级设置'))
  assert.ok(advanced)
  assert.equal(advanced.props['aria-expanded'], 'false')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(!rows.includes('库容量上限'), '收起时不应渲染高级项')
  assert.ok(!rows.includes('自定义存储目录'), '收起时不应渲染存储目录')
  // 首屏只露常显区：发送 4 + 收集 2 + 视觉 3 + 主动 2 + 斗图 1 + 备份 1 = 13
  assert.ok(rows.length <= 14, `默认平铺项应 ≤14，实际 ${rows.length}：${JSON.stringify(rows)}`)
})

console.log('\n⑥-b v2 新增配置项')

await check('主动发图段露出总开关与触发概率', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('主动发图'), `实际：${JSON.stringify(rows)}`)
  assert.ok(rows.includes('触发概率'))
})

await check('斗图段露出「加入队形」开关', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('加入队形'), `实际：${JSON.stringify(rows)}`)
})

await check('备份段露出「定时备份」开关', async () => {
  const { tree } = await openTab('config')
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('定时备份'), `实际：${JSON.stringify(rows)}`)
})

await check('展开「主动发图」后出现检索模式 / 意图模型 / 只选表情包', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const heads = findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
  heads.find((node) => textOf(node).includes('主动发图')).props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('检索模式'), `实际：${JSON.stringify(rows)}`)
  assert.ok(rows.includes('意图分析模型'))
  assert.ok(rows.includes('只发表情包'))
})

await check('标签类别是多行文本域，普通回车不提交、Ctrl+Enter 才提交', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const heads = findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
  heads.find((node) => textOf(node).includes('视觉打标')).props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const textareas = findAll(tree, (node) => node.type === 'textarea')
  assert.ok(textareas.length >= 1, `应有 textarea，实际 ${textareas.length}`)
  const tagArea = textareas[0]
  const onKeyDown = tagArea.props.onKeyDown
  assert.equal(typeof onKeyDown, 'function')
  let blurred = false
  const fakeTarget = { blur() { blurred = true } }
  onKeyDown({ key: 'Enter', preventDefault() {}, currentTarget: fakeTarget })
  assert.equal(blurred, false, '普通回车不该提交（标签类别要多行输入）')
  onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {}, currentTarget: fakeTarget })
  assert.equal(blurred, true, 'Ctrl+Enter 才提交')
})

await check('展开「发送设置」后出现其余字段', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const sendHead = findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
    .find((node) => textOf(node).includes('发送设置'))
  sendHead.props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  assert.ok(rows.includes('每轮候选数'), `展开后应出现更多字段，实际：${JSON.stringify(rows)}`)
})

await check('显示可写状态「改动会立即写入」', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const text = textOf(tree)
  assert.ok(text.includes('改动会立即写入'), `实际：${text.slice(0, 160)}`)
  assert.ok(!text.includes('只读模式'), 'remote 可用时不应显示只读')
})

await check('改配置调用 remote.settings.mutate，path 是点分数组', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  // 配图频率下拉 → 改成 often（HTML select 的 onChange 收 event）
  const selects = findAll(tree, (node) => node.type === 'select')
  assert.ok(selects.length >= 1, `应有下拉框，实际 ${selects.length}`)
  await selects[0].props.onChange({ target: { value: 'often' } })
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ns === 'qq-sticker')
  assert.ok(hit, `应调用 mutate，实际：${JSON.stringify(mount.mutations)}`)
  assert.equal(hit.ops[0].op, 'set')
  // ⚠️ 跨 vm realm 的数组原型不同，assert.deepEqual 会因「结构相同但非同一引用」失败，
  //    所以这里用 JSON 序列化比较形状。
  assert.equal(JSON.stringify(hit.ops[0].path), JSON.stringify(['send', 'frequency']))
  assert.equal(hit.ops[0].value, 'often')
  assert.equal(hit.revision, 7, '应带上 describe 读到的 revision')
})

await check('开关类配置也能写：关掉自动收集', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const switches = findAll(tree, (node) => node.props?.role === 'switch' && node.props['aria-label'] === '自动收集')
  assert.ok(switches.length === 1, `应有一个自动收集开关，实际 ${switches.length}`)
  assert.equal(switches[0].props['aria-checked'], 'true')
  await switches[0].props.onClick(true)   // 现值为 true，点一下变 false
  // onClick 是 () => onChange(!checked)，所以直接调 props.onClick
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'collect.enabled')
  assert.ok(hit, `应写入 collect.enabled，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, false)
})

/* ════════════════════════════════════════════════════════════
   ⑤-b 收集总闸（概览页顶部的大开关）
   ════════════════════════════════════════════════════════════ */

console.log('\n⑤-b 收集总闸')

await check('概览页顶部有「收集开关」卡，收集中时显示绿灯与「暂停收集」按钮', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  const card = findAll(tree, (node) => classOf(node).split(/\s+/).includes('qqs-collect-switch'))[0]
  assert.ok(card, '概览页应有收集开关卡')
  const text = textOf(card)
  assert.ok(text.includes('收集开关'), `卡里该有标题，实际：${text}`)
  assert.ok(text.includes('收集中'), '开着的状态文案')
  const btn = findAll(card, (node) => node.type === 'button' && textOf(node) === '暂停收集')[0]
  assert.ok(btn, '收集中时按钮文案应是「暂停收集」')
  assert.equal(classOf(card).includes('qqs-collect-paused'), false, '没暂停时不该有 paused 类')
  // 绿灯
  const dot = findAll(card, (node) => classOf(node).split(/\s+/).includes('qqs-dot'))[0]
  assert.ok(dot, '应有状态灯')
  assert.equal(classOf(dot).includes('qqs-dot-ok'), true, `收集中应是绿灯，实际 ${classOf(dot)}`)
})

await check('点「暂停收集」写 collect.enabled=false，并弹出提示', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  const card = findAll(tree, (node) => classOf(node).split(/\s+/).includes('qqs-collect-switch'))[0]
  const btn = findAll(card, (node) => node.type === 'button' && textOf(node) === '暂停收集')[0]
  await btn.props.onClick()
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'collect.enabled')
  assert.ok(hit, `应写入 collect.enabled，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, false, '点「暂停收集」应写 false')
})

await check('暂停态：红灯 + 「恢复收集」按钮 + 那句提示文案', async () => {
  const mount = mountMain()
  // 直接把 /state 的 collect.enabled 改成 false，模拟已暂停
  const original = STATE.collect.enabled
  STATE.collect.enabled = false
  try {
    let tree = await renderPanelSettled(mount)
    await settle(8)
    const card = findAll(tree, (node) => classOf(node).split(/\s+/).includes('qqs-collect-switch'))[0]
    assert.ok(card, '暂停时卡片还在')
    assert.equal(classOf(card).includes('qqs-collect-paused'), true, '暂停时卡片应带 paused 类')
    const text = textOf(card)
    assert.ok(text.includes('已暂停'), `应显示「已暂停」，实际：${text}`)
    assert.ok(
      text.includes('当前已暂停自动收集，群友发图仅供聊天识别，不入库。'),
      `必须显示那句提示，实际：${text}`,
    )
    const btn = findAll(card, (node) => node.type === 'button' && textOf(node) === '恢复收集')[0]
    assert.ok(btn, '暂停时按钮文案应是「恢复收集」')
    const dot = findAll(card, (node) => classOf(node).split(/\s+/).includes('qqs-dot'))[0]
    assert.equal(classOf(dot).includes('qqs-dot-err'), true, `暂停应是红灯，实际 ${classOf(dot)}`)
    assert.equal(text.includes('群友发图不会入库'), true)
  } finally {
    STATE.collect.enabled = original
  }
})

await check('点「恢复收集」写 collect.enabled=true', async () => {
  const mount = mountMain()
  const original = STATE.collect.enabled
  STATE.collect.enabled = false
  try {
    let tree = await renderPanelSettled(mount)
    await settle(8)
    const card = findAll(tree, (node) => classOf(node).split(/\s+/).includes('qqs-collect-switch'))[0]
    const btn = findAll(card, (node) => node.type === 'button' && textOf(node) === '恢复收集')[0]
    await btn.props.onClick()
    await settle(8)
    const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'collect.enabled')
    assert.ok(hit, '应写入 collect.enabled')
    assert.equal(hit.ops[0].value, true, '点「恢复收集」应写 true')
  } finally {
    STATE.collect.enabled = original
  }
})

/* ════════════════════════════════════════════════════════════
   ⑥-c 本次重构的回归点（卡片 / 层级 / 下拉 / 折叠 / 旧 Schema）
   ════════════════════════════════════════════════════════════ */

console.log('\n⑥-c 视觉重构与保存失败的回归')

/** 打开设置页并展开指定 section（按标题匹配 sec-head）。 */
async function openConfigSection(title) {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  findAll(tree, (node) => classOf(node) === 'qqs-sec-head')
    .find((node) => textOf(node).includes(title)).props.onClick()
  // ⚠️ 假 React 的 setState 不触发重渲染；组件的异步 effect（模型目录）要等
  //    微任务落地后再渲一版才看得到选项。
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  return { mount, tree }
}

await check('每个大分类是一张独立卡片（qqs-sec 带圆角底色内边距）', async () => {
  const { tree } = await openTab('config')
  const secs = findAll(tree, (node) => classOf(node) === 'qqs-sec')
  assert.equal(secs.length, 7, `应有 7 张分类卡，实际 ${secs.length}`)
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-sec\s*\{[^}]*border-radius:\s*12px/, '分类卡应有圆角')
  assert.match(css, /\.qqs-sec\s*\{[^}]*background:\s*var\(--qqs-surface\)/, '分类卡应有背景')
})

await check('卡片标题加粗，左侧有彩色装饰条', async () => {
  const { tree } = await openTab('config')
  const titles = findAll(tree, (node) => classOf(node) === 'qqs-sec-title')
  assert.equal(titles.length, 7)
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-sec-title\s*\{[^}]*font-weight:\s*700/, '标题应加粗')
  assert.match(css, /\.qqs-sec-head::before\s*\{[^}]*background:\s*var\(--qqs-sec-accent/, '应有左侧彩色装饰条')
  // 每张卡都拿到自己的色系
  const secs = findAll(tree, (node) => classOf(node) === 'qqs-sec')
  for (const sec of secs) {
    assert.ok(sec.props.style?.['--qqs-sec-accent'], '每张卡都应设置 --qqs-sec-accent')
  }
})

await check('整行可点击折叠，右侧箭头是 v/^（收起朝下）', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const head = findAll(tree, (node) => classOf(node) === 'qqs-sec-head').find((node) => textOf(node).includes('发送设置'))
  assert.ok(head, '应有发送设置的头')
  assert.equal(head.props['aria-expanded'], 'false', '默认收起')
  assert.equal(head.props.title, '展开这一组', '收起态提示「展开这一组」')
  // 箭头用的是朝下的 v 形图标（不是右箭头旋转 90°）
  const chev = findAll(head, (node) => node.type === 'svg')
  assert.ok(chev.length >= 1, '应有箭头图标')
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-sec-on \.qqs-sec-chev\s*\{[^}]*rotate\(180deg\)/, '展开时箭头应翻转成 ^')
})

await check('子分组有左侧缩进 + 淡灰竖线（斗图与连发拆成 3 组）', async () => {
  const { tree } = await openConfigSection('斗图与连发')
  const groups = findAll(tree, (node) => classOf(node) === 'qqs-group')
  assert.equal(groups.length, 3, `斗图应拆成 3 个子分组，实际 ${groups.length}`)
  const heads = findAll(tree, (node) => classOf(node) === 'qqs-group-head').map(textOf)
  assert.deepEqual(heads, ['跟队形', '连发', '团战'])
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-group\s*\{[^}]*padding:[^;]*16px/, '子分组应左侧缩进')
  assert.match(css, /\.qqs-group\s*\{[^}]*border-left:\s*2px solid var\(--qqs-line\)/, '子分组应有淡灰竖线')
})

await check('说明文字与控件同一基线（行用 grid + baseline 对齐）', () => {
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-row\s*\{[^}]*display:\s*grid/, '行应是 grid')
  assert.match(css, /\.qqs-row\s*\{[^}]*align-items:\s*baseline/, '行应基线对齐')
  assert.match(css, /\.qqs-row-ctl\s*\{[^}]*grid-row:\s*1/, '控件应在第一行，与标题同基线')
})

await check('输入框与下拉框有明显边框', () => {
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.match(css, /\.qqs-input,\s*\.qqs-select\s*\{[^}]*border:\s*1px solid var\(--qqs-line-strong\)/, '应有明显边框')
  assert.match(css, /\.qqs-select\s*\{[^}]*-webkit-appearance:\s*none/, '下拉应自定义外观')
})

await check('「意图分析模型」渲染成真 <select>，选项含 provider/model', async () => {
  const { tree } = await openConfigSection('主动发图')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
    .find((node) => textOf(node).includes('意图分析模型'))
  assert.ok(row, '应有意图分析模型这一行')
  const select = findAll(row, (node) => node.type === 'select')[0]
  assert.ok(select, '应渲染成 select，而不是文本框')
  const options = findAll(select, (node) => node.type === 'option').map((node) => node.props.value)
  assert.ok(options.includes('opencode-go/deepseek-v4.1-flash'), `选项应含目录里的真实模型，实际：${JSON.stringify(options)}`)
  assert.ok(options.includes('trae/deepseek-v4.1-flash'), '应含第二个 provider 的模型')
  // 当前配置是空串 → 选中「留空跟随当前」那一项
  assert.equal(select.props.value, '', '留空时应选中空选项')
})

await check('意图分析模型选完之后写回 provider/model 串', async () => {
  const { mount, tree } = await openConfigSection('主动发图')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
    .find((node) => textOf(node).includes('意图分析模型'))
  const select = findAll(row, (node) => node.type === 'select')[0]
  await select.props.onChange({ target: { value: 'opencode-go/deepseek-v4.1-flash' } })
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'proactive.model')
  assert.ok(hit, `应写入 proactive.model，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, 'opencode-go/deepseek-v4.1-flash')
})

await check('「视觉模型」也是下拉，且写回的是裸模型 id（不是 provider/model）', async () => {
  const { mount, tree } = await openConfigSection('视觉打标')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
    .find((node) => textOf(node).includes('视觉模型 ID'))
  assert.ok(row, '应有视觉模型 ID 这一行')
  const select = findAll(row, (node) => node.type === 'select')[0]
  assert.ok(select, '视觉模型应渲染成 select')
  // vision.model 是裸 id，选项里不能带 provider 前缀
  const options = findAll(select, (node) => node.type === 'option').map((node) => node.props.value)
  assert.ok(options.includes('deepseek-v4.1-flash'), `选项应是裸 id，实际：${JSON.stringify(options)}`)
  assert.ok(!options.some((value) => String(value).includes('/')), `不应出现 provider/model 复合选项：${JSON.stringify(options)}`)
  await select.props.onChange({ target: { value: 'deepseek-v4-flash-vision-exp' } })
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'vision.model')
  assert.ok(hit, `应写入 vision.model，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, 'deepseek-v4-flash-vision-exp')
})

await check('宿主拒绝写入时，界面显示具体原因而不是只说「保存失败」', async () => {
  const mount = mountMain({
    schemaTopKeys: Object.keys(CONFIG),
    mutateReply: async () => ({
      ok: false,
      error: { code: 'settings/rejected', message: 'Config field "proactive.enabled" is not volatile' },
    }),
  })
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const switches = findAll(tree, (node) => node.props?.role === 'switch' && node.props['aria-label'] === '主动发图')
  assert.ok(switches.length === 1, `应有主动发图开关，实际 ${switches.length}`)
  await switches[0].props.onClick()
  await settle(8)
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const text = textOf(tree)
  assert.ok(text.includes('保存失败'), `应提示保存失败，实际：${text.slice(0, 300)}`)
  assert.ok(text.includes('not volatile') || text.includes('重启 DSH'),
    `应把宿主的真实原因带出来（或明确说要重启），实际：${text.slice(0, 400)}`)
})

await check('旧 Host Schema：缺的段提前标「需重启」，且渲染成不可点占位', async () => {
  // 模拟「改了 src/config.js 但没重启 DSH」：Schema 里没有 proactive/battle/backup/store/gif
  const mount = mountMain({
    schemaTopKeys: ['enabled', 'debug', 'library', 'collect', 'vision', 'send', 'prompt', 'maintenance'],
  })
  let tree = await renderPanelSettled(mount)
  await settle(10)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  const text = textOf(tree)
  assert.ok(text.includes('要重启 DSH'), `应有顶部横幅说明要重启，实际：${text.slice(0, 400)}`)
  assert.ok(text.includes('proactive') || text.includes('主动发图'), '横幅应列出缺的段')
  const badges = findAll(tree, (node) => classOf(node) === 'qqs-need-restart').map(textOf)
  assert.ok(badges.length > 0, '缺字段的行应带「需重启」徽标')
  // 主动发图开关不应再渲染成可点的 switch
  const switches = findAll(tree, (node) => node.props?.role === 'switch' && node.props['aria-label'] === '主动发图')
  assert.equal(switches.length, 0, '字段未知时不应渲染可点控件（点了也只会失败）')
  assert.ok(text.includes('重启 DSH 后可改'), '应给出占位文字说明')
})

await check('小数配置（触发概率 0.25）不会被取整成 0', async () => {
  const { mount, tree } = await openConfigSection('主动发图')
  let current = tree
  let input = findAll(current, (node) => node.props?.type === 'number' && node.props['aria-label'] === '触发概率')[0]
  assert.ok(input, '应有触发概率输入框')
  assert.equal(input.props.step, 0.05, '概率应允许 0.05 步进')
  // 假 React 不会因 setState 自动重渲染，所以每个事件之间手动渲一版：
  // 这样 blur 时的闭包读到的才是 onChange 之后的草稿（真机上 React 自己做这件事）。
  input.props.onFocus()
  current = renderTree(mount.main.component, mount.props)
  input = findAll(current, (node) => node.props?.type === 'number' && node.props['aria-label'] === '触发概率')[0]
  input.props.onChange({ target: { value: '0.35' } })
  current = renderTree(mount.main.component, mount.props)
  input = findAll(current, (node) => node.props?.type === 'number' && node.props['aria-label'] === '触发概率')[0]
  input.props.onBlur()
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'proactive.probability')
  assert.ok(hit, `应写入 proactive.probability，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, 0.35, '小数不能被 trunc 成 0')
})

await check('「展开另外 N 项」按钮带上下箭头', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const head = findAll(tree, (node) => classOf(node) === 'qqs-sec-head').find((node) => textOf(node).includes('发送设置'))
  head.props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const btns = findAll(tree, (node) => hasToken(node, 'qqs-more-btn') || hasToken(node, 'qqs-more-btn-on'))
  assert.ok(btns.length >= 1, '应有展开/收起按钮')
  const chev = findAll(btns[0], (node) => classOf(node).includes('qqs-more-chev'))
  assert.equal(chev.length, 1, '按钮里应有箭头')
})

await check('inject 同时声明 remote.session（模型目录靠它）', () => {
  assert.ok(clientModule.inject.includes('remote.session'),
    `inject 应含 remote.session，实际：${JSON.stringify(clientModule.inject)}`)
})

await check('拿不到模型目录时退化成可手填，不是死控件', async () => {
  const mount = mountMain({ withSession: false })
  let tree = await renderPanelSettled(mount)
  await settle(10)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  findAll(tree, (node) => classOf(node) === 'qqs-sec-head').find((node) => textOf(node).includes('主动发图')).props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
    .find((node) => textOf(node).includes('意图分析模型'))
  assert.ok(row, '应有意图分析模型这一行')
  const inputs = findAll(row, (node) => node.type === 'input' && node.props?.type === 'text')
  assert.equal(inputs.length, 1, '目录不可用时应给出可手填的文本框')
})

console.log('\n⑥-d GIF / 路径管理 / 发送位置的回归')

await check('发送设置里有「图片位置」下拉，选项是 文字之后/文字之前', async () => {
  const { tree } = await openConfigSection('发送设置')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row'))
    .find((node) => textOf(node).includes('图片位置'))
  assert.ok(row, '应有图片位置这一行')
  const select = findAll(row, (node) => node.type === 'select')[0]
  assert.ok(select, `图片位置应渲染成下拉，实际：${textOf(row).slice(0, 80)}`)
  const labels = findAll(select, (node) => node.type === 'option').map(textOf)
  assert.deepEqual(labels, ['文字之后', '文字之前'])
})

await check('改「图片位置」写回 send.imagePosition', async () => {
  const { mount, tree } = await openConfigSection('发送设置')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row'))
    .find((node) => textOf(node).includes('图片位置'))
  const select = findAll(row, (node) => node.type === 'select')[0]
  await select.props.onChange({ target: { value: 'before' } })
  await settle(8)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'send.imagePosition')
  assert.ok(hit, `应写入 send.imagePosition，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, 'before')
})

await check('操作页有「打开本地文件夹」按钮', async () => {
  const { tree } = await openTab('actions')
  const titles = findAll(tree, (node) => classOf(node) === 'qqs-card-title').map(textOf)
  assert.ok(titles.some((text) => text.includes('本地文件')), `应有本地文件卡，实际：${JSON.stringify(titles)}`)
  const button = findAll(tree, (node) => node.type === 'button')
    .find((node) => textOf(node) === '打开本地文件夹')
  assert.ok(button, '应有「打开本地文件夹」按钮')
})

await check('点「打开本地文件夹」会 POST /open-path', async () => {
  fetchLog.length = 0
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '操作').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  const button = findAll(tree, (node) => node.type === 'button')
    .find((node) => textOf(node) === '打开本地文件夹')
  assert.ok(button, '应有打开文件夹按钮')
  await button.props.onClick()
  await settle(10)
  const hit = fetchLog.find((entry) => entry.url.endsWith('/open-path'))
  assert.ok(hit, `应 POST /open-path，实际请求：${JSON.stringify(fetchLog.map((e) => e.url))}`)
  assert.equal(hit.method, 'POST')
  assert.ok(String(hit.body).includes('"sub"'), '请求体应带 sub 字段')
})

await check('高级设置有路径输入框 + 浏览按钮（自定义存储目录）', async () => {
  const { tree } = await openConfigSection('高级设置')
  const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
    .find((node) => textOf(node).includes('自定义存储目录'))
  assert.ok(row, '应有自定义存储目录这一行')
  const input = findAll(row, (node) => node.type === 'input' && node.props?.type === 'text')[0]
  assert.ok(input, '应有路径输入框')
  const browse = findAll(row, (node) => node.type === 'button')
    .find((node) => textOf(node) === '浏览')
  assert.ok(browse, '应有「浏览」按钮')
  assert.ok(textOf(row).includes('重启'), `应提示需重启，实际：${textOf(row).slice(0, 120)}`)
})

await check('路径输入框失焦会写回 store.dataDir', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle(8)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(8)
  findAll(tree, (node) => classOf(node) === 'qqs-sec-head').find((n) => textOf(n).includes('高级设置')).props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  const grab = () => {
    const row = findAll(tree, (node) => hasToken(node, 'qqs-row-block'))
      .find((node) => textOf(node).includes('自定义存储目录'))
    return findAll(row, (node) => node.type === 'input' && node.props?.type === 'text')[0]
  }
  let input = grab()
  assert.ok(input, '应有路径输入框')
  input.props.onFocus()
  tree = renderTree(mount.main.component, mount.props)
  await settle(6)
  input = grab()
  input.props.onChange({ target: { value: 'D:\\Emoji' } })
  tree = renderTree(mount.main.component, mount.props)
  await settle(6)
  input = grab()
  input.props.onBlur()
  await settle(10)
  const hit = mount.mutations.find((entry) => entry.ops?.[0]?.path?.join('.') === 'store.dataDir')
  assert.ok(hit, `应写入 store.dataDir，实际：${JSON.stringify(mount.mutations.map((e) => e.ops))}`)
  assert.equal(hit.ops[0].value, 'D:\\Emoji')
})

await check('remote 不可用时显示只读提示，控件禁用', async () => {
  const mount = mountMain({ withRemote: false })
  let tree = await renderPanelSettled(mount)
  await settle(10)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  const text = textOf(tree)
  assert.ok(text.includes('只读'), `实际：${text.slice(0, 200)}`)
  const selects = findAll(tree, (node) => node.type === 'select')
  if (selects.length > 0) assert.equal(selects[0].props.disabled, true, '只读时下拉应禁用')
})

/* ════════════════════════════════════════════════════════════
   ⑦ 数据通路与容错
   ════════════════════════════════════════════════════════════ */

section('⑦ 数据通路与容错')

await check('轮询 /dsh-qq-sticker/state，GET + credentials + AbortSignal', async () => {
  fetchLog.length = 0
  const mount = mountMain()
  await renderPanelSettled(mount)
  await settle()
  const hit = fetchLog.find((entry) => entry.url.endsWith('/dsh-qq-sticker/state'))
  assert.ok(hit, `实际请求：${JSON.stringify(fetchLog.map((e) => e.url))}`)
  assert.equal(hit.method, 'GET')
  assert.ok(hit.signal, '应带 AbortSignal')
})

await check('状态请求失败时显示错误条，而不是空白', async () => {
  fetchMode = 'state-fail'
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  // 首次 fetch 失败后 setState 走 error，需要再渲染一次
  await settle()
  tree = renderTree(mount.main.component, mount.props)
  await settle()
  const text = textOf(tree)
  assert.ok(text.includes('读取状态失败'), `实际：${text.slice(0, 200)}`)
  assert.ok(text.includes('重启 DSH'), '应提示重启排查方向')
  fetchMode = 'ok'
})

await check('describe 失败但 HTTP /config 可用 → 只读兜底', async () => {
  const mount = mountMain({ describe: 'fail' })
  let tree = await renderPanelSettled(mount)
  await settle(10)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  const text = textOf(tree)
  assert.ok(text.includes('只读') || text.includes('读取配置失败'), `实际：${text.slice(0, 200)}`)
  // 只要有配置就应能渲染出字段（值来自 HTTP 兜底）
  const rows = findAll(tree, (node) => classOf(node) === 'qqs-row-main').map(textOf)
  if (rows.length === 0) assert.ok(text.includes('读取配置失败'), '既无字段又无错误提示就是 bug')
})

await check('describe 返回缺 ns → 明确报错而不是静默空表', async () => {
  const mount = mountMain({ describe: 'missing-ns' })
  let tree = await renderPanelSettled(mount)
  await settle(10)
  findAll(tree, (node) => node.props?.role === 'tab').find((tab) => textOf(tab) === '设置').props.onClick()
  tree = renderTree(mount.main.component, mount.props)
  await settle(10)
  // HTTP 兜底会成功，所以最终应是只读可显示状态
  const text = textOf(tree)
  assert.ok(text.includes('只读') || text.includes('读取配置失败'), `实际：${text.slice(0, 200)}`)
})

/* ════════════════════════════════════════════════════════════
   ⑧ 红线
   ════════════════════════════════════════════════════════════ */

section('⑧ 红线检查')

await check('零外部依赖：只 require react', () => {
  const requires = [...SOURCE.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual([...new Set(requires)], ['react'], `实际：${JSON.stringify([...new Set(requires)])}`)
  assert.ok(!/from\s+['"]https?:\/\//.test(SOURCE), '不应有远程 import')
  assert.ok(!/<script/i.test(SOURCE), '不应注入外部脚本')
})

await check('所有类名都在 qqs- 命名空间里', async () => {
  const mount = mountMain()
  let tree = await renderPanelSettled(mount)
  await settle()
  const tokens = new Set(allClassTokens(tree))
  // 再收一遍三个 Tab 的类名
  for (const tabId of ['actions', 'config']) {
    const opened = await openTab(tabId)
    for (const token of allClassTokens(opened.tree)) tokens.add(token)
  }
  const offenders = [...tokens].filter((token) => !token.startsWith('qqs-'))
  assert.deepEqual(offenders, [], `非 qqs- 前缀的类名：${JSON.stringify(offenders)}`)
  // CSS 里也不应有全局选择器
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const globalSel = withoutComments.match(/(^|\n)\s*(html|body|div|button|input|select|svg|:root)\s*[,{]/g) ?? []
  assert.deepEqual(globalSel.map((s) => s.trim()), [], `发现全局选择器：${JSON.stringify(globalSel)}`)
})

await check('颜色只用主题令牌或 color-mix，无硬编码色值', () => {
  const css = (SOURCE.match(/const CSS = `([\s\S]*?)`\n/) ?? [])[1] ?? ''
  assert.ok(css.length > 2000)
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const offenders = [...withoutComments.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\))/g)]
    .map((match) => match[0])
  assert.deepEqual(offenders, [], `硬编码颜色：${JSON.stringify(offenders)}`)
})

await check('引用的 --dsw 令牌都在 Theme 目录内', () => {
  const ALLOWED = new Set([
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
    '--dsw-alias-brand-primary', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
    '--dsw-specific-sidebar-fill',
  ])
  const used = new Set([...SOURCE.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))
  assert.ok(used.size > 0, '应至少引用一个主题令牌')
  const unknown = [...used].filter((token) => !ALLOWED.has(token))
  assert.deepEqual(unknown, [], `目录外令牌：${JSON.stringify(unknown)}`)
})

await check('不操作 document.body，样式随 effect 清理', () => {
  assert.ok(!/document\.body/.test(SOURCE), '不应操作 document.body')
  // apply 里三处 effect：css / main / sidebar
  const { ctx, effects } = makeCtx()
  clientModule.apply(ctx)
  assert.ok(effects.length >= 3, `应有 ≥3 处注册，实际 ${effects.length}`)
  assert.ok(effects.some((label) => String(label).includes('css')))
  assert.ok(effects.some((label) => String(label).includes('main panel')))
  assert.ok(effects.some((label) => String(label).includes('sidebar entry')))
})

await check('没有 TODO / FIXME / 占位符文案', () => {
  assert.ok(!/\bTODO\b/.test(SOURCE))
  assert.ok(!/\bFIXME\b/.test(SOURCE))
  assert.ok(!/lorem ipsum/i.test(SOURCE))
})

/* ════════════════════════════════════════════════════════════
   汇总
   ════════════════════════════════════════════════════════════ */

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) {
    console.log(`\n· ${item.name}`)
    console.log(String(item.error?.stack ?? item.error).split('\n').slice(0, 8).join('\n'))
  }
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
