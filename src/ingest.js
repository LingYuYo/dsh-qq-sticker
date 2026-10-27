/**
 * 收图：从 DSH 会话事件里把图片捞进库。
 *
 * 两个入口：
 *  1. **实时**：`session/event` 的 `user/message` 里带 `image` 块 → 立刻入队（不入库等 IO）；
 *  2. **回扫**：`scan` 工具 / 定时收集 → 读该会话最近的事件窗口，按出现频率排。
 *
 * 异步纪律（原插件的血泪）：监听器里绝不做 IO。事件回调只做三件事：
 * 判 enabled / 判预算 / 入队；真正下载与写盘在后台串行跑，全局 try/catch，
 * 失败只 warn 一次，绝不影响聊天主链路。
 */
import { createLimiter, hourKey, num, oneLine, todayKey } from './util.js'
import { shortId } from './library.js'

/** 单张图下载/落库的并发上限。 */
const INGEST_CONCURRENCY = 2

/**
 * 附件 ref 的"真实尺寸"。
 *
 * ⚠️ 为什么要合并 originalDimensions：DSH 的附件服务会**归一化**图片
 * （缩放/重编码），`ref.width/height` 是归一化后的尺寸；一张 1080×1260 的照片
 * 可能被压到 640×747，只看 ref 就会误判成"小图=表情包"。
 * 所以取 ref 与 originalDimensions 里更大的那个。
 *
 * @param {object} ref ImageAttachmentRef
 * @returns {{width:number, height:number}}
 */
export function effectiveDimensions(ref) {
  const width = Math.max(num(ref?.width, 0), num(ref?.originalDimensions?.width, 0))
  const height = Math.max(num(ref?.height, 0), num(ref?.originalDimensions?.height, 0))
  return { width, height }
}

/**
 * 判定"这张图看起来是不是表情包"。
 *
 * 判错方向的代价不对称：把照片当表情收进来，只是库里多一张没用的；
 * 把表情漏掉，这个功能就废了。所以偏宽松 —— 只在**明确像照片**时才排除。
 *
 * 动图（GIF/动 WebP）一律放行，**不受尺寸与字节限制**：
 *  - QQ 里 GIF 就是表情，没人拿 GIF 当照片；
 *  - DSH 附件服务会把 GIF 重编码成单帧，字节数和尺寸都与原图对不上，
 *    拿这些归一化后的数字去判"像不像表情"，只会把动图误杀。
 *
 * @param {object} meta { mediaType, width, height, bytes }
 * @param {object} config 归一化配置
 */
export function isLikelySticker(meta, config) {
  const mediaType = String(meta?.mediaType ?? '')
  const bytes = Math.max(0, num(meta?.bytes, 0))
  const width = Math.max(0, num(meta?.width, 0))
  const height = Math.max(0, num(meta?.height, 0))

  // 动图几乎都是表情（QQ 里没人用 GIF 当照片）；尺寸/容量都不设门槛
  if (mediaType === 'image/gif') return true
  // 尺寸未知时按"像表情"放行（判定不了就别误杀）
  if (!width || !height) return bytes <= config.collect.stickerMaxBytes
  const longest = Math.max(width, height)
  if (longest > config.collect.stickerMaxDim) return false
  if (bytes > config.collect.stickerMaxBytes) return false
  return true
}

/**
 * 收图器。
 *
 * 一个实例对应一个插件实例；`config` 是**现读**的（热改配置下一条即生效）。
 */
export class Ingestor {
  /**
   * @param {object} opts
   * @param {import('./library.js').Library} opts.library
   * @param {() => object} opts.getConfig 现读归一化配置
   * @param {(level:string, message:string)=>void} [opts.log]
   * @param {object} [opts.state] state.json 内容（读预算计数）
   * @param {() => void} [opts.markStateDirty]
   * @param {object} [opts.deps]
   * @param {(ref:object, signal?:AbortSignal)=>Promise<{data:Uint8Array}|null>} [opts.deps.readImage] 读附件字节
   */
  constructor({ library, getConfig, log, state, markStateDirty, deps = {} }) {
    this.library = library
    this.getConfig = getConfig
    this.log = log ?? (() => {})
    this.state = state ?? { ingest: { day: '', count: 0, hour: '', hourCount: 0 } }
    this.markStateDirty = markStateDirty ?? (() => {})
    this.deps = deps
    this._limit = createLimiter(INGEST_CONCURRENCY)
    this._queue = []
    this._draining = false
    this._failedKeys = new Set()
    this._recentKeys = new Map() // sessionId -> Set(attachmentId) 防重复处理同一条
  }

