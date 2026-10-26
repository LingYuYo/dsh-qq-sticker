/**
 * HTTP 路由：面板（client.js）与外部脚本的唯一数据源。
 *
 * 路由表（契约 `sticker-ui-contract.md` §1/§2/§4/§5）：
 *   GET  /dsh-qq-sticker/state   只读状态 + limits/dataDir/jobs
 *   GET  /dsh-qq-sticker/report  只读报表（原有，保留）
 *   GET  /dsh-qq-sticker/config  兜底只读配置
 *   POST /dsh-qq-sticker/config  兜底写配置（settings 服务不可用就 501）
 *   POST /dsh-qq-sticker/action  { kind, args } → 启动任务
 *
 * 安全约定（§4 规则）：
 *   · 写路由：`sec-fetch-site` 只放行 same-origin / none（缺头也放行，桥接/脚本没这个头）；
 *   · 写路由：请求体上限 64KB、JSON 解析失败 → 400、任何异常 → 500 `{ok:false,reason}`；
 *   · 所有响应：`cache-control: no-store`、`content-type: application/json; charset=utf-8`。
 *
 * 为什么只读路由的 register 闭包不复用到写路由：那个闭包把非 GET/HEAD 一律 405，
 * 写路由需要自己的方法判断（405 只对"方法不对"的写路由生效）。
 */
import pathUtil from 'node:path'
import { mkdir as fsMkdir, stat as fsStat } from 'node:fs/promises'
import { num, safeService } from './util.js'

/** 路由前缀（改这里要同步 README）。 */
export const ROUTE_PREFIX = '/dsh-qq-sticker'

/** 写路由的请求体上限：动作参数都是小 JSON，64KB 足够，且能挡住拿大 body 拖死 Host。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 原始图片上传上限。
 * 单张硬顶 12MB（与 library.maxItemMB 的硬顶一致），base64 膨胀约 1.34 倍，
 * 再留一点 JSON 包装的余量 → 18MB。
 */
const MAX_RAW_IMAGE_BYTES = 18 * 1024 * 1024

/**
 * 注册路由。
 *
 * @param {object} ctx DSH 插件 ctx（may be the `inject(['webServer'])` scoped ctx）
 * @param {object} runtime
 * @returns {() => void} 注销函数
 */
