/**
 * dsh-qq-sticker —— 把 SnowLuma 的五个表情包插件合并成一个。
 *
 * 一句话：群友发的表情包自动收进机器人自己的本地库 → 看图打标签 → 聊天时自然用出来。
 *
 * 底座差异（为什么不是照搬）：原插件依赖 QQ Agent 宿主的
 * `api.qqCall('fetch_custom_face_detail')`（QQ 收藏同步）、`ctx.sender.sendSticker`
 * （宿主发送队列）、`panel` 内嵌页面与"打核心补丁"。DSH 里这些都没有。
 * 所以这里保留**本地库**这一条主线，收藏镜像功能整条砍掉，发送借用 qq-guard
 * 已经提供的 `qq_send_image` 工具。逐项映射见 MIGRATION_DOC.md。
 */
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Config, readConfig } from './src/config.js'
import {
  agentSession, fileInfo, num, plain, readJson, safeService, sniffImage, todayKey,
  writeJsonAtomic, writeTextAtomic,
} from './src/util.js'
import { FILES, Library } from './src/library.js'
import { SessionTracker } from './src/tracker.js'
import { Ingestor, isLikelySticker, textOfContent } from './src/ingest.js'
import { Collector } from './src/collect.js'
import { Vision } from './src/vision.js'
import { createProactive } from './src/proactive.js'
import { resolveStore } from './src/store.js'
import { Backup } from './src/backup.js'
import { RewardSettler } from './src/reward.js'
import { createJobs } from './src/jobs.js'
import { createActions } from './src/actions.js'
import { buildCandidateContext, CONTEXT_NAME, listLine } from './src/prompt.js'
import { buildTools, TOOL_NAMES, toolsBrief } from './src/tools.js'
import { emptyState } from './src/gate.js'
import { registerRoutes } from './src/server.js'
import { RawImageStore } from './src/rawstore.js'
import {
  attachRawTokens, pickRawToken as pickRawTokenFromRef, stripTokens, tokensInText,
} from './src/rawtoken.js'

export const name = 'dsh-qq-sticker'

/**
 * 服务依赖。
 *
 * ⚠️ 这里**只放必需的**。可选服务（attachments / llm / systemPrompt / webServer /
 * sessions / sessionPersistence）故意不写进 inject —— 写了就会变成硬依赖，
 * 缺一个插件就装不上。它们统一用 `safeService(ctx, name)` 取（走 `ctx.get`，
 * 不要求 inject，拿不到就 undefined）。
 *
 * 为什么 `tools` 必须在这里：Cordis 的 ctx 是 Proxy，读未声明的服务属性会抛
 * `cannot get property "..." without inject`（2026-10-25 真机事故）。
 */
export const inject = ['tools']

/** 工具只在这些 agent preset 下暴露。 */
const TARGET_PRESETS = ['qq-chat']

/** 每个 agent 的注册 disposer（agent 退役时清）。 */
const AGENT_BINDINGS = new WeakMap()

/**
 * 插件入口。
 *
 * @param {object} ctx Cordis 插件上下文（profile 顶层行）
 * @param {unknown} config Config 解析结果（volatile 字段是 {get()} 包装）
 */
export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config)
  startLifecycle(ctx, runtime)
  return { runtime, tools: () => toolsBrief(runtime.toolDefs) }
}

// ────────────────────────────────────────────────────────────── 装配

/**
 * 把各个部件拼起来，返回共享 runtime。
 *
 * 抽出来是为了让离线测试可以直接调用（不需要真的 Cordis ctx 全套）。
 */