  /** 今日识图预算还剩多少（recognizeOnIngest 用；与收集上限分开算）。 */
  budgetLeft(now = Date.now()) {
    const cfg = this.getConfig()
    if (cfg.vision.ingestBudgetPerDay <= 0) return Infinity
    this._rollIngestWindows(now)
    return Math.max(0, cfg.vision.ingestBudgetPerDay - num(this.state.ingest.count, 0))
  }

  /** 每小时收集上限还剩多少。 */
  hourlyLeft(now = Date.now()) {
    const cfg = this.getConfig()
    if (cfg.collect.maxPerHour <= 0) return Infinity
    this._rollIngestWindows(now)
    return Math.max(0, cfg.collect.maxPerHour - num(this.state.ingest.hourCount, 0))
  }

  _rollIngestWindows(now) {
    const ingest = this.state.ingest ?? {}
    const day = todayKey(now)
    const hour = hourKey(now)
    if (ingest.day !== day) { ingest.day = day; ingest.count = 0 }
    if (ingest.hour !== hour) { ingest.hour = hour; ingest.hourCount = 0 }
    this.state.ingest = ingest
  }

  /** 记一次识图（用掉预算）。 */
  useVisionBudget(now = Date.now()) {
    this._rollIngestWindows(now)
    this.state.ingest.count = num(this.state.ingest.count, 0) + 1
    this.markStateDirty()
  }

  /**
   * 收图总闸（**所有入库路径的唯一入口检查**）。
   *
   * 2026-10-27：用户要求「随时一键暂停收集」——暂停时必须 0 资源消耗：
   * 不下载、不写盘、不触发打标，连附件都不读。
   *
   * @returns {{ok:boolean, reason?:string}}
   */
  collectGate() {
    const cfg = this.getConfig()
    if (!cfg?.enabled) return { ok: false, reason: 'plugin-disabled' }
    if (!cfg?.collect?.enabled) return { ok: false, reason: 'collect-paused' }
    return { ok: true }
  }

  /**
   * 实时收：从一条 `user/message` 的 content 里挑 image 块入库。
   *
   * @param {object} opts
   * @param {string} opts.sessionId
   * @param {Array<object>} opts.content 消息的 content blocks
   * @param {string} [opts.srcHint] 同一条消息里的文本（"当时在聊什么"）
   * @param {string} [opts.chatKey]
   * @returns {{queued:number, skipped:string[]}}
   */
  onUserMessage({ sessionId, content, srcHint = '', chatKey = '' }) {
    // ⚠️ 第一件事就是过总闸：暂停时后面一行都不该执行（不解析、不入队、不读图）。
    const gate = this.collectGate()
    if (!gate.ok) return { queued: 0, skipped: [gate.reason] }
    const cfg = this.getConfig()
    const blocks = Array.isArray(content) ? content : []
    const images = blocks.filter((block) => block && block.type === 'image' && block.attachment)
    if (images.length === 0) return { queued: 0, skipped: ['no-image'] }

    const hint = oneLine(srcHint, 120)
    const seen = this._recentKeys.get(sessionId) ?? new Set()
    this._recentKeys.set(sessionId, seen)
    let queued = 0
    const skipped = []
    for (const block of images) {
      const ref = block.attachment
      const refId = String(ref?.attachmentId ?? '')
      if (!refId) { skipped.push('no-ref'); continue }
      // 同一条消息被重放（pre-step / 重试）时不要重复处理
      if (seen.has(refId)) { skipped.push('replay'); continue }
      seen.add(refId)
      if (seen.size > 200) {
        // 只留最近 200 个，防止长跑内存涨
        const drop = [...seen].slice(0, seen.size - 200)
        for (const key of drop) seen.delete(key)
      }
      if (this.hourlyLeft() <= 0) { skipped.push('hour-limit'); continue }
      const dims = effectiveDimensions(ref)
      /**
       * 判定「像不像表情」。
       *
       * ⚠️ 容易误杀的坑（2026-10-26 真机）：
       *   ref 上的 mediaType / 尺寸 / 字节都是 **DSH 归一化后**的 —— 一张 GIF 会被
       *   转成单帧 webp，mediaType 不再是 image/gif，isLikelySticker 的 GIF 快速
       *   通道就失效了，再按普通图判尺寸/字节，很容易被误判成"不是表情"。
       *
       *   所以：**只要池里有这张图的原始字节、且原始类型是 GIF，就直接放行**，
       *   完全不看 ref 上那些归一化后的数字。
       */
      const rawType = this._rawMediaTypeOf(ref)
      const looksGif = String(rawType ?? ref.mediaType ?? '') === 'image/gif'
      if (cfg.collect.stickerOnly && !looksGif && !isLikelySticker(
        { mediaType: ref.mediaType, bytes: ref.bytes, width: dims.width, height: dims.height },
        cfg,
      )) {
        skipped.push('not-sticker')
        continue
      }
      this._queue.push({ sessionId, ref, hint, chatKey })
      queued++
    }
    void this._drain()
    return { queued, skipped }
  }

