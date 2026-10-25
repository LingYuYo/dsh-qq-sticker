/**
 * 标签体系：预设类别 + 自定义标签。
 *
 * 原来的标签是**闭合词表**（MOOD_WORDS 18 个词 + normalizeTag 把自由词往里归）。
 * 那种做法保证了"标签不会被打散"，但用户没法加自己的分类。这里在保留闭合
 * 兜底的前提下，允许用户扩展：
 *
 *   · 预设类别（tagCategories）：按类别给出词表，如
 *       「情绪」开心/无奈/生气  「人物特征」猫娘/大叔  「动作」挥手/比心
 *   · 自定义标签（customTags）：不属于任何类别的散词
 *
 * 两者合成一个**有序词表**：先预设类别里的词（按类别顺序），再自定义词，
 * 最后才是内置的 MOOD_WORDS（保证老库的标签仍然认得）。
 *
 * 为什么"顺序"重要：`normalizeTag` 是子串匹配，先命中先返回。把用户词放前面，
 * 用户写「猫娘」不会被内置的「插画」之类抢走。
 */
import { MOOD_WORDS } from './config.js'

/** 默认只有内置情绪词，不预设类别（保持向后兼容）。 */
export const DEFAULT_TAG_CATEGORIES = []

/** 自定义标签分隔符：逗号 / 分号 / 空白（中英文都算）。 */
function splitWords(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[,;，；\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * 解析 `tagCategories` 配置。
 *
 * 支持两种写法（设置页里用文本编辑更省事，所以两种都吃）：
 *
 * ① 结构化数组（JSON 存的时候用这个）：
 *    `[{ name: '情绪', tags: ['开心','无奈'] }, { name: '动作', tags: ['挥手'] }]`
 * ② 纯文本，一行一个类别，`类别: 词1, 词2`：
 *    ```
 *    情绪: 开心, 无奈, 生气
 *    动作: 挥手, 比心
 *    ```
 *
 * @param {unknown} raw
 * @returns {Array<{name:string, tags:string[]}>} 已去重、已过滤空项
 */
export function parseTagCategories(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        name: String(entry.name ?? '').trim() || '未命名',
        tags: splitWords(entry.tags),
      }))
      .filter((entry) => entry.tags.length > 0)
  }

  const text = String(raw ?? '').trim()
  if (!text) return []

  const out = []
  for (const line of text.split(/\r?\n/)) {
    const row = line.trim()
    if (!row || row.startsWith('#')) continue
    // 「类别: 词1, 词2」或「类别 词1 词2」
    const separator = row.search(/[:：]/)
    const name = separator >= 0 ? row.slice(0, separator).trim() : ''
    const body = separator >= 0 ? row.slice(separator + 1) : row
    const tags = splitWords(body)
    if (tags.length === 0) continue
    out.push({ name: name || '未命名', tags })
  }
  return out
}

/**
 * 合成去掉重后的完整词表。
 *
 * 顺序：预设类别的词（类别顺序，类别内顺序）→ 自定义词 → 内置情绪词。
 * 「无意义」永远在最后且只出现一次（它是判定哨兵，不该被用户词挤掉）。
 *
 * @param {object} config 归一化配置
 * @returns {string[]}
 */
export function tagVocabulary(config) {
  const categories = parseTagCategories(config?.vision?.tagCategories)
  const custom = splitWords(config?.vision?.customTags)
  const seen = new Set()
  const out = []

  const push = (word) => {
    const text = String(word ?? '').trim()
    if (!text) return
    if (text === '无意义') return           // 哨兵词单独追加
    if (seen.has(text)) return
    seen.add(text)
    out.push(text)
  }

  for (const category of categories) for (const tag of category.tags) push(tag)
  for (const tag of custom) push(tag)
  for (const word of MOOD_WORDS) push(word)
  out.push('无意义')
  return out
}

/**
 * 词 → 类别名的映射（报表/UI 里按类别分组显示用）。
 *
 * @param {object} config
 * @returns {Map<string, string>} tag → category
 */
export function tagCategoryMap(config) {
  const map = new Map()
  for (const category of parseTagCategories(config?.vision?.tagCategories)) {
    for (const tag of category.tags) {
      if (!map.has(tag)) map.set(tag, category.name)
    }
  }
  return map
}

/**
 * 把自由标签对齐到词表。
 *
 * 比 library.normalizeTag 更宽松：先走用户词表（精确 → 子串），再走内置。
 * 保留「无意义」的强判定语义（模型说看不出内容就归到那儿）。
 *
 * @param {unknown} raw
 * @param {string[]} vocabulary tagVocabulary() 的结果
 * @returns {string} 对齐后的标签，或 ''（空标签）
 */
export function alignTag(raw, vocabulary) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const words = Array.isArray(vocabulary) && vocabulary.length > 0 ? vocabulary : tagVocabulary({})

  // 「无意义」的多种说法先拦下来（这是唯一允许"模糊命中"的判定）
  if (text.includes('无意义')) return '无意义'
  const meaninglessHints = ['看不出', '纯色', '乱码', '残缺', '空白图', '无内容', '无法辨认']
  if (meaninglessHints.some((hint) => text.includes(hint))) return '无意义'

  // ① 精确命中
  const exact = words.find((word) => word === text)
  if (exact) return exact

  // ② 用户词优先做子串匹配（避免用户词被内置词抢走）
  const builtinSet = new Set(MOOD_WORDS)
  const userWords = words.filter((word) => !builtinSet.has(word) && word !== '无意义')
  for (const word of userWords) {
    if (text.includes(word) || word.includes(text)) return word
  }

  // ③ 内置词子串匹配
  for (const word of words) {
    if (word === '无意义') continue
    if (text.includes(word)) return word
  }

  // ④ 都对不上：如果词表是用户扩展过的，允许保留原文做一个"自由标签"
  //    （否则用户加了新词、模型说了同义词，会被静默丢掉，体验很差）
  if (userWords.length > 0 && text.length <= 8) return text

  return ''
}

/**
 * 生成识图提示词里的标签说明段。
 *
 * @param {object} config
 * @param {number} [maxChars] 上限，超了截断（别让提示词吃掉太多预算）
 * @returns {string}
 */
export function buildTagPromptSection(config, maxChars = 900) {
  const categories = parseTagCategories(config?.vision?.tagCategories)
  const custom = splitWords(config?.vision?.customTags)
  const builtin = MOOD_WORDS.filter((word) => word !== '无意义')

  const lines = []
  if (categories.length > 0) {
    lines.push('可选标签按类别分组（优先从这些里选，每个标签必须落在一个类别里）：')
    for (const category of categories) {
      lines.push(`- ${category.name}：${category.tags.join('、')}`)
    }
  } else {
    lines.push(`可选标签（1~3 个，从这里选）：${builtin.join('、')}`)
  }

  if (custom.length > 0) {
    lines.push(`另外还可以用这些自定义标签：${custom.join('、')}`)
  }
  if (categories.length > 0) {
    lines.push(`内置兜底标签（上面都不合适时可用）：${builtin.join('、')}`)
  }

  lines.push('如果这张图确实看不出任何内容（纯色块、乱码、残缺），tags 填 ["无意义"]。')
  lines.push('标签必须是上面出现过的词，不要自己发明新词。')

  let text = lines.join('\n')
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`
  return text
}
