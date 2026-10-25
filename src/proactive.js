/**
 * 主动发图 + 斗图 + 连发 + 团战。
 *
 * ## 为什么必须放在回合末（`agent/turn-stopping`）
 *
 * 插件**不能**往会话里插入 assistant 文本消息 —— `Session.append` 是宿主的，
 * 插件只能读 `session/event`。唯一的出站通道是 `ctx.tools.execute({name:'qq_send_image'})`，
 * 而那个工具的设计前提是"模型调它"。
 *
 * 所以「主动发图」不是"替模型发"，而是"模型说完话之后，由插件补一张"：
 *   · `agent/turn-stopping` 的语义正是"回合即将关闭，模型不再欠回应" ——
 *     这里是文字回复已经落盘、但回合还没结束的位置，补发图时序最自然；
 *   · 它是 serial 事件，可以 await（发图要等桥接回执 ~20s），不阻塞别的事情。
 *
 * ## 三层闸门（顺序不能反）
 *
 *   ① 总开关 / 冷却（idleTurns）
 *   ② 概率闸（proactive.probability）—— 先掷骰子，没过就不烧任何 token
 *   ③ 发送闸（gate.js 的档位 × 活跃度 × 每日上限）—— 原有硬上限仍然生效
 *
 * 概率闸放前面是有意的：**意图分析要花一次 LLM 调用**，先掷骰子能把 75% 的回合
 * 省掉这次调用。如果先分析再掷骰子，等于每个回合都在白烧 token。
 *
 * ## 意图分析为什么不用视觉模型
 *
 * 判断"这句话该配什么图"只需要读文本，不需要看图。所以这里走纯文本 `chatText()`，
 * 模型随便哪个便宜的都行（`proactive.model` 可单独指定）。只有**团战模式**需要
 * 看懂别人发的图在表达什么，那一步才走多模态。
 */
import { num, oneLine } from './util.js'
import { shortId } from './library.js'
import { pickCandidates } from './pick.js'
import { sendGate, markSent } from './gate.js'

/** 意图分析最多允许输出多少 token（只要一个 JSON，不用长）。 */
const INTENT_MAX_TOKENS = 200

/** 团战分析最多输出多少 token。 */
const TEAM_MAX_TOKENS = 260

/** 发图之间的最小间隔（连发时用，避免桥接队列挤爆）。 */
const BURST_GAP_MS = 700

/**
 * 主动发图引擎。
 *
 * @param {object} opts
 * @param {import('./library.js').Library} opts.library
 * @param {import('./tracker.js').SessionTracker} opts.tracker
 * @param {() => object} opts.getConfig
 * @param {() => object} opts.state 当前 state.json
 * @param {(level:string, message:string)=>void} [opts.log]
 * @param {object} opts.deps
 * @param {(request:object)=>Promise<string>} opts.deps.chatText 纯文本 LLM 调用
 * @param {(request:object)=>Promise<string>} opts.deps.chatWithImages 多模态（团战用）
 * @param {(item:object)=>Promise<{ok:boolean, detail?:string, reason?:string}>} opts.deps.sendItem 真正发图
 * @param {(imageRef:string)=>Promise<{data:Uint8Array, mediaType:string}|null>} opts.deps.readImageRef 读附件字节
 * @param {()=>void} [opts.deps.markStateDirty]
 * @param {(kind:string, payload?:object)=>void} [opts.deps.recordEvent] 统计/排障
 */