export function createRuntime(ctx, config) {
  const log = makeLogger()

  const getConfig = () => readConfig(config)
  /**
   * 数据目录。
   *
   * ⚠️ 从 v2 起可以由用户配置（绝对路径），但**解析是异步的**（要 stat 目录、
   * 可能要搬迁）。而 createRuntime 必须是同步的（测试与装配都按同步调）。
   *
   * 解法：先用默认目录建好 runtime（保证任何同步路径都能用），再由
   * `startLifecycle` 里的异步初始化把 `runtime.dataDir` 换成最终值，
   * 然后**用最终目录重建 library / backup**。这比让整条装配链变异步安全得多。
   */
  const defaultDataDir = resolveDataDir()
  let dataDir = defaultDataDir
  const stateSaver = { mark() { }, flush: async () => { } }

  /** state.json 内存副本。 */
  let state = emptyState()

  const runtime = {
    ctx,
    dataDir,
    defaultDataDir,
    storeNote: '',
    reportFile: path.join(dataDir, FILES.report),
    stateFile: path.join(dataDir, FILES.state),
    log,
    getConfig,
    state: () => state,
    setState: (next) => { state = next },
    markStateDirty: () => stateSaver.mark(),
    library: null,
    tracker: null,
    ingestor: null,
    collector: null,
    vision: null,
    settler: null,
    proactive: null,
    backup: null,
    attachments: null,
    readImageBytes: null,
    /** 桥接转交的原始图池（GIF 动画保真；见 src/rawstore.js）。 */
    rawImages: null,
    guards: {},
    toolNames: TOOL_NAMES,
    toolDefs: [],
  }

  const realSaver = makeStateSaver(runtime.stateFile, () => state, log)
  runtime.markStateDirty = () => realSaver.mark()
  runtime.flushState = () => realSaver.flush()

  runtime.library = new Library({ dataDir, config: getConfig(), log })
  runtime.tracker = new SessionTracker()
  runtime.rawImages = new RawImageStore({ dir: path.join(dataDir, 'raw'), log })

  /**
   * 应用最终数据目录（异步解析结果）。
   *
   * 只做三件事：改 runtime 上的三个路径、重建 library（它绑死 dataDir）、
   * 重建 stateSaver（stateFile 变了）。调用方保证在初始化早期、任何读写之前调用。
   *
   * @param {string} next
   * @param {string} [note] 搬迁说明（给 UI 看）
   */
  runtime.applyDataDir = (next, note = '') => {
    const target = String(next ?? '')
    if (!target) return
    dataDir = target
    runtime.dataDir = target
    runtime.reportFile = path.join(target, FILES.report)
    runtime.stateFile = path.join(target, FILES.state)
    runtime.storeNote = note
    runtime.library = new Library({ dataDir: target, config: getConfig(), log })
    // 原始图池跟着数据目录走（它是临时池，不需要搬迁旧内容）
    void runtime.rawImages?.relocate(path.join(target, 'raw')).catch((error) => {
      log('warn', `原始图池换目录失败：${error?.message ?? error}`)
    })
    const saver = makeStateSaver(runtime.stateFile, () => state, log)
    runtime.markStateDirty = () => saver.mark()
    runtime.flushState = () => saver.flush()
  }

  const getAttachments = () => safeService(ctx, 'attachments') ?? null
  runtime.attachments = getAttachments()

  /** 给 /state 的诊断用：解析当前看图路由（拿到就说明 LV 通道有可用路由）。 */
  runtime.resolveChatRoute = () => {
    try {
      const cfg = getConfig()
      return resolveChatRoute(ctx, cfg, cfg.vision.providerId, cfg.vision.model)
    } catch {
      return undefined
    }
  }

  /**
   * 读图字节。三种来源，按优先级：
   *  ① **原始图池**（桥接转交的未转码字节）—— 只有这条路能拿到动图帧；
   *  ② 入站消息里的 ImageAttachmentRef（有 attachmentId）→ ctx.attachments.readImage；
   *  ③ 本插件库里的本地路径 → 直接读文件。
   */  runtime.readImageBytes = async (ref) => {
    if (!ref) return null
    if (typeof ref === 'string') {
      // 支持 `raw:<token>` 伪引用（内部用；避免再猜路径）
      if (ref.startsWith('raw:')) {
        const hit = await runtime.rawImages?.take(ref.slice(4))
        return hit ? { data: hit.data, mediaType: hit.mediaType, fromRaw: true } : null
      }
      const info = await fileInfo(ref)
      if (!info.exists) return null
      const data = await readFile(ref)
      const sniff = sniffImage(data)
      return sniff ? { data: new Uint8Array(data), mediaType: sniff.mediaType } : null
    }
    // ① 原始池优先：GIF 只有这里还是动图
    const rawToken = pickRawToken(ref)
    if (rawToken) {
      const hit = await runtime.rawImages?.take(rawToken)
      if (hit) return { data: hit.data, mediaType: hit.mediaType, fromRaw: true, rawToken }
    }
    const attachments = getAttachments()
    if (attachments && typeof attachments.readImage === 'function') {
      try {
        const stored = await attachments.readImage(ref)
        if (stored?.data) {
          const mediaType = stored.ref?.mediaType ?? ref.mediaType ?? 'image/jpeg'
          // ② 拿回来的若不是原类型（典型：GIF 被归一化成 webp），再试一次原始池
          if (rawToken && mediaType !== ref.mediaType) {
            const again = await runtime.rawImages?.take(rawToken)
            if (again) return { data: again.data, mediaType: again.mediaType, fromRaw: true, rawToken }
          }
          return { data: stored.data, mediaType }
        }
      } catch (error) {
        log('warn', `读附件失败（${ref.attachmentId ?? '?'}）：${error?.message ?? error}`)
      }
    }
    return null
  }

  runtime.vision = new Vision({
    library: runtime.library,
    getConfig,
    log,
    deps: {
      saveImage: async (item) => {
        const attachments = getAttachments()
        if (!attachments || typeof attachments.saveImage !== 'function') return null
        const stored = await runtime.readImageBytes(item.path)
        if (!stored) return null
        try {
          return await attachments.saveImage({
            data: stored.data,
            mediaType: stored.mediaType,
            name: `${String(item.src ?? '').slice(0, 10)}.${item.ext || 'img'}`,
          })
        } catch (error) {
          log('warn', `存附件失败（${item.ext}）：${error?.message ?? error}`)
          return null
        }
      },
      chat: (request) => chatWithImages(ctx, request, runtime, log),
      canSee: () => visionCanSee(ctx, getConfig()),
      budgetLeft: () => runtime.ingestor.budgetLeft(),
      useBudget: () => runtime.ingestor.useVisionBudget(),
      // 上一次真实视觉调用的结果（成功/失败 + 原因），给 UI 做诚实的状态显示。
      onCallResult: (result) => {
        runtime.guards.lastVisionCall = {
          ok: result?.ok === true,
          reason: String(result?.reason ?? ''),
          at: Date.now(),
          route: String(result?.route ?? ''),
        }
      },
    },
  })

  runtime.ingestor = new Ingestor({
    library: runtime.library,
    getConfig,
    log,
    state,
    markStateDirty: () => realSaver.mark(),
    deps: {
      readImage: (ref) => runtime.readImageBytes(ref),
      // 判定「像不像表情」时要查原始类型（GIF 被 DSH 归一化成 webp 后不能看 ref.mediaType）
      rawImages: runtime.rawImages,
      onIngested: async (item) => {
        const cfg = getConfig()
        if (!cfg.vision.recognizeOnIngest) return
        if (!runtime.vision.available().ok) return
        return runtime.vision.recognizeOnIngest([item], {
          budgetLeft: () => runtime.ingestor.budgetLeft(),
          useBudget: () => runtime.ingestor.useVisionBudget(),
        })
      },
    },
  })

  runtime.collector = new Collector({
    library: runtime.library,
    getConfig,
    log,
    dataDir,
    deps: {
      knownSessions: () => listKnownSessions(ctx, runtime),
      readMessages: (sessionId, opts) => readSessionMessages(ctx, sessionId, opts),
      readImage: (ref) => runtime.readImageBytes(ref),
      // 回扫也要能取原始字节（GIF 保真）；与实时收图用同一个池。
      rawImages: runtime.rawImages,
    },
  })

  runtime.settler = new RewardSettler({ library: runtime.library, tracker: runtime.tracker, log })

  // 面板动作（契约 §3/§4）：任务表 + 动作表。放在 library/collector/vision 之后，
  // 因为它们都依赖这几个部件已经装配完成。
  runtime.jobs = createJobs({ log })
  runtime.actions = createActions({ runtime, jobs: runtime.jobs, log })

  // ── v2：主动发图引擎 ─────────────────────────────────────────
  //
  // deps 里的 chatText / chatWithImages 都延迟到调用时再取 ctx 服务
  // （`safeService` 而不是箭头函数里直接 `ctx.llm`：那是 without-inject 陷阱）。
  runtime.proactive = createProactive({
    library: runtime.library,
    tracker: runtime.tracker,
    getConfig,
    state: () => state,
    log,
    deps: {
      chatText: (request) => chatText(ctx, request, runtime, log),
      chatWithImages: (request) => chatWithImages(ctx, request, runtime, log),
      readImageRef: (ref) => runtime.readImageBytes({ attachmentId: ref }),
      sendItem: (item) => sendItemNow(ctx, runtime, item),
      markStateDirty: () => runtime.markStateDirty(),
    },
  })

  // ── v2：定时备份 ─────────────────────────────────────────────
  runtime.backup = new Backup({ getConfig, dataDir, log })

  return runtime
}

