/**
 * 会话消息窗口：自己攒一份"最近谁说了什么"，不依赖宿主的消息库。
 *
 * 为什么必须自己攒：DSH 的 `session/event` 是 fire-and-forget 的实时流，
 * 而我们要的三件事都基于"最近一段时间"：
 *   · 活跃度（最近 30 分钟别人说了几条）→ 发送闸的缩放；
 *   · 互动结算（发图后 3 分钟有几个人回应）→ 奖励评分；
 *   · 挑选时的语境（最近聊天里有没有出现图上那句话）。
 *
 * 全部只看 user/message 的 text 块 + 图片块数量，**不读图片内容**，零 token。
 * 内存里只留最近 N 条（默认 300/会话，最多 200 个会话），退出即丢 —— 这是可接受的：
 * 重启后"最近 30 分钟"从空开始，只会让第一批判定偏保守（活跃度按冷清算）。
 */
import { num, oneLine } from './util.js'

/** 每个会话保留多少条。 */
const MAX_PER_SESSION = 300
/** 最多跟踪多少个会话（防止长跑内存涨）。 */
const MAX_SESSIONS = 200

/**
 * 一条记录的形态：
 * `{ at, senderId, self, text, imageCount, content }`
 * content 保留原始 blocks（图 ref 在互动结算里不用，collect/scan 另外走持久层）。
 */
export class SessionTracker {
  constructor() {
    /** @type {Map<string, Array<object>>} sessionId -> records（旧到新） */
    this.records = new Map()
    /** @type {Map<string, string>} sessionId -> 群名片/标题（尽力而为） */
    this.names = new Map()
    this.selfId = ''
  }

  /** 记一条用户消息。 */
  noteUserMessage(sessionId, message, { selfId = '' } = {}) {
    if (!sessionId || !message) return
    const blocks = Array.isArray(message.content) ? message.content : []
    const content = blocks.filter((block) => block && (block.type === 'text' || block.type === 'image'))
    const text = oneLine(
      content.filter((block) => block.type === 'text').map((block) => block.text).join(' '),
      200,
    )
    const imageCount = content.filter((block) => block.type === 'image').length
    // v2：记下图片身份，斗图/团战要判"是不是同一张图"。
    // ⚠️ 只认 attachmentId —— QQ 侧重新上传同一张图会拿到新 id，那种情况识别不了，
    //    这是已知局限（换来的是零 IO、零 token、不下载图片）。
    const imageRefs = content
      .filter((block) => block.type === 'image' && block.attachment)
      .map((block) => String(block.attachment.attachmentId ?? ''))
      .filter(Boolean)
    const senderId = String(message.source?.senderId ?? message.senderId ?? '')
    const self = String(selfId) !== '' && senderId === String(selfId)
    this.push(sessionId, {
      at: Date.now(),
      senderId,
      self,
      text,
      imageCount,
      imageRefs,
      content,
    })
  }

  /** 记一条机器人自己的消息（用于"不要连着发"与"发完之后等回应"）。 */
  noteOwnMessage(sessionId, text = '') {
    if (!sessionId) return
    this.push(sessionId, {
      at: Date.now(),
      senderId: this.selfId,
      self: true,
      text: oneLine(text, 200),
      imageCount: 0,
      content: [],
    })
  }

