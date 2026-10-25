/**
 * 每轮的候选段：把这个会话能用的表情列进模型看得到的地方。
 *
 * ⚠️ 为什么不用 `systemPrompt.section`：qq-guard 在 QQ 会话里注册了
 * `complete: true` 的人设 section，而 DSH 的 SystemPrompt.assemble 一旦发现
 * complete section，会把 sections 硬压成只留它一个（dsh-system-prompt/lib/index.js:381-403）。
 * 我们再注册 section 一定会被丢掉。
 *
 * 唯一活路是 `required: true` 的 **context**：assemble 里对 required context
 * 网开一面，即使 suppressRuntimeContext 也保留。落点是一条 `runtime-context`
 * 的 user 消息（dsh-agent-loop 的 RuntimeContextProjection），形态是：
 *
 *   Current runtime context. ...
 *   【表情包库】...候选列表...
 *
 * 这条消息不会被 qq-guard 的 pre-step 过滤器摘掉（它只认 dsh-mnemon/mnemon）。
 */
import { itemLine } from './library.js'
import { pickCandidates, candidateLine } from './pick.js'
import { effectiveLimits, activityOf } from './gate.js'
import { num } from './util.js'

/** context 的注册名（同层重名会抛错，所以带上插件前缀）。 */
export const CONTEXT_NAME = 'dsh-qq-sticker/candidates'

/** compact 档的字符上限（超了截断，别把预算全吃掉）。 */
const COMPACT_MAX_CHARS = 700

/**
 * 生成这一轮的表情段。
 *
 * @param {object} opts
 * @param {import('./library.js').Library} opts.library
 * @param {object} opts.config 归一化配置
 * @param {string} opts.sessionId
 * @param {object} [opts.state] state.json 内容（读今日额度；缺省则不显示剩余）
 * @param {number} [opts.activityBySession] 最近窗口内别人说了几条
 * @param {number} [opts.now]
 * @returns {string} 空字符串 = 本轮不注入
 */
export function buildCandidateContext({
  library, config, sessionId, state, activityBySession = 0, now = Date.now(),
}) {
  if (!config?.enabled) return ''
  if (config.prompt.candidatesLevel === 'off') return ''
  const visible = library.visible()
  if (visible.length === 0) return ''

  const activity = activityOf(activityBySession)
  const limits = effectiveLimits(config.send.frequency, activity.id)
  const scored = pickCandidates(visible, {
    sessionId,
    limit: config.prompt.maxCandidates,
    now,
  })
  if (scored.length === 0) return ''

  const parts = []
  parts.push(`【表情包库】你自己收藏的表情包有 ${visible.length} 张。配图档位：${limits.label}（群里${limits.activityLabel}）。`)
  parts.push(encourageLine(config.prompt.encourage))
  parts.push(limits.prompt)
  parts.push('发图不必等别人要：觉得好笑、想吐槽、想附和的时候自己挑一张发出去。配图是加分项，不用每句都配。')

  const full = config.prompt.candidatesLevel === 'full'
  const lines = scored.map((row) => candidateLine(row.item, {
    showText: config.send.showTextInContext,
    showStats: full,
  }))
  parts.push(`现成好发的：${lines.join('｜')}`)
  parts.push('直接用「发表情包」工具发编号就行，不用先挑。想看更多候选用「挑一张表情包」（那个不花 token）。')

  const remaining = remainingToday(state, sessionId, limits, now)
  if (remaining !== null) parts.push(`这个会话今天还能发 ${remaining} 张。`)
  if (config.send.sendAsSticker) {
    parts.push('（当前发送链未透传 sub_type，图会以普通图片形式发出，不影响内容。）')
  }

  let text = parts.join('\n')
  if (config.prompt.candidatesLevel === 'compact' && text.length > COMPACT_MAX_CHARS) {
    text = `${text.slice(0, COMPACT_MAX_CHARS - 1)}…`
  }
  return text
}

/** 按 encourage 档位改写频率话术（只改这一行，不强制）。 */
export function encourageLine(level) {
  const n = Math.round(num(level, 3))
  const table = [
    '积极度：0（保守）—— 纯文字回应完全没问题，表情包是可有可无的。',
    '积极度：1（偶尔）—— 大约每 3~5 轮配一张就够。',
    '积极度：2（较积极）—— 回应、吐槽、接梗时优先考虑配一张贴切的图。',
    '积极度：3（很积极）—— 能配的地方尽量配，聊天要有表情包的烟火气；注意换着用。',
  ]
  return table[Math.min(3, Math.max(0, n))]
}

/** 这个会话今天还剩几张额度；档位不限日额度时返回 null。 */
export function remainingToday(state, sessionId, limits, now = Date.now()) {
  if (!limits || limits.perSessionDaily <= 0) return null
  const session = state?.sessions?.[String(sessionId ?? '')]
  const used = session && session.day === formatDay(now) ? num(session.sentToday, 0) : 0
  return Math.max(0, limits.perSessionDaily - used)
}

function formatDay(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 一行摘要（工具结果里列库用）：带不带文字可配。
 * 复用 library.itemLine，保持"提示词/工具/报表三处长相一致"。
 */
export function listLine(item, config) {
  return itemLine(item, { showText: config?.send?.showTextInContext !== false })
}