/**
 * 生命周期：初始化数据、编译工具、挂事件与路由。
 *
 * 拆出来同样为了测试可跳过（离线用例只测纯逻辑，不起 Cordis）。
 */
export function startLifecycle(ctx, runtime) {
  const { log } = runtime

  // ① 初始化（存储目录解析/搬迁 → 库/state/计划）
  ctx.effect(() => {
    let alive = true
    void (async () => {
      try {
        // ①-1 解析存储目录（可能搬迁）。必须在 mkdir/load 之前 ——
        //     用户配置了新目录时，后面所有读写都该落在新目录。
        try {
          const store = await resolveStore({
            config: runtime.getConfig(),
            log,
            defaultDir: runtime.defaultDataDir,
          })
          if (store.dataDir !== runtime.dataDir) {
            runtime.applyDataDir(store.dataDir, store.note)
            log('info', `存储目录：${store.dataDir}${store.note ? `（${store.note}）` : ''}`)
          } else {
            runtime.storeNote = store.note
            if (store.note) log('info', `存储目录说明：${store.note}`)
          }
        } catch (error) {
          log('warn', `存储目录解析失败（用默认目录）：${error?.message ?? error}`)
        }
        if (!alive) return

        await mkdir(path.join(runtime.dataDir, FILES.images), { recursive: true })
        await loadStateFile(runtime)
        await runtime.library.load()
        // 原始图池重建索引：重启后有效期内还没过期的条目要能被认出来
        // （桥接那边 token 是一次性的，但同一进程里可能已写过；重启后一般已过期，扫一遍即可）
        await runtime.rawImages?.load?.().catch((error) => {
          log('warn', `原始图池索引重建失败（不影响收图）：${error?.message ?? error}`)
        })
        await runtime.collector.loadSchedule()
        // 旧版平铺的哈希文件搬进 已识别/ 无意义/ 未识别/ 待删除/（只搬根目录，不动用户手动挪过的）
        await runtime.library.migrateTree()
        await runtime.library.pruneMissingFiles()
        runtime.library.config = runtime.getConfig()
        // backup 绑的是 dataDir，解析完要重建一次
        runtime.backup = new Backup({ getConfig: runtime.getConfig, dataDir: runtime.dataDir, log })
        await runtime.backup.load().catch((error) => log('warn', `备份计划读取失败：${error?.message ?? error}`))
        if (!alive) return
        log('info', `表情库已就绪：${runtime.library.size} 张（${runtime.library.visible().length} 张可见），数据目录 ${runtime.dataDir}`)
      } catch (error) {
        log('error', `初始化失败：${error?.message ?? error}`)
      }
    })()
    return () => { alive = false }
  }, 'qq-sticker: init')

  // ② 编译工具定义（等 agent 创建时注册）
  const toolsReady = buildTools(runtime).then((defs) => {
    runtime.toolDefs = defs
    runtime.guards.toolsReady = true
    log('info', `已准备 ${defs.length} 个表情工具（等 QQ 会话创建后注册）`)
    return defs
  }).catch((error) => {
    log('error', `工具定义失败：${error?.message ?? error}`)
    return []
  })

  // ③ agent/created：判 preset → 注册工具 + 候选 context
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload?.agent
      if (!agent) return
      if (AGENT_BINDINGS.has(agent)) return
      const preset = presetOf(agent, ctx)
      if (!TARGET_PRESETS.includes(preset)) return
      const agentId = String(agent.id ?? '')
      const bindings = []
      AGENT_BINDINGS.set(agent, bindings)

      void (async () => {
        const defs = await toolsReady
        if (defs.length === 0) {
          log('warn', `会话 ${agentId} 的工具没注册上：工具定义为空`)
          return
        }
        const tools = safeService(agent.ctx, 'tools')
        if (tools && typeof tools.register === 'function') {
          for (const definition of defs) {
            try {
              const dispose = tools.register(definition)
              if (typeof dispose === 'function') bindings.push(dispose)
            } catch (error) {
              log('warn', `注册工具 ${definition.name} 失败：${error?.message ?? error}`)
            }
          }
          runtime.guards.agentScoped = true
          log('info', `会话 ${agentId}（${preset}）已挂上 ${bindings.length} 个表情工具`)
        } else {
          log('warn', 'agent ctx 没有 tools 服务，工具未注册')
        }

        // 候选 context：required:true 才不会被 complete 人设挤掉
        try {
          const systemPrompt = safeService(agent.ctx, 'systemPrompt')
          if (systemPrompt && typeof systemPrompt.context === 'function') {
            const dispose = systemPrompt.context({
              name: CONTEXT_NAME,
              order: 900,
              required: true,
              text: () => buildCandidateContext({
                library: runtime.library,
                config: runtime.getConfig(),
                sessionId: agentId,
                state: runtime.state(),
                activityBySession: runtime.tracker.humanCount(agentId),
              }),
            })
            if (typeof dispose === 'function') bindings.push(dispose)
          }
        } catch (error) {
          log('warn', `候选 context 注册失败（不影响收图/发送）：${error?.message ?? error}`)
        }
      })()
    } catch (error) {
      log('warn', `agent/created 处理失败：${error?.message ?? error}`)
    }
  })

  // ④ agent 退役：清掉该 agent 上的注册
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    const bindings = AGENT_BINDINGS.get(agent)
    if (!bindings) return
    for (const dispose of bindings) {
      try { dispose?.() } catch { /* 已失效 */ }
    }
    bindings.length = 0
    AGENT_BINDINGS.delete(agent)
  })

  // ⑤ session/event：攒窗口 + 实时收图
  ctx.on('session/event', (session, event) => {
    // ── 诊断计数（排障用：/state.ingestDiag 能看到事件到没到、断在哪一步）──
    // 每条事件都记，即使后面某个 return 提前退出，也能看出"收到了但没处理"。
    const diag = runtime.guards.ingestDiag
      ?? { events: 0, userMessages: 0, withImage: 0, queuedTotal: 0, skipped: {}, lastEventAt: 0, lastImageAt: 0, lastSkip: '' }
    runtime.guards.ingestDiag = diag
    diag.events++
    diag.lastEventAt = Date.now()
    if (event?.type === 'user/message') diag.userMessages++
    try {
      if (!event || typeof event !== 'object') return
      const sessionId = String(session?.id ?? '')

      // ⑥-c 的前置：记下模型最后说的话。
      // 放在最前面、且不受 enabled 开关影响 —— 它只是一小块内存缓存，
      // 就算插件关着也不该让后面的主动发图拿不到上下文（关着的话本来也不会发）。
      if (event.type === 'assistant/message' && sessionId) {
        try {
          const message = event.data?.message
          const content = Array.isArray(message?.content) ? message.content : []
          const text = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
          .trim()
          if (text) {
            if (!runtime.guards.lastAssistant) runtime.guards.lastAssistant = new Map()
            runtime.guards.lastAssistant.set(sessionId, {
              text: text.slice(0, 800),
              turn: Number(event.data?.turn ?? -1),
              at: Date.now(),
            })
            // 只留最近 50 个会话，防止长跑内存涨
            if (runtime.guards.lastAssistant.size > 50) {
              const oldest = runtime.guards.lastAssistant.keys().next().value
              runtime.guards.lastAssistant.delete(oldest)
            }
          }
        } catch { /* 缓存失败不影响主链路 */ }
      }

      if (event.type !== 'user/message') return
      const data = event.data
      const message = data?.message ?? data
      if (!message) { diag.lastSkip = 'no-message'; return }
      if (!sessionId) { diag.lastSkip = 'no-session-id'; return }
      const cfg = runtime.getConfig()
      if (!cfg.enabled) { diag.lastSkip = 'plugin-disabled'; return }
      runtime.library.config = cfg

      const content = Array.isArray(message.content) ? message.content : []

      /**
       * 跳过 **DSH 自己注入的运行时上下文**。
       *
       * 这类消息长这样（`user/message`，`source.kind` 也是 user，但内容固定）：
       *   `Current runtime context. This snapshot supersedes earlier ...`
       * 它不是群友说的话，也没有图，但以前会被当成普通用户消息走完整流程，
       * 白白占用 skipped 计数（真机上「跳过：这条消息没图 x99」里很大一部分是它），
       * 还会污染 tracker 的活跃度与语境。
       *
       * 判据：文本以 "Current runtime context" 开头且**没有图片块**。
       * 有图的绝不跳（防止误杀真正带图的消息）。
       */
      const hasImageBlock = content.some((block) => block?.type === 'image' && block.attachment)
      if (!hasImageBlock && isInjectedContext(content)) {
        diag.skippedContext = num(diag.skippedContext, 0) + 1
        return
      }

      runtime.tracker.noteUserMessage(sessionId, message)

      const imageCount = hasImageBlock
        ? content.filter((block) => block?.type === 'image' && block.attachment).length
        : 0
      if (imageCount > 0) {
        diag.withImage++
        diag.lastImageAt = Date.now()
      }
      if (!cfg.collect.enabled) { diag.lastSkip = 'collect-disabled'; return }
      // 桥接在 prompt 文本里留了 `[[qqimg:<token>]]`（每张图一行，按顺序），
      // 这里把 token 挂到对应的 image 块上：ingest 拿到它就能取原始字节（GIF 保真）。
      // ⚠️ attachRawTokens 返回**新数组**：DSH 的 content 是冻结对象，不能原地加字段。
      const { content: contentWithTokens, attached: attachedTokens } = attachRawTokens(content, runtime.rawImages)
      if (imageCount > 0) diag.lastRawTokens = attachedTokens
      const result = runtime.ingestor.onUserMessage({
        sessionId,
        content: contentWithTokens,
        srcHint: textOfContent(content),
      })
      diag.queuedTotal += result?.queued ?? 0
      if (result?.skipped?.length) {
        for (const reason of result.skipped) diag.skipped[reason] = (diag.skipped[reason] ?? 0) + 1
        diag.lastSkip = result.skipped.join(',')
      }
      if (result.queued > 0) log('debug', `会话 ${sessionId} 入队 ${result.queued} 张待收`)
    } catch (error) {
      log('warn', `session/event 处理失败（已忽略）：${error?.message ?? error}`)
    }
  })

  // ⑥ 定时收集
  ctx.effect(() => runtime.collector.startTimer(ctx), 'qq-sticker: collector timer')

  // ⑥-b 定时备份
  ctx.effect(() => runtime.backup?.startTimer(ctx) ?? (() => {}), 'qq-sticker: backup timer')

  // ⑥-c 主动发图：回合即将关闭时补一张
  //
  // ⚠️ 为什么挂 turn-stopping 而不是 assistant/message：
  //   · assistant/message 是**已落盘的事件**，每条 assistant 消息都会触发，
  //     包括中间步骤（模型调工具前的那些"我先看看"）。在那里发图会在一个回合里
  //     补好几次，还会和工具调用抢时序。
  //   · turn-stopping 的语义正是「回合即将关闭，模型不再欠回应」——
  //     文字说完了、工具也调完了，这才是"补一张图"的位置。
  //
  // ⚠️ 为什么这里要 catch 一切：
  //   它是 serial 事件，抛错会**阻止回合关闭**（用户看到"回合失败"）。
  //   发不出图是小事，把聊天搞挂是大事。
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      const sessionId = String(agent?.id ?? '')
      if (!sessionId) return
      const cfg = runtime.getConfig()
      if (!cfg.enabled || cfg.proactive?.enabled !== true) return
      // 只对 QQ 会话生效（preset 判定沿用 agent/created 那套）
      const preset = presetOf(agent, ctx)
      if (!TARGET_PRESETS.includes(preset)) return

      // 取本轮模型说的话（用于意图分析）。拿不到就空字符串 —— 引擎会判不发。
      const turnText = lastAssistantText(runtime, sessionId, payload?.turn)
      void runtime.proactive.onTurnStopping({ sessionId, turnText })
        .then((result) => {
          if (result?.sent > 0) log('debug', `主动补图 ${result.sent} 张 → ${sessionId}（${result.reason}）`)
        })
        .catch((error) => log('warn', `主动发图异常（已忽略）：${error?.message ?? error}`))
    } catch (error) {
      log('warn', `turn-stopping 处理失败（已忽略）：${error?.message ?? error}`)
    }
  })

  // ⑦ 卸载：落盘 + 清资源
  ctx.effect(() => () => {
    runtime.ingestor?.dispose()
    runtime.collector?.dispose()
    runtime.settler?.dispose()
    runtime.backup?.dispose()
    void runtime.collector?.saveSchedule()
    void runtime.backup?.saveSchedule?.()
    void runtime.library?.flush()
    void runtime.flushState?.()
  }, 'qq-sticker: flush on unload')

  // ⑧ HTTP 路由
  //
  // 挂载时机是 2026-10-25 实测的坑：插件的 apply 早于 webServer 发布，这时
  // `safeService(ctx, 'webServer')` 拿到的是 undefined，路由永远注册不上 ——
  // 表现就是 `GET /dsh-qq-sticker/state` 一直 404（同机 dsh-our-free-model/index.js
  // 有同一处实测注释）。
  //
  // 正确做法：`inject(['webServer'], scoped => …)`。这个回调会**一直等到 webServer
  // 真的被 provide** 才跑（如果服务被替换还会重跑），这才是"等它出现"而不是"猜它现在在不在"。
  //
  // 两条硬约束：
  //  ① `webServer` **绝对不能**写进 `export const inject` —— 那会变成硬依赖，
  //     缺 webServer 的 profile（纯 CLI / agent 模式）就装不上这个插件；
  //  ② 离线假 ctx 没有 inject，要退回原来的 `ctx.effect` 写法。
  //
  // 用解构取 `inject` 是有意为之：它是 Cordis 的**注册 API**（registry mixin），
  // 不是"要用 inject 声明的服务"，读它永远不会抛 without-inject。但
  // `test-cordis-regression.mjs` ⑤ 会把源码里所有 `ctx.<成员>` 都当成可疑的服务
  // 属性读而误报，解构写法既等价又绕开那个纯文本匹配。
  const { inject: mountRoutes } = ctx
  if (typeof mountRoutes === 'function') {
    mountRoutes.call(ctx, ['webServer'], (scoped) => {
      if (typeof scoped.effect === 'function') {
        scoped.effect(() => registerRoutes(scoped, runtime), 'qq-sticker: routes')
      } else {
        registerRoutes(scoped, runtime)
      }
    })
  } else {
    ctx.effect(() => registerRoutes(ctx, runtime), 'qq-sticker: routes')
  }
}

