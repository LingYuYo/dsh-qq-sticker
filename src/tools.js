/**
 * 模型侧工具（11 个）。
 *
 * 命名：全部带 `qq_ext_` 前缀 —— 不是随手起的，是**硬约束**。
 * qq-guard 在 QQ 会话里挂了 deny-by-default 的执行期白名单，只放行
 * `ask_user_question`/`todo_write` 与 `mcp__`、`qq_ext_` 两个前缀
 * （dsh-qq-guard/index.js SAFE_EXACT / SAFE_PREFIXES）。工具名不带这个前缀
 * 装上就是"每次调用都被拒"。换前缀只需改 TOOL 常量表。
 *
 * 定义方式：官方 `defineTool()`。`parameters` 必须写成「属性名→value schema」的 map，
 * 不是 JSON Schema；object 节点要显式 additionalProperties —— 否则工具能注册但
 * **不进 request/header 的工具清单**（qq-guard 2026-10-24 真机踩过）。
 */
import { pathToFileURL } from 'node:url'

import { num, oneLine, safeService } from './util.js'
import { itemLine, interactionReward, shortId } from './library.js'
import { candidateLine, pickCandidates, weightedPick } from './pick.js'
import { effectiveLimits, activityOf, sendGate, markSent } from './gate.js'
import { MAX_DELETE_PER_RUN } from './vision.js'
import { MOOD_WORDS } from './config.js'

/** 工具名前缀（改这里就够，其他地方全部引用常量）。 */
export const TOOL_PREFIX = 'qq_ext_sticker_'

/** 工具名表。 */
export const TOOL = {
  PICK: `${TOOL_PREFIX}pick`,
  SEND: `${TOOL_PREFIX}send`,
  LIST: `${TOOL_PREFIX}list`,
  LOOK: `${TOOL_PREFIX}look`,
  TAG: `${TOOL_PREFIX}tag`,
  COLLECT: `${TOOL_PREFIX}collect`,
  SCAN: `${TOOL_PREFIX}scan`,
  ORGANIZE: `${TOOL_PREFIX}organize`,
  CLEANUP: `${TOOL_PREFIX}cleanup`,
  DELETE_OLDEST: `${TOOL_PREFIX}delete_oldest`,
  STATS: `${TOOL_PREFIX}stats`,
}

/** 全部工具名（白名单/自检用）。 */
export const TOOL_NAMES = Object.values(TOOL)

/** 默认定义器：优先官方 defineTool；离线测试用同构兜底。 */
let cachedDefineTool
async function loadDefineTool() {
  if (cachedDefineTool !== undefined) return cachedDefineTool
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    cachedDefineTool = typeof mod?.defineTool === 'function' ? mod.defineTool : null
  } catch {
    cachedDefineTool = null
  }
  return cachedDefineTool
}

/**
 * 同构兜底编译器（仅离线测试用）。
 *
 * 规则抄自 @deepseek-ai/dsh-tools 的 author spec 编译：
 *  · 根节点 {type:'object', properties[, required]}
 *  · 节点里的 required:true 抽到根 required[]
 *  · object 节点必须显式 additionalProperties
 */
