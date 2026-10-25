import assert from 'node:assert/strict'

import {
  parseTagCategories, tagVocabulary, tagCategoryMap, alignTag, buildTagPromptSection,
  DEFAULT_TAG_CATEGORIES,
} from './src/tagging.js'
import { readConfig, DEFAULTS } from './src/config.js'

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

console.log('\n① 类别解析')

await check('空配置 → 没有类别', () => {
  assert.deepEqual(parseTagCategories(''), [])
  assert.deepEqual(DEFAULT_TAG_CATEGORIES, [])
})

await check('文本格式「类别: 词1, 词2」逐行解析', () => {
  const parsed = parseTagCategories('情绪: 开心, 无奈, 生气\n动作: 挥手, 比心')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].name, '情绪')
  assert.deepEqual(parsed[0].tags, ['开心', '无奈', '生气'])
  assert.equal(parsed[1].name, '动作')
  assert.deepEqual(parsed[1].tags, ['挥手', '比心'])
})

await check('中文冒号也认，注释行跳过', () => {
  const parsed = parseTagCategories('# 这是注释\n情绪：开心\n\n动作: 挥手')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].name, '情绪')
})

await check('结构化数组也认（JSON 存的那种）', () => {
  const parsed = parseTagCategories([
    { name: '人物', tags: ['猫娘', '大叔'] },
    { name: '空类别', tags: [] },
  ])
  assert.equal(parsed.length, 1, '空 tags 的类别应被丢掉')
  assert.equal(parsed[0].name, '人物')
})

await check('一行里没冒号 → 整行当「未命名」类别的词表', () => {
  const parsed = parseTagCategories('猫娘 大叔 萝莉')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].name, '未命名')
  assert.deepEqual(parsed[0].tags, ['猫娘', '大叔', '萝莉'])
})

console.log('\n② 词表合成')

await check('用户词排在 内置情绪词 之前', () => {
  const cfg = readConfig({ vision: { tagCategories: '人物: 猫娘', customTags: '自定义词' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(vocab[0], '猫娘', '用户类别词应排最前')
  assert.equal(vocab[1], '自定义词')
  assert.ok(vocab.includes('开心'), '内置词仍在')
  assert.equal(vocab[vocab.length - 1], '无意义', '无意义永远在最后')
})

await check('去重：用户词与内置词重名只留一份', () => {
  const cfg = readConfig({ vision: { tagCategories: '情绪: 开心,高兴', customTags: '开心' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(vocab.filter((word) => word === '开心').length, 1)
  assert.ok(vocab.includes('高兴'))
})

await check('「无意义」不会被用户词重复插入', () => {
  const cfg = readConfig({ vision: { customTags: '无意义,别的' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(vocab.filter((word) => word === '无意义').length, 1)
  assert.ok(vocab.includes('别的'))
})

await check('默认配置的词表 = 内置 18 个 + 无意义', () => {
  const vocab = tagVocabulary(readConfig({}))
  assert.equal(vocab.length, 19, `实际 ${vocab.length}：${vocab.join(',')}`)
})

console.log('\n③ 标签对齐')

await check('精确命中用户词', () => {
  const cfg = readConfig({ vision: { tagCategories: '人物: 猫娘' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(alignTag('猫娘', vocab), '猫娘')
})

await check('用户词优先于内置词（子串冲突时）', () => {
  // 用户词「笑」和内置「开心」都出现在 "笑死"里；用户词应赢
  const cfg = readConfig({ vision: { customTags: '笑死' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(alignTag('笑死', vocab), '笑死')
})

await check('内置词子串对齐仍有效（向后兼容老库）', () => {
  const vocab = tagVocabulary(readConfig({}))
  assert.equal(alignTag('有点无奈', vocab), '无奈')
  assert.equal(alignTag('开心/高兴', vocab), '开心')
})

await check('「无意义」强判定：看不出内容的都归过去', () => {
  const vocab = tagVocabulary(readConfig({}))
  assert.equal(alignTag('无意义', vocab), '无意义')
  assert.equal(alignTag('看不出内容', vocab), '无意义')
  assert.equal(alignTag('纯色块', vocab), '无意义')
  assert.equal(alignTag('乱码', vocab), '无意义')
})

await check('用户扩展了词表后，对不上的自由词会保留（不静默丢）', () => {
  const cfg = readConfig({ vision: { customTags: '摸鱼达人' } })
  const vocab = tagVocabulary(cfg)
  assert.equal(alignTag('咸鱼', vocab), '咸鱼', '词表被用户扩展过 → 保留自由词')
})

await check('没扩展词表时，对不上的自由词返回空（保持闭合）', () => {
  const vocab = tagVocabulary(readConfig({}))
  assert.equal(alignTag('完全对不上的词', vocab), '', '默认闭合词表应丢弃')
})

await check('空标签返回空', () => {
  const vocab = tagVocabulary(readConfig({}))
  assert.equal(alignTag('', vocab), '')
  assert.equal(alignTag(null, vocab), '')
})

await check('类别映射：词 → 类别名', () => {
  const cfg = readConfig({ vision: { tagCategories: '情绪: 开心,无奈\n动作: 挥手' } })
  const map = tagCategoryMap(cfg)
  assert.equal(map.get('开心'), '情绪')
  assert.equal(map.get('挥手'), '动作')
  assert.equal(map.has('内置词'), false)
})

console.log('\n④ 提示词生成')

await check('有类别时按类别分组列出', () => {
  const cfg = readConfig({ vision: { tagCategories: '情绪: 开心,无奈\n动作: 挥手' } })
  const text = buildTagPromptSection(cfg)
  assert.ok(text.includes('情绪：开心、无奈'), `实际：${text}`)
  assert.ok(text.includes('动作：挥手'))
  assert.ok(text.includes('按类别分组'))
})

await check('没类别时退回内置词清单', () => {
  const text = buildTagPromptSection(readConfig({}))
  assert.ok(text.includes('可选标签'), `实际：${text}`)
  assert.ok(text.includes('开心'))
  assert.ok(!text.includes('按类别分组'))
})

await check('自定义标签会附在提示词里', () => {
  const cfg = readConfig({ vision: { customTags: '摸鱼,加班' } })
  const text = buildTagPromptSection(cfg)
  assert.ok(text.includes('自定义标签'))
  assert.ok(text.includes('摸鱼'))
})

await check('提示词有长度上限', () => {
  const many = Array.from({ length: 200 }, (_, index) => `词${index}`).join(',')
  const cfg = readConfig({ vision: { customTags: many } })
  const text = buildTagPromptSection(cfg, 300)
  assert.ok(text.length <= 300, `实际 ${text.length}`)
  assert.ok(text.endsWith('…'))
})

await check('提示词明确禁止模型自造新词', () => {
  const text = buildTagPromptSection(readConfig({}))
  assert.ok(text.includes('不要自己发明新词') || text.includes('必须是上面出现过的词'))
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