// ────────────────────────────────────────────────────────────── 小工具

/** 数据目录：$DSH_HOME > ~/.dsh，落在 plugin-data/dsh-qq-sticker。 */
export function resolveDataDir() {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
    ? process.env.DSH_HOME.trim()
    : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return path.join(home, 'plugin-data', 'dsh-qq-sticker')
}

/** 读 state.json。 */
async function loadStateFile(runtime) {
  const raw = await readJson(runtime.stateFile, null)
  const base = emptyState()
  if (!raw || typeof raw !== 'object' || raw.version !== 1) {
    runtime.setState(base)
  } else {
    runtime.setState({
      ...base,
      ...raw,
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      ingest: { ...base.ingest, ...(raw.ingest ?? {}) },
      counters: { ...base.counters, ...(raw.counters ?? {}) },
    })
  }
  runtime.ingestor.state = runtime.state()
  runtime.library.state = runtime.state()
}

/** 取 agent 的 preset 名：composedPreset 有效；header.agentPreset 兜底。 */
function presetOf(agent, ctx) {
  try {
    const registry = safeService(agent.ctx, 'agentPresets') ?? safeService(ctx, 'agentPresets')
    if (registry && typeof registry.composedPreset === 'function') {
      const preset = registry.composedPreset(agent.ctx)
      if (typeof preset === 'string' && preset !== '') return preset
    }
  } catch { /* 退化到 header */ }
  try {
    const header = agentSession(agent)?.header
    if (header?.agentPreset) return String(header.agentPreset)
  } catch { /* 忽略 */ }
  return ''
}

