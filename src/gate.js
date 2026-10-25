/**
 * 发送闸：能不能在这个会话里发一张表情。
 *
 * 数值全部来自原 sticker-steal（用户自己调过的四档 × 五档活跃度），别自己重编：
 *   档位基准 rare 15张/日·60分钟 ; occasional 30/日·20分钟 ; normal 每分钟≤2 ; often 全不限
 *   活跃度（最近 30 分钟别人说了多少条）：<4 ×0.5/×2 ; 4~11 ×0.8/×1.2 ;
 *     12~29 ×1/×1 ; 30~69 ×1.5/×0.6 ; ≥70 ×2/×0.35
 *
 * 刻意**不做**概率闸门：原插件已经撤掉（"攒够时间就必发一张"很机械，
 * 硬拦又会让模型嘴炮答应）。发不发由模型按提示词决定，这里只管用户设的硬上限。
 */
import { num } from './util.js'

/** 四档频率的基准值。 */
export const FREQ_LEVELS = {
  rare: {
    label: '很少',
    perSessionDaily: 15,
    minIntervalMin: 60,
    perMinute: 0,
    prompt: '表情包是备选项，不勉强；纯文字回应完全没问题。',
  },
  occasional: {
    label: '偶尔',
    perSessionDaily: 30,
    minIntervalMin: 20,
    perMinute: 0,
    prompt: '频率：普通闲聊不用每次都配图；大约每 2~3 轮配一张就够，热闹/玩梗时可以更密一些，但不要连续刷屏。',
  },
  normal: {
    label: '一般',
    perSessionDaily: 0,
    minIntervalMin: 0,
    perMinute: 2,
    prompt: '频率：回应、吐槽、接梗时优先考虑配一张贴切的图，让对话更有活人感；但**每分钟最多两张**，别连着刷。',
  },
  often: {
    label: '经常',
    perSessionDaily: 0,
    minIntervalMin: 0,
    perMinute: 0,
    prompt: '频率：你是表情包爱好者——能配图的地方尽量配，接梗/调侃/附和时几乎都会带一张。**不要连续发同一张**（换着用），但不用刻意克制数量。',
  },
}

/** 活跃度五档：额度系数与间隔系数。 */
export const ACTIVITY_LEVELS = [
  { id: 'cold', label: '冷清', max: 3, quotaScale: 0.5, gapScale: 2.0 },
  { id: 'quiet', label: '一般', max: 11, quotaScale: 0.8, gapScale: 1.2 },
  { id: 'active', label: '较活跃', max: 29, quotaScale: 1, gapScale: 1 },
  { id: 'hot', label: '很活跃', max: 69, quotaScale: 1.5, gapScale: 0.6 },
  { id: 'burst', label: '爆聊', max: Infinity, quotaScale: 2, gapScale: 0.35 },
]

/**
 * 按最近 30 分钟别人说的条数判活跃度。
 * @param {number} humanMessages 窗口内（排除机器人自己）的消息条数
 */
export function activityOf(humanMessages) {
  const count = Math.max(0, num(humanMessages, 0))
  for (const level of ACTIVITY_LEVELS) {
    if (count <= level.max) return level
  }
  return ACTIVITY_LEVELS[ACTIVITY_LEVELS.length - 1]
}

/**
 * 算这一档 × 这一活跃度下的实际额度与间隔。
 * `perSessionDaily` / `perMinute` 为 0 表示"该档位不限制这一项"，缩放后仍为 0。
 */
export function effectiveLimits(freqId, activityId) {
  const level = FREQ_LEVELS[freqId] ?? FREQ_LEVELS.occasional
  const activity = ACTIVITY_LEVELS.find((entry) => entry.id === activityId) ?? ACTIVITY_LEVELS[1]
  const scaleQuota = (base) => (base <= 0 ? 0 : Math.max(1, Math.round(base * activity.quotaScale)))
  const scaleGap = (base) => (base <= 0 ? 0 : Math.max(1, Math.round(base * activity.gapScale)))
  return {
    label: level.label,
    activityLabel: activity.label,
    perSessionDaily: scaleQuota(level.perSessionDaily),
    minIntervalMin: scaleGap(level.minIntervalMin),
    perMinute: level.perMinute,
    prompt: level.prompt,
  }
}

/**
 * 判一次发送。
 *
 * @param {object} opts
 * @param {object} opts.config 归一化配置
 * @param {object} opts.state state.json 内容（会被原地改的只有调用方自己 mark）
 * @param {string} opts.sessionId DSH 会话 id（= 一个 QQ 群/私聊）
 * @param {number} opts.activityBySession 该会话最近 30 分钟别人说的条数
 * @param {boolean} [opts.wantSticker] 对方点名要图：跳过"软门槛"，但硬上限仍然生效
 * @param {number} [opts.now]
 * @returns {{ok:boolean, reason?:string, limits?:object, waitSec?:number}}
 */