export function registerRoutes(ctx, runtime) {
  const webServer = safeService(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    runtime.log('info', '没有 webServer，状态路由未注册（不影响工具与收图）')
    return () => {}
  }
  const disposers = []
  const mount = (path, handler, label) => {
    const run = () => webServer.register({ kind: 'exact', path, handler })
    disposers.push(typeof ctx.effect === 'function' ? ctx.effect(run, label) : run())
  }

  /** 只读路由：只接受 GET/HEAD（原有行为，别改）。 */
  const registerRead = (path, handler, label) => {
    mount(path, (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, reason: 'method not allowed' })
        return
      }
      // 把 promise 返回出去：webServer 不在乎，但测试与排障需要能 await 到响应写完。
      return Promise.resolve(handler(req, res)).catch((error) => {
        if (!res.writableEnded) sendJson(res, 500, { ok: false, reason: errorText(error) })
      })
    }, label)
  }

  // ── GET /state：原有字段全部保留，只新增 limits / dataDir / jobs ──────────
  registerRead(`${ROUTE_PREFIX}/state`, (req, res) => {
    const cfg = runtime.getConfig()
    const stats = runtime.library.stats()
    sendJson(res, 200, {
      ok: true,
      enabled: cfg.enabled,
      library: {
        total: stats.total,
        visible: stats.visible,
        hidden: stats.hidden,
        tagged: stats.tagged,
        untagged: stats.untagged,
        animated: stats.animated,
        meaningless: stats.meaningless,
        bytes: stats.bytes,
        freedMB: Number((stats.bytes / 1048576).toFixed(1)),
      },
      limits: {
        maxCount: num(cfg.library?.maxCount, 500),
        maxTotalMB: num(cfg.library?.maxTotalMB, 200),
        maxItemMB: num(cfg.library?.maxItemMB, 6),
      },
      send: {
        frequency: cfg.send.frequency,
        dailyLimit: cfg.send.dailyLimit,
        usedToday: num(runtime.state().sentToday, 0),
        sentTotal: num(runtime.state().sentTotal, 0),
      },
      collect: runtime.collector.brief(),
      ingest: runtime.ingestor.snapshot(),
      reward: runtime.settler.snapshot(),
      vision: visionBrief(runtime),
      tools: runtime.toolNames,
      dataDir: String(runtime.dataDir ?? ''),
      // v2：存储目录说明（搬迁/回落的原因，UI 直接显示给用户看）
      store: {
        dataDir: String(runtime.dataDir ?? ''),
        defaultDataDir: String(runtime.defaultDataDir ?? ''),
        configured: String(cfg.store?.dataDir ?? ''),
        custom: Boolean(cfg.store?.dataDir),
        note: String(runtime.storeNote ?? ''),
      },
      // v2：备份概况（下次运行时间、已有备份列表）
      backup: safeBrief(() => runtime.backup?.brief?.()) ?? {
        enabled: cfg.backup?.enabled === true, at: cfg.backup?.at ?? '06:00',
        nextRunAt: 0, nextRunInMin: 0, lastRunAt: 0, backups: [],
      },
      // v2：主动发图汇总（跨会话统计 + 当前配置回显）
      proactive: safeBrief(() => proactiveBrief(runtime, cfg)),
      // v2.1：原始图池（GIF 保真用；UI 排障会看）
      rawPool: safeBrief(() => {
        const stats = runtime.rawImages?.stats?.()
        return { count: num(stats?.count, 0), bytes: num(stats?.bytes, 0) }
      }) ?? { count: 0, bytes: 0 },
      // 收图链路诊断：事件到没到、图片块有没有、入队多少、被什么条件挡下。
      // 排「群友发了图但库里没有」时先看这个，比自己猜快得多。
      ingestDiag: safeBrief(() => {
        const diag = runtime.guards?.ingestDiag
        if (!diag) {
          return {
            events: 0, userMessages: 0, withImage: 0, queuedTotal: 0,
            skipped: {}, lastSkip: '尚未收到任何事件', lastEventAt: 0, lastImageAt: 0,
          }
        }
        return {
          events: num(diag.events, 0),
          userMessages: num(diag.userMessages, 0),
          withImage: num(diag.withImage, 0),
          queuedTotal: num(diag.queuedTotal, 0),
          lastRawTokens: num(diag.lastRawTokens, 0),
          skipped: { ...(diag.skipped ?? {}) },
          lastSkip: String(diag.lastSkip ?? ''),
          lastEventAt: num(diag.lastEventAt, 0),
          lastImageAt: num(diag.lastImageAt, 0),
        }
      }) ?? { events: 0, userMessages: 0, withImage: 0, queuedTotal: 0, skipped: {} },
      // 打标链路的**真实**状态：静态检查 + 上一次真实调用的结果。
      // UI 的「视觉识别通道」据此显示「就绪 / 上次失败：原因」，不再虚假乐观。
      visionDiag: safeBrief(() => visionDiagnostics(runtime)) ?? { ok: false, reason: '诊断不可用', canSee: false },
      jobs: runtime.jobs?.list?.() ?? [],
    })
  }, 'qq-sticker: state route')

  // ── GET /report：原有只读报表（保留） ──────────────────────────────────
  registerRead(`${ROUTE_PREFIX}/report`, async (req, res) => {
    const text = runtime.library.reportText()
    try {
      const { writeTextAtomic } = await import('./util.js')
      await writeTextAtomic(runtime.reportFile, `${text}\n`)
    } catch { /* 写不了就只回文本 */ }
    sendJson(res, 200, { ok: true, report: text })
  }, 'qq-sticker: report route')

  // ── /config：GET 只读兜底 / POST 兜底写（同一路径，方法自己分发） ─────────
  mount(`${ROUTE_PREFIX}/config`, async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, { ok: true, config: runtime.getConfig() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, reason: 'method not allowed' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
      return
    }
    let body
    try {
      body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, reason: errorText(error) })
      return
    }
    try {
      const result = await writeConfig(ctx, runtime, body)
      sendJson(res, result.status, result.payload)
    } catch (error) {
      sendJson(res, error?.statusCode ?? 500, { ok: false, reason: errorText(error) })
    }
  }, 'qq-sticker: config route')

  // ── POST /raw-image：桥接转交的**原始图片字节** ─────────────────────
  //
  // 为什么需要这条路由：DSH 的附件服务（dsh-attachment-local）会把所有 GIF/动图
  // 重新编码成**单帧** webp/jpeg —— `canPassThroughNormalization()` 对 gif / animated
  // 一律返回 false，编码阶梯只产出 webp(有 alpha) 或 jpeg。所以插件从
  // `ctx.attachments.readImage(ref)` 拿到的永远不是动图。
  //
  // 桥接本来就下载了原始 Buffer，它把原字节 POST 到这里，插件落盘成"原始图池"，
  // 之后 ingest 优先用原始字节入库（GIF 才留得住动画），发送也用它。
  //
  // 约定：**best-effort**。桥接那边超时 1.5s、失败只 warn，绝不影响聊天；
  // 这边同样任何异常都回 {ok:false}，不抛。
  mount(`${ROUTE_PREFIX}/raw-image`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, reason: 'method not allowed' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
      return
    }
    let body
    try {
      // 图可能到 10MB，base64 后约 13.3MB —— 这里必须比普通 JSON 路由宽
      body = await readJsonBody(req, { maxBytes: MAX_RAW_IMAGE_BYTES })
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, reason: errorText(error) })
      return
    }
    const store = runtime.rawImages
    if (!store || typeof store.put !== 'function') {
      sendJson(res, 503, { ok: false, reason: '原始图池未就绪（插件还在初始化？）' })
      return
    }
    try {
      const stored = await store.put({
        token: body?.token,
        mediaType: body?.mediaType,
        ext: body?.ext,
        dataB64: body?.dataB64,
      })
      sendJson(res, stored.ok ? 200 : 400, stored)
    } catch (error) {
      sendJson(res, 500, { ok: false, reason: errorText(error) })
    }
  }, 'qq-sticker: raw-image route')

  // ── POST /open-path：在系统资源管理器里打开数据目录（或任意受控子目录）───
  //
  // 为什么要服务端中转：客户端（浏览器页面）不能直接调 `shell.openPath`／
  // 也没有 Node 的 child_process 权限；宿主提供的是 `ctx.remote.session.openWorkspacePath`
  // （Remote，只接受「工作区内的路径」）。数据目录在 ~/.dsh/plugin-data 下，
  // 不在工作区内 —— 所以走插件自己的 Host 路由，由��端用系统命令打开。
  //
  // 安全：只允许打开 runtime.dataDir 及其子目录（不接受任意路径），
  // 且必须在 POST + same-origin 下。
  mount(`${ROUTE_PREFIX}/open-path`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, reason: 'method not allowed' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
      return
    }
    let body
    try {
      body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, reason: errorText(error) })
      return
    }
    try {
      const result = await openDataDir(req, runtime, body)
      sendJson(res, result.status, result.payload)
    } catch (error) {
      sendJson(res, error?.statusCode ?? 500, { ok: false, reason: errorText(error) })
    }
  }, 'qq-sticker: open-path route')

  // ── POST /action：{ kind, args } → 启动任务 ────────────────────────────
  mount(`${ROUTE_PREFIX}/action`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, reason: 'method not allowed' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, reason: 'cross-site request refused' })
      return
    }
    let body
    try {
      body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })
    } catch (error) {
      sendJson(res, error?.statusCode ?? 400, { ok: false, reason: errorText(error) })
      return
    }
    const actions = runtime.actions
    if (!actions || typeof actions.run !== 'function') {
      sendJson(res, 500, { ok: false, reason: '动作通道未就绪（插件还在初始化？）' })
      return
    }
    try {
      const started = actions.run(body?.kind, body?.args)
      if (started?.ok === true) {
        sendJson(res, 200, { ok: true, job: started.job })
        return
      }
      if (started?.reason === 'already-running') {
        sendJson(res, 409, { ok: false, reason: 'already-running', job: started.job })
        return
      }
      sendJson(res, 400, { ok: false, reason: String(started?.reason ?? 'invalid action') })
    } catch (error) {
      // actions.run 对「参数非法 / 未知 kind」抛带 statusCode=400 的错误
      sendJson(res, error?.statusCode ?? 500, { ok: false, reason: errorText(error) })
    }
  }, 'qq-sticker: action route')

  return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
}