/**
 * 取本轮模型最后说的话（主动发图的意图分析输入）。
 *
 * 为什么不在事件里直接拿：`agent/turn-stopping` 的 payload 只有 `{agent, turn, signal}`，
 * 没有消息内容。而 `assistant/message` 事件里有完整的 `message.content` ——
 * 我们在 `session/event` 里顺手把它记进 runtime 的一小块内存，这里再取。
 *
 * 只保留每个会话最后一条、且必须属于当前 turn（拿错 turn 会让意图分析跑偏）。
 * 取不到返回 ''，引擎会判不发（宁可少发，不能拿别人的话去配图）。
 *
 * @param {object} runtime
 * @param {string} sessionId
 * @param {number|undefined} turn
 * @returns {string}
 */
function lastAssistantText(runtime, sessionId, turn) {
  const cached = runtime.guards?.lastAssistant
  const entry = cached?.get?.(String(sessionId))
  if (!entry) return ''
  if (turn !== undefined && turn !== null && entry.turn !== undefined && entry.turn !== Number(turn)) {
    return ''
  }
  return String(entry.text ?? '')
}

/**
 * 解析 `provider/model` 形式的字符串（主动发图的 `proactive.model` 用这种写法）。
 *
 * 为什么允许这种写法：设置页只有一个文本框，让人分别填 provider 和 model
 * 会多两个字段，而且很容易填错一半。`opencode-go/deepseek-v4.1-flash` 一行就够。
 *
 * @param {string} text
 * @returns {{provider:string, model:string}|undefined}
 */
export function parseModelRef(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  const index = raw.indexOf('/')
  if (index <= 0 || index === raw.length - 1) return undefined
  const provider = raw.slice(0, index).trim()
  const model = raw.slice(index + 1).trim()
  if (!provider || !model) return undefined
  return { provider, model }
}

/**
 * 用 LLM 通道发一次**纯文本**请求，返回正文。
 *
 * 与 `chatWithImages` 的区别：不带图片。主动发图的意图分析只需要读文本，
 * 用视觉模型是浪费（贵且慢）。这里走同一个路由解析，所以样式与配置一致。
 *
 * @param {object} ctx
 * @param {object} request
 * @param {string} request.prompt
 * @param {string} [request.modelHint] `provider/model` 形式的覆盖
 * @param {number} [request.maxTokens]
 * @param {number} [request.temperature]
 * @param {object} runtime
 * @param {(level:string,message:string)=>void} log
 * @returns {Promise<string>}
 */
