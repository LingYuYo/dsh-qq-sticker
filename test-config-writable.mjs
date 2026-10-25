/**
 * qq-sticker 配置可写性验证（只读探针，可重复运行）。
 *
 * 验什么：
 *   1. 源码侧：src/config.js 的 Config 有 13 个顶层段、65 个叶子，全部 volatile；
 *   2. 运行时：live DSH 的 qq-sticker Schema 有几个段，缺不缺 v2 段；
 *   3. 行为：写一个 live Schema 里不存在的字段应被拒（settings/rejected），
 *      且错误文案含 "is not volatile" —— 这是"Host 是旧代码"的指纹；
 *   4. client.js 的 FIELDS 与 Host DEFAULTS 叶子一一对应。
 *
 * 只读约定：第 3 条故意写一个**必然被拒**的字段（不存在于旧 Schema 里），
 * 绝不写任何会真正落盘的配置。如果探针意外成功了，脚本会立刻把它改回去并报警。
 *
 * 用法：node verify-sticker-config.mjs [--base http://127.0.0.1:14297]
 * 退出码：0 全部符合预期；1 有断言失败。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const REPO = 'D:/DeepSeekHarness_workarea/Dsh-QQ-Mod/dsh-qq-sticker'
const DSH_CLIENT = 'file:///C:/Users/1/Documents/deepseek-harness/default-workspace/qq-bridge/src/dsh.mjs'

const argv = process.argv.slice(2)
const baseArg = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length)
  ?? (argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined)

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

/* ════════════════════════════════════════════════════════════
   ① 源码侧
   ════════════════════════════════════════════════════════════ */
console.log('\n① 源码侧 Config')

const { Config, DEFAULTS } = await import(pathToFileURL(`${REPO}/src/config.js`).href)

/** schemastery toJSON 信封 → 顶层段 + 叶子列表。 */
function inspectSchema() {
  const json = Config.toJSON()
  const refs = json.refs ?? {}
  const root = refs[json.uid]
  const sections = root?.dict ? Object.keys(root.dict) : []
  const leaves = []
  const walk = (node, path) => {
    if (!node) return
    if (node.type === 'object' && node.dict) {
      for (const [key, childId] of Object.entries(node.dict)) {
        walk(refs[childId], path ? `${path}.${key}` : key)
      }
      return
    }
    leaves.push({ path, type: node.type, volatile: node.meta?.volatile === true })
  }
  walk(root, '')
  return { sections, leaves }
}

const { sections, leaves } = inspectSchema()

await check('顶层段有 13 个（旧 8 + v2 的 5）', () => {
  const expected = ['enabled', 'debug', 'library', 'collect', 'vision', 'send', 'prompt', 'maintenance', 'store', 'proactive', 'battle', 'backup', 'gif']
  const missing = expected.filter((key) => !sections.includes(key))
  if (missing.length) throw new Error(`缺段：${missing.join(', ')}，实际：${sections.join(', ')}`)
  if (sections.length !== expected.length) throw new Error(`段数应为 ${expected.length}，实际 ${sections.length}`)
})

await check('全部叶子都标了 volatile（缺一个就写不进去）', () => {
  const bad = leaves.filter((leaf) => !leaf.volatile)
  if (bad.length) throw new Error(`未 volatile：${bad.map((leaf) => leaf.path).join(', ')}`)
  if (leaves.length === 0) throw new Error('没解析出任何叶子')
  console.log(`      （${leaves.length} 个叶子，全部 volatile）`)
})

await check('v2 段的叶子都在（proactive / battle / backup / store / gif）', () => {
  const must = [
    'proactive.enabled', 'proactive.probability', 'proactive.mode', 'proactive.model',
    'battle.joinEnabled', 'battle.burstProbability', 'battle.teamEnabled',
    'backup.enabled', 'backup.at', 'backup.keep',
    'store.dataDir', 'gif.normalizeOnSend',
    'vision.tagCategories', 'vision.customTags',
  ]
  const have = new Set(leaves.map((leaf) => leaf.path))
  const missing = must.filter((path) => !have.has(path))
  if (missing.length) throw new Error(`缺字段：${missing.join(', ')}`)
})

await check('client FIELDS 与 Host DEFAULTS 一一对应', () => {
  const source = readFileSync(`${REPO}/client.js`, 'utf8')
  const block = source.slice(source.indexOf('const FIELDS = ['), source.indexOf('const DEFAULTS ='))
  const paths = [...block.matchAll(/path: '([^']+)'/g)].map((m) => m[1])
  const flatKeys = (obj, prefix = '', out = new Set()) => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object' && !Array.isArray(value)) flatKeys(value, path, out)
      else out.add(path)
    }
    return out
  }
  const hostKeys = flatKeys(DEFAULTS)
  const clientOnly = paths.filter((path) => !hostKeys.has(path))
  const hostOnly = [...hostKeys].filter((path) => !paths.includes(path))
  if (clientOnly.length) throw new Error(`client 有但 Host 没有：${clientOnly.join(', ')}`)
  if (hostOnly.length) throw new Error(`Host 有但 client 没露：${hostOnly.join(', ')}`)
  console.log(`      （client ${paths.length} 条 ↔ Host ${hostKeys.size} 个叶子）`)
})