/**
 * 在系统文件管理器里打开数据目录。
 *
 * 只允许打开 `runtime.dataDir`（及其子目录，用 `sub` 指定），防止这条路由被
 * 当成任意文件系统的打开器。`sub` 只能是单段目录名（不含分隔符与 `..`）。
 *
 * 打开方式按平台分派，全部用系统自带命令，不引任何依赖：
 *   · win32 → `explorer.exe <path>`（explorer 对已存在目录会直接打开，返回码 1 是常态）
 *   · darwin → `open <path>`
 *   · 其它 → `xdg-open <path>`
 *
 * @returns {{status:number, payload:object}}
 */
async function openDataDir(req, runtime, body) {
  const sub = String(body?.sub ?? '').trim()
  if (sub && (!/^[A-Za-z0-9._-]+$/.test(sub) || sub === '.' || sub === '..')) {
    return { status: 400, payload: { ok: false, reason: 'sub 只能是单段目录名' } }
  }
  const root = String(runtime.dataDir ?? '').trim()
  if (!root) return { status: 503, payload: { ok: false, reason: '数据目录还没解析出来（插件仍在初始化）' } }

  const target = sub ? pathUtil.join(root, sub) : root
  // 兜底再确认一次：解析后的绝对路径必须以数据目录开头
  const normalizedRoot = pathUtil.resolve(root)
  const normalizedTarget = pathUtil.resolve(target)
  const inside = normalizedTarget === normalizedRoot
    || normalizedTarget.startsWith(`${normalizedRoot}${pathUtil.sep}`)
  if (!inside) {
    return { status: 403, payload: { ok: false, reason: '只允许打开插件自己的数据目录' } }
  }

  // 目录不存在就先建（备份目录、raw 池这些按需创建）
  let exists = true
  try {
    await fsStat(normalizedTarget)
  } catch {
    exists = false
  }
  if (!exists) {
    try {
      await fsMkdir(normalizedTarget, { recursive: true })
    } catch (error) {
      return { status: 500, payload: { ok: false, reason: `目录不存在且创建失败：${errorText(error)}` } }
    }
  }

  const opened = await spawnDetached(normalizedTarget)
  return {
    status: opened.ok ? 200 : 500,
    payload: {
      ok: opened.ok,
      path: normalizedTarget,
      method: opened.method,
      ...(opened.ok ? {} : { reason: opened.reason }),
    },
  }
}