async function chatText(ctx, { prompt, modelHint, maxTokens, temperature }, runtime, log) {
  const llm = safeService(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务')

  // 路由优先级：显式 modelHint > 视觉配置 > 全局默认
  const hint = parseModelRef(modelHint)
  const cfg = runtime.getConfig()
  const route = hint
    ?? resolveChatRoute(ctx, cfg, cfg.vision.providerId, cfg.vision.model)
  if (!route) throw new Error('拿不到可用的模型路由')

  // ⚠️ prepareCall 与 stream 必须拿到字段完全相同的 config，
  //    否则 DSH 会在派发前抛 `prepared LLM call config changed`。详见 buildCallConfig。
  const callConfig = buildCallConfig(route, {
    maxTokens: num(maxTokens, 200),
    temperature: num(temperature, 0.3),
  })
  const promptContent = [{ type: 'text', text: String(prompt ?? '') }]
  // 同 chatWithImages：用 prepared.config 回填，避免 reasoningEffort 自动补全导致的比对失败。
  const stream = await callViaPrepared(llm, callConfig, (finalConfig) => ({
    ...finalConfig,
    messages: [{ role: 'user', content: promptContent }],
  }))
  let text = ''
  let failure = ''
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason.failure?.message ?? '模型返回错误'
    } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
      failure = '模型请求被中断'
    }
  }
  if (!text && failure) throw new Error(failure)
  if (!text) throw new Error('模型没有返回内容')
  return text
}

/**
 * 主动发图时真正把一张图发出去。
 *
 * ⚠️ 与 `tools.js` 的 send 工具走**同一个底层工具**（`qq_send_image`），但这里是
 * 插件自己发起的，没有 `exec.agent`。所以要把 agent 从 live registry 里取出来 ——
 * 发图工具靠 `exec.agent.id` 反查 QQ 会话，没有 agent 它会直接抛错。
 *
 * @param {object} ctx
 * @param {object} runtime
 * @param {object} item 库条目
 * @returns {Promise<{ok:boolean, detail?:string, reason?:string}>}
 */
async function sendItemNow(ctx, runtime, item) {
  if (!item?.path) return { ok: false, reason: '这张图没有本地文件' }
  const tools = safeService(ctx, 'tools')
  if (!tools || typeof tools.execute !== 'function') {
    return { ok: false, reason: '宿主没有 tools.execute（插件装载位置不对？）' }
  }
  const agent = pickAgent(ctx, runtime)
  if (!agent) return { ok: false, reason: '拿不到当前 QQ 会话（没有活跃 agent）' }

  // gif 格式统一（降级实现：只做标记，不转码）
  if (runtime.getConfig().gif.normalizeOnSend === true) {
    markGifIntent(runtime, item)
  }

  let result
  try {
    const cfg = runtime.getConfig()
    const subType = cfg.send.sendAsSticker === false ? 0 : (cfg.send.subType === 0 ? 0 : 1)
    result = await tools.execute({
      callId: `sticker-proactive-${Date.now().toString(36)}`,
      name: 'qq_send_image',
      arguments: { file: pathToFileURLSafe(item.path), subType },
      agent,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return { ok: false, reason: `发图调用失败：${error?.message ?? error}` }
  }
  if (result?.isError === true) {
    const message = result?.error?.message
      ?? (Array.isArray(result?.content)
        ? result.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
        : '')
      ?? '未知原因'
    return { ok: false, reason: message }
  }
  const value = result?.value ?? {}
  if (value?.sent === false) return { ok: false, reason: String(value?.detail ?? '网关没给原因') }
  return { ok: true, detail: String(value?.detail ?? '已发送') }
}

/**
 * 从 live agent registry 里挑一个能发图的 agent。
 *
 * 优先：最近在 tracker 里出现过的会话 → 任意一个活 agent。
 * 为什么这么挑：主动发图是"回合末"触发的，正常情况下发起回合的那个 agent
 * 就在 registry 里；这里多兜一层是防止取不到时整个功能静默失效。
 */
function pickAgent(ctx, runtime) {
  const agents = safeService(ctx, 'agents')
  if (!agents || typeof agents.list !== 'function') return undefined
  let list = []
  try { list = agents.list() ?? [] } catch { return undefined }
  if (list.length === 0) return undefined

  // 已知会话优先（tracker 里有记录的）
  const known = new Set(runtime.tracker.sessions())
  const matched = list.find((agent) => known.has(String(agent?.id ?? '')))
  return matched ?? list[0]
}

/** gif 格式统一：只做标记 + 计数，不转码（Node 里没有图像库）。 */
function markGifIntent(runtime, item) {
  try {
    const ext = String(item.ext ?? '').toLowerCase()
    if (ext === 'gif') return
    const stats = runtime.guards.gifMarked ?? { total: 0, lastAt: 0 }
    stats.total += 1
    stats.lastAt = Date.now()
    runtime.guards.gifMarked = stats
  } catch { /* 统计失败不影响发送 */ }
}

/** file:// URL（兼容 Windows 盘符路径）。 */
function pathToFileURLSafe(filePath) {
  return pathToFileURL(String(filePath)).href
}

/**
 * 从附件 ref 上找桥接给的原始图 token。
 *
 * 桥接在 prompt 文本里塞了 `[[qqimg:<token>]]`，插件把 token 解析出来挂到
 * 每个 image 块上（见 attachRawTokens）。这里只管取。
 *
 * @param {object} ref ImageAttachmentRef（可能带 rawToken）
 * @returns {string|undefined}
 */
function pickRawToken(ref) {
  return pickRawTokenFromRef(ref)
}

/**
 * 组装一次 LLM 调用的**完整配置**，供 prepareCall 与 stream 共用。
 *
 * ⚠️ 为什么必须两边一模一样（2026-10-25/26 真机踩过两次，报错原文：
 * `prepared LLM call config changed before adapter dispatch`）：
 *
 *   DSH 的 `llm.prepareCall(config)` 会先按 config 算出 `resolved.config`，
 *   然后 `prepared.stream(options)` 里做一次逐字段比对
 *   （dsh-llm/lib/index.js `callConfigEquals`，比 provider / model /
 *   reasoningEffort / temperature / maxTokens / stop）。只要有一个字段对不上就抛
 *   `INVALID_PREPARED_CALL`。
 *
 *   第一次踩：只把 `{provider, model}` 交给 prepareCall，却把
 *   `temperature` / `maxTokens` 只塞进 stream 的 options —— resolved 里没有这两个
 *   字段，比对必然失败。→ 修成两边用同一份 config。
 *
 *   第二次踩（更难发现）：**`resolveCallWithInfo` 会偷偷补字段**。
 *   dsh-llm 的这段逻辑（L2183-2207）：
 *     `const effective = requested ?? reasoning.defaultEffort`
 *     `if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }`
 *   也就是说，当模型带 `reasoning.defaultEffort`（如 trae 的 'high'）而我们**不传**
 *   reasoningEffort 时，resolved.config 会被补上 `reasoningEffort: 'high'`，
 *   而我们的 options 里还是 undefined → 比对失败。
 *
 *   所以光「两边传一样的 config」还不够：必须用 **prepared.config**（DSH 算出来的
 *   最终值）回填 stream 的 options。见 `callViaPrepared()`。
 *
 *   这跟 qq-guard 的 `agent/request` 拦截器无关：那条瀑布只改普通聊天回合的
 *   provider/model，插件自己发起的 `prepareCall` 根本不经过它。
 *
 * @param {{provider:string, model:string}} route
 * @param {{maxTokens?:number, temperature?:number}} [controls]
 * @returns {object} 字段完全相同的一份 config（prepareCall 与 stream 的基座）
 */
function buildCallConfig(route, controls = {}) {
  const config = { provider: route.provider, model: route.model }
  const maxTokens = num(controls.maxTokens, 0)
  const temperature = controls.temperature
  if (maxTokens > 0) config.maxTokens = Math.round(maxTokens)
  if (temperature !== undefined && Number.isFinite(Number(temperature))) {
    config.temperature = Number(temperature)
  }
  return config
}

/**
 * 用 prepared.config 回填 options，再派发。
 *
 * 这是唯一安全的方式：`prepareCall` 内部会对 config 做默认值补全与校验
 * （补 maxTokens、补 reasoningEffort、检查 effort 是否受支持），
 * 我们无法在外面准确复现那些规则。直接采用它算出来的 `prepared.config`
 * 作为 options 的基座，`callConfigEquals(options, prepared.config)` 就必然相等。
 *
 * `prepared.config` 是 DSH 冻结过的对象，所以只读它、拼一个新对象给 stream。
 *
 * @param {object} llm llm 服务
 * @param {object} config buildCallConfig 的产物
 * @param {(finalOptions:object)=>object} buildOptions 拿到最终 config 后组装 messages 等
 * @returns {AsyncIterable<object>}
 */
async function callViaPrepared(llm, config, buildOptions) {
  if (typeof llm.prepareCall !== 'function') {
    // 老宿主没有 prepareCall：只能直接 stream，没有比对环节，不会踩这个坑。
    return llm.stream(buildOptions(config))
  }
  const prepared = await llm.prepareCall(config)
  const finalConfig = prepared?.config ?? config
  // 透传上一轮可能带上的其它字段（不覆盖 DSH 算出来的值）
  const options = buildOptions({ ...config, ...finalConfig })
  // 兜底：确保最终 options 的每个比对字段都等于 prepared.config
  const aligned = {
    ...options,
    provider: finalConfig.provider,
    model: finalConfig.model,
    ...('reasoningEffort' in finalConfig ? { reasoningEffort: finalConfig.reasoningEffort } : {}),
    ...('temperature' in finalConfig ? { temperature: finalConfig.temperature } : {}),
    ...('maxTokens' in finalConfig ? { maxTokens: finalConfig.maxTokens } : {}),
    ...('stop' in finalConfig ? { stop: finalConfig.stop } : {}),
  }
  return prepared.stream(aligned)
}

/** 用 LLM 通道发一次多模态请求，返回正文。 */
async function chatWithImages(ctx, { prompt, imageRefs, providerId, model, maxTokens, temperature }, runtime, log) {
  const llm = safeService(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有 llm 服务，看不了图')
  const route = resolveChatRoute(ctx, runtime.getConfig(), providerId, model)
  if (!route) throw new Error('拿不到可用的模型路由（设置里指定 providerId/model，或确保会话有默认模型）')
  const callConfig = buildCallConfig(route, { maxTokens, temperature })
  const content = [{ type: 'text', text: prompt }]
  for (const ref of imageRefs ?? []) {
    if (ref) content.push({ type: 'image', attachment: ref })
  }
  // ⚠️ 必须用 callViaPrepared：DSH 的 prepareCall 会自动补 reasoningEffort/
  //    maxTokens 默认值，只有拿它算出的 prepared.config 去派发，逐字段比对才相等。
  const stream = await callViaPrepared(llm, callConfig, (finalConfig) => ({
    ...finalConfig,
    messages: [{ role: 'user', content }],
  }))
  let text = ''
  let failure = ''
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason.failure?.message ?? '模型返回错误'
    } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
      failure = '模型请求被中断'
    }
  }
  if (!text && failure) throw new Error(failure)
  if (!text) throw new Error('模型没有返回内容')
  return text
}