export function createProactive({
  library, tracker, getConfig, state, log, deps = {},
}) {
  const note = (level, message) => {
    try { log?.(level, message) } catch { /* 日志失败不能影响主链路 */ }
  }

  /**
   * 单个会话的主动发图运行态（防并发重入 + 冷却 + 团战额度）。
   *
   * ⚠️ 必须是**每个引擎实例一份**，不能提到模块级：模块级 Map 会让两个引擎
   * （比如测试里连开两个、或插件被 HMR 重载后新旧实例并存）共享同一批 sessionId
   * 的状态，导致计数串味。实例级天然跟着引擎一起被回收。
   */
  const sessionStates = new Map()

  /** 取（或建）一个会话的运行态。 */
  const stateOf = (sessionId) => {
    const key = String(sessionId ?? '')
    let entry = sessionStates.get(key)
    if (!entry) {
      entry = {
        running: false,
        lastSentAt: 0,
        lastOutcome: '',      // '' | 'sent' | 'skipped' | 'gated' | 'error'
        lastDetail: '',
        sentTotal: 0,
        teamUsedDay: '',
        teamUsedCount: 0,
      }
      sessionStates.set(key, entry)
    }
    return entry
  }

  /** 每日团战额度：跨天自动清零。 */
  const teamBudgetLeft = (cfg, entry, now = Date.now()) => {
    const budget = num(cfg?.battle?.teamBudgetPerDay, 0)
    if (budget <= 0) return Infinity
    const day = todayKey(now)
    if (entry.teamUsedDay !== day) {
      entry.teamUsedDay = day
      entry.teamUsedCount = 0
    }
    return Math.max(0, budget - entry.teamUsedCount)
  }

  const consumeTeamBudget = (entry, now = Date.now()) => {
    const day = todayKey(now)
    if (entry.teamUsedDay !== day) {
      entry.teamUsedDay = day
      entry.teamUsedCount = 0
    }
    entry.teamUsedCount++
  }

  /**
   * 回合末的入口。**任何异常都必须吞掉** —— 这里挂在聊天主链路上，
   * 抛错会让用户看到"回合失败"，而发不出图根本不值得那个代价。
   *
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} [args.turnText] 本轮模型最终文本（用于意图分析）
   * @returns {Promise<{ok:boolean, sent:number, reason:string}>}
   */
  async function onTurnStopping({ sessionId, turnText = '' }) {
    const id = String(sessionId ?? '')
    if (!id) return { ok: false, sent: 0, reason: 'no-session' }
    const entry = stateOf(id)
    if (entry.running) return { ok: false, sent: 0, reason: 'busy' }

    entry.running = true
    try {
      const cfg = getConfig()
      const outcome = await decide({ sessionId: id, turnText, cfg, entry })
      entry.lastOutcome = outcome.kind
      entry.lastDetail = outcome.reason
      if (outcome.kind === 'sent') {
        entry.lastSentAt = Date.now()
        entry.sentTotal += outcome.sent
      }
      return {
        ok: outcome.kind === 'sent',
        sent: outcome.sent ?? 0,
        reason: outcome.reason,
      }
    } catch (error) {
      note('warn', `主动发图失败（已忽略）：${error?.message ?? error}`)
      entry.lastOutcome = 'error'
      entry.lastDetail = String(error?.message ?? error)
      return { ok: false, sent: 0, reason: `error: ${error?.message ?? error}` }
    } finally {
      entry.running = false
    }
  }

  /**
   * 决策链：闸门 → 意图 → 选图 → 发（可能连发）。
   *
   * @returns {Promise<{kind:'sent'|'skipped'|'gated', sent:number, reason:string}>}
   */
  async function decide({ sessionId, turnText, cfg, entry }) {
    // ── ① 总开关 ──────────────────────────────────────────────
    if (cfg.proactive.enabled !== true) return { kind: 'skipped', sent: 0, reason: 'disabled' }
    if (cfg.enabled !== true) return { kind: 'skipped', sent: 0, reason: 'plugin-disabled' }

    const visible = library.visible().filter((item) => !item.tags.includes('无意义'))
    if (visible.length === 0) return { kind: 'skipped', sent: 0, reason: 'empty-library' }

    // ── ② 冷却：距上次发图隔了几个回合 ────────────────────────
    const idleTurns = num(cfg.proactive.idleTurns, 0)
    if (idleTurns > 0 && entry.lastSentAt > 0) {
      const turns = tracker.turnsSinceOwnMessage(sessionId)
      // turns 是 Infinity 表示"没发过"，不该被冷却拦住
      if (Number.isFinite(turns) && turns < idleTurns) {
        return { kind: 'skipped', sent: 0, reason: `cooldown(${turns}/${idleTurns})` }
      }
    }

    // ── ③ 概率闸（先掷骰子，省掉后面的 LLM 调用）────────────
    const probability = clamp01(num(cfg.proactive.probability, 0))
    if (probability <= 0) return { kind: 'skipped', sent: 0, reason: 'probability-0' }
    if (Math.random() >= probability) {
      return { kind: 'skipped', sent: 0, reason: 'probability-miss' }
    }

    // ── ④ 发送闸（原有硬上限，绝不被主动发图绕过）─────────────
    const activity = tracker.humanCount(sessionId)
    const verdict = sendGate({
      config: cfg,
      state: state(),
      sessionId,
      activityBySession: activity,
    })
    if (!verdict.ok) return { kind: 'gated', sent: 0, reason: verdict.reason }

    // ── ⑤ 斗图优先：队形命中就跟着发，不用做意图分析 ──────────
    if (cfg.battle.joinEnabled === true) {
      const formation = tracker.detectFormation(sessionId, {
        windowMs: num(cfg.battle.joinWindowSec, 30) * 1000,
        threshold: num(cfg.battle.joinThreshold, 3),
      })
      if (formation.hit) {
        return await joinFormation({ sessionId, cfg, entry, formation, visible })
      }
    }

    // ── ⑥ 团战：多图刷屏时，看懂它们在说什么再找相似图 ────────
    if (cfg.battle.teamEnabled === true) {
      const team = tracker.detectTeamFight(sessionId, {
        windowMs: 60_000,
        minImages: 3,
      })
      const left = teamBudgetLeft(cfg, entry)
      if (team.active && left > 0) {
        const result = await joinTeamFight({ sessionId, cfg, entry, team, visible })
        if (result.kind === 'sent') return result
        // 团战没成功（比如模型判断不该接），继续走普通配图
      }
    }

    // ── ⑦ 普通主动配图：意图分析 → 选图 ───────────────────────
    const intent = await analyzeIntent({ cfg, turnText, sessionId })
    if (!intent.send) return { kind: 'skipped', sent: 0, reason: intent.reason || 'model-declined' }

    const target = chooseSticker({
      cfg,
      sessionId,
      visible,
      mood: intent.mood,
      keyword: intent.keyword,
    })
    if (!target) return { kind: 'skipped', sent: 0, reason: 'no-match' }

    return await sendWithBurst({ sessionId, cfg, entry, first: target, visible })
  }

  /**
   * 意图分析：这段回复该不该配图、配什么情绪/关键词。
   *
   * 输出强制 JSON，解析失败一律**判不发**（宁可少发一张，也别乱发）。
   */
  async function analyzeIntent({ cfg, turnText, sessionId }) {
    const text = oneLine(String(turnText ?? ''), 600)
    if (!text) return { send: false, reason: 'no-text' }
    const chatText = deps.chatText
    if (typeof chatText !== 'function') return { send: false, reason: 'no-llm' }

    const recent = tracker.recentText(sessionId, 5 * 60 * 1000)
    const prompt = buildIntentPrompt({ turnText: text, recent })
    let raw = ''
    try {
      raw = await chatText({
        prompt,
        modelHint: cfg.proactive.model,
        maxTokens: INTENT_MAX_TOKENS,
        temperature: 0.3,
      })
    } catch (error) {
      note('debug', `意图分析请求失败：${error?.message ?? error}`)
      return { send: false, reason: 'llm-error' }
    }

    const parsed = parseIntent(raw)
    return parsed
  }

  /**
   * 连发：命中后按 burstProbability 决定发 1 张还是 2~3 张。
   *
   * 每一张都要单独过闸（`sendGate` 看的是 state 里的累计数，所以第二张会自然递减）。
   */
  async function sendWithBurst({ sessionId, cfg, entry, first, visible }) {
    const maxPerTurn = Math.max(1, num(cfg.proactive.maxPerTurn, 1))
    let want = 1
    if (cfg.battle.burstEnabled === true && maxPerTurn > 1) {
      const burstProbability = clamp01(num(cfg.battle.burstProbability, 0))
      if (Math.random() < burstProbability) {
        want = Math.min(maxPerTurn, Math.max(2, num(cfg.battle.burstCount, 2)))
      }
    }

    const sentIds = []
    let firstDetail = ''
    // 第一张用传入的 target，后续自己挑（别重复同一张）
    let target = first
    for (let index = 0; index < want; index++) {
      if (index > 0) {
        const next = chooseSticker({
          cfg,
          sessionId,
          visible,
          mood: '',
          keyword: '',
          exclude: sentIds.map((item) => item.key),
        })
        if (!next) break
        target = next
      }
      if (!target) break

      // 每张都要重新过闸，但**连发场景要放宽间隔**：
      //   · 全局间隔 / 单群间隔的本意是「别刷屏」，而连发是用户显式打开的功能，
      //     用户要的就是"一次来 2~3 张"。拿间隔去拦它等于功能永远不生效。
      //   · 每日上限 / 每分钟上限**仍然生效** —— 那才是真正防止失控的闸。
      //   · 首张永远走完整闸门（不因为是主动发图就跳过）。
      const skipInterval = index > 0
      const verdict = sendGate({
        config: cfg,
        state: state(),
        sessionId,
        activityBySession: tracker.humanCount(sessionId),
      })
      if (!verdict.ok) {
        const reason = String(verdict.reason ?? '')
        const intervalBlocked = reason.includes('还要等') || reason.includes('间隔')
        if (!(skipInterval && intervalBlocked)) {
          if (index === 0) return { kind: 'gated', sent: 0, reason }
          break
        }
        // 连发的第 2+ 张：只放行「间隔」这一条，其它拒绝仍然要停
      }

      if (index > 0) await sleepGap(deps.sleep)()
      const result = await sendOne({ cfg, sessionId, item: target })
      if (!result.ok) {
        if (index === 0) return { kind: 'skipped', sent: 0, reason: result.reason ?? 'send-failed' }
        break
      }
      sentIds.push(target)
      if (index === 0) firstDetail = result.detail ?? ''
    }

    if (sentIds.length === 0) return { kind: 'skipped', sent: 0, reason: 'send-failed' }
    deps.recordEvent?.('proactive-sent', { sessionId, count: sentIds.length })
    return {
      kind: 'sent',
      sent: sentIds.length,
      reason: sentIds.length > 1 ? `burst-${sentIds.length}` : (firstDetail || 'sent'),
    }
  }

  /**
   * 加入队形：多人发同一张图时跟着发一张。
   *
   * 优先发库里"和这张图最像"的（同标签），没有再随便挑一张高分的 ——
   * 队形的意思是"我也来一张"，不是"我要发同一张"。
   */
  async function joinFormation({ sessionId, cfg, entry, formation, visible }) {
    // 找库里和队形图同源的那张（attachmentId 对不上，但 src 是内容 sha1，可能存过）
    let target = visible.find((item) => item.src && formation.attachmentId.includes(item.src))
    if (!target) {
      target = chooseSticker({ cfg, sessionId, visible, mood: '', keyword: '' })
    }
    if (!target) return { kind: 'skipped', sent: 0, reason: 'no-sticker-for-formation' }

    const result = await sendOne({ cfg, sessionId, item: target })
    if (!result.ok) return { kind: 'skipped', sent: 0, reason: result.reason ?? 'send-failed' }
    deps.recordEvent?.('battle-join', { sessionId, users: formation.users })
    note('debug', `跟队形：${formation.users} 人发了同一张图，跟发 #${shortId(target)}`)
    return { kind: 'sent', sent: 1, reason: `formation(${formation.users}人)` }
  }

  /**
   * 团战：看懂窗口内那几张图在表达什么，再从库里找相似图。
   *
   * 成本说明：这一步要走多模态（`chatWithImages`），每次约一次视觉调用，
   * 所以有 `teamBudgetPerDay` 硬额度，超了直接跳过。
   */
  async function joinTeamFight({ sessionId, cfg, entry, team, visible }) {
    const chatWithImages = deps.chatWithImages
    const readImageRef = deps.readImageRef
    if (typeof chatWithImages !== 'function' || typeof readImageRef !== 'function') {
      return { kind: 'skipped', sent: 0, reason: 'no-vision' }
    }

    // 最多取最近 3 张，控制 token
    const refs = team.refs.slice(-3)
    const images = []
    for (const ref of refs) {
      try {
        const stored = await readImageRef(ref)
        if (stored?.data) images.push({ ref, ...stored })
      } catch { /* 单张读不到就跳过 */ }
    }
    if (images.length === 0) return { kind: 'skipped', sent: 0, reason: 'no-readable-image' }

    let raw = ''
    try {
      raw = await chatWithImages({
        prompt: buildTeamPrompt({ count: images.length, chatText: team.texts }),
        imageRefs: images.map((image) => image.ref),
        maxTokens: TEAM_MAX_TOKENS,
        temperature: 0.4,
      })
    } catch (error) {
      note('debug', `团战分析失败：${error?.message ?? error}`)
      return { kind: 'skipped', sent: 0, reason: 'llm-error' }
    }

    const parsed = parseTeam(raw)
    consumeTeamBudget(entry)
    if (!parsed.join) return { kind: 'skipped', sent: 0, reason: 'team-declined' }

    const target = chooseSticker({
      cfg,
      sessionId,
      visible,
      mood: parsed.mood,
      keyword: parsed.keyword,
    })
    if (!target) return { kind: 'skipped', sent: 0, reason: 'no-match' }

    const result = await sendOne({ cfg, sessionId, item: target })
    if (!result.ok) return { kind: 'skipped', sent: 0, reason: result.reason ?? 'send-failed' }
    deps.recordEvent?.('battle-team', { sessionId, images: images.length })
    return { kind: 'sent', sent: 1, reason: 'team-fight' }
  }

  /** 真正发一张：调 deps.sendItem，成功后记账（库 + state + tracker + 结算）。 */
  async function sendOne({ cfg, sessionId, item }) {
    if (!item) return { ok: false, reason: 'no-item' }

    // 「只选表情包」：发送期再过滤一次（库里可能混着用户手动塞进来的照片）
    if (cfg.proactive.stickerOnly === true && !looksLikeSticker(item, cfg)) {
      return { ok: false, reason: 'not-sticker' }
    }

    let result
    try {
      result = await deps.sendItem(item)
    } catch (error) {
      return { ok: false, reason: `send threw: ${error?.message ?? error}` }
    }
    if (!result?.ok) return { ok: false, reason: result?.reason ?? 'send-failed' }

    try {
      library.markSent(item, sessionId)
      markSent(state(), sessionId, { itemKey: item.key })
      deps.markStateDirty?.()
      tracker.noteOwnMessage(sessionId, `[表情 #${shortId(item)}]`)
    } catch (error) {
      note('warn', `发图后记账失败（图已经发出去了）：${error?.message ?? error}`)
    }
    return { ok: true, detail: result.detail }
  }

  return {
    onTurnStopping,
    /** 面板/状态用的简报。 */
    brief(sessionId) {
      const entry = stateOf(sessionId)
      const cfg = getConfig()
      return {
        enabled: cfg.proactive.enabled === true,
        running: entry.running,
        lastSentAt: entry.lastSentAt,
        lastOutcome: entry.lastOutcome,
        lastDetail: entry.lastDetail,
        sentTotal: entry.sentTotal,
        teamBudgetLeft: Number.isFinite(teamBudgetLeft(cfg, entry)) ? teamBudgetLeft(cfg, entry) : null,
      }
    },
    /** 测试/排障：清掉运行态。 */
    reset() { sessionStates.clear() },
  }
}

