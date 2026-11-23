/**
 * 工具输出 schema 回归（2026-11-23）。
 *
 * 背景：真机 11-19 调用 `qq_ext_sticker_pick` 直接失败：
 *   Error: tool "qq_ext_sticker_pick" returned invalid output:
 *   "value.quota.perSessionDaily" is not a declared property (additionalProperties: false);
 *   "value.quota.usedToday" is not a declared property ...
 *
 * 根因：`quotaBrief()` 返回的字段比 pick 的 output.schema 多，而且 remaining 还返回过 null。
 * 官方的工具输出校验是 additionalProperties:false + 类型严格，多一个字段/一个 null 就整条失败。
 *
 * 这个测试不需要启动 DSH：直接读 src/tools.js 源码，把「quotaBrief 返回的键」和
 * 「pick schema 声明的 quota 键」做集合比对，防止以后再漂移。
 *
 * 用法：node test-tool-output.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(HERE, 'src', 'tools.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (error) {
    console.log(`  ✗ ${name}\n      ${error.message}`)
    fail++
  }
}

/** 从源码里截一段（找不到就抛，避免正则静默通过）。 */
function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, `找不到起始标记：${startMarker}`)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(end > start, `找不到结束标记：${endMarker}`)
  return source.slice(start, end)
}

console.log('工具输出 schema 回归：')

const quotaBrief = slice('const quotaBrief =', 'const defs = []')
const pickTool = slice('name: TOOL.PICK', 'name: TOOL.SEND')
const quotaSchema = pickTool.slice(pickTool.indexOf('quota: {'))

// quotaBrief 返回对象的顶层键（缩进 6 空格 + key:）
const returnedKeys = [
  ...quotaBrief.matchAll(/^ {6}(\w+):/gm),
  ...quotaBrief.matchAll(/^ {6}(\w+),$/gm),
].map((row) => row[1])
const schemaKeys = [...quotaSchema.matchAll(/^ {14}(\w+):/gm)].map((row) => row[1])

check('quotaBrief 至少返回 level/activity/perSessionDaily/usedToday/remaining', () => {
  for (const key of ['level', 'activity', 'perSessionDaily', 'usedToday', 'remaining']) {
    assert.ok(returnedKeys.includes(key), `quotaBrief 缺少 ${key}（实际：${returnedKeys.join(',')}）`)
  }
})

check('pick schema 的 quota 声明覆盖 quotaBrief 的所有返回键', () => {
  const missing = returnedKeys.filter((key) => !schemaKeys.includes(key))
  assert.deepEqual(missing, [], `schema 少了这些字段：${missing.join(', ')}`)
})

check('remaining 不能返回 null（schema 是 number，null 会整条工具调用失败）', () => {
  assert.equal(/remaining:[^,\n]*\bnull\b/u.test(quotaBrief), false, 'quotaBrief 里 remaining 还在返回 null')
  assert.equal(/remaining: \{ type: 'number'/u.test(quotaSchema), true, 'schema 里 remaining 必须是 number')
})

check('不限额度用 unlimited 标记，而不是 remaining=null', () => {
  assert.ok(schemaKeys.includes('unlimited'), 'schema 缺 unlimited')
  assert.ok(/unlimited:/u.test(quotaBrief), 'quotaBrief 没返回 unlimited')
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
