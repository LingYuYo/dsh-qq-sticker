/**
 * 表情库：内容是本地文件 + 一份 JSON 索引。
 *
 * 设计取舍（都来自原 sticker-steal 的实战结论）：
 *  · 主键 = 图片字节的 sha1（内容寻址）。同一张图从任何群收进来都只存一份，
 *    "按内容去重"比"按消息 id 去重"可靠（用户会把同一张图转发很多遍）。
 *  · 图片本体单独放 images/<sha1>.<ext>，索引只记相对文件名 —— 索引损坏时可以重建，
 *    图片不会跟着废掉。
 *  · 索引整份读写 + 防抖落盘：800 张规模下 ~300KB，够用；真要更大再换 sqlite。
 *  · 软删除用 hidden 集合，不删文件也不删条目 —— 模型误删可以恢复，
 *    而"物理删除"只发生在容量淘汰与清理，且都过 dryRun/保底。
 */
import path from 'node:path'

import { MOOD_WORDS } from './config.js'
import {
  createSaver, fileInfo, listDir, num, oneLine, readJson, removeFile,
  sha1, sniffImage, todayKey, writeBytes, writeJsonAtomic,
} from './util.js'

/** 索引结构版本。不兼容的旧结构直接重来（不猜着迁移）。 */
const LIB_VERSION = 1

/** 编号（对模型/人展示的短 id）长度。太长模型抄错，太短会撞。 */
const SHORT_ID_LEN = 10

/** 库文件布局（相对 dataDir）。 */
export const FILES = {
  index: 'library.json',
  state: 'state.json',
  schedule: 'schedule.json',
  report: 'report.txt',
  images: 'images',
}

/** 新条目：所有字段都显式给默认值（白名单式加载，漏字段就读盘丢失）。 */
function emptyItem() {
  return {
    key: '',
    src: '',
    file: '',
    path: '',
    bytes: 0,
    ext: '',
    animated: false,
    width: 0,
    height: 0,
    tags: [],
    note: '',
    text: '',
    source: 'observed',
    chatKey: '',
    sessionId: '',
    srcHint: '',
    createdAt: 0,
    usedAt: 0,
    useCount: 0,
    sentCount: 0,
    sentTo: {},
    interactShown: 0,
    interactUsers: 0,
    interactReplies: 0,
    lastReward: 0,
    tagFails: 0,
    tagTriedAt: 0,
    viewedAt: 0,
    hidden: false,
  }
}

/** 从磁盘条目归一化（字段白名单；坏条目返回 null 由调用方丢掉）。 */
function normalizeItem(raw, imagesDir) {
  if (!raw || typeof raw !== 'object') return null
  const src = String(raw.src ?? '').trim()
  const file = String(raw.file ?? '').trim()
  if (!src && !file) return null
  const item = emptyItem()
  item.src = src
  item.file = file
  item.key = src ? `src:${src}` : `file:${file.toLowerCase()}`
  item.path = file ? path.join(imagesDir, file) : String(raw.path ?? '')
  item.bytes = Math.max(0, num(raw.bytes, 0))
  item.ext = String(raw.ext ?? '').slice(0, 8)
  item.animated = raw.animated === true
  item.width = Math.max(0, num(raw.width, 0))
  item.height = Math.max(0, num(raw.height, 0))
  item.tags = Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean).slice(0, 6) : []
  item.note = String(raw.note ?? '').slice(0, 200)
  item.text = String(raw.text ?? '').slice(0, 80)
  item.source = raw.source === 'model' ? 'model' : 'observed'
  item.chatKey = String(raw.chatKey ?? '').slice(0, 60)
  item.sessionId = String(raw.sessionId ?? '').slice(0, 160)
  item.srcHint = String(raw.srcHint ?? '').slice(0, 120)
  item.createdAt = num(raw.createdAt, 0)
  item.usedAt = num(raw.usedAt, 0)
  item.useCount = Math.max(0, num(raw.useCount, 0))
  item.sentCount = Math.max(0, num(raw.sentCount, 0))
  item.sentTo = raw.sentTo && typeof raw.sentTo === 'object' && !Array.isArray(raw.sentTo)
    ? Object.fromEntries(Object.entries(raw.sentTo).slice(0, 20).map(([k, v]) => [String(k).slice(0, 160), num(v, 0)]))
    : {}
  item.interactShown = Math.max(0, num(raw.interactShown, 0))
  item.interactUsers = Math.max(0, num(raw.interactUsers, 0))
  item.interactReplies = Math.max(0, num(raw.interactReplies, 0))
  item.lastReward = num(raw.lastReward, 0)
  item.tagFails = Math.max(0, num(raw.tagFails, 0))
  item.tagTriedAt = num(raw.tagTriedAt, 0)
  item.viewedAt = num(raw.viewedAt, 0)
  item.hidden = raw.hidden === true
  return item
}