// ────────────────────────────────────────────────────────────── 纯函数（可单测）

/** 按贴合度挑一张（可排除指定 key）。 */
export function chooseSticker({ cfg, sessionId, visible, mood = '', keyword = '', exclude = [] }) {
  if (!Array.isArray(visible) || visible.length === 0) return null
  const excluded = new Set(exclude)
  const pool = excluded.size > 0 ? visible.filter((item) => !excluded.has(item.key)) : visible
  if (pool.length === 0) return null

  // 先走评分（复用现有 pick.js，保证手感一致）
  const scored = pickCandidates(pool, {
    sessionId,
    limit: Math.max(3, num(cfg?.send?.keepRecentCount, 5)),
    mood,
    keyword,
    now: Date.now(),
  })
  if (scored.length > 0) {
    // 有明确 mood/keyword 时取最高分；没有语境时随机取一个（避免老是同一张）
    if (mood || keyword) return scored[0].item
    const index = Math.floor(Math.random() * Math.min(scored.length, 5))
    return scored[index].item
  }
  // 评分失败兜底：随机一张，至少能发出去
  return pool[Math.floor(Math.random() * pool.length)]
}

/** 这张图看起来像不像表情包（发送期过滤用）。 */
export function looksLikeSticker(item, cfg) {
  if (!item) return false
  const ext = String(item.ext ?? '').toLowerCase()
  // 动图一律算表情（QQ 里 GIF 就是表情），不受尺寸/字节限制
  if (ext === 'gif') return true
  if (item.animated === true) return true
  const longest = Math.max(num(item.width, 0), num(item.height, 0))
  const maxDim = num(cfg?.collect?.stickerMaxDim, 1920)
  const maxBytes = num(cfg?.collect?.stickerMaxBytes, 10485760)
  if (!longest) return num(item.bytes, 0) <= maxBytes
  if (longest > maxDim) return false
  if (num(item.bytes, 0) > maxBytes) return false
  return true
}

