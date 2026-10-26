/**
 * 通用小工具：路径、哈希、图片类型嗅探、原子写、防抖落盘。
 *
 * 为什么不用第三方依赖：DSH Host 侧零依赖是本项目的惯例（qq-guard 同样零运行时依赖），
 * 只有 schemastery 用来声明 Config。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink, stat, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 插件数据默认根：显式传入 > $DSH_HOME > ~/.dsh（与 dsh-home-paths 同一套解析规则）。 */
export function defaultDataDir(...segments) {
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.trim())
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'dsh-qq-sticker', ...segments)
}

/** sha1（十六进制小写）。内容寻址的主键。 */
export function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

/** 字节头嗅探图片类型。返回 {ext, mediaType}；认不出返回 null。 */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mediaType: 'image/png' }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mediaType: 'image/jpeg' }
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: 'gif', mediaType: 'image/gif' }
  }
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mediaType: 'image/webp' }
  }
  return null
}

/** 安全整数（NaN/负数/字符串 → fallback）。 */
export function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 夹到区间内。 */
export function clamp(value, lo, hi, fallback = lo) {
  const n = num(value, fallback)
  return Math.min(hi, Math.max(lo, n))
}

/** 单行化 + 截断（写进提示词/报表的文本都要过这道）。 */
export function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 读 JSON（不存在/坏掉都返回 fallback，不抛）。 */
export async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 原子写：先写同目录临时文件再 rename。Windows 上 rename 覆盖已存在文件是原子替换。
 * 目录不存在会自动建。
 */
export async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const text = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** 写普通文本（同样走临时文件，避免半截文件被读到）。 */
export async function writeTextAtomic(file, text) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** 写二进制（图片本体用这个）。调用方保证不覆盖已存在文件。 */
export async function writeBytes(file, bytes) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  await writeFile(file, bytes)
}

/** 删文件（不存在不报错）。 */
export async function removeFile(file) {
  try { await unlink(file) } catch { /* 不存在就当作已删 */ }
}

/** 文件是否存在 + 大小。 */
export async function fileInfo(file) {
  try {
    const s = await stat(file)
    return { exists: true, bytes: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return { exists: false, bytes: 0, mtimeMs: 0 }
  }
}

/** 列目录（不存在返回空数组）。 */
export async function listDir(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * 防抖落盘器。
 *
 * 库一改就整份写盘在 500~800 张规模下会很费 IO，而 session/event 一秒能来好几条；
 * 所以统一走这里：标记脏 + 延迟写，卸载时 flush。
 *
 * ⚠️ 两个容易丢数据的边界（2026-10-26 真机排查后加固）：
 *  ① `mark()` 在已有定时器时直接 return —— 若这期间又发生改动，定时器还是原来那个，
 *     到点写盘内容确实是最新的（因为写的是整份内存快照），所以这条其实安全。
 *  ② **真正危险的是 `flush()` 之后的改动**：flush 把 dirty 清成 false 并开始写盘，
 *     若写盘期间又有 mark()，dirty 变 true 但没人再排期 → 这份改动要等到
 *     *下一次* mark 才可能落盘，可能永远不落。
 *     修法：写盘期间新标记的 dirty，在写完后自动再排一次。
 */
export function createSaver(delayMs, writer) {
  let timer = null
  let dirty = false
  /** 是否正在写盘（写盘期间来的改动要在写完后补排一次）。 */
  let writing = false
  let chain = Promise.resolve()
  const schedule = () => {
    if (timer || writing) return
    timer = setTimeout(() => { timer = null; void flush() }, delayMs)
    timer.unref?.()
  }
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!dirty) return
    dirty = false
    writing = true
    chain = chain
      .then(() => writer())
      .catch(() => { /* 写失败不炸插件，下次再写 */ })
      .finally(() => {
        writing = false
        // 写盘期间又被标脏了 → 补排一次，别把这次改动漏掉
        if (dirty) schedule()
      })
    await chain
  }
  const mark = () => {
    dirty = true
    schedule()
  }
  return { mark, flush, get dirty() { return dirty } }
}

/** 把 `1.5`→"1.5"，`3`→"3"；报表里用。 */
export function fmtNum(value, digits = 2) {
  const n = num(value, 0)
  return Number.isInteger(n) ? String(n) : n.toFixed(digits)
}

/** 今天（本地时区）YYYY-MM-DD。配额按天滚动用它。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 这一小时的键：YYYY-MM-DD-HH（每小时限额用）。 */
export function hourKey(now = Date.now()) {
  const d = new Date(now)
  return `${todayKey(now)}-${String(d.getHours()).padStart(2, '0')}`
}

/** 递归解 `{get()}` 包装（schemastery volatile 字段解析后的形态）。 */
export function plain(value) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') {
    if (typeof value.get === 'function') {
      try { return plain(value.get()) } catch { return undefined }
    }
    const out = {}
    for (const key of Object.keys(value)) {
      const child = plain(value[key])
      if (child !== undefined) out[key] = child
    }
    return out
  }
  return value
}

/** 两个对象浅合并（后者覆盖）；任一侧不是对象就当空。 */
export function shallowMerge(base, patch) {
  const a = base && typeof base === 'object' ? base : {}
  const b = patch && typeof patch === 'object' ? patch : {}
  return { ...a, ...b }
}

/** 简易并发闸：同时最多 n 个任务。 */
export function createLimiter(n) {
  let active = 0
  const queue = []
  const pump = () => {
    while (active < n && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift()
      active++
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => { active--; pump() })
    }
  }
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    pump()
  })
}

/**
 * 安全地取一个 Cordis 服务（**唯一正确**的取法）。
 *
 * ⚠️ 为什么不能写 `ctx.foo`：
 * Cordis 的 ctx 是 **Proxy**，读一个没在插件 `inject` 里声明的服务属性会**抛错**：
 *   `cannot get property "timer" without inject`
 * 而且这个抛错发生在 proxy 的 get 陷阱内部 —— 不是"返回 null"，所以
 * **`ctx?.foo` / `ctx.foo ?? fallback` 都兜不住**，`?.` 照样炸。
 * 2026-10-25 插件在 DSH 里 fiberPhase=failed 就是这一条（`ctx.timer`）。
 *
 * 正确写法只有两种：
 *   ① 把这个服务写进 `export const inject = [...]`，然后 `ctx.foo`；
 *   ② 用 `ctx.get(name)` —— 它按契约 **不要求 inject**，拿不到就返回 undefined。
 * 这里统一走 ②，并且多兜一层 try/catch（ctx 形态不明时也不炸）。
 *
 * @param {object} ctx Cordis 插件/agent 上下文
 * @param {string} name 服务名（'tools' / 'timer' / 'attachments' / 'llm' …）
 * @returns {any} 服务实例或 undefined
 */
export function safeService(ctx, name) {
  if (!ctx || !name) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const hit = ctx.get(name)
      if (hit !== undefined) return hit
    }
  } catch { /* 某些 ctx 形态的 get 会抛，继续尝试下一层 */ }
  try {
    // 最后再试一次直接读属性（非 Cordis 的假 ctx 用得上）；
    // 真 Cordis 上这一步会在 try 里抛，被 catch 吞掉。
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 取 agent 的 session 对象（agent.ctx.session 在 Cordis proxy 上也可能抛）。 */
export function agentSession(agent) {
  try {
    const direct = agent?.session
    if (direct) return direct
  } catch { /* ignore */ }
  try {
    const viaCtx = agent?.ctx?.session
    if (viaCtx) return viaCtx
  } catch { /* ignore */ }
  try {
    return safeService(agent?.ctx, 'session')
  } catch {
    return undefined
  }
}
