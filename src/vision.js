/**
 * 视觉识别 / 自动打标。
 *
 * 为什么插件自己调 LLM 而不是让 agent 调工具：`organize` 要能"一键整理全库"，
 * 而且收录时要"悄悄识别"——这些都不该占用模型的一轮对话。原插件是直调核心
 * chatCompletion，这里换成 DSH 的 `ctx.llm.prepareCall` + `stream`。
 *
 * 两道保险（原插件的实测教训，必须保留）：
 *  ① 单次整理最多删 25 张（防止一次模型抽风把整个库清空）；
 *  ② 一批 ≥3 张且失败比例 ≥0.5 → 判"可疑"，本批**不删**，只累计失败次数。
 *     这通常不是图片的问题，是模型/网络挂了。
 */
import { clamp, num, oneLine } from './util.js'
import { normalizeTag, shortId } from './library.js'
import { MOOD_WORDS } from './config.js'
import { alignTag, buildTagPromptSection, tagVocabulary } from './tagging.js'

/** 单次整理硬删除上限。 */
export const MAX_DELETE_PER_RUN = 25

/** 判"可疑批次"的最小样本数与失败比例。 */
const SUSPICIOUS_MIN_BATCH = 3
const SUSPICIOUS_FAIL_RATIO = 0.5

/** 图片传入前的最大边长（原插件 320/256；太大费 token 且没必要）。 */
const MAX_VIEW_DIM = 320

/**
 * 看图打标器。
 *
 * @param {object} opts
 * @param {import('./library.js').Library} opts.library
 * @param {() => object} opts.getConfig
 * @param {(level:string, message:string)=>void} [opts.log]
 * @param {object} [opts.deps]
 * @param {(bytes:Uint8Array, mediaType:string)=>Promise<object|null>} opts.deps.saveImage 存成附件 ref
 * @param {(args:object)=>Promise<string>} opts.deps.chat 一次多模态请求，返回正文
 * @param {() => boolean} [opts.deps.canSee] 当前路由是否支持图片输入
 * @param {(now?:number)=>number} [opts.deps.budgetLeft]
 * @param {(now?:number)=>void} [opts.deps.useBudget]
 */
export class Vision {
  constructor({ library, getConfig, log, deps = {} }) {
    this.library = library
    this.getConfig = getConfig
    this.log = log ?? (() => {})
    this.deps = deps
  }

  /** 能力自检：没有看图依赖时，所有识别工具都要**明确拒绝**而不是假装成功。 */
  available() {
    if (typeof this.deps.chat !== 'function') return { ok: false, reason: '当前宿主没有可用的 LLM 调用通道' }
    if (typeof this.deps.saveImage !== 'function') return { ok: false, reason: '拿不到附件服务，无法把图片交给模型' }
    if (typeof this.deps.canSee === 'function' && !this.deps.canSee()) {
      return { ok: false, reason: '当前模型/路由不支持图片输入（设置里换个支持看图的模型试试）' }
    }
    return { ok: true }
  }