/** 意图提示词。 */
export function buildIntentPrompt({ turnText, recent }) {
  const lines = []
  lines.push('你是聊天机器人的「配图助手」。机器人刚在群里说完下面这句话，判断它该不该补一张表情包。')
  lines.push('')
  lines.push(`【刚说的话】${oneLine(turnText, 400)}`)
  if (recent) lines.push(`【最近群里的对话】${recent}`)
  lines.push('')
  lines.push('规则：')
  lines.push('- 严肃话题（求助、生病、工作、钱、矛盾、坏消息）→ 不配图。')
  lines.push('- 别人明确在要信息、要答案 → 不配图。')
  lines.push('- 接梗、吐槽、开玩笑、附和、自嘲、无语、庆祝、道别 → 可以配图。')
  lines.push('- 已经连着好几条表情包了 → 不配图（别刷屏）。')
  lines.push('')
  lines.push('严格只输出一个 JSON 对象，不要解释、不要 markdown：')
  lines.push('{"send":true|false,"mood":"<情绪词，没把握就留空>","keyword":"<更具体的关键词，可留空>","confidence":0~1}')
  lines.push('mood 只能从这些里选：开心、无奈、生气、难过、害羞、惊讶、嘲讽、赞同、拒绝、打招呼、关心、沙雕、发呆、困、偷看、紧张。')
  return lines.join('\n')
}