/** 短编号：sha1 前 10 位（模型和用户都用这个）。 */
export function shortId(item) {
  const src = String(item?.src ?? '')
  if (src) return src.slice(0, SHORT_ID_LEN)
  const file = String(item?.file ?? '').replace(/\.[a-z0-9]+$/i, '')
  return file.slice(0, SHORT_ID_LEN)
}

/** 一行摘要（提示词/列表/报表共用）：`#abc1234567 [开心/沙雕] 笑死 动图`。 */
export function itemLine(item, { showText = true } = {}) {
  const tag = item.tags?.length ? `[${item.tags.join('/')}]` : '[未分类]'
  const parts = [`#${shortId(item)}`, tag]
  const note = oneLine(item.note, 40)
  const text = showText ? oneLine(item.text, 20) : ''
  if (note) parts.push(note)
  if (text) parts.push(`「${text}」`)
  if (item.animated) parts.push('动图')
  return parts.join(' ')
}

/** 把"编号 / #编号 / 全 sha1 / 备注关键字"解析成条目。 */
export function matchItem(items, ref) {
  const raw = String(ref ?? '').trim().replace(/^#/, '')
  if (!raw) return null
  const lower = raw.toLowerCase()
  return items.find((item) => item.src === lower)
    ?? items.find((item) => shortId(item) === lower)
    ?? items.find((item) => item.src.startsWith(lower))
    ?? items.find((item) => item.note && item.note.includes(raw))
    ?? null
}

/**
 * 库本体。
 *
 * 一个实例属于一个插件实例；测试里可以直接 new Library({ dataDir }) 用假目录。
 */
export class Library {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir 数据目录绝对路径
   * @param {object} opts.config 归一化配置（readConfig 的返回值）
   * @param {(level:string, message:string)=>void} [opts.log]
   */
  constructor({ dataDir, config, log }) {
    this.dataDir = dataDir
    this.config = config
    this.log = log ?? (() => {})
    this.imagesDir = path.join(dataDir, FILES.images)
    this.indexFile = path.join(dataDir, FILES.index)
    /** @type {Array<object>} 全部条目（含 hidden） */
    this.items = []
    this.bornAt = Date.now()
    this._loaded = false
    this._byKey = new Map()
    this._saver = createSaver(1500, () => this.saveNow())
    /** 运行期统计（不落盘，报表里只当参考） */
    this.counters = { collected: 0, duplicates: 0, skipped: 0, evicted: 0, failed: 0 }
  }

  /** 懒加载：第一次用到才读盘。 */
  async load() {
    if (this._loaded) return this
    this._loaded = true
    const raw = await readJson(this.indexFile, null)
    if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
      const seen = new Set()
      for (const entry of raw.items) {
        const item = normalizeItem(entry, this.imagesDir)
        if (!item || seen.has(item.key)) continue
        seen.add(item.key)
        this.items.push(item)
      }
      this.bornAt = num(raw.bornAt, this.bornAt)
      if (raw.counters && typeof raw.counters === 'object') {
        for (const key of Object.keys(this.counters)) {
          this.counters[key] = Math.max(0, num(raw.counters[key], 0))
        }
      }
    }
    this._rebuildIndex()
    return this
  }

  _rebuildIndex() {
    this._byKey.clear()
    for (const item of this.items) this._byKey.set(item.key, item)
  }

  /** 立即落盘（卸载/测试用）。 */
  async saveNow() {
    try {
      await writeJsonAtomic(this.indexFile, {
        version: LIB_VERSION,
        savedAt: new Date().toISOString(),
        bornAt: this.bornAt,
        items: this.items,
        counters: this.counters,
      })
    } catch (error) {
      this.log('warn', `表情库写盘失败：${error?.message ?? error}`)
    }
  }

  /** 标记脏（1.5s 后合并写盘）。 */
  touch() {
    this._saver.mark()
  }

  async flush() {
    await this._saver.flush()
  }

  /** 可见条目（去掉 hidden 与永久剔除）。 */
  visible() {
    const blocked = new Set(this.config.library.blockedIds)
    const hiddenConfig = new Set(this.config.library.hiddenIds)
    return this.items.filter((item) => {
      if (item.hidden) return false
      const sid = shortId(item)
      if (blocked.has(sid) || blocked.has(String(item.src))) return false
      if (hiddenConfig.has(sid)) return false
      return true
    })
  }

  /** 全部条目数（含 hidden）。 */
  get size() {
    return this.items.length
  }

  /** 总字节（含 hidden，物理占盘）。 */
  totalBytes() {
    let sum = 0
    for (const item of this.items) sum += Math.max(0, item.bytes)
    return sum
  }

  find(ref) {
    return matchItem(this.items, ref)
  }

  /**
   * 收一张图进库（幂等：同 sha1 已存在就只补元信息）。
   *
   * @param {object} input
   * @param {Uint8Array} input.bytes 图片字节
   * @param {string} [input.sessionId] 来源 DSH 会话 id
   * @param {string} [input.chatKey] 来源 QQ 会话键（如 g:123，尽力而为）
   * @param {string} [input.srcHint] 来源上下文（当时群里在聊什么）
   * @param {string} [input.source] observed | model
   * @param {number} [input.width]
   * @param {number} [input.height]
   * @param {string} [input.mediaType]
   * @returns {Promise<{ok:boolean, reason?:string, item?:object, duplicate?:boolean}>}
   */
  async ingest(input) {
    await this.load()
    const bytes = input?.bytes
    if (!bytes || bytes.length === 0) return { ok: false, reason: '空图片' }
    const maxItemBytes = this.config.library.maxItemMB * 1024 * 1024
    if (bytes.length > maxItemBytes) {
      this.counters.skipped++
      return { ok: false, reason: `单张太大（${(bytes.length / 1048576).toFixed(1)}MB > ${this.config.library.maxItemMB}MB）` }
    }
    const sniff = sniffImage(bytes)
    if (!sniff) {
      this.counters.skipped++
      return { ok: false, reason: '不认识的图片格式' }
    }
    const src = sha1(bytes)
    const key = `src:${src}`
    const existing = this._byKey.get(key)
    if (existing) {
      this.counters.duplicates++
      // 已存在：补齐此前未知的来源信息（同一张图从别的群收进来，也值得记来源场景）
      let touched = false
      if (!existing.sessionId && input.sessionId) { existing.sessionId = String(input.sessionId); touched = true }
      if (!existing.chatKey && input.chatKey) { existing.chatKey = String(input.chatKey); touched = true }
      if (!existing.srcHint && input.srcHint) { existing.srcHint = oneLine(input.srcHint, 120); touched = true }
      if (touched) this.touch()
      return { ok: true, duplicate: true, item: existing }
    }

    // 容量：先试着腾地方；腾不出来就不收（绝不因为收一张新图而超限）
    const verdict = await this.ensureCapacity(bytes.length)
    if (!verdict.ok) {
      this.counters.skipped++
      return { ok: false, reason: verdict.reason }
    }

    const file = `${src.slice(0, 16)}.${sniff.ext}`
    const full = path.join(this.imagesDir, file)
    try {
      await writeBytes(full, bytes)
    } catch (error) {
      this.counters.failed++
      return { ok: false, reason: `写文件失败：${error?.message ?? error}` }
    }

    const item = emptyItem()
    item.key = key
    item.src = src
    item.file = file
    item.path = full
    item.bytes = bytes.length
    item.ext = sniff.ext
    item.animated = sniff.mediaType === 'image/gif'
    item.width = Math.max(0, num(input.width, 0))
    item.height = Math.max(0, num(input.height, 0))
    if (!item.width || !item.height) {
      const dim = dimensionsOf(bytes, sniff.ext)
      item.width = dim.width
      item.height = dim.height
    }
    item.source = input.source === 'model' ? 'model' : 'observed'
    item.sessionId = String(input.sessionId ?? '').slice(0, 160)
    item.chatKey = String(input.chatKey ?? '').slice(0, 60)
    item.srcHint = oneLine(input.srcHint, 120)
    item.createdAt = Date.now()

    this.items.push(item)
    this._byKey.set(item.key, item)
    this.counters.collected++
    this.touch()
    return { ok: true, item }
  }

  /**
   * 容量检查：超限就按「最少发 → 最久没用 → 最早入库」淘汰，直到合规。
   * 腾不出空间（比如只剩保底张数）就拒绝收新的。
   *
   * @param {number} incomingBytes 即将写入的字节数
   */
  async ensureCapacity(incomingBytes = 0) {
    const maxCount = this.config.library.maxCount
    const maxBytes = this.config.library.maxTotalMB * 1024 * 1024
    let evicted = 0
    while (this.items.length + 1 > maxCount || this.totalBytes() + incomingBytes > maxBytes) {
      const victim = this._pickEviction()
      if (!victim) {
        return {
          ok: false,
          reason: `库已满（${this.items.length} 张 / ${(this.totalBytes() / 1048576).toFixed(0)}MB），且没有可淘汰的旧图`,
        }
      }
      await this.removeItem(victim, { reason: 'evict' })
      evicted++
      if (evicted > 5000) break // 防御：绝不死循环
    }
    if (evicted > 0) {
      this.counters.evicted += evicted
      this.touch()
      this.log('info', `容量超限，淘汰 ${evicted} 张旧图（现在 ${this.items.length} 张）`)
    }
    return { ok: true }
  }

  /** 淘汰候选：优先 hidden → 从没发过 → 发得最少 → 最久没用 → 最早入库。 */
  _pickEviction() {
    if (this.items.length === 0) return null
    const score = (item) => {
      const hiddenBonus = item.hidden ? -1e9 : 0
      return hiddenBonus
        + item.sentCount * 1000
        + item.useCount * 100
        + item.interactShown * 10
        + Math.min(item.usedAt, Date.now()) / 1e10
    }
    let worst = null
    let worstScore = Infinity
    for (const item of this.items) {
      const s = score(item)
      if (s < worstScore) { worstScore = s; worst = item }
    }
    return worst
  }

  /** 物理删除条目 + 图片文件。 */
  async removeItem(item, { reason = '' } = {}) {
    if (!item) return false
    const idx = this.items.indexOf(item)
    if (idx < 0) return false
    this.items.splice(idx, 1)
    this._byKey.delete(item.key)
    if (item.path) await removeFile(item.path)
    if (reason === 'evict') this.counters.evicted++
    this.touch()
    return true
  }

  /** 软隐藏（可恢复）。 */
  hide(item) {
    if (!item) return false
    if (item.hidden) return true
    item.hidden = true
    this.touch()
    return true
  }

  unhide(item) {
    if (!item) return false
    if (!item.hidden) return true
    item.hidden = false
    this.touch()
    return true
  }

  /** 记一次发送（影响评分与"最近发过"轮换）。 */
  markSent(item, sessionId, now = Date.now()) {
    if (!item) return
    item.sentCount = num(item.sentCount, 0) + 1
    item.usedAt = now
    item.useCount = num(item.useCount, 0) + 1
    if (sessionId) item.sentTo[String(sessionId)] = now
    this.touch()
  }

  /** 写标签/备注/文字。tags 会做闭合词表对齐（子串命中即归到标准词）。 */
  annotate(item, patch = {}) {
    if (!item) return null
    if (Array.isArray(patch.tags)) {
      item.tags = [...new Set(patch.tags.map(String).map(normalizeTag).filter(Boolean))].slice(0, 6)
    }
    if (patch.note !== undefined) item.note = String(patch.note ?? '').slice(0, 200)
    if (patch.text !== undefined) item.text = String(patch.text ?? '').slice(0, 80)
    if (patch.srcHint !== undefined) item.srcHint = oneLine(patch.srcHint, 120)
    item.tagTriedAt = Date.now()
    item.lastReward = num(item.lastReward, 0)
    this.touch()
    return item
  }

  /** 视觉识别失败一次：累计次数（用来判"无意义"是否达标）。 */
  markTagFail(item) {
    if (!item) return
    item.tagFails = num(item.tagFails, 0) + 1
    item.tagTriedAt = Date.now()
    this.touch()
  }

  /** 自愈：索引里有路径但文件已丢的条目清出去。返回被清的条数。 */
  async pruneMissingFiles() {
    await this.load()
    const gone = []
    for (const item of this.items) {
      const info = await fileInfo(item.path)
      if (!info.exists) gone.push(item)
    }
    for (const item of gone) await this.removeItem(item)
    if (gone.length > 0) this.log('warn', `清掉 ${gone.length} 条「图片文件已丢失」的条目`)
    return gone.length
  }

  /** 清掉 images/ 里没有任何条目引用的文件（索引损坏后的收尾）。 */
  async pruneOrphanFiles() {
    const referenced = new Set(this.items.map((item) => item.file))
    const files = await listDir(this.imagesDir)
    let removed = 0
    for (const file of files) {
      if (referenced.has(file)) continue
      if (!/\.(png|jpe?g|gif|webp)$/i.test(file)) continue
      await removeFile(path.join(this.imagesDir, file))
      removed++
    }
    if (removed > 0) this.log('info', `清掉 ${removed} 个无人引用的图片文件`)
    return removed
  }

  /** 报表：库里现在什么状况。 */
  stats() {
    const visible = this.visible()
    const tagged = this.items.filter((item) => item.tags.length > 0 || item.note || item.text).length
    const animated = this.items.filter((item) => item.animated).length
    const sentItems = this.items.filter((item) => item.sentCount > 0)
    const shown = this.items.filter((item) => item.interactShown > 0)
    return {
      total: this.items.length,
      visible: visible.length,
      hidden: this.items.filter((item) => item.hidden).length,
      tagged,
      untagged: this.items.length - tagged,
      animated,
      meaningless: this.items.filter((item) => item.tags.includes('无意义')).length,
      sentItems: sentItems.length,
      sentTotal: this.items.reduce((sum, item) => sum + item.sentCount, 0),
      shownItems: shown.length,
      bytes: this.totalBytes(),
      bornAt: this.bornAt,
    }
  }

  /** 表现报表（文本）：哪些图真能带动气氛。 */
  reportText() {
    const s = this.stats()
    const lines = []
    const push = (text) => lines.push(text)
    push(`表情库：${s.total} 张（可见 ${s.visible}｜隐藏 ${s.hidden}｜动图 ${s.animated}）`)
    push(`已认识 ${s.tagged} 张｜没认识 ${s.untagged} 张｜标「无意义」${s.meaningless} 张`)
    push(`被发过 ${s.sentItems} 张，累计 ${s.sentTotal} 次｜有互动统计 ${s.shownItems} 张`)
    push(`占用 ${(s.bytes / 1048576).toFixed(1)} MB`)

    if (s.shownItems === 0) {
      push('')
      push('⚠️ 还没有互动统计。发一张表情后 3 分钟会回看群里的反应，那之后这里才有数据。')
    } else {
      const rows = this.items
        .filter((item) => item.interactShown > 0)
        .map((item) => ({ item, reward: interactionReward(item) }))
        .sort((a, b) => b.reward - a.reward)
      const hot = rows.filter((row) => row.reward >= 0.1875)
      const warm = rows.filter((row) => row.reward >= 0.0625 && row.reward < 0.1875)
      const cold = rows.filter((row) => row.reward === 0)
      push('')
      push(`🏆 带动气氛 ${hot.length} 张｜🙂 有回应 ${warm.length} 张｜💤 无人搭理 ${cold.length} 张`)
      push('')
      push('表现最好的（单次互动奖励均值）：')
      for (const row of rows.slice(0, 12)) {
        const tags = row.item.tags.join('/') || '未分类'
        push(`  #${shortId(row.item)} ${row.reward.toFixed(3)} [${tags}] `
          + `${oneLine(row.item.note || row.item.text, 40)}（${row.item.interactShown} 次统计）`)
      }
      if (cold.length > 0) {
        push('')
        push(`从没引起回应的 ${cold.length} 张：`
          + cold.slice(0, 10).map((row) => `#${shortId(row.item)}(${row.item.interactShown}次)`).join('、'))
      }
    }

    const hotSent = this.items
      .filter((item) => item.sentCount >= 2)
      .sort((a, b) => b.sentCount - a.sentCount)
    push('')
    push('被发得最多的（模型偏好）：')
    if (hotSent.length === 0) push('  （还没有发过 2 次以上的图）')
    for (const item of hotSent.slice(0, 10)) {
      push(`  #${shortId(item)} 发过 ${item.sentCount} 次｜${item.animated ? '动图' : '静态'}`
        + `｜标签 ${item.tags.join('/') || '未分类'}`
        + `｜互动 ${item.interactShown ? `均值 ${interactionReward(item).toFixed(3)}` : '（暂无）'}`)
    }
    return lines.join('\n')
  }
}