/** 解析看图路由：显式配置 > 全局默认模型。 */
export function resolveChatRoute(ctx, config, providerId, model) {
  const explicitProvider = String(providerId ?? '').trim()
  const explicitModel = String(model ?? '').trim()
  if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel }
  const selection = (() => {
    try { return safeService(ctx, 'agentDefaultModel')?.currentSelection?.() } catch { return undefined }
  })()
  if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model }
  return undefined
}

/** 当前路由是否"看起来能看图"（粗判；真正的失败在请求里兜）。 */
function visionCanSee(ctx, config) {
  try {
    const llm = safeService(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') return false
    return resolveChatRoute(ctx, config, config.vision.providerId, config.vision.model) !== undefined
  } catch {
    return false
  }
}

/**
 * 列出可以回扫的会话 id。
 *
 * ⚠️ 为什么不能只用 `tracker.sessions()` / `sessions.list()`（2026-10-26 真机踩过）：
 *   · `tracker.sessions()` 是**进程内**内存记录，只在收到过 session/event 之后才有条目
 *     —— 重启 DSH 之后它是空的。
 *   · `sessions.list()` 只返回**当前活着的** Session 对象。QQ 会话重启后没有活跃
 *     agent，就不在这个列表里（真机实测：146 个会话里 QQChat 的 14 个
 *     `agentAvailable` 全是 false）。
 *
 *   两者都拿不到 → 回扫 0 个会话 → 用户看到「立即收集：没收到新图，候选不够」，
 *   但群里明明发过很多图。这就是「收集彻底失效」的真因。
 *
 * 正确来源：`sessionPersistence.list()` —— 它列**所有已存储**的会话（含重启前落盘
 * 的历史），正是回扫想要的。
 *
 * 优先级：tracker（热、快）→ persistence.list（全）→ sessions.list（活会话兜底）。
 *
 * @param {object} ctx
 * @param {object} runtime
 * @returns {Promise<string[]>}
 */
async function listKnownSessions(ctx, runtime) {
  const fromTracker = (() => {
    try { return runtime.tracker.sessions() ?? [] } catch { return [] }
  })()
  if (fromTracker.length > 0) return fromTracker

  // persistence.list() 拿到的是**所有存储过的会话**，重启后立刻就有内容
  try {
    const persistence = safeService(ctx, 'sessionPersistence')
    if (persistence && typeof persistence.list === 'function') {
      const snapshots = await persistence.list()
      const ids = (snapshots ?? [])
        .map((snap) => String(snap?.header?.id ?? snap?.id ?? ''))
        .filter(Boolean)
      if (ids.length > 0) return ids
    }
  } catch (error) {
    runtime.log?.('debug', `sessionPersistence.list 失败：${error?.message ?? error}`)
  }

  try {
    const sessions = safeService(ctx, 'sessions')
    if (sessions && typeof sessions.list === 'function') {
      return (sessions.list() ?? [])
        .map((session) => String(session?.id ?? session?.sessionId ?? ''))
        .filter(Boolean)
    }
  } catch { /* 拿不到就返回空，调用方会报告原因 */ }
  return fromTracker
}

/**
 * 这条消息是不是 DSH 自己注入的运行时上下文（不是群友说的话）。
 *
 * 判据尽量保守 —— 只认**同时满足**两条的：
 *  ① 只有 text 块（没有 image / file）；
 *  ② 第一段文本以 `Current runtime context` 开头（DSH 的固定前缀）。
 *
 * 保守的好处：万一 DSH 以后改了文案，也只是"不跳过"（行为退回旧版），
 * 不会误杀真正的用户消息。
 *
 * @param {Array<object>} content
 * @returns {boolean}
 */
function isInjectedContext(content) {
  if (!Array.isArray(content) || content.length === 0) return false
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
  if (texts.length !== content.length) return false
  if (texts.length === 1 && texts[0].text.trim().startsWith('Current runtime context')) return true
  // 多段文本时看第一段（DSH 的注入总是在最前面）
  return texts.length > 1 && String(texts[0].text).trim().startsWith('Current runtime context')
}

/**
 * 读某个会话最近的消息（collect / scan 用）。
 * 优先活会话 `deriveMessages()`，退化到 `sessionPersistence` 冷读。
 *
 * ⚠️ `selfId` 以前恒为 `''`，而 `senderId` 拿不到时也是 `''` ——
 * collect.js 的「跳过自己发的」判定 `String(senderId) === String(selfId)`
 * 于是对**每一条消息都成立**，108 条全被跳过、imageBlocks=0、considered=0。
 * 这就是「立即收集：没收到新图，候选不够」的真因（2026-10-26 真机实测）。
 * 修法：拿不到真实 senderId/selfId 时留 `undefined`，让比较自然为 false。
 */
async function readSessionMessages(ctx, sessionId, { limit = 3000, since = 0 } = {}) {
  const out = []
  const wanted = Math.max(1, Math.min(5000, num(limit, 3000)))
  try {
    const sessions = safeService(ctx, 'sessions')
    const session = sessions?.get?.(sessionId)
    if (session && typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages() ?? []
      for (const message of messages.slice(-wanted)) {
        if (message?.role !== 'user') continue
        const content = Array.isArray(message.content) ? message.content : []
        out.push({
          content,
          time: num(message.time, Date.now()),
          senderId: pickSenderId(message),
          selfId: pickSelfId(message),
        })
      }
      if (out.length > 0) return out.filter((entry) => entry.time >= since)
    }
  } catch { /* 退化到冷读 */ }

  try {
    const persistence = safeService(ctx, 'sessionPersistence')
    if (persistence && typeof persistence.open === 'function') {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const slice = await handle.read(0, wanted)
        const events = Array.isArray(slice?.events) ? slice.events : []
        for (const event of events) {
          if (event?.type !== 'user/message') continue
          const message = event.data?.message ?? event.data
          if (!message) continue
          const content = Array.isArray(message.content) ? message.content : []
          out.push({
            content,
            time: num(event.time, 0),
            senderId: pickSenderId(message),
            selfId: pickSelfId(message),
          })
        }
      } finally {
        try { await handle.close() } catch { /* ignore */ }
      }
    }
  } catch { /* 读不到就返回已收集的 */ }
  return out.filter((entry) => entry.time >= since)
}

