/**
 * test-llm-call.mjs —— LLM 调用的「prepareCall 与 stream 配置必须一致」回归。
 *
 * 这条规则来自一次真机故障（2026-10-25）：
 *   「识别请求失败：prepared LLM call config changed before adapter dispatch」
 *
 * 根因不在 qq-guard 的模型拦截器（那条 `agent/request` 瀑布只改普通聊天回合的
 * provider/model，插件自己发起的 prepareCall 根本不经过它），而是我们**只把
 * {provider, model} 交给 prepareCall，却把 temperature/maxTokens 只塞进
 * stream(options)**。DSH 的 dsh-llm 会在派发前做一次逐字段比对
 * （`callConfigEquals`，比 provider / model / reasoningEffort / temperature /
 * maxTokens / stop），对不上就抛 `INVALID_PREPARED_CALL` —— 于是每一张图都报错。
 *
 * 这个测试把「两边字段完全相同」钉死：直接从 index.js 抽出 buildCallConfig 求值，
 * 再用与 dsh-llm 相同语义的比对函数检查。
 *
 * 跑法：`node test-llm-call.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

/**
 * 与 dsh-llm `callConfigEquals` 完全同语义的比对。
 * （解包源码：dsh-llm/lib/index.js L368-372）
 */
function callConfigEquals(a, b) {
  if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false
  if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

/* ── 从 index.js 里抽出 buildCallConfig 求值（不整包 import，避免副作用）── */
const SOURCE = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const START = SOURCE.indexOf('function buildCallConfig')
assert.ok(START > 0, 'index.js 里应有 buildCallConfig（它保证 prepareCall/stream 配置一致）')
const END = SOURCE.indexOf('\n}\n', START)
assert.ok(END > START, 'buildCallConfig 函数体应完整')
const BODY = SOURCE.slice(START, END + 3)

// num 的语义：取有限数，否则回落默认
const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const buildCallConfig = new Function('num', `${BODY}; return buildCallConfig`)(num)

console.log('\n① buildCallConfig 的形状')

await check('视觉请求：prepareCall 与 stream 的配置逐字段相等', () => {
  const route = { provider: 'trae', model: 'deepseek-v4.1-flash' }
  const config = buildCallConfig(route, { maxTokens: 2600, temperature: 0.2 })
  // 插件里 stream 拿到的就是 { ...callConfig, messages }
  const streamOptions = { ...config, messages: [{ role: 'user', content: [] }] }
  assert.equal(
    callConfigEquals(streamOptions, config), true,
    `字段不一致：config=${JSON.stringify(config)} stream=${JSON.stringify({ ...streamOptions, messages: '[...]' })}`
      + ' —— 这会让 DSH 抛 "prepared LLM call config changed before adapter dispatch"',
  )
})

await check('纯文本请求（主动发图意图分析）：同样相等', () => {
  const route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
  const config = buildCallConfig(route, { maxTokens: 200, temperature: 0.3 })
  const streamOptions = { ...config, messages: [] }
  assert.equal(callConfigEquals(streamOptions, config), true)
})

await check('maxTokens 与 temperature 真的进了 config（不是只进 stream）', () => {
  const route = { provider: 'p', model: 'm' }
  const config = buildCallConfig(route, { maxTokens: 128, temperature: 0.7 })
  assert.equal(config.maxTokens, 128, 'maxTokens 必须在 prepareCall 的入参里')
  assert.equal(config.temperature, 0.7, 'temperature 必须在 prepareCall 的入参里')
})

await check('不传 controls 时只含 provider/model（别塞 undefined 字段）', () => {
  const config = buildCallConfig({ provider: 'p', model: 'm' })
  assert.deepEqual(Object.keys(config).sort(), ['model', 'provider'])
  assert.equal(callConfigEquals({ ...config, messages: [] }, config), true)
})

await check('非法 controls 被丢掉，不会污染比对', () => {
  const config = buildCallConfig({ provider: 'p', model: 'm' }, { maxTokens: NaN, temperature: 'abc' })
  assert.equal(Object.hasOwn(config, 'maxTokens'), false, 'NaN 的 maxTokens 应被丢掉')
  assert.equal(Object.hasOwn(config, 'temperature'), false, '非数字 temperature 应被丢掉')
  assert.equal(callConfigEquals({ ...config, messages: [] }, config), true)
})

console.log('\n② 反例：老写法确实会触发那个报错')

await check('只给 {provider, model} 却带 controls 派发 → 比对失败（复现旧 bug）', () => {
  const route = { provider: 'trae', model: 'deepseek-v4.1-flash' }
  // 旧写法：prepareCall 只拿 route，stream 却带 maxTokens/temperature
  const oldPrepared = { ...route }
  const oldStream = { ...route, maxTokens: 2600, temperature: 0.2, messages: [] }
  assert.equal(
    callConfigEquals(oldStream, oldPrepared), false,
    '这正是旧代码的行为 —— 用来证明这个测试确实能抓到回归',
  )
})

console.log('\n③ 第二层真凶：reasoningEffort 被 DSH 自动补全')

/**
 * 复刻 dsh-llm 的 `resolveCallWithInfo`（L2183-2207）。
 * 这是真机上「修了 temperature/maxTokens 还在报错」的原因：
 * 模型带 `reasoning.defaultEffort` 时，DSH 会把 resolvedConfig.reasoningEffort
 * 补成那个值，而调用方的 options 里还是 undefined → 比对失败。
 */
function resolveCallWithInfo(config, info) {
  const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== undefined
    ? { ...config, maxTokens: info.defaultMaxTokens } : config
  const reasoning = info.reasoning
  const requested = defaulted.reasoningEffort
  let resolvedConfig = defaulted
  if (reasoning === undefined) {
    if (requested !== undefined) throw new Error('UNSUPPORTED_REASONING_EFFORT')
  } else {
    const effective = requested ?? reasoning.defaultEffort
    if (effective !== undefined) {
      if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }
    }
  }
  return resolvedConfig
}

