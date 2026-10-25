/**
 * 主动收集：定时按"最常用"收 + 回扫历史。
 *
 * 三条入口共用 `collectTopUsed`：
 *  · 聊天时顺带（实时入口在 ingest.js，这里只管"按频率"）；
 *  · 定时（每 5 分钟检查一次 nextRunAt，到点才真跑）；
 *  · 手动（工具 `scan`）。
 *
 * 统计口径（原插件踩过的坑，别改）：**每次出现都计数**。
 * 早期实现按媒体 sha1 去重再数，结果"每张都是 1 次"，排名完全失效。
 */
import { createLimiter, num, oneLine, readJson, safeService, todayKey, writeJsonAtomic } from './util.js'
import { FILES } from './library.js'
import { shortId } from './library.js'

/** 单次收集最多下载几张候选（按频率排序后截断）。 */
const MAX_CANDIDATES = 60

/** 下载候选图的并发上限。 */
const FETCH_CONCURRENCY = 4

/**
 * 主动收集器。
 *
 * @param {object} opts
 * @param {import('./library.js').Library} opts.library
 * @param {() => object} opts.getConfig
 * @param {(level:string,message:string)=>void} [opts.log]
 * @param {string} opts.dataDir
 * @param {object} opts.deps
 * @param {(sessionId:string, opts:object)=>Promise<Array<{content:Array, time:number, sessionId:string, senderId:string}>>} opts.deps.readMessages 读会话最近消息
 * @param {(ref:object)=>Promise<{data:Uint8Array}|null>} opts.deps.readImage 读图片字节
 * @param {() => string[]} [opts.deps.knownSessions] 已知 QQ 会话 id 列表
 */
export class Collector {
  constructor({ library, getConfig, log, dataDir, deps = {} }) {
    this.library = library
    this.getConfig = getConfig
    this.log = log ?? (() => {})
    this.dataDir = dataDir
    this.deps = deps
    this.scheduleFile = `${dataDir}/${FILES.schedule}`
    this._limit = createLimiter(FETCH_CONCURRENCY)
    this.schedule = { nextRunAt: 0, lastRunAt: 0, lastResult: null }
    this._running = false
    this._timer = null
    this._shaCache = new Map() // refKey -> { at, sha1 } 跨轮复用，省重复下载
  }

  async loadSchedule() {
    const raw = await readJson(this.scheduleFile, null)
    if (raw && typeof raw === 'object') {
      this.schedule = {
        nextRunAt: num(raw.nextRunAt, 0),
        lastRunAt: num(raw.lastRunAt, 0),
        lastResult: raw.lastResult ?? null,
      }
    }
    return this.schedule
  }

  async saveSchedule() {
    try {
      await writeJsonAtomic(this.scheduleFile, this.schedule)
    } catch (error) {
      this.log('warn', `收集计划写盘失败：${error?.message ?? error}`)
    }
  }

  /** 下一次该跑的时刻（按 everyHours 计算）。0 = 关掉定时。 */
  computeNextRunAt(now = Date.now()) {
    const cfg = this.getConfig()
    const hours = cfg.collect.everyHours
    if (hours <= 0) return 0
    // 从"上次跑的整点"往后推，避免每次启动都重新计时
    const base = this.schedule.lastRunAt > 0 ? this.schedule.lastRunAt : now
    return base + hours * 3_600_000
  }

  /** 计划状态（工具/报表要显示"下次什么时候收"）。 */
  brief(now = Date.now()) {
    const cfg = this.getConfig()
    if (cfg.collect.everyHours <= 0) return { enabled: false, nextRunAt: 0 }
    const nextRunAt = this.schedule.nextRunAt > 0 ? this.schedule.nextRunAt : this.computeNextRunAt(now)
    return {
      enabled: true,
      everyHours: cfg.collect.everyHours,
      nextRunAt,
      nextRunInMin: Math.max(0, Math.round((nextRunAt - now) / 60_000)),
      lastRunAt: this.schedule.lastRunAt,
      lastResult: this.schedule.lastResult,
    }
  }