/** 起一个不等待的进程（打开文件管理器不该把 HTTP 请求挂住）。 */
async function spawnDetached(target) {
  const { spawn } = await import('node:child_process')
  const platform = process.platform
  const plan = platform === 'win32'
    ? { cmd: 'explorer.exe', args: [target], method: 'explorer' }
    : platform === 'darwin'
      ? { cmd: 'open', args: [target], method: 'open' }
      : { cmd: 'xdg-open', args: [target], method: 'xdg-open' }
  return await new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(plan.cmd, plan.args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', (error) => done({ ok: false, method: plan.method, reason: errorText(error) }))
      // explorer.exe 打开成功也常返回 1，所以**只把 spawn 失败当失败**；
      // 进程退出码只用于日志，不影响响应（否则 Windows 上永远报错）。
      child.on('exit', () => done({ ok: true, method: plan.method }))
      // 3 秒内没退出也算成功（detached 的 GUI 程序本来就长命）
      const timer = setTimeout(() => done({ ok: true, method: plan.method }), 3000)
      timer.unref?.()
    } catch (error) {
      done({ ok: false, method: plan.method, reason: errorText(error) })
    }
  })
}

/**
 * 兜底写配置：走 `settings.update('qq-sticker', patch)`。 *
 * patch 必须**带上当前段的其它字段**再覆盖目标叶子，否则 settings 的层合并
 * 会把整段冲掉（契约 §5 的 `{ [path[0]]: { ...当前段, [path.at(-1)]: value } }`）。
 * settings 服务不可用 → 501 `{ok:false,reason}`（契约 §5 原文）。
 *
 * @returns {{status:number, payload:object}}
 */