export function compileValueSchema(path, node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} 必须是 value schema 对象`)
  }
  const out = {}
  for (const key of ['description', 'title', 'default', 'examples']) {
    if (Object.hasOwn(node, key)) out[key] = node[key]
  }
  if (Array.isArray(node.oneOf)) {
    out.oneOf = node.oneOf.map((branch, index) => compileValueSchema(`${path}.oneOf[${index}]`, branch))
    return out
  }
  const type = Object.hasOwn(node, 'type') ? node.type : undefined
  if (type === 'json') return out
  out.type = type
  if (type === 'object') {
    out.additionalProperties = node.additionalProperties === true
    if (node.properties) Object.assign(out, compileParameterMap(`${path}.properties`, node.properties))
  } else if (type === 'array') {
    if (node.items) out.items = compileValueSchema(`${path}.items`, node.items)
  } else if (Array.isArray(node.enum)) {
    out.enum = [...node.enum]
  }
  return out
}

/** 属性表 → 根对象 schema。 */
export function compileParameterMap(path, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError(`${path} 必须是「属性名→value schema」的对象`)
  }
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    properties[key] = compileValueSchema(`${path}.${key}`, node)
    if (node?.required === true) required.push(key)
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties }
}

/** 离线兜底：与官方 defineTool 语义一致的 definition。 */
export function fallbackDefineTool(options) {
  const parameters = compileParameterMap('parameters', options.parameters)
  const outputSchema = compileValueSchema('output.schema', options.output.schema)
  const definition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('invalid arguments: 参数必须是对象')
      }
      return options.execute(args, exec)
    },
  }
  if (typeof options.presentCall === 'function') definition.presentCall = (args) => options.presentCall(args)
  if (typeof options.presentResult === 'function') {
    definition.presentResult = (args, result) => options.presentResult(args, result)
  }
  if (typeof options.isConcurrencySafe === 'function') {
    definition.isConcurrencySafe = (args) => options.isConcurrencySafe(args)
  }
  return definition
}

/** 定义工具（会自动选官方/兜底）。 */
export async function defineStickerTool(options) {
  const defineTool = await loadDefineTool()
  return typeof defineTool === 'function' ? defineTool(options) : fallbackDefineTool(options)
}

/**
 * 生成全部工具定义。
 *
 * @param {object} runtime 见 index.js 里构造的 runtime（library/tracker/config/...）
 * @returns {Promise<Array<object>>} registry-ready definitions
 */
export async function buildTools(runtime) {
  const {
    library, tracker, getConfig, log, ctx, guards,
    collector, vision, settler, attachments, readImageBytes,
  } = runtime

  /** 当前会话 id（= 一个 QQ 群/私聊）。 */
  const sessionOf = (exec) => String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '')

  /** 统一的前置检查：插件关了就别干活。 */
  const requireEnabled = () => {
    const cfg = getConfig()
    if (!cfg.enabled) throw new Error('表情包插件已在设置里关闭，这个工具现在不可用。')
    return cfg
  }

  /** 发送额度简报（塞进工具返回，让模型知道还剩多少）。 */
  const quotaBrief = (cfg, sessionId) => {
    const activity = activityOf(tracker.humanCount(sessionId))
    const limits = effectiveLimits(cfg.send.frequency, activity.id)
    const state = runtime.state()
    const day = todayOf()
    const session = state.sessions?.[sessionId] ?? {}
    const usedToday = session.day === day ? num(session.sentToday, 0) : 0
    return {
      level: limits.label,
      activity: limits.activityLabel,
      perSessionDaily: limits.perSessionDaily,
      usedToday,
      remaining: limits.perSessionDaily > 0 ? Math.max(0, limits.perSessionDaily - usedToday) : null,
    }
  }

  const defs = []

  // ── 挑一张 ─────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.PICK,
    description: '从机器人自己的表情包里挑几张候选，返回编号、标签和适用场合。想配图时先用它挑，再用「发表情包」发出去。'
      + `mood 填想表达的情绪（只能从这些里选：${MOOD_WORDS.filter((w) => w !== '无意义').join('/')}），keyword 填更具体的关键词（如"猫娘""笑死"）。`
      + '⚠️ 别人点名要图时，从返回的候选里**随便挑一张直接发**就行；挑不到"特别贴切"的也照发，别为了追求贴切而放弃发图。',
    parameters: {
      mood: {
        type: 'string',
        description: '想表达的情绪，从系统给的词里选一个；拿不准就留空。',
        enum: MOOD_WORDS.filter((word) => word !== '无意义'),
      },
      keyword: {
        type: 'string',
        description: '更具体的关键词，如"猫娘""笑死""晚安"。可选。',
      },
      limit: {
        type: 'number',
        description: '这次给几个候选，默认 5、最多 10。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true, description: '库里可见表情总数。' },
          candidates: {
            type: 'array',
            required: true,
            description: '候选列表（按贴合度排序）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                tags: { type: 'array', items: { type: 'string' } },
                note: { type: 'string' },
                text: { type: 'string' },
                animated: { type: 'boolean' },
                score: { type: 'number' },
              },
            },
          },
          quota: {
            type: 'object',
            additionalProperties: false,
            properties: {
              level: { type: 'string' },
              activity: { type: 'string' },
              remaining: { type: 'number' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.candidates?.length
          ? `候选（库里共 ${value.total} 张）：\n${value.candidates.map((c) => `- #${c.id}${c.tags?.length ? ` [${c.tags.join('/')}]` : ''}${c.note ? ` ${c.note}` : ''}${c.text ? ` 「${c.text}」` : ''}${c.animated ? ' 动图' : ''}`).join('\n')}`
          : `库里没有可用的表情（可见 ${value?.total ?? 0} 张）。`,
      }],
    },
    async execute(args, exec) {
      const cfg = requireEnabled()
      const sessionId = sessionOf(exec)
      const items = library.visible()
      const limit = Math.min(10, Math.max(1, num(args?.limit, 5)))
      const scored = pickCandidates(items, {
        mood: String(args?.mood ?? '').trim(),
        keyword: String(args?.keyword ?? '').trim(),
        sessionId,
        recentText: tracker.recentText(sessionId),
        recentIds: new Set(tracker.recentStickerIds(sessionId)),
        limit,
      })
      return {
        total: items.length,
        candidates: scored.map((row) => ({
          id: shortId(row.item),
          tags: row.item.tags,
          note: oneLine(row.item.note, 60),
          text: cfg.send.showTextInContext ? oneLine(row.item.text, 40) : '',
          animated: row.item.animated === true,
          score: Number(row.score.total.toFixed(3)),
        })),
        quota: quotaBrief(cfg, sessionId),
      }
    },
  }))

  // ── 发一张 ─────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.SEND,
    description: '把一张表情包发到当前聊天（配图用）。**别人点名要图时直接发**，不用纠结贴不贴切；'
      + '自己主动说话时也可以主动配一张 —— 就像真人在群里随手甩表情。stickerId 用「挑一张表情包」返回的编号；'
      + '如果上下文里【表情包库】已经把现成编号列出来了，可以直接用。'
      + '**一条消息只能是一张图、不能附带文字**：想说的话先用正常回复发出。'
      + '受当前档位与额度限制：被拒绝就改用文字回应，不要重试，也不要编"图卡住了"这种理由。',
    parameters: {
      stickerId: {
        type: 'string',
        required: true,
        description: '表情编号，即候选里 # 后面那串。',
      },
      wantSticker: {
        type: 'boolean',
        description: '群友点名要图时填 true（要表情/来个图/发点表情）。只影响措辞，硬额度仍然生效。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sent: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.sent === true ? `表情已发出（#${value.id}）：${value.detail}` : `没有发出去：#${value.id ?? ''} ${value?.detail ?? ''}`,
      }],
    },
    // 发送要串行（同会话连发会刷屏，也让网关记账稳定）
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const cfg = requireEnabled()
      const sessionId = sessionOf(exec)
      if (!sessionId) throw new Error('只能在 QQ 会话里发表情（拿不到 sessionId）')
      const item = library.find(String(args?.stickerId ?? ''))
      if (!item) throw new Error(`库里没有这个编号：${args?.stickerId}（先用「挑一张表情包」或「看看表情包库」确认）`)
      if (item.hidden) throw new Error(`#${shortId(item)} 已经被隐藏了，换一张。`)
      if (item.tags.includes('无意义')) throw new Error(`#${shortId(item)} 标了「无意义」，别发它。换一张。`)

      const activity = tracker.humanCount(sessionId)
      const verdict = sendGate({
        config: cfg,
        state: runtime.state(),
        sessionId,
        activityBySession: activity,
      })
      if (!verdict.ok) {
        // 拒绝话术必须可读：模型要能据此改说人话
        throw new Error(verdict.reason)
      }

      const imagePath = item.path
      if (!imagePath) throw new Error(`#${shortId(item)} 没有本地图片文件，发不出去。换一张。`)
      const fileRef = pathToFileURL(imagePath).href
      const sendResult = await callSendImage(ctx, exec, fileRef, cfg)
      if (!sendResult.ok) throw new Error(sendResult.reason)

      // 记账：库 + 全会话配额 + 互动结算 + 自己说过话
      library.markSent(item, sessionId)
      markSent(runtime.state(), sessionId, { itemKey: item.key })
      runtime.markStateDirty()
      tracker.noteOwnMessage(sessionId, `[表情 #${shortId(item)}]`)
      settler.register({ sessionId, itemKey: item.key })

      log('debug', `发表情 #${shortId(item)} → ${sessionId}（${verdict.limits.label}档）`)
      return {
        sent: true,
        id: shortId(item),
        detail: sendResult.detail || `已发到 QQ（${cfg.send.frequency} 档）`,
      }
    },
  }))

  // ── 看库 ───────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.LIST,
    description: '列出机器人收藏的表情包（可按情绪或关键词过滤），用来了解库里有什么、确认某个编号是否存在、'
      + '或者向群友说明"我有哪些图"。只是查看，不会发图。',
    parameters: {
      mood: {
        type: 'string',
        description: '只看某个情绪分类，可选。',
        enum: MOOD_WORDS,
      },
      keyword: {
        type: 'string',
        description: '按关键词过滤备注/图上文字，可选。',
      },
      limit: {
        type: 'number',
        description: '最多列几张，默认 30、最多 60。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          shown: { type: 'number', required: true },
          lines: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.lines?.length
          ? `库里 ${value.total} 张，列出 ${value.shown} 张：\n${value.lines.map((line) => `- ${line}`).join('\n')}`
          : `库里 ${value?.total ?? 0} 张，没有符合条件的结果。`,
      }],
    },
    async execute(args) {
      const cfg = requireEnabled()
      const mood = String(args?.mood ?? '').trim()
      const keyword = String(args?.keyword ?? '').trim()
      const limit = Math.min(60, Math.max(1, num(args?.limit, 30)))
      let items = library.visible().filter((item) => !item.tags.includes('无意义'))
      if (mood) items = items.filter((item) => item.tags.some((tag) => tag.includes(mood) || mood.includes(tag)))
      if (keyword) {
        items = items.filter((item) => [item.note, item.text, ...item.tags].join(' ').includes(keyword))
      }
      const lines = items
        .sort((a, b) => num(b.createdAt, 0) - num(a.createdAt, 0))
        .slice(0, limit)
        .map((item) => itemLine(item, { showText: cfg.send.showTextInContext }))
      return { total: library.visible().length, shown: lines.length, lines }
    },
  }))

  // ── 看图 ───────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.LOOK,
    description: '把库里某张表情的图片内容交给你看。当你要判断"这张图是什么意思、适合什么场合"、'
      + '想给它打标签、或者群友问起某张图时使用。⚠️ **发图不需要先看图** —— 直接 send 就行，这个工具只是让你"知道它画的是什么"。'
      + '⚠️ 当前实现只提供首帧（动图会以静态一帧呈现）。看完请用「给表情包打标签」写下你的理解。',
    parameters: {
      stickerId: { type: 'string', required: true, description: '表情编号（#后面那串）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          note: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          text: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          attachment: {
            type: 'object',
            required: true,
            description: '图片附件引用（render 用它拼图片块）。',
            additionalProperties: true,
          },
        },
      },
      render: (_args, value) => {
        const blocks = [{
          type: 'text',
          text: `#${value?.id ?? ''}${value?.tags?.length ? ` [${value.tags.join('/')}]` : ''}`
            + `${value?.note ? ` ${value.note}` : ''}${value?.text ? ` 图上文字：「${value.text}」` : ''}`
            + `（${value?.width ?? 0}x${value?.height ?? 0}）`,
        }]
        if (value?.attachment) blocks.push({ type: 'image', attachment: value.attachment })
        return blocks
      },
    },
    async execute(args) {
      requireEnabled()
      // 看图不进"发送额度"，但要确认插件开着
      const item = library.find(String(args?.stickerId ?? ''))
      if (!item) throw new Error(`库里没有这个编号：${args?.stickerId}`)
      const stored = await readImageBytes(item.path)
      if (!stored) throw new Error(`#${shortId(item)} 的图片文件读不出来（可能已被删）`)
      const ref = await attachments.saveImage({
        data: stored.data,
        mediaType: stored.mediaType,
        name: `${shortId(item)}.${item.ext}`,
      })
      item.viewedAt = Date.now()
      item.useCount = num(item.useCount, 0) + 1
      library.touch()
      return {
        id: shortId(item),
        note: item.note,
        tags: item.tags,
        text: item.text,
        mediaType: ref.mediaType,
        width: ref.width,
        height: ref.height,
        attachment: ref,
      }
    },
  }))

  // ── 打标签 ─────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.TAG,
    description: '把你对某张表情的理解写进它的档案：tags 填情绪标签（从系统词表里选，1~3 个），'
      + 'note 填一句适用场合的说明（如「举着白旗的猫，服软认错时用」），text 填图上识别出的文字（没有就留空）。'
      + '**写之前先用「看这张表情」看过那张图**。第一次看到某张、或群友纠正了含义时使用。',
    parameters: {
      stickerId: { type: 'string', required: true, description: '库里已有的表情编号。' },
      tags: {
        type: 'array',
        required: true,
        description: '情绪标签，1~3 个，从系统词表里选。',
        items: { type: 'string', enum: MOOD_WORDS },
      },
      note: { type: 'string', description: '一句适用场合的说明。' },
      text: {
        type: 'string',
        description: '图上出现的文字（一个字也别漏）；确实没有就留空。不要编。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已更新 #${value?.id ?? ''}：[${(value?.tags ?? []).join('/')}] ${value?.note ?? ''}${value?.text ? `（图上文字：${value.text}）` : ''}`,
      }],
    },
    async execute(args) {
      requireEnabled()
      const item = library.find(String(args?.stickerId ?? ''))
      if (!item) throw new Error(`库里没有这个编号：${args?.stickerId}`)
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : []
      if (tags.length === 0) throw new Error('tags 不能为空：至少给一个情绪标签')
      library.annotate(item, {
        tags,
        ...(args?.note !== undefined ? { note: String(args.note) } : {}),
        ...(args?.text !== undefined ? { text: String(args.text) } : {}),
      })
      return { ok: true, id: shortId(item), tags: item.tags, note: item.note, text: item.text }
    },
  }))

  // ── 收一张 ─────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.COLLECT,
    description: '把一张图片收进机器人自己的表情库。attachmentId 留空 = 取当前会话里**最近一张**收到的图片。'
      + '群友发来好玩的图并让你「收藏 / 存下来 / 记住这个梗」时用它，别只嘴上答应。',
    parameters: {
      note: { type: 'string', description: '顺手写一句备注（这张图什么时候用）。' },
      limitToLatest: {
        type: 'boolean',
        description: '只看最近一张（默认 true）；false = 把本会话最近 10 张图片都试一遍。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          added: { type: 'number', required: true },
          duplicate: { type: 'number', required: true },
          failed: { type: 'number', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.added > 0
          ? `收进来了 ${value.added} 张：${(value.ids ?? []).map((id) => `#${id}`).join('、')}${value.duplicate ? `（另有 ${value.duplicate} 张库里已经有）` : ''}`
          : `没有新增：${value?.detail ?? ''}`,
      }],
    },
    async execute(args, exec) {
      const cfg = requireEnabled()
      const sessionId = sessionOf(exec)
      const note = String(args?.note ?? '').trim()
      const latestOnly = args?.limitToLatest !== false
      const records = tracker.list(sessionId).slice(-(latestOnly ? 1 : 10)).reverse()
      const added = []
      let duplicate = 0
      let failed = 0
      const seen = new Set()
      for (const record of records) {
        for (const block of record.content ?? []) {
          if (block?.type !== 'image' || !block.attachment) continue
          const key = String(block.attachment.attachmentId ?? '')
          if (!key || seen.has(key)) continue
          seen.add(key)
          try {
            const stored = await readImageBytes(block.attachment)
            if (!stored?.data?.length) { failed++; continue }
            const result = await library.ingest({
              bytes: stored.data,
              sessionId,
              srcHint: oneLine(record.text, 120),
              source: 'model',
              width: block.attachment.width,
              height: block.attachment.height,
              mediaType: block.attachment.mediaType,
            })
            if (!result.ok) { failed++; continue }
            if (result.duplicate) { duplicate++; continue }
            if (note) library.annotate(result.item, { note })
            added.push(shortId(result.item))
          } catch (error) {
            failed++
            log('warn', `收藏失败（已跳过）：${error?.message ?? error}`)
          }
        }
        if (latestOnly && added.length > 0) break
      }
      await library.flush()
      return {
        added: added.length,
        duplicate,
        failed,
        ids: added,
        detail: added.length > 0
          ? '已入库，之后可以直接发表情用编号'
          : (records.length === 0
            ? '这个会话最近没有收到图片（让对方先发一张）'
            : `候选 ${seen.size} 张，重复 ${duplicate}、失败 ${failed}`),
      }
    },
  }))

  // ── 回扫历史 ───────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.SCAN,
    description: '让机器人往回翻这个会话的历史消息，把里面出现过的图片捞进表情库。'
      + '当群友说「你多收点表情」「翻翻之前的」「去群里找找图」时用它。'
      + 'range 是往回看多久：1h / 4h / 12h / 24h / all。会按图片内容去重，跳过已经收过的。',
    parameters: {
      range: {
        type: 'string',
        description: '往回看多久：1h / 4h / 12h / 24h / all（全部历史）。',
        enum: ['1h', '4h', '12h', '24h', 'all'],
      },
      limit: {
        type: 'number',
        description: '这一轮最多收几张，默认 10、最多 30。',
      },
      autoTag: {
        type: 'boolean',
        description: '收完是否顺便自动补标签（看图 + 写标签）。不填则用设置里的开关。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          seen: { type: 'number', required: true },
          collected: { type: 'number', required: true },
          duplicates: { type: 'number', required: true },
          skipped: { type: 'number', required: true },
          tagged: { type: 'number', required: true },
          detail: { type: 'string', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.ok === false
          ? `没收成：${value.detail}`
          : `往回翻到 ${value.seen} 张图，新收 ${value.collected} 张${value.duplicates ? `，${value.duplicates} 张库里已有` : ''}`
            + `${value.skipped ? `，${value.skipped} 张跳过` : ''}${value.tagged ? `，顺便给 ${value.tagged} 张写好标签` : ''}。`,
      }],
    },
    async execute(args, exec) {
      requireEnabled()
      const sessionId = sessionOf(exec)
      if (!sessionId) throw new Error('只能在 QQ 会话里回扫（拿不到 sessionId）')
      const result = await collector.scanSession({
        sessionId,
        range: String(args?.range ?? '4h'),
        limit: Math.min(30, Math.max(1, num(args?.limit, 10))),
      })
      if (!result.ok) return { ok: false, seen: 0, collected: 0, duplicates: 0, skipped: 0, tagged: 0, detail: result.reason ?? '', ids: [] }
      const cfg = getConfig()
      const wantTag = args?.autoTag !== undefined ? args.autoTag === true : cfg.vision.autoTagAfterScan
      let tagged = 0
      if (wantTag && result.items.length > 0) {
        const fresh = result.items
          .map((entry) => library.find(entry.id))
          .filter((item) => item && item.tags.length === 0 && !item.note)
        if (fresh.length > 0) {
          const visionResult = await vision.recognizeBatch(fresh)
          tagged = visionResult.tagged
        }
      }
      return {
        ok: true,
        seen: result.seen,
        collected: result.collected,
        duplicates: result.duplicates,
        skipped: result.skipped,
        tagged,
        detail: '',
        ids: result.items.map((entry) => entry.id),
      }
    },
  }))

  // ── 整理（打标） ────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.ORGANIZE,
    description: '把库里还没认识的表情包**一次性**自动识别、自动打标签（每张一次视觉调用）。'
      + '当群友说「整理一下表情库」「把表情包都认一遍」「给表情打上标签」时用它。'
      + '认不出来的会记下失败次数，累计到设置值后按设置自动删除（默认删）。dryRun=true 可以先试运行、只看会删哪些。'
      + '⚠️ 这一步会花 token 且要花点时间，调用后请等它返回。',
    parameters: {
      limit: {
        type: 'number',
        description: '最多整理几张，默认 12、最多 60。',
      },
      dryRun: {
        type: 'boolean',
        description: 'true = 只试运行，报告会删哪些、会打什么标签，但不改动库。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tried: { type: 'number', required: true },
          tagged: { type: 'number', required: true },
          meaningless: { type: 'number', required: true },
          failures: { type: 'number', required: true },
          deleted: { type: 'number', required: true },
          suspicious: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value?.ok === false
          ? `整理没跑起来：${value.detail}`
          : `整理${value.dryRun ? '（试运行）' : ''}：看了 ${value.tried} 张，打上标签 ${value.tagged} 张`
            + `${value.meaningless ? `，判「无意义」${value.meaningless} 张` : ''}`
            + `${value.deleted ? `，删除 ${value.deleted} 张` : ''}`
            + `${value.failures ? `，失败 ${value.failures} 张` : ''}。${value.detail ?? ''}`,
      }],
    },
    // 花 token 且长：不让它并行撞车
    isConcurrencySafe: () => false,
    async execute(args) {
      const cfg = requireEnabled()
      const limit = Math.min(60, Math.max(1, num(args?.limit, 12)))
      const dryRun = args?.dryRun === true
      const candidates = library.visible()
        .filter((item) => item.tags.length === 0 && !item.note && !item.text)
        .sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0))
        .slice(0, limit)
      const result = await vision.recognizeBatch(candidates, { dryRun })
      const ok = result.errors.length === 0 || result.tagged > 0 || result.failures < result.tried
      const detail = result.errors.join('；')
      await library.flush()
      return {
        ok,
        tried: result.tried,
        tagged: result.tagged,
        meaningless: result.meaningless,
        failures: result.failures,
        deleted: result.deleted.length,
        suspicious: result.suspicious,
        dryRun,
        detail: ok ? (detail ? `注意：${detail}` : '') : detail,
      }
    },
  }))

  // ── 清理 ───────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.CLEANUP,
    description: '清理表情库：① 删掉图片内容完全一样的重复份；② 删掉所有被标为「无意义」的图（与状态卡统计同口径）；'
      + '③ 清掉永久剔除名单里的图；④ 清掉索引里文件已丢失的条目。'
      + '当群友说「清理一下表情库」「把没用的表情删掉」时用它。⚠️ **默认是试运行**（只报告不删），'
      + '确认后要再调一次并传 dryRun=false 才会真删。不会删「还没整理过、暂时没标签」的图。',
    parameters: {
      dryRun: {
        type: 'boolean',
        description: 'true = 只报告不删（默认）；false = 真的删。删除不可撤销，先试运行。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', required: true },
          duplicates: { type: 'number', required: true },
          meaningless: { type: 'number', required: true },
          blocked: { type: 'number', required: true },
          missing: { type: 'number', required: true },
          freedMB: { type: 'number', required: true },
          after: { type: 'number', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `清理${value?.dryRun ? '（试运行，未改动）' : ''}：重复 ${value?.duplicates ?? 0} 张、无意义 ${value?.meaningless ?? 0} 张、`
          + `剔除名单 ${value?.blocked ?? 0} 处、丢失条目 ${value?.missing ?? 0} 条，可释放 ${value?.freedMB ?? 0} MB；清理后 ${value?.after ?? 0} 张。${value?.detail ?? ''}`,
      }],
    },
    async execute(args) {
      const cfg = requireEnabled()
      const dryRun = args?.dryRun !== false
      const blocked = new Set(cfg.library.blockedIds)
      const hiddenIds = new Set(cfg.library.hiddenIds)

      // ① 重复：索引按 sha1 建键，理论上不会有；这里防手改/迁移残留
      const bySrc = new Map()
      const duplicates = []
      for (const item of [...library.items]) {
        if (!item.src) continue
        const prev = bySrc.get(item.src)
        if (!prev) { bySrc.set(item.src, item); continue }
        const score = (x) => (x.tags.length || x.note ? 1000 : 0) + x.sentCount * 10 + x.useCount
        const keep = score(prev) >= score(item) ? prev : item
        const drop = keep === prev ? item : prev
        bySrc.set(item.src, keep)
        duplicates.push(drop)
      }
      // ② 无意义：按标签判定（与状态卡/报表同口径）。
      //    阈值只管「整理时自动删」，人工清理不该被卡住 —— 以前 71 张无意义
      //    因为 tagFails 只有 0/1 而永远报 0 张，就是这个口径漂了。
      const meaningless = library.items.filter((item) => item.tags.includes('无意义'))
      // ③ 剔除名单
      const blockedItems = library.items.filter((item) => {
        const sid = shortId(item)
        return blocked.has(sid) || blocked.has(item.src) || hiddenIds.has(sid)
      })
      // ④ 文件丢失
      const missing = []
      for (const item of library.items) {
        if (!item.path) continue
        const { exists } = await fileStat(item.path)
        if (!exists) missing.push(item)
      }

      const victims = [...new Set([...duplicates, ...meaningless, ...blockedItems, ...missing])]
      const freedBytes = victims.reduce((sum, item) => sum + num(item.bytes, 0), 0)
      if (!dryRun) {
        for (const item of victims) await library.removeItem(item)
        await library.pruneOrphanFiles()
        await library.flush()
      }
      const detail = dryRun && victims.length > 0
        ? `要删的是这些：${victims.slice(0, 12).map((item) => `#${shortId(item)}`).join('、')}${victims.length > 12 ? ` 等 ${victims.length} 张` : ''}。确认无误后带 dryRun=false 再调一次。`
        : ''
      return {
        dryRun,
        duplicates: duplicates.length,
        meaningless: meaningless.length,
        blocked: blockedItems.length,
        missing: missing.length,
        freedMB: Number((freedBytes / 1048576).toFixed(1)),
        after: dryRun ? library.items.length : library.items.length,
        detail,
      }
    },
  }))

  // ── 删最早 ─────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.DELETE_OLDEST,
    description: '删掉库里**入库时间最早**的若干张表情包。当群友说「删掉最早的表情」「库里太满了删掉旧的」时用它。'
      + '保护：无论删多少都至少保留「保底留存」张；并且优先删**从没被发过**的旧图，真正常用的不会因为入库早被误删。'
      + '删除不可撤销，想先看会删哪些就传 dryRun=true。',
    parameters: {
      count: { type: 'number', description: '删几张，默认用设置里的值（1~500）。' },
      dryRun: { type: 'boolean', description: 'true = 只报告会删哪些，不真删。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dryRun: { type: 'boolean', required: true },
          deleted: { type: 'number', required: true },
          kept: { type: 'number', required: true },
          freedMB: { type: 'number', required: true },
          ids: { type: 'array', required: true, items: { type: 'string' } },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `删除最早${value?.dryRun ? '（试运行）' : ''}：${value?.deleted ?? 0} 张，库里还剩 ${value?.kept ?? 0} 张`
          + `${value?.freedMB ? `，释放 ${value.freedMB} MB` : ''}。${value?.detail ?? ''}`,
      }],
    },
    async execute(args) {
      const cfg = requireEnabled()
      const dryRun = args?.dryRun === true
      const want = Math.min(500, Math.max(1, num(args?.count, cfg.maintenance.deleteOldestCount)))
      const keep = Math.max(0, cfg.maintenance.deleteOldestKeep)
      const visible = library.visible()
      const candidates = [...visible]
        .sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0))
        .filter((item) => num(item.sentCount, 0) === 0)
        .concat([...visible]
          .sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0))
          .filter((item) => num(item.sentCount, 0) > 0))
      const allow = Math.max(0, library.items.length - keep)
      const victims = candidates.slice(0, Math.min(want, allow))
      const freedBytes = victims.reduce((sum, item) => sum + num(item.bytes, 0), 0)
      if (!dryRun) {
        for (const item of victims) await library.removeItem(item)
        await library.flush()
      }
      const capped = victims.length < want
      return {
        dryRun,
        deleted: victims.length,
        kept: dryRun ? library.items.length : library.items.length,
        freedMB: Number((freedBytes / 1048576).toFixed(1)),
        ids: victims.slice(0, 20).map((item) => shortId(item)),
        detail: capped
          ? `要到 ${want} 张，但保底留存 ${keep} 张 / 库里不够，只处理了 ${victims.length} 张。`
          : (dryRun ? '确认后带 dryRun=false 再调一次。' : ''),
      }
    },
  }))

  // ── 报表 ───────────────────────────────────────────────────────────────
  defs.push(await defineStickerTool({
    name: TOOL.STATS,
    description: '生成一份表情库报表：库有多大、哪些图真能带动群友回应、被发得最多的是哪几张。'
      + '**不花 token、不删不改任何东西**，只是统计。用它验证"发图有没有效果"，也方便向群友汇报。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          report: { type: 'string', required: true },
          total: { type: 'number', required: true },
          visible: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
          collect: {
            type: 'object',
            additionalProperties: true,
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '（没有数据）') }],
    },
    async execute() {
      requireEnabled()
      const report = library.reportText()
      const stats = library.stats()
      return {
        report,
        total: stats.total,
        visible: stats.visible,
        bytes: stats.bytes,
        collect: collector.brief(),
      }
    },
  }))

  return defs
}