  /**
   * 识一批图。返回每张的结果（并原地写回库）。
   *
   * @param {Array<object>} items
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun] 只报告不动库
   * @returns {Promise<{tagged:number, meaningless:number, failures:number, deleted:Array, suspicious:boolean, dryRun:boolean, errors:string[]}>}
   */
  async recognizeBatch(items, { dryRun = false } = {}) {
    const out = {
      tagged: 0, meaningless: 0, failures: 0, deleted: [], suspicious: false,
      dryRun, errors: [], tried: items.length,
    }
    if (items.length === 0) return out
    const ability = this.available()
    if (!ability.ok) {
      out.errors.push(ability.reason)
      return out
    }

    let payload
    try {
      payload = await this._askAndParse(items)
    } catch (error) {
      out.failures = items.length
      out.errors.push(`识别请求失败：${error?.message ?? error}`)
      return out
    }

    const cfg = this.getConfig()
    const byId = new Map(items.map((item) => [shortId(item), item]))
    for (const entry of payload) {
      const item = byId.get(String(entry.id ?? ''))
      if (!item) continue
      const tags = normalizeTagsFor(cfg, entry.tags)
      const note = oneLine(entry.note, 120)
      const text = oneLine(entry.text, 60)
      if (tags.length === 0 && !note && !text) {
        // 模型这一张没给结论 → 记失败（不动 tags）
        out.failures++
        if (!dryRun) this.library.markTagFail(item)
        continue
      }
      if (tags.includes('无意义')) out.meaningless++
      else out.tagged++
      if (dryRun) continue
      this.library.annotate(item, { tags, note, text })
      // ⚠️ 「无意义」要**累计**失败次数，不能清零：达阈值才删。
      //    （清零的话这张图永远删不掉 —— 一次误判会把计数洗回 0。）
      if (tags.includes('无意义')) this.library.markTagFail(item)
      else item.tagFails = 0
    }

    // 没有任何响应的（模型漏答）也算失败
    const answered = new Set(payload.map((entry) => String(entry.id ?? '')))
    const missed = items.filter((item) => !answered.has(shortId(item)))
    out.failures += missed.length
    if (!dryRun) for (const item of missed) this.library.markTagFail(item)

    // ② 可疑批次：失败比例过高就不自动删
    if (out.tried >= SUSPICIOUS_MIN_BATCH && out.failures / out.tried >= SUSPICIOUS_FAIL_RATIO) {
      out.suspicious = true
      out.errors.push(`本批 ${out.tried} 张里失败 ${out.failures} 张，比例过高，判为「可疑批次」：本批不自动删图（多半是模型或网络挂了，稍后重试）`)
      return out
    }

    // 达阈值的「无意义」按策略处理
    const maxAttempts = cfg.vision.organizeMaxAttempts
    const stale = items.filter((item) => item.tags.includes('无意义') && num(item.tagFails, 0) >= maxAttempts)
    if (cfg.vision.organizeOnTagFail === 'delete') {
      let deleted = 0
      for (const item of stale) {
        if (deleted >= MAX_DELETE_PER_RUN) {
          out.errors.push(`有 ${stale.length - deleted} 张达到删除条件但本次没删：单次整理最多删 ${MAX_DELETE_PER_RUN} 张（防一次异常清空整库）。再跑一次可以继续。`)
          break
        }
        out.deleted.push({ id: shortId(item), fails: num(item.tagFails, 0), bytes: item.bytes })
        if (!dryRun) await this.library.removeItem(item)
        deleted++
      }
    }
    return out
  }

  /** 收录时识图（一张一张，串行 + 小间隔；失败不动 tagFails）。 */
  async recognizeOnIngest(items, { budgetLeft = () => Infinity, useBudget = () => { } } = {}) {
    const cfg = this.getConfig()
    if (!cfg.vision.recognizeOnIngest) return { tagged: 0, skipped: 'disabled' }
    const ability = this.available()
    if (!ability.ok) return { tagged: 0, skipped: ability.reason }
    let tagged = 0
    for (const item of items) {
      if (budgetLeft() <= 0) return { tagged, skipped: 'budget' }
      try {
        const payload = await this._askAndParse([item])
        useBudget()
        const entry = payload[0]
        if (!entry) continue
        const tags = normalizeTagsFor(cfg, entry.tags)
        const note = oneLine(entry.note, 120)
        const text = oneLine(entry.text, 60)
        if (tags.length === 0 && !note && !text) continue
        this.library.annotate(item, { tags, note, text })
        tagged++
      } catch (error) {
        this.log('warn', `收录识图失败（这张先不标，之后可用「整理」补）：${error?.message ?? error}`)
      }
      await sleep(300)
    }
    return { tagged }
  }

  /**
   * 一次多模态请求：把一批图交给模型，让它返回 JSON 数组。
   *
   * 为什么强制 JSON：自然语言描述没法入库；而且"每张都必须给结论"这句话
   * 能显著降低漏答（原插件实测）。
   */
  async _askAndParse(items) {
    const cfg = this.getConfig()
    const refs = []
    for (const item of items) {
      const ref = await this.deps.saveImage(item)
      if (!ref) continue
      refs.push({ id: shortId(item), ref, hint: item.srcHint || item.note || '' })
    }
    if (refs.length === 0) throw new Error('这批图都读不出来（文件缺失或格式不支持）')

    const prompt = buildPrompt(refs, cfg)
    const route = `${cfg.vision.providerId || '(会话默认)'}/${cfg.vision.model || ''}`
    let text
    try {
      text = await this.deps.chat({
        prompt,
        imageRefs: refs.map((entry) => entry.ref),
        providerId: cfg.vision.providerId || undefined,
        model: cfg.vision.model || undefined,
        maxTokens: 2600,
        temperature: 0.2,
      })
      this.deps.onCallResult?.({ ok: true, reason: '', route })
    } catch (error) {
      // 把失败原因记下来：UI 的「视觉识别通道」要据此显示真实状态，
      // 不能因为 handler 存在就报"就绪"（那会在真机上给虚假希望）。
      this.deps.onCallResult?.({ ok: false, reason: String(error?.message ?? error), route })
      this.log('warn', `视觉请求失败（route=${route}）：${error?.message ?? error}`)
      throw error
    }
    return parseJsonArray(text, refs.map((entry) => entry.id))
  }
}