  /**
   * 启动定时检查（由插件在 apply 里用 ctx.effect 挂，随 fiber 卸载）。
   *
   * ⚠️ 必须走 `ctx.get('timer')`，**不能**写 `ctx.timer`：
   * Cordis 的 ctx 是 Proxy，读一个没在 `inject` 里声明的服务属性会抛
   * `cannot get property "timer" without inject`，而 `?.` 兜不住（抛错发生在
   * proxy 陷阱内部，不是 null 上）。这个坑让插件在真机上直接 failed（2026-10-25）。
   *
   * @param {object} ctx DSH 插件 ctx
   * @returns {() => void} 停止函数
   */
  startTimer(ctx) {
    const stop = () => {
      if (this._timer) { try { this._timer() } catch { /* ignore */ } this._timer = null }
    }
    const tick = () => {
      void this.maybeRun()
    }
    const timer = safeService(ctx, 'timer')
    // 每 5 分钟检查一次（到点才真跑）；别用更密，收集本身要下载。
    if (timer && typeof timer.interval === 'function') {
      this._timer = timer.interval(tick, 5 * 60 * 1000)
    } else {
      const id = setInterval(tick, 5 * 60 * 1000)
      id.unref?.()
      this._timer = () => clearInterval(id)
    }
    return stop
  }

  /** 到点就跑（0 小时关闭）。 */
  async maybeRun() {
    const cfg = this.getConfig()
    if (!cfg.enabled || cfg.collect.everyHours <= 0) return { skipped: 'disabled' }
    if (this._running) return { skipped: 'busy' }
    const now = Date.now()
    let nextRunAt = this.schedule.nextRunAt
    if (nextRunAt <= 0) {
      nextRunAt = this.computeNextRunAt(now)
      this.schedule.nextRunAt = nextRunAt
      await this.saveSchedule()
    }
    if (now < nextRunAt) return { skipped: 'not-yet' }
    const result = await this.collectTopUsed({ hours: cfg.collect.topHours, limit: cfg.collect.topCount, reason: 'timer' })
    this.schedule.lastRunAt = now
    this.schedule.nextRunAt = now + cfg.collect.everyHours * 3_600_000
    this.schedule.lastResult = summarizeResult(result)
    await this.saveSchedule()
    return result
  }