async function writeConfig(ctx, runtime, body) {
  // ⚠️ 先校验请求体，再查服务：参数错了就是 400，不该被「服务不可用」的 501 抢答
  //    （501 是「你请求没错，但我这边没有能力」，语义完全不同）。
  const path = Array.isArray(body?.path) ? body.path.map((seg) => String(seg)) : []
  if (path.length === 0 || path.length > 2 || path.some((seg) => seg === '')) {
    return { status: 400, payload: { ok: false, reason: 'path 必须是 1~2 段非空字符串数组' } }
  }
  if (!Object.hasOwn(body ?? {}, 'value')) {
    return { status: 400, payload: { ok: false, reason: '缺少 value' } }
  }
  const settings = safeService(ctx, 'settings')
  if (!settings || typeof settings.update !== 'function') {
    return { status: 501, payload: { ok: false, reason: '设置服务不可用，无法写配置' } }
  }
  const value = body.value
  const cfg = runtime.getConfig()
  let patch
  if (path.length === 1) {
    patch = { [path[0]]: value }
  } else {
    const section = cfg?.[path[0]]
    const base = section && typeof section === 'object' && !Array.isArray(section) ? section : {}
    patch = { [path[0]]: { ...base, [path[path.length - 1]]: value } }
  }
  try {
    await settings.update('qq-sticker', patch)
  } catch (error) {
    // 契约 §4：「任何异常 → 500 {ok:false, reason}」。400 只留给参数非法（上面的 path / value 校验），
    // 这里多半是 revision 冲突 / schema 不认字段 / 写盘失败，语义上属于服务端异常。
    return { status: 500, payload: { ok: false, reason: `写配置失败：${errorText(error)}` } }
  }
  return { status: 200, payload: { ok: true, config: runtime.getConfig() } }
}

/**
 * 同源检查。
 *
 * `sec-fetch-site` 是浏览器自愿头：脚本/桥接请求没有它 → 放行；
 * 浏览器里跨站页面发起的请求会带 `cross-site` → 403。
 */
function sameOrigin(req) {
  const fetchSite = req?.headers?.['sec-fetch-site']
  if (typeof fetchSite !== 'string') return true
  return fetchSite === 'same-origin' || fetchSite === 'none'
}

/**
 * 读一个 JSON 请求体（有大小上限）。
 *
 * 自己写而不是依赖 body parser：这个插件零依赖。超过上限 → 413；
 * 空 body 当 `{}`；解析失败 → 400。
 *
 * ⚠️ 超限时**不能立刻 destroy socket**（2026-10-25 真 HTTP 上踩到）：客户端还在
 * 上行，这边一 destroy，浏览器/fetch 只看到 "socket 断了"，拿不到那个 413。
 * 所以改成：超过 maxBytes 就丢弃后续字节（不再累积），把 body 读完；
 * 只有超过硬上限（8×）才强制断开，避免有人拿无限流拖住 Host。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{maxBytes?:number}} [options]
 * @returns {Promise<object>}
 */
