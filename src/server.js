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
import { num, safeService } from './util.js'

/** 路由前缀（改这里要同步 README）。 */
export const ROUTE_PREFIX = '/dsh-qq-sticker'

/** 写路由的请求体上限：动作参数都是小 JSON，64KB 足够，且能挡住拿大 body 拖死 Host。 */
const MAX_BODY_BYTES = 64 * 1024

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
 * 兜底写配置：走 `settings.update('qq-sticker', patch)`。
 *
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