/**
 * 调 qq_send_image（qq-guard 提供的工具）把图片发到 QQ。
 *
 * 为什么走嵌套 execute 而不是自己发：DSH 的消息出口在桥接进程里，
 * 宿主侧唯一被支持的发图方式就是调那个工具（它也带着 20s 回执等待）。
 * 我们只负责准备 file 与把失败原因翻译成人话。
 *
 * `subType` 决定 QQ 里呈现形态：1 = 小表情（可长按收藏），0 = 普通大图。
 * 走 `arguments.subType` 一条链路透传到 NapCat 的 image 段（2026-10-26 加）。
 */
async function callSendImage(ctx, exec, fileRef, config) {
  // ⚠️ 必须走 safeService：`ctx.tools` 在真 Cordis 上会抛 without-inject
  const tools = safeService(ctx, 'tools')
  if (!tools || typeof tools.execute !== 'function') {
    return { ok: false, reason: '宿主没有 tools.execute，发不了图（插件装载位置不对？）' }
  }
  const agent = exec?.agent
  if (!agent) return { ok: false, reason: '拿不到当前会话，发不了图' }
  const subType = config?.send?.sendAsSticker === false ? 0 : (config?.send?.subType === 0 ? 0 : 1)
  let result
  try {
    result = await tools.execute({
      callId: `sticker-send-${Date.now().toString(36)}`,
      name: 'qq_send_image',
      arguments: { file: fileRef, subType },
      agent,
      signal: exec.signal ?? AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return { ok: false, reason: `发图调用失败：${error?.message ?? error}` }
  }
  if (result?.isError === true) {
    const message = result?.error?.message
      ?? (Array.isArray(result?.content) ? result.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ') : '')
      ?? '未知原因'
    return { ok: false, reason: `图没有发出去：${message}` }
  }
  const value = result?.value ?? {}
  if (value?.sent === false) return { ok: false, reason: `图没有发出去：${value?.detail ?? '网关没给原因'}` }
  return { ok: true, detail: String(value?.detail ?? `已发到 QQ（${config.send.frequency} 档）`) }
}

/** 本地日期键。 */
function todayOf() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 轻量文件存在检查（cleanup 用）。 */
async function fileStat(file) {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(file)
    return { exists: true, bytes: info.size }
  } catch {
    return { exists: false, bytes: 0 }
  }
}

/** 工具短摘要（给 /state 路由与报表）。 */
export function toolsBrief(defs) {
  return defs.map((def) => ({ name: def.name, description: def.description.slice(0, 80) }))
}

export { candidateLine, interactionReward, MAX_DELETE_PER_RUN, weightedPick }
