/**
 * 挑选：从库里挑一张最合适的表情。
 *
 * 评分（与原 sticker-steal 同权重，别改数值 —— 那是被用户实际反馈调过的）：
 *   S = 0.10C + 0.25I + 0.25N + 0.15D
 *   C 语境：标签精确命中 1 / 包含 0.8 / 有标签未命中 0.25 / 无标签 0.45；
 *           keyword 命中 1 否则 0.2；最近聊天里出现过图上文字 +0.9
 *   I 期望互动：贝叶斯平均 (raw*shown + 0.5*3)/(shown+3)，raw = min(1,(users+replies)/shown/1.5)
 *   N 新颖：没发过 = 1；否则 recency(hours/24)*0.65 + max(0,1-used/12)*0.35
 *   D 均衡：1 - used/max(1,(totalSent/30)*4)
 *
 * 为什么不用"取最高分"：那样永远发同几张。所以最后一步是 **softmax 加权随机**（温度 2.2），
 * 高分更容易被选中，但低分也有机会 —— 这才是"偶尔换着用"的手感。
 */
import { num } from './util.js'
import { interactionReward, shortId } from './library.js'

/** softmax 温度：越大越平（越随机）。 */
export const WEIGHT_TEMP = 2.2

/** 排除"最近在这个会话发过的"前几张（避免连续发同一张）。 */
const RECENT_EXCLUDE = 5

/** 单张的评分明细（排障与报表都要）。 */
export function scoreItem(item, ctx = {}) {
  const mood = String(ctx.mood ?? '').trim()
  const keyword = String(ctx.keyword ?? '').trim()
  const recentText = String(ctx.recentText ?? '')
  const totalSent = num(ctx.totalSent, 0)
  const now = num(ctx.now, Date.now())

  // ── C 语境 ──
  const tags = Array.isArray(item.tags) ? item.tags : []
  let moodScore = 0.45 // 无标签：中性偏下（能发，但不如有标签的贴切）
  if (tags.length > 0 && mood) {
    if (tags.some((tag) => tag === mood)) moodScore = 1
    else if (tags.some((tag) => tag.includes(mood) || mood.includes(tag))) moodScore = 0.8
    else moodScore = 0.25
  }
  let keywordScore = 0.2
  if (keyword) {
    const haystack = [item.note, item.text, ...tags].join(' ')
    keywordScore = haystack.includes(keyword) ? 1 : 0.2
  }
  // 最近聊天里出现过这张图的文字 → 说明正好在聊这个（不花 token 的强信号）
  const recentBonus = (item.text && recentText.includes(item.text)) ? 0.9 : 0
  const contextScore = clamp01(moodScore * 0.6 + keywordScore * 0.4 + recentBonus)

  // ── I 期望互动（贝叶斯）──
  const shown = num(item.interactShown, 0)
  const rawRate = shown > 0
    ? Math.min(1, (num(item.interactUsers, 0) + num(item.interactReplies, 0)) / shown / 1.5)
    : 0
  const expected = (rawRate * shown + 0.5 * 3) / (shown + 3)

  // ── N 新颖度 ──
  let novelty
  if (num(item.sentCount, 0) === 0) {
    novelty = 1
  } else {
    const hours = Math.max(0, (now - num(item.usedAt, 0)) / 3_600_000)
    const recency = Math.max(0, 1 - hours / 24)
    novelty = recency * 0.65 + Math.max(0, 1 - num(item.useCount, 0) / 12) * 0.35
  }

  // ── D 均衡度 ──
  const balance = 1 - num(item.useCount, 0) / Math.max(1, (totalSent / 30) * 4)

  const total = 0.10 * clamp01(contextScore) + 0.25 * clamp01(expected) + 0.25 * clamp01(novelty) + 0.15 * clamp01(balance)
  return { total, contextScore, expected, novelty, balance }
}

/**
 * 挑候选（返回已排序+打分，不含随机抽样；工具"挑一张"用的是这里的列表）。
 *
 * @param {Array<object>} items 可见条目
 * @param {object} opts
 * @param {string} [opts.mood] 情绪词
 * @param {string} [opts.keyword] 关键词
 * @param {string} [opts.sessionId] 会话 id（用于排除最近发过的）
 * @param {string} [opts.recentText] 最近聊天文本（拼图上的字）
 * @param {number} [opts.limit]
 * @param {number} [opts.now]
 */
export function pickCandidates(items, opts = {}) {
  const limit = Math.max(1, Math.min(50, num(opts.limit, 8)))
  const sessionId = String(opts.sessionId ?? '')
  const alive = items.filter((item) => item && !item.hidden && !item.tags.includes('无意义'))
  if (alive.length === 0) return []
  const totalSent = alive.reduce((sum, item) => sum + num(item.sentCount, 0), 0)

  // 排除本会话最近发过的（排除干净就放宽，绝不因此报"没有图"）
  const recentIds = opts.recentIds ?? collectRecentIds(alive, sessionId)
  const pool = alive.filter((item) => !recentIds.has(item.key))
  const base = pool.length > 0 ? pool : alive

  const scored = base.map((item) => ({
    item,
    score: scoreItem(item, { ...opts, totalSent }),
  }))
  scored.sort((a, b) => b.score.total - a.score.total)
  return scored.slice(0, limit)
}

/** 从条目自带的 sentTo 里推出"这个会话最近发过的编号"。 */
export function collectRecentIds(items, sessionId) {
  const out = new Set()
  if (!sessionId) return out
  const candidates = items
    .filter((item) => item.sentTo && num(item.sentTo[sessionId], 0) > 0)
    .sort((a, b) => num(b.sentTo[sessionId], 0) - num(a.sentTo[sessionId], 0))
  for (const item of candidates.slice(0, RECENT_EXCLUDE)) out.add(item.key)
  return out
}

/**
 * softmax 加权随机抽一张。
 *
 * @param {Array<{item:object, score:{total:number}}>} scored pickCandidates 的输出
 * @param {() => number} [random] 测试可注入固定随机源
 */
export function weightedPick(scored, random = Math.random) {
  if (!Array.isArray(scored) || scored.length === 0) return null
  if (scored.length === 1) return scored[0].item
  const scores = scored.map((row) => row.score.total)
  const max = Math.max(...scores)
  const weights = scores.map((s) => Math.exp((s - max) * WEIGHT_TEMP))
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return scored[Math.floor(random() * scored.length)].item
  let r = random() * sum
  for (let i = 0; i < scored.length; i++) {
    r -= weights[i]
    if (r <= 0) return scored[i].item
  }
  return scored[scored.length - 1].item
}

/** 一行候选（给提示词/工具结果）：`#abc1234567 [开心] 笑死 动图 发过3次`。 */
export function candidateLine(item, { showText = true, showStats = false } = {}) {
  const tag = item.tags?.length ? `[${item.tags.join('/')}]` : '[未分类]'
  const parts = [`#${shortId(item)}`, tag]
  const note = oneLineText(item.note, 30)
  if (note) parts.push(note)
  if (showText && item.text) parts.push(`「${oneLineText(item.text, 16)}」`)
  if (item.animated) parts.push('动图')
  if (showStats) {
    const sent = num(item.sentCount, 0)
    if (sent > 0) parts.push(`发过${sent}次`)
    if (item.interactShown > 0) parts.push(`互动${interactionReward(item).toFixed(2)}`)
  }
  return parts.join(' ')
}

function clamp01(value) {
  const n = num(value, 0)
  return Math.min(1, Math.max(0, n))
}

function oneLineText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