/**
 * 一批原始标签 → 对齐后的标签（v2 标签体系）。
 *
 * 与 library.normalizeTag 的差别：优先用**用户配置的词表**，用户词不会被内置词
 * 抢走；用户扩展过词表时还会保留对不上的自由词（不静默丢弃）。
 *
 * @param {object} config 归一化配置
 * @param {unknown} rawTags 模型返回的 tags 数组
 * @returns {string[]} 已对齐、去重、非空的标签（最多 6 个）
 */
export function normalizeTagsFor(config, rawTags) {
  const list = Array.isArray(rawTags) ? rawTags : []
  const vocabulary = tagVocabulary(config)
  const out = []
  const seen = new Set()
  for (const raw of list) {
    // alignTag 负责用户词优先 + 无意义强判定 + 自由词保留；兜底再走一次内置归一化
    const tag = alignTag(raw, vocabulary) || normalizeTag(raw)
    if (!tag || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= 6) break
  }
  return out
}

/** 识图提示词（对齐原插件口径：必须 JSON 数组、每张都要给结论）。 */
export function buildPrompt(refs, config) {
  const lines = []
  lines.push('你要给「聊天表情包」做标注。看下面的图片，对**每一张**都给出结论。')
  lines.push('')
  lines.push('严格只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块。数组每一项：')
  lines.push('{"id":"<图片编号>","tags":["<情绪词>"],"note":"<一句话适用场合>","text":"<图上文字>"}')
  lines.push('')
  // v2：标签体系可配置（预设类别 + 自定义标签）。buildTagPromptSection 会处理
  // 两种形态：有类别时按类别分组、没类别时退回内置词表，并兜住长度上限。
  // 它已经含「无意义」的判定说明，这里不要再重复一遍。
  lines.push(buildTagPromptSection(config, 900))
  lines.push('note：一句中文，说明"什么时候适合发这张"，如「举着白旗的猫，服软认错时用」。不要写"这是一张图片"这种废话。')
  lines.push('text：图上出现的文字，一个字也别漏（哪怕只是「嗯」「?」）；确实没有就填空字符串。不要编。')
  lines.push('')
  lines.push('要标注的图片：')
  for (const entry of refs) {
    lines.push(`- id=${entry.id}${entry.hint ? `（来源场景：${oneLine(entry.hint, 40)}）` : ''}`)
  }
  if (config?.vision?.organizeBatchSize) {
    lines.push('')
    lines.push(`（本批共 ${refs.length} 张，请全部标注）`)
  }
  return lines.join('\n')
}

/**
 * 从模型输出里抠 JSON 数组。
 *
 * 模型常见毛病：外面包 ```json、前面加一句"好的"、末尾多一个逗号。
 * 这里做三件事：剥代码块 → 找第一个 `[` 到最后一个 `]` → 修尾逗号重试。
 * 还不行就按单个对象逐条抠（宁可只剩一半，也别整批失败）。
 */
export function parseJsonArray(text, knownIds) {
  const raw = String(text ?? '').trim()
  if (!raw) return []
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1))
  candidates.push(raw)

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (Array.isArray(parsed)) return normalizeEntries(parsed, knownIds)
  }
  // 兜底：逐对象抠
  const out = []
  const objRe = /\{[^{}]*\}/g
  let match
  while ((match = objRe.exec(raw)) !== null) {
    const parsed = tryParse(match[0])
    if (parsed && typeof parsed === 'object') out.push(parsed)
  }
  return normalizeEntries(out, knownIds)
}

function tryParse(text) {
  const attempts = [
    text,
    text.replace(/,\s*([}\]])/g, '$1'),
  ]
  for (const attempt of attempts) {
    try { return JSON.parse(attempt) } catch { /* 继续试 */ }
  }
  return null
}

function normalizeEntries(list, knownIds) {
  const allowed = new Set(knownIds)
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const id = String(entry.id ?? '').trim()
    if (!allowed.has(id)) continue
    out.push({
      id,
      tags: Array.isArray(entry.tags) ? entry.tags : (typeof entry.tags === 'string' ? entry.tags.split(/[,\s/]+/) : []),
      note: String(entry.note ?? ''),
      text: String(entry.text ?? ''),
    })
  }
  return out
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.() })
}

/** 把长边压到 MAX_VIEW_DIM 以内（只用于"交图给模型"；发送用原图）。 */
export { MAX_VIEW_DIM }