/**
 * 解析意图输出。
 *
 * 容错：剥代码块 → 找第一个完整 JSON 对象 → 修尾逗号。
 * **解析不出一律判不发**（宁可少发，不能乱发）。
 */
export function parseIntent(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { send: false, reason: 'empty' }

  const candidates = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1))
  candidates.push(text)

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (parsed && typeof parsed === 'object' && typeof parsed.send === 'boolean') {
      return {
        send: parsed.send === true,
        mood: String(parsed.mood ?? '').trim().slice(0, 20),
        keyword: String(parsed.keyword ?? '').trim().slice(0, 30),
        confidence: clamp01(num(parsed.confidence, 0)),
        reason: parsed.send === true ? '' : 'model-declined',
      }
    }
  }
  return { send: false, reason: 'unparsable' }
}

/** 团战提示词。 */
export function buildTeamPrompt({ count, chatText }) {
  const lines = []
  lines.push(`群里刚刚连着刷了 ${count} 张图，大家在斗图。看这些图在表达什么，判断机器人该不该也来一张。`)
  if (chatText) lines.push(`【同时的聊天内容】${oneLine(chatText, 200)}`)
  lines.push('')
  lines.push('严格只输出一个 JSON 对象：')
  lines.push('{"join":true|false,"mood":"<情绪词>","keyword":"<关键词，如猫娘/笑死/服了>"}')
  lines.push('mood 从这些里选：开心、无奈、生气、难过、害羞、惊讶、嘲讽、赞同、拒绝、沙雕、发呆、紧张。')
  lines.push('如果是正经讨论（不是玩梗），join 填 false。')
  return lines.join('\n')
}