function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  const hardLimit = maxBytes * 8
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    const chunks = []
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > hardLimit) {
        settled = true
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节`), { statusCode: 413 }))
        req.destroy?.()
        return
      }
      if (overflow) return // 已超上限：只排空，不再累积
      if (size > maxBytes) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (overflow) {
        reject(Object.assign(new Error(`请求体超过 ${maxBytes} 字节`), { statusCode: 413 }))
        return
      }
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) { resolve({}); return }
      try {
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }))
          return
        }
        resolve(parsed)
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** 错误 → 可读原因（error.message 为空时兜底）。 */
function errorText(error) {
  return String(error?.message ?? error ?? '未知错误')
}

/** 视觉通道简报：`reason` 恒为字符串（契约 §1）。 */
function visionBrief(runtime) {
  let brief
  try {
    brief = runtime.vision.available()
  } catch (error) {
    brief = { ok: false, reason: errorText(error) }
  }
  return { ok: brief?.ok === true, reason: String(brief?.reason ?? '') }
}

/**
 * 打标链路的**真实**诊断。
 *
 * 为什么需要：`vision.available()` 只做静态检查（handler 在不在、路由解析得到不），
 * 它说"就绪"并不代表真能打标 —— 之前 UI 显示"视觉识别通道就绪"但一点就报
 * `prepared LLM call config changed`，属于**虚假的乐观**。这里把上一次真实调用的
 * 结果也带上，UI 据此显示"就绪 / 上次失败：原因"。
 *
 * @param {object} runtime
 * @returns {{ok:boolean, reason:string, route?:string, canSee:boolean, lastCall?:object}}
 */
function visionDiagnostics(runtime) {
  const brief = visionBrief(runtime)
  let route = ''
  let canSee = false
  try {
    const cfg = runtime.getConfig()
    const resolved = resolveChatRouteSafe(runtime, cfg)
    if (resolved) {
      route = `${resolved.provider}/${resolved.model}`
      canSee = true
    }
  } catch { /* 路由解析失败不影响诊断结构 */ }
  const lastCall = runtime.guards?.lastVisionCall ?? undefined
  return {
    ok: brief.ok && canSee,
    reason: brief.reason,
    route,
    canSee,
    ...(lastCall ? { lastCall } : {}),
  }
}

/** 保守地解析看图路由（拿不到就返回 undefined，绝不抛）。 */
function resolveChatRouteSafe(runtime, cfg) {
  try {
    const resolver = runtime.resolveChatRoute
    if (typeof resolver === 'function') return resolver()
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 主动发图汇总（v2）。
 *
 * 为什么要汇总而不是直接回显配置：UI 想知道的是"这套配置实际会怎样工作"——
 * 比如「概率 0.25」很好懂，但「0.25 加上每日上限 40，实际大概一天最多补几次」
 * 才是用户真正关心的。这里把两者都算出来。
 *
 * @param {object} runtime
 * @param {object} cfg 归一化配置
 * @returns {object}
 */
function proactiveBrief(runtime, cfg) {
  const enabled = cfg.proactive?.enabled === true && cfg.enabled === true
  const probability = num(cfg.proactive?.probability, 0)
  const dailyLimit = num(cfg.send?.dailyLimit, 0)

  // 粗估：按「一天 200 个回合」算期望补图次数（仅供 UI 参考，不是承诺）
  const assumedTurns = 200
  const expectedPerDay = enabled && probability > 0
    ? Math.round(assumedTurns * probability)
    : 0
  const cappedPerDay = dailyLimit > 0 ? Math.min(expectedPerDay, dailyLimit) : expectedPerDay

  return {
    enabled,
    mode: String(cfg.proactive?.mode ?? 'serial'),
    probability,
    stickerOnly: cfg.proactive?.stickerOnly !== false,
    embedMode: cfg.proactive?.embedMode === true,
    maxPerTurn: num(cfg.proactive?.maxPerTurn, 1),
    idleTurns: num(cfg.proactive?.idleTurns, 0),
    model: String(cfg.proactive?.model ?? ''),
    // 期望值（UI 用一句话告诉用户"大概一天补几次"）
    expectedPerDay: cappedPerDay,
    battle: {
      joinEnabled: cfg.battle?.joinEnabled !== false,
      joinWindowSec: num(cfg.battle?.joinWindowSec, 30),
      joinThreshold: num(cfg.battle?.joinThreshold, 3),
      burstEnabled: cfg.battle?.burstEnabled !== false,
      burstCount: num(cfg.battle?.burstCount, 2),
      burstProbability: num(cfg.battle?.burstProbability, 0.2),
      teamEnabled: cfg.battle?.teamEnabled === true,
      teamBudgetPerDay: num(cfg.battle?.teamBudgetPerDay, 10),
    },
    gif: {
      normalizeOnSend: cfg.gif?.normalizeOnSend === true,
      // 只做标记，没有真实转码能力 —— UI 要如实说明
      marked: num(runtime.guards?.gifMarked?.total, 0),
      lastMarkedAt: num(runtime.guards?.gifMarked?.lastAt, 0),
    },
  }
}

/** 包一层 try：任何 brief 抛错都不该让 /state 整体 500。 */
function safeBrief(fn) {
  try {
    const value = fn()
    return value === undefined ? undefined : value
  } catch {
    return undefined
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