/* ════════════════════════════════════════════════════════════
   ② 运行时（连 live DSH）
   ════════════════════════════════════════════════════════════ */
console.log('\n② 运行时（live DSH）')

let client
let live
try {
  const { DshClient } = await import(DSH_CLIENT)
  client = new DshClient(baseArg ? { baseUrl: baseArg, timeoutMs: 20000 } : { timeoutMs: 20000 })
  await client.ensureBaseUrl()
  live = { baseUrl: client.baseUrl, cookie: client.ensureCookie() }
} catch (error) {
  console.log(`  --  跳过运行时检查（连不上 DSH）：${String(error?.message ?? error).split('\n')[0]}`)
}

/** 无参端点必须手工 POST，payload 是 {args:{}}。 */
async function rpc(method, args) {
  const res = await fetch(`${live.baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: live.cookie },
    body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method,
      payload: { args: args ?? {} },
    }),
    signal: AbortSignal.timeout(20000),
  })
  return await res.json()
}

let liveRow

if (live) {
  await check('live DSH 能读到 qq-sticker 的 settings 行', async () => {
    const body = await rpc('settings/describe', {})
    if (!body?.result?.ok) throw new Error(`describe 失败：${JSON.stringify(body?.result?.error ?? body).slice(0, 300)}`)
    liveRow = body.result.value.namespaces.find((row) => row.ns === 'qq-sticker')
    if (!liveRow) throw new Error(`describe 里没有 qq-sticker：${body.result.value.namespaces.map((r) => r.ns).join(', ')}`)
  })

  await check('live Schema 的段数与源码一致（不一致 = Host 还是旧代码）', () => {
    const root = liveRow?.schema?.refs?.[liveRow.schema.uid]
    const liveSections = root?.dict ? Object.keys(root.dict) : []
    const missing = sections.filter((key) => !liveSections.includes(key))
    if (missing.length) {
      throw new Error(
        `运行中的 Host 缺这几段：${missing.join(', ')} —— Host 还是旧代码，需要完全退出 DSH 再启动。`
        + `（live 实际有 ${liveSections.length} 段：${liveSections.join(', ')}）`,
      )
    }
    console.log(`      （live ${liveSections.length} 段，与源码一致）`)
  })

  await check('写 live Schema 里不存在的字段 → 被拒且文案是 is not volatile（旧 Host 的指纹）', async () => {
    const root = liveRow?.schema?.refs?.[liveRow.schema.uid]
    const liveSections = new Set(root?.dict ? Object.keys(root.dict) : [])
    // 挑一个 live 不认的段（正常应为 proactive）。若 live 已经有了，就跳过——说明已重启过了。
    const probeSection = ['proactive', 'battle', 'backup', 'store', 'gif']
      .find((key) => !liveSections.has(key))
    if (!probeSection) {
      console.log('      （live Schema 已含全部 v2 段——DSH 已经重启过，这条自然成立）')
      return
    }
    const body = await rpc('settings/mutate', {
      ns: 'qq-sticker',
      ops: [{ op: 'set', path: [probeSection, 'enabled'], value: true }],
      expectedRevision: liveRow.revision,
    })
    // 万一它居然写成功了（不该发生），立刻改回去再报错
    if (body?.result?.ok) {
      await rpc('settings/mutate', {
        ns: 'qq-sticker',
        ops: [{ op: 'unset', path: [probeSection, 'enabled'] }],
        expectedRevision: body.result.value?.revision,
      })
      throw new Error(`意外写入成功：${probeSection}.enabled —— 说明 live Schema 其实认这个段，探针前提不成立（已回滚）`)
    }
    const error = body?.result?.error ?? {}
    const message = String(error.message ?? JSON.stringify(error))
    const okCode = String(error.code ?? '').includes('settings/rejected')
    const okMessage = /is not volatile/.test(message)
    console.log(`      （${error.code}: ${message}）`)
    if (!okCode) throw new Error(`错误码不像预期：${error.code}`)
    if (!okMessage) throw new Error(`错误文案不像预期：${message}`)
  })

  await check('live /config 是否已经带 v2 段（重启前的旁证）', async () => {
    const res = await fetch(`${live.baseUrl}/dsh-qq-sticker/config`, { signal: AbortSignal.timeout(10000) })
    const body = await res.json().catch(() => ({}))
    if (body?.ok !== true) throw new Error(`GET /dsh-qq-sticker/config 失败：HTTP ${res.status}`)
    const present = ['store', 'proactive', 'battle', 'backup', 'gif'].filter((key) => key in (body.config ?? {}))
    console.log(`      （live config 里的 v2 段：${present.length ? present.join(', ') : '无'}）`)
    // 这条只作旁证，不判定失败：它是"重启前/后"的观察值，不是断言目标
  })
}

/* ════════════════════════════════════════════════════════════
   汇总
   ════════════════════════════════════════════════════════════ */
console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`\n· ${item.name}\n  ${String(item.error?.message ?? item.error)}`)
  process.exit(1)
}
console.log('全部符合预期')
process.exit(0)