  push(sessionId, record) {
    const key = String(sessionId)
    let list = this.records.get(key)
    if (!list) {
      if (this.records.size >= MAX_SESSIONS) {
        const oldest = this.records.keys().next().value
        this.records.delete(oldest)
      }
      list = []
      this.records.set(key, list)
    }
    list.push(record)
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION)
  }

  /** 这个会话的最近记录（旧到新）。 */
  list(sessionId) {
    return this.records.get(String(sessionId)) ?? []
  }

  /** 已知会话 id（定时收集要遍历）。 */
  sessions() {
    return [...this.records.keys()]
  }

  /**
   * 最近 windowMs 内**别人**说了几条（活跃度判定）。
   * 排除机器人自己。
   */
  humanCount(sessionId, windowMs = 30 * 60 * 1000, now = Date.now()) {
    const since = now - windowMs
    let count = 0
    for (const record of this.list(sessionId)) {
      if (record.at < since) continue
      if (record.self) continue
      count++
    }
    return count
  }

  /**
   * 最近 windowMs 内别人说了多少条、多少不同的人（互动结算）。
   * @returns {{users:number, replies:number, texts:string}}
   */
  reactionSince(sessionId, since, now = Date.now()) {
    const users = new Set()
    let replies = 0
    const texts = []
    for (const record of this.list(sessionId)) {
      if (record.at <= since || record.at > now) continue
      if (record.self) continue
      replies++
      if (record.senderId) users.add(record.senderId)
      if (record.text) texts.push(record.text)
    }
    return {
      users: users.size || (replies > 0 ? 1 : 0),
      replies,
      texts: texts.join(' ').slice(0, 500),
    }
  }

  /** 最近一段时间里的文本（挑选时的语境用）。 */
  recentText(sessionId, windowMs = 10 * 60 * 1000, now = Date.now()) {
    const since = now - windowMs
    const parts = []
    for (const record of this.list(sessionId)) {
      if (record.at < since) continue
      if (record.text) parts.push(record.text)
    }
    return parts.join(' ').slice(0, 400)
  }

  /** 这个会话最近发过哪张表情（避免连发同一张）。 */
  recentStickerIds(sessionId) {
    const out = []
    for (const record of this.list(sessionId)) {
      if (record.stickerId) out.push(record.stickerId)
    }
    return out.slice(-5)
  }

  /**
   * 斗图检测：滑动窗口内有没有"多个不同的人连续发同一张图"。
   *
   * 判定口径（刻意保守，避免误跟）：
   *   · 只看 windowMs 内的记录；
   *   · 同一 attachmentId 至少被 threshold 个**不同 senderId** 发过；
   *   · 排除机器人自己（不能自己跟自己组队形）；
   *   · 取命中次数最多的那一张。
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {number} [opts.windowMs] 滑动窗口
   * @param {number} [opts.threshold] 至少几个不同的人
   * @param {number} [opts.now]
   * @returns {{hit:boolean, attachmentId:string, users:number, count:number, senders:string[]}}
   */
  detectFormation(sessionId, { windowMs = 30_000, threshold = 3, now = Date.now() } = {}) {
    const since = now - Math.max(1, num(windowMs, 30_000))
    /** @type {Map<string, {count:number, senders:Set<string>}>} */
    const byRef = new Map()

    for (const record of this.list(sessionId)) {
      if (record.at < since || record.at > now) continue
      if (record.self) continue
      const refs = Array.isArray(record.imageRefs) ? record.imageRefs : []
      for (const ref of refs) {
        let entry = byRef.get(ref)
        if (!entry) {
          entry = { count: 0, senders: new Set() }
          byRef.set(ref, entry)
        }
        entry.count++
        if (record.senderId) entry.senders.add(record.senderId)
      }
    }

    let best = null
    for (const [ref, entry] of byRef) {
      if (entry.senders.size < Math.max(2, num(threshold, 3))) continue
      if (!best || entry.senders.size > best.users || (entry.senders.size === best.users && entry.count > best.count)) {
        best = { ref, users: entry.senders.size, count: entry.count, senders: [...entry.senders] }
      }
    }
    if (!best) return { hit: false, attachmentId: '', users: 0, count: 0, senders: [] }
    return { hit: true, attachmentId: best.ref, users: best.users, count: best.count, senders: best.senders }
  }

  /**
   * 团战检测：窗口内是不是"连续出现多张图"。
   *
   * 与 detectFormation 的区别：那个看"同一张图被多人发"，这个看"图多不多"——
   * 连续几张不同的图刷屏，就该考虑加入战斗。
   *
   * @param {string} sessionId
   * @param {object} opts
   * @param {number} [opts.windowMs]
   * @param {number} [opts.minImages] 至少几张图才算团战
   * @param {number} [opts.now]
   * @returns {{active:boolean, images:number, senders:number, refs:string[], texts:string[]}}
   */
  detectTeamFight(sessionId, { windowMs = 60_000, minImages = 3, now = Date.now() } = {}) {
    const since = now - Math.max(1, num(windowMs, 60_000))
    const refs = []
    const senders = new Set()
    const texts = []

    for (const record of this.list(sessionId)) {
      if (record.at < since || record.at > now) continue
      if (record.self) continue
      const list = Array.isArray(record.imageRefs) ? record.imageRefs : []
      for (const ref of list) refs.push(ref)
      if (record.senderId) senders.add(record.senderId)
      if (record.text) texts.push(record.text)
    }

    const threshold = Math.max(2, num(minImages, 3))
    return {
      active: refs.length >= threshold,
      images: refs.length,
      senders: senders.size,
      refs,
      texts: texts.join(' ').slice(0, 300),
    }
  }

  /**
   * 距离上次机器人发图过了几个回合（主动发图的"冷却"用）。
   *
   * 口径：数一数机器人最近一条 record 之后，别人说了多少条。
   * 没发过图 → Infinity（随便发）。
   *
   * @param {string} sessionId
   * @returns {number}
   */
  turnsSinceOwnMessage(sessionId) {
    const list = this.list(sessionId)
    let lastOwnIndex = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].self) { lastOwnIndex = i; break }
    }
    if (lastOwnIndex < 0) return Infinity
    let turns = 0
    for (let i = lastOwnIndex + 1; i < list.length; i++) {
      if (!list[i].self) turns++
    }
    return turns
  }

  /** 排障/报表：窗口概况。 */
  snapshot() {
    return {
      sessions: this.records.size,
      perSession: [...this.records.entries()].slice(0, 20).map(([id, list]) => ({
        id,
        records: list.length,
        lastAt: num(list[list.length - 1]?.at, 0),
      })),
    }
  }
}