/** 互动奖励（与原插件同权重）：0.125·min(U/3,1) + 0.125·min(M/5,1)。 */
export function interactionReward(item) {
  const shown = num(item?.interactShown, 0)
  if (!shown) return 0
  const users = Math.min(num(item.interactUsers, 0) / Math.max(1, shown) / 3, 1)
  const replies = Math.min(num(item.interactReplies, 0) / Math.max(1, shown) / 5, 1)
  return 0.125 * users + 0.125 * replies
}

/** 情绪标签 → 标准词（闭合词表，防止自由发挥把标签打散）。 */
export function normalizeTag(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  // 精确命中直接用
  if (MOOD_WORDS.includes(text)) return text
  // 「无意义」是特殊判定：明确说看不出内容的，一律归到这里
  if (text.includes('无意义')) return '无意义'
  const meaninglessHints = ['看不出', '纯色', '乱码', '残缺', '空白图', '无内容', '无法辨认']
  if (meaninglessHints.some((hint) => text.includes(hint))) return '无意义'
  // 其余做子串对齐：模型常给「开心/高兴」「有点无奈」这种
  for (const word of MOOD_WORDS) {
    if (word === '无意义') continue
    if (text.includes(word)) return word
  }
  const alias = {
    高兴: '开心', 快乐: '开心', 笑: '开心', 兴奋: '开心',
    无语: '无奈', 叹气: '无奈', 摊手: '无奈',
    愤怒: '生气', 恼火: '生气', 气: '生气',
    伤心: '难过', 哭: '难过', 低落: '难过',
    腼腆: '害羞', 脸红: '害羞',
    震惊: '惊讶', 吃惊: '惊讶',
    讽刺: '嘲讽', 阴阳: '嘲讽', 嘲笑: '嘲讽',
    同意: '赞同', 赞: '赞同', 好耶: '赞同',
    反对: '拒绝', 不要: '拒绝',
    你好: '打招呼', 招手: '打招呼', 嗨: '打招呼',
    安慰: '关心', 抱抱: '关心', 摸摸: '关心',
    梗: '沙雕', 搞怪: '沙雕', 滑稽: '沙雕',
    摸鱼: '发呆', 愣: '发呆', 空白: '发呆',
    睡了: '困', 困倦: '困', 睡觉: '困',
    暗爽: '偷看', 偷瞄: '偷看', 盯: '偷看',
    慌: '紧张', 害怕: '紧张',
    绘画: '插画', 画: '插画',
  }
  for (const [needle, word] of Object.entries(alias)) {
    if (text.includes(needle)) return word
  }
  return '其他'
}

/**
 * 读 PNG/JPEG/GIF/WEBP 的像素尺寸（不依赖图像库）。
 * 认不出返回 {width:0,height:0}（调用方按 0 处理，不做判定）。
 */
export function dimensionsOf(bytes, ext) {
  try {
    if (ext === 'png' && bytes.length >= 24) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    if (ext === 'gif' && bytes.length >= 10) {
      return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
    }
    if (ext === 'jpg') return jpegDimensions(bytes)
    if (ext === 'webp') return webpDimensions(bytes)
  } catch { /* 解析失败就当未知 */ }
  return { width: 0, height: 0 }
}

function jpegDimensions(bytes) {
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue }
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      }
    }
    i += 2 + length
  }
  return { width: 0, height: 0 }
}

function webpDimensions(bytes) {
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return { width: 0, height: 0 }
}

/** 当前日期键（配额重置判断用）。 */
export { todayKey }