/** 解析团战输出。 */
export function parseTeam(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { join: false }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1].trim() : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? body.slice(start, end + 1) : body
  const parsed = tryParse(candidate)
  if (!parsed || typeof parsed !== 'object') return { join: false }
  return {
    join: parsed.join === true,
    mood: String(parsed.mood ?? '').trim().slice(0, 20),
    keyword: String(parsed.keyword ?? '').trim().slice(0, 30),
  }
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { /* 继续尝试修 */ }
  try { return JSON.parse(String(text).replace(/,\s*([}\]])/g, '$1')) } catch { /* 放弃 */ }
  return null
}

function clamp01(value) {
  const n = num(value, 0)
  return Math.min(1, Math.max(0, n))
}

function todayKey(now = Date.now()) {
  const date = new Date(now)
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 连发间隔（可被测试替换）。
 *
 * 生产环境走 700ms（给桥接队列留呼吸空间）；测试里注入 `() => Promise.resolve()`
 * 就不用真的等 —— 否则每条连发用例都要拖一秒，整个测试文件慢到没法跑。
 *
 * @param {(() => Promise<void>) | undefined} injected
 * @returns {() => Promise<void>}
 */
function sleepGap(injected) {
  return typeof injected === 'function' ? injected : () => sleep(BURST_GAP_MS)
}