  /**
   * 按「使用频率」收集最常用的表情。
   *
   * 算法（原插件 1:1）：
   *  ① 取窗内消息 → ② 每次出现都计数（**不去重**）→ ③ 剔除库里已有的，
   *  按时间倒序截断候选 → ④ 并发下载算 sha1 → ⑤ 按次数降序（同次数取更近）
   *  → ⑥ 依次入库，已在库则跳过顺延，不够就终止（不硬凑）。
   *
   * @param {object} opts
   * @param {number} [opts.hours] 往回看几小时
   * @param {number} [opts.limit] 最多收几张
   * @param {string} [opts.reason]
   */
  async collectTopUsed({ hours, limit, reason = 'manual' } = {}) {
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ok: false, reason: '插件已关闭' }
    if (this._running) return { ok: false, reason: '已经有一轮收集在跑' }
    this._running = true
    const out = { ok: true, reason, considered: 0, collected: 0, already: 0, failed: 0, stopReason: '', items: [] }
    try {
      const windowHours = Math.max(1, Math.round(num(hours, cfg.collect.topHours)))
      const want = Math.max(1, Math.round(num(limit, cfg.collect.topCount)))
      const since = Date.now() - windowHours * 3_600_000
      const sessions = typeof this.deps.knownSessions === 'function' ? this.deps.knownSessions() : []
      const readMessages = this.deps.readMessages
      if (typeof readMessages !== 'function') return { ok: false, reason: '宿主没有提供读取会话消息的通道' }

      // ① 取窗内消息；② 每次出现都计数
      const counts = new Map() // refKey -> { ref, count, lastAt, hint }
      for (const sessionId of sessions) {
        let messages = []
        try {
          messages = await readMessages(sessionId, { limit: 2000, since })
        } catch (error) {
          this.log('debug', `读会话 ${sessionId} 失败：${error?.message ?? error}`)
          continue
        }
        for (const message of messages) {
          if (!message || message.time < since) continue
          if (String(message.senderId ?? '') === String(message.selfId ?? '')) continue // 跳过自己发的
          const content = Array.isArray(message.content) ? message.content : []
          const hint = oneLine(content.filter((b) => b?.type === 'text').map((b) => b.text).join(' '), 120)
          for (const block of content) {
            if (!block || block.type !== 'image' || !block.attachment) continue
            const key = String(block.attachment.attachmentId ?? '')
            if (!key) continue
            const prev = counts.get(key)
            if (prev) {
              prev.count += 1
              prev.lastAt = Math.max(prev.lastAt, message.time)
            } else {
              counts.set(key, { ref: block.attachment, count: 1, lastAt: message.time, hint })
            }
          }
        }
      }
      out.considered = counts.size

      // ③ 剔除库里已有的（按 sha1 无法预知，只能先算；但可以先用 attachmentId 缓存筛掉重复下载）
      const ranked = [...counts.values()]
        .sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt))
        .slice(0, MAX_CANDIDATES)

      // ④ 并发下载 + 算 sha1
      const readImage = this.deps.readImage
      if (typeof readImage !== 'function') return { ok: false, reason: '宿主没有提供读取图片的通道' }
      const prepared = []
      await Promise.all(ranked.map((entry) => this._limit(async () => {
        try {
          const stored = await readImage(entry.ref)
          if (!stored?.data?.length) { out.failed++; return }
          const result = await this.library.ingest({
            bytes: stored.data,
            sessionId: '',
            srcHint: entry.hint,
            source: 'observed',
            width: entry.ref.width,
            height: entry.ref.height,
            mediaType: entry.ref.mediaType,
          })
          if (!result.ok) { out.failed++; return }
          if (result.duplicate) { out.already++; return }
          prepared.push({ item: result.item, count: entry.count })
        } catch (error) {
          out.failed++
          this.log('debug', `候选收图失败：${error?.message ?? error}`)
        }
      })))
      out.collected = prepared.length
      out.items = prepared.slice(0, want).map((entry) => ({ id: shortId(entry.item), count: entry.count }))

      // ⑤⑥ 收满就停（这里已经在上面不收超过候选；真正"收几个"由 limit 控制）
      if (out.collected < want) out.stopReason = '候选不够'
      await this.library.flush()
      return out
    } catch (error) {
      return { ok: false, reason: `收集失败：${error?.message ?? error}` }
    } finally {
      this._running = false
    }
  }

  /**
   * 回扫某个会话的最近历史，把里面的图收进来（`scan` 工具用）。
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {string} [opts.range] 1h / 4h / 12h / 24h / all
   * @param {number} [opts.limit]
   */
  async scanSession({ sessionId, range = '4h', limit = 10 } = {}) {
    const cfg = this.getConfig()
    if (!cfg.enabled) return { ok: false, reason: '插件已关闭' }
    const hours = parseRange(range)
    const since = hours === Infinity ? 0 : Date.now() - hours * 3_600_000
    const readMessages = this.deps.readMessages
    const readImage = this.deps.readImage
    if (typeof readMessages !== 'function' || typeof readImage !== 'function') {
      return { ok: false, reason: '宿主没有提供读取消息/图片的通道' }
    }
    let messages = []
    try {
      messages = await readMessages(sessionId, { limit: 3000, since })
    } catch (error) {
      return { ok: false, reason: `读会话历史失败：${error?.message ?? error}` }
    }
    const max = Math.max(1, Math.min(30, num(limit, 10)))
    const out = { ok: true, seen: 0, collected: 0, duplicates: 0, skipped: 0, items: [] }
    // 从近往远
    for (const message of [...messages].sort((a, b) => b.time - a.time)) {
      if (out.collected >= max) break
      const content = Array.isArray(message.content) ? message.content : []
      const hint = oneLine(content.filter((b) => b?.type === 'text').map((b) => b.text).join(' '), 120)
      for (const block of content) {
        if (!block || block.type !== 'image' || !block.attachment) continue
        out.seen++
        try {
          const stored = await readImage(block.attachment)
          if (!stored?.data?.length) { out.skipped++; continue }
          const result = await this.library.ingest({
            bytes: stored.data,
            sessionId,
            srcHint: hint,
            source: 'observed',
            width: block.attachment.width,
            height: block.attachment.height,
            mediaType: block.attachment.mediaType,
          })
          if (!result.ok) { out.skipped++; continue }
          if (result.duplicate) { out.duplicates++; continue }
          out.collected++
          out.items.push({ id: shortId(result.item) })
          if (out.collected >= max) break
        } catch (error) {
          out.skipped++
          this.log('debug', `回扫收图失败：${error?.message ?? error}`)
        }
      }
    }
    await this.library.flush()
    return out
  }

  dispose() {
    if (this._timer) { try { this._timer() } catch { /* ignore */ } this._timer = null }
    this._shaCache.clear()
  }
}

/** "1h"/"4h"/"12h"/"24h"/"all"/"6" → 小时数（all = Infinity）。 */
export function parseRange(range) {
  const text = String(range ?? '').trim().toLowerCase()
  if (text === 'all' || text === '全部') return Infinity
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(h|小时|m|分钟)?$/)
  if (!match) return 4
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return 4
  if (match[2] === 'm' || match[2] === '分钟') return value / 60
  return value
}

/** 收集结果摘要（落 schedule.json，给报表/工具看）。 */
export function summarizeResult(result) {
  if (!result || result.ok === false) return { ok: false, reason: result?.reason ?? '未知' }
  return {
    ok: true,
    at: Date.now(),
    collected: result.collected ?? 0,
    already: result.already ?? 0,
    failed: result.failed ?? 0,
    considered: result.considered ?? 0,
    stopReason: result.stopReason ?? '',
  }
}