export function sendGate({ config, state, sessionId, activityBySession = 0, now = Date.now() }) {
  const send = config.send
  const session = state.sessions?.[sessionId] ?? emptySessionState()
  const dayKey = todayKeyOf(now)
  const sentToday = session.day === dayKey ? num(session.sentToday, 0) : 0
  const globalToday = state.sentDay === dayKey ? num(state.sentToday, 0) : 0

  // ① 全局每日
  if (send.dailyLimit > 0 && globalToday >= send.dailyLimit) {
    return reject(`今天全局已经发了 ${globalToday} 张（上限 ${send.dailyLimit}），明天再说。用文字回应就好，别重试。`)
  }
  // ② 全局最小间隔
  if (send.globalIntervalSec > 0) {
    const last = num(state.lastGlobalSendAt, 0)
    const gapMs = send.globalIntervalSec * 1000
    if (last > 0 && now - last < gapMs) {
      return reject(`刚发过一张图，全局还要等 ${Math.ceil((gapMs - (now - last)) / 1000)} 秒。用文字回应就好。`)
    }
  }
  // ③ 同会话最小间隔
  if (send.minIntervalSec > 0) {
    const last = num(session.lastAt, 0)
    const gapMs = send.minIntervalSec * 1000
    if (last > 0 && now - last < gapMs) {
      return reject(`这个会话 ${Math.ceil((gapMs - (now - last)) / 1000)} 秒前刚发过表情，先别连着发。用文字回应就好。`)
    }
  }
  // ④ 档位额度 × 活跃度缩放
  const activity = activityOf(activityBySession)
  const limits = effectiveLimits(send.frequency, activity.id)
  if (limits.perSessionDaily > 0 && sentToday >= limits.perSessionDaily) {
    return reject(`这个会话今天已经发了 ${sentToday} 张（${limits.label}档上限 ${limits.perSessionDaily} 张），今天先到这里。用文字回应就好。`)
  }
  if (limits.minIntervalMin > 0 && num(session.lastAt, 0) > 0) {
    const gapMs = limits.minIntervalMin * 60 * 1000
    const last = num(session.lastAt, 0)
    if (now - last < gapMs) {
      return reject(`这个会话 ${Math.ceil((gapMs - (now - last)) / 60000)} 分钟内刚发过，档位要求再等等。用文字回应就好。`)
    }
  }
  // ⑤ 每分钟上限（normal 档）：滑动 60 秒窗口
  if (limits.perMinute > 0) {
    const recent = (Array.isArray(session.recentAt) ? session.recentAt : [])
      .map((v) => num(v, 0))
      .filter((ts) => ts > 0 && now - ts < 60_000)
    if (recent.length >= limits.perMinute) {
      return reject(`这一分钟已经发了 ${recent.length} 张（该档上限 ${limits.perMinute} 张/分钟），等一会儿再发。用文字回应就好。`)
    }
  }
  return { ok: true, limits, activity: activity.id }
}

/** 记一次成功发送（原地改 state；调用方负责落盘）。 */
export function markSent(state, sessionId, { now = Date.now(), itemKey = '' } = {}) {
  const dayKey = todayKeyOf(now)
  if (state.sentDay !== dayKey) {
    state.sentDay = dayKey
    state.sentToday = 0
  }
  state.sentToday = num(state.sentToday, 0) + 1
  state.sentTotal = num(state.sentTotal, 0) + 1
  state.lastSendAt = now
  state.lastGlobalSendAt = now

  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {}
  const session = state.sessions[sessionId] ?? emptySessionState()
  if (session.day !== dayKey) {
    session.day = dayKey
    session.sentToday = 0
  }
  session.sentToday = num(session.sentToday, 0) + 1
  session.sentTotal = num(session.sentTotal, 0) + 1
  session.lastAt = now
  session.lastStickerAt = now
  if (itemKey) {
    session.recentIds = [...(Array.isArray(session.recentIds) ? session.recentIds : []), itemKey].slice(-8)
  }
  session.recentAt = [...(Array.isArray(session.recentAt) ? session.recentAt : []), now].slice(-120)
  state.sessions[sessionId] = session
  return state
}

/** 一个会话的配额状态空壳（字段必须齐全，否则读盘后"最近发送"会静默归零）。 */
export function emptySessionState() {
  return {
    day: '',
    sentToday: 0,
    lastAt: 0,
    sentTotal: 0,
    lastStickerAt: 0,
    recentIds: [],
    recentAt: [],
  }
}

/** state 的空壳。 */
export function emptyState() {
  return {
    version: 1,
    sentDay: '',
    sentToday: 0,
    sentTotal: 0,
    lastSendAt: 0,
    lastGlobalSendAt: 0,
    sessions: {},
    ingest: { day: '', count: 0, hour: '', hourCount: 0 },
    counters: { collected: 0, duplicates: 0, skipped: 0, evicted: 0, sent: 0, failed: 0 },
  }
}

/** 拒绝结果统一话术：强调"图没坏、用文字回应、别编技术原因"。 */
function reject(reason) {
  return {
    ok: false,
    reason: `${reason}（这张图本身没问题，不是发不出去；不要重试、不要编技术原因。）`,
  }
}

function todayKeyOf(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 简报：给设置页/报表看"这一档现在是什么额度"。 */
export function freqBrief(freqId) {
  const level = FREQ_LEVELS[freqId] ?? FREQ_LEVELS.occasional
  return {
    id: freqId,
    label: level.label,
    perSessionDaily: level.perSessionDaily,
    minIntervalMin: level.minIntervalMin,
    perMinute: level.perMinute,
  }
}