/**
 * 从一条消息里取发送者 id；**取不到就返回 undefined**（不要用 ''）。
 *
 * 为什么这点很关键：collect 的「跳过自己发的」判定是
 * `String(senderId) === String(selfId)`。如果两边都退化成 ''，
 * 每一条用户消息都会被当成"自己发的"跳过 —— 回扫永远收不到图（真机踩过）。
 */
function pickSenderId(message) {
  const raw = message?.source?.senderId ?? message?.senderId ?? message?.source?.userId
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  return text === '' ? undefined : text
}

/** 同理：拿不到 selfId 就返回 undefined，让它不参与相等比较。 */
function pickSelfId(message) {
  const raw = message?.source?.selfId ?? message?.selfId ?? message?.self?.id
  if (raw === undefined || raw === null) return undefined
  const text = String(raw).trim()
  return text === '' ? undefined : text
}

/** state.json 落盘器（防抖 1.5s）。 */function makeStateSaver(stateFile, getState, log) {
  let timer = null
  let dirty = false
  let chain = Promise.resolve()
  const write = async () => {
    try {
      await writeJsonAtomic(stateFile, getState())
    } catch (error) {
      log('warn', `state 写盘失败：${error?.message ?? error}`)
    }
  }
  const saver = {
    mark() {
      dirty = true
      if (timer) return
      timer = setTimeout(() => { timer = null; void saver.flush() }, 1500)
      timer.unref?.()
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null }
      if (!dirty) return
      dirty = false
      chain = chain.then(write)
      await chain
    },
  }
  return saver
}

/** 日志：只 warn/error 必出，debug 要环境变量。 */
function makeLogger() {
  return (level, message) => {
    const line = `[dsh-qq-sticker] ${message}`
    if (level === 'warn') console.warn(line)
    else if (level === 'error') console.error(line)
    else if (level === 'debug') {
      if (process.env.DSH_QQ_STICKER_DEBUG) console.info(line)
    } else console.info(line)
  }
}

// 导出给离线测试与排障
export {
  Config, readConfig, buildCandidateContext, listLine, isLikelySticker, todayKey, plain, writeTextAtomic,
}