// 真机 trae 模型的 reasoning 元数据（有 defaultEffort='high'）
const MODEL_INFO = {
  defaultMaxTokens: 8192,
  reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
}

await check('不带 reasoningEffort 时 resolved 会被补成 defaultEffort（坑真实存在）', () => {
  const config = buildCallConfig({ provider: 'trae', model: 'deepseek-v4.1-flash' }, { maxTokens: 2600, temperature: 0.2 })
  const resolved = resolveCallWithInfo(config, MODEL_INFO)
  assert.equal(resolved.reasoningEffort, 'high', 'DSH 应把 reasoningEffort 补成 defaultEffort')
  assert.equal(
    callConfigEquals({ ...config, messages: [] }, resolved), false,
    '原始 config 与 resolved 必然不相等 —— 这正是真机第二次报错的原因',
  )
})

await check('用 prepared.config 回填后比对通过（callViaPrepared 的做法）', () => {
  const config = buildCallConfig({ provider: 'trae', model: 'deepseek-v4.1-flash' }, { maxTokens: 2600, temperature: 0.2 })
  const resolved = resolveCallWithInfo(config, MODEL_INFO)
  const aligned = {
    ...config,
    ...resolved,
    provider: resolved.provider,
    model: resolved.model,
    ...('reasoningEffort' in resolved ? { reasoningEffort: resolved.reasoningEffort } : {}),
    ...('temperature' in resolved ? { temperature: resolved.temperature } : {}),
    ...('maxTokens' in resolved ? { maxTokens: resolved.maxTokens } : {}),
    messages: [],
  }
  assert.equal(
    callConfigEquals(aligned, resolved), true,
    `回填后应相等：aligned=${JSON.stringify({ ...aligned, messages: '[...]' })} resolved=${JSON.stringify(resolved)}`,
  )
})

await check('模型没有 reasoning 元数据时也不会误加字段', () => {
  const config = buildCallConfig({ provider: 'p', model: 'm' }, { maxTokens: 100 })
  const resolved = resolveCallWithInfo(config, {})
  assert.equal(Object.hasOwn(resolved, 'reasoningEffort'), false)
  assert.equal(callConfigEquals({ ...config, messages: [] }, resolved), true)
})

await check('两处调用都走 callViaPrepared（没有漏网的裸 prepared.stream）', () => {
  // 只统计真正的代码行（排除注释）：以 `return prepared.stream(` 或裸 `prepared.stream(` 开头的
  const codeLines = SOURCE.split('\n').filter((line) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false
    return /prepared\.stream\(/.test(trimmed)
  })
  // callViaPrepared 内部那一处是允许的（它就是唯一入口）
  assert.equal(codeLines.length, 1, `prepared.stream 应只在 callViaPrepared 里出现 1 次，实际 ${codeLines.length} 处：${JSON.stringify(codeLines)}`)
  const good = [...SOURCE.matchAll(/callViaPrepared\(/g)]
  assert.ok(good.length >= 2, `应有 ≥2 处 callViaPrepared（视觉 + 纯文本），实际 ${good.length}`)
})

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