  /** 后台串行消费队列（并发 2，失败不重试、不阻塞后续）。 */
  async _drain() {
    if (this._draining) return
    this._draining = true
    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift()
        await this._limit(async () => {
          try {
            await this._ingestOne(job)
          } catch (error) {
            this.log('warn', `收图失败（已跳过）：${error?.message ?? error}`)
          }
        })
      }
    } finally {
      this._draining = false
    }
  }

  /** 池里这张图的原始媒体类型（没挂 token / 池里没有就返回 undefined）。 */
  _rawMediaTypeOf(ref) {
    try {
      const token = ref?.rawToken
      if (!token) return undefined
      const store = this.deps.rawImages
      if (!store || typeof store.peek !== 'function') return undefined
      return store.peek(String(token))?.mediaType
    } catch {
      return undefined
    }
  }

  /** 真正下载 + 入库。 */
  async _ingestOne(job) {
    // 暂停发生在「已入队、还没下载」之间时，这里必须立刻放弃 ——
    // 否则用户点了暂停，后台还在安静地下载写盘，等于没停。
    const gate = this.collectGate()
    if (!gate.ok) return
    const cfg = this.getConfig()
    if (this.hourlyLeft() <= 0) return
    const readImage = this.deps.readImage
    if (typeof readImage !== 'function') {
      this.log('warn', '收图跳过：没有注入 attachments.readImage（插件环境未就绪）')
      return
    }
    const stored = await readImage(job.ref)
    if (!stored || !stored.data || stored.data.length === 0) return
    const result = await this.library.ingest({
      bytes: stored.data,
      sessionId: job.sessionId,
      chatKey: job.chatKey,
      srcHint: job.hint,
      source: 'observed',
      // ⚠️ 原始池命中时不要用 ref 上报的宽高：那些是 DSH 归一化后的尺寸，
      //    对 GIF 完全对不上。让 library 从真实字节里读尺寸。
      width: stored.fromRaw ? undefined : job.ref.width,
      height: stored.fromRaw ? undefined : job.ref.height,
      mediaType: stored.fromRaw ? stored.mediaType : job.ref.mediaType,
    })
    if (!result.ok) {
      if (result.reason !== 'duplicate') this.log('debug', `未收：${result.reason}`)
      return
    }
    if (result.duplicate) return
    // 用掉每小时份额
    this._rollIngestWindows()
    this.state.ingest.hourCount = num(this.state.ingest.hourCount, 0) + 1
    this.markStateDirty()
    const summary = result.item.tags.length ? `[${result.item.tags.join('/')}]` : '未分类'
    this.log('debug', `收进表情 #${shortId(result.item)}（${summary}，${result.item.width}x${result.item.height}）`)
    if (typeof this.deps.onIngested === 'function') {
      // 交给 vision 做"收录时识图"（带预算，失败不动 tagFails）
      void this.deps.onIngested(result.item).catch((error) => {
        this.log('warn', `收录识图失败（不影响入库）：${error?.message ?? error}`)
      })
    }
  }

  /** 清空未处理队列（插件卸载 / 暂停收集时用）。 */
  dispose() {
    this._queue.length = 0
    this._recentKeys.clear()
    this._failedKeys.clear()
  }

  /** 暂停收集：立刻清空还没处理的队列（已入队的也不收了）。 */
  pause() {
    this._queue.length = 0
    return this.snapshot()
  }

  /** 排障：队列长度。 */
  snapshot() {
    return { queued: this._queue.length, draining: this._draining }
  }
}

/**
 * 从一条消息的 content 里拼出"当时在聊什么"（给 srcHint 用）。
 * 只取 text 块，截断。
 */
export function textOfContent(content, max = 120) {
  const blocks = Array.isArray(content) ? content : []
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(' ')
    .replace(/\[图片\]/g, '')
    .trim()
  return oneLine(text, max)
}
