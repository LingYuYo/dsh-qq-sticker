/**
 * 定时备份：把整个库（索引 + 状态 + 收集计划 + 全部图片）打成一个 zip。
 *
 * 调度风格与 collect.js 保持一致：定时器只做「每 60 秒看一眼到没到点」，
 * 真活由 `runNow` 干；schedule 落盘在 `backup-schedule.json`，重启后接着算。
 *
 * 三条硬约束（都来自实战）：
 *  · **不能阻塞聊天主链路**：runNow 内部逐文件读，单个文件失败只 warn 后跳过，
 *    不 throw、不拖垮插件；整个备份在 IO 上只占自己的时间片。
 *  · **同一时刻只许一个备份**：`_running` 标记，第二次调用直接返回 busy
 *    （定时器 tick 与手动「立即备份」可能撞车）。
 *  · **零依赖**：ZIP 用 ./zip.js，文件操作走 node:fs / util.js 的现成工具。
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createZip } from './zip.js'
import { FILES } from './library.js'
import { num, readJson, safeService, writeJsonAtomic } from './util.js'

/** 备份计划文件名（相对 dataDir）。不含进备份内容里，避免自引用。 */
const SCHEDULE_FILE = 'backup-schedule.json'

/** 备份文件名前缀 + 形态：qq-sticker-YYYYMMDD-HHmm.zip（同分钟冲突时加 -2、-3）。 */
const FILE_PREFIX = 'qq-sticker-'
const FILE_RE = /^qq-sticker-\d{8}-\d{4}(?:-\d+)?\.zip$/

/** 定时器默认轮询间隔：一分钟看一眼，够每天 HH:MM 的精度。 */
const TICK_MS = 60 * 1000

/** 默认配置（cfg.backup 缺失时兜底，Lead 还没改完 config 也不会崩）。 */
export const BACKUP_DEFAULTS = {
  enabled: false,
  at: '06:00',
  dir: '',
  keep: 7,
  deflate: false,
}

/** 'HH:MM' → 当天的分钟数（0~1439）；非法/越界返回 null。 */
export function parseAtMinute(at) {
  const match = String(at ?? '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 本地时间的下一次 HH:MM（今天还没到就是今天，否则明天）。 */
export function computeNextRunAt(at, now = Date.now()) {
  const minuteOfDay = parseAtMinute(at)
  if (minuteOfDay === null) return 0
  const date = new Date(now)
  date.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0)
  if (date.getTime() <= now) date.setDate(date.getDate() + 1)
  return date.getTime()
}

/** 备份文件名排序键：时间戳 + 同分钟后缀号（无后缀算 1）。 */
function nameRank(name) {
  const match = String(name).match(/^qq-sticker-(\d{8})-(\d{4})(?:-(\d+))?\.zip$/)
  if (!match) return 0
  return Number(match[1]) * 1e7 + Number(match[2]) * 1e3 + Number(match[3] ?? 1)
}

/** 本地时间 → 文件名里的 YYYYMMDD-HHmm。 */
function stampOf(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** cfg.backup 归一化（设置页能填任何东西，这里不信它）。 */
function backupCfgOf(cfg) {
  const raw = cfg && typeof cfg.backup === 'object' && cfg.backup ? cfg.backup : {}
  return {
    enabled: raw.enabled === true,
    at: parseAtMinute(raw.at) === null ? BACKUP_DEFAULTS.at : String(raw.at).trim(),
    dir: String(raw.dir ?? '').trim(),
    keep: Math.max(1, Math.round(num(raw.keep, BACKUP_DEFAULTS.keep))),
    deflate: raw.deflate === true,
  }
}

/**
 * 定时备份器。
 *
 * @param {object} opts
 * @param {() => object} opts.getConfig 读归一化后的配置（要含 backup.*）
 * @param {string} opts.dataDir 库根目录（images/、library.json 都在下面）
 * @param {(level:string, message:string)=>void} [opts.log]
 * @param {() => number} [opts.now] 测试用时钟（默认 Date.now）
 */
export class Backup {
  constructor({ getConfig, dataDir, log, now = Date.now }) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({})
    this.dataDir = dataDir
    this.log = log ?? (() => {})
    this.now = typeof now === 'function' ? now : Date.now
    this.scheduleFile = path.join(dataDir, SCHEDULE_FILE)
    this.imagesDir = path.join(dataDir, FILES.images)
    this.schedule = { nextRunAt: 0, lastRunAt: 0, at: '', lastFile: '', lastResult: null }
    this._running = false
    this._timer = null
    /** brief() 是同步的，备份列表由 refreshBackups()/runNow() 刷进这里。 */
    this._cachedBackups = []
    /** 是否已经刷过至少一轮列表（brief 首次调用时补刷）。 */
    this._listed = false
    /** 本进程内已经用过的备份文件名（prune 删掉后同名也不复用，保证「每份是不同时刻」）。 */
    this._usedNames = new Set()
  }

  /** 当前生效的 cfg.backup（每次现读，设置页一改就生效）。 */
  cfg() {
    return backupCfgOf(this.getConfig())
  }

  /** 备份输出目录：cfg.backup.dir 非空则用它，否则 dataDir/backups。 */
  backupDir(cfg = this.cfg()) {
    return cfg.dir ? path.resolve(cfg.dir) : path.join(this.dataDir, 'backups')
  }

  async load() {
    const raw = await readJson(this.scheduleFile, null)
    if (raw && typeof raw === 'object') {
      this.schedule = {
        nextRunAt: num(raw.nextRunAt, 0),
        lastRunAt: num(raw.lastRunAt, 0),
        at: String(raw.at ?? ''),
        lastFile: String(raw.lastFile ?? ''),
        lastResult: raw.lastResult ?? null,
      }
    }
    return this.schedule
  }

  async saveSchedule() {
    try {
      await writeJsonAtomic(this.scheduleFile, this.schedule)
    } catch (error) {
      this.log('warn', `备份计划写盘失败：${error?.message ?? error}`)
    }
  }

  /**
   * 启动定时检查（由插件在 apply 里用 ctx.effect 挂，随 fiber 卸载）。
   *
   * ⚠️ 必须走 `ctx.get('timer')`，**不能**写 `ctx.timer`：Cordis 的 ctx 是 Proxy，
   * 读一个没在 inject 里声明的服务属性会抛 `cannot get property "timer" without inject`，
   * 而 `?.` 兜不住（抛错在 proxy 陷阱内部）。同一坑见 collect.js:startTimer。
   *
   * @param {object} ctx DSH 插件 ctx
   * @returns {() => void} 停止函数
   */
  startTimer(ctx) {
    const stop = () => {
      if (this._timer) { try { this._timer() } catch { /* ignore */ } this._timer = null }
    }
    const tick = () => { void this.maybeRun() }
    const timer = safeService(ctx, 'timer')
    if (timer && typeof timer.interval === 'function') {
      this._timer = timer.interval(tick, TICK_MS)
    } else {
      const id = setInterval(tick, TICK_MS)
      id.unref?.()
      this._timer = () => clearInterval(id)
    }
    return stop
  }

  /** 到点就跑（关掉定时就跳过）。 */
  async maybeRun() {
    const cfg = this.cfg()
    if (!cfg.enabled) return { ok: false, reason: 'disabled' }
    if (this._running) return { ok: false, reason: 'busy' }
    const now = this.now()
    const nextRunAt = this.effectiveNextRunAt(cfg, now)
    if (nextRunAt !== this.schedule.nextRunAt) {
      this.schedule.nextRunAt = nextRunAt
      await this.saveSchedule()
    }
    if (now < nextRunAt) return { ok: false, reason: 'not-yet', nextRunAt }
    const result = await this.runNow({ reason: 'timer' })
    this.schedule.lastRunAt = this.now()
    this.schedule.nextRunAt = computeNextRunAt(cfg.at, this.schedule.lastRunAt)
    this.schedule.at = cfg.at
    this.schedule.lastFile = result.ok ? path.basename(result.file) : this.schedule.lastFile
    this.schedule.lastResult = result.ok
      ? { ok: true, at: this.schedule.lastRunAt, file: result.file, bytes: result.bytes, entries: result.entries }
      : { ok: false, at: this.schedule.lastRunAt, reason: result.reason ?? '未知' }
    await this.saveSchedule()
    return result
  }

  /**
   * 当前应生效的下次运行时刻。
   * 设置页把 `backup.at` 改掉以后，旧的 nextRunAt 就过期了 —— 按新时刻重算，
   * 否则面板会一直显示改动前那个时间（用户会以为没生效）。
   * `schedule.at` 为空 = 老版本落盘的计划表（那时还没存 at），沿用已有 nextRunAt，
   * 跑完一轮后自然补上 at。
   */
  effectiveNextRunAt(cfg = this.cfg(), now = this.now()) {
    if (this.schedule.nextRunAt > 0 && (!this.schedule.at || this.schedule.at === cfg.at)) {
      return this.schedule.nextRunAt
    }
    return computeNextRunAt(cfg.at, now)
  }

  /**
   * 备份状态摘要（面板/报表用）。
   *
   * @param {number} [now]
   */
  brief(now = this.now()) {
    const cfg = this.cfg()
    const nextRunAt = this.effectiveNextRunAt(cfg, now)
    // brief 必须同步（面板/工具直接调），列表靠缓存；第一次调用时先异步刷一轮，
    // 下一次轮询就能看到真实文件列表（面板本来就是周期拉状态）。
    if (!this._listed) {
      this._listed = true
      void this.refreshBackups()
    }
    const backups = this._cachedBackups ?? []
    return {
      enabled: cfg.enabled,
      at: cfg.at,
      keep: cfg.keep,
      deflate: cfg.deflate,
      dir: this.backupDir(cfg),
      nextRunAt,
      nextRunInMin: Math.max(0, Math.round((nextRunAt - now) / 60_000)),
      lastRunAt: this.schedule.lastRunAt,
      lastBackupFile: this.schedule.lastFile || (backups[0]?.name ?? ''),
      running: this._running,
      backups: backups.map((entry) => ({ name: entry.name, size: entry.size, at: entry.at })),
    }
  }

  /**
   * 预读备份列表（brief 是同步的，列表由这里刷进缓存）。
   * 面板每次取状态前可以 await 一下；失败当空列表，不影响 brief 可用。
   */
  async refreshBackups() {
    try {
      this._cachedBackups = await this.listBackups()
    } catch (error) {
      this._cachedBackups = []
      this.log('warn', `列备份目录失败：${error?.message ?? error}`)
    }
    return this._cachedBackups
  }

  /** 备份目录里的备份文件（新→旧）。 */
  async listBackups() {
    const dir = this.backupDir()
    let names = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (!FILE_RE.test(name)) continue
      try {
        const info = await stat(path.join(dir, name))
        out.push({ name, size: info.size, at: info.mtimeMs })
      } catch { /* 刚被删，跳过 */ }
    }
    // 新→旧：先按 mtime，同一毫秒内再按文件名里的时间戳 + 后缀号（`-2` 比 `-10` 旧）。
    // 不能直接按字符串比：`...-2.zip` 的 char 比 `.zip` 小，会排反。
    return out.sort((a, b) => (b.at - a.at) || (nameRank(b.name) - nameRank(a.name)))
  }

  /** 备份目录里已存在的文件名集合（目录不存在当空）。 */
  async _namesOnDisk(dir) {
    try {
      return new Set(await readdir(dir))
    } catch {
      return new Set()
    }
  }

  /** 读一个文件进 zip 条目；失败返回 null（只 warn，不炸整次备份）。 */
  async _entry(dir, name, zipName, errors) {
    try {
      const data = await readFile(path.join(dir, name))
      return { name: zipName ?? name, data }
    } catch (error) {
      errors.push({ name, message: String(error?.message ?? error) })
      this.log('warn', `备份跳过 ${name}：${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 立即备份。
   *
   * @param {{reason?:string}} [opts]
   * @returns {Promise<{ok:boolean, reason?:string, file?:string, bytes?:number, entries?:number, kept?:number, removed?:string[], errors?:Array<{name:string,message:string}>}>}
   */
  async runNow({ reason = 'manual' } = {}) {
    if (this._running) return { ok: false, reason: 'busy' }
    this._running = true
    const errors = []
    try {
      const cfg = this.cfg()
      const backupDir = this.backupDir(cfg)
      await mkdir(backupDir, { recursive: true })

      const entries = []
      // 索引 / 状态 / 收集计划：缺了也不影响「图还在」，所以失败只记 warn。
      for (const name of [FILES.index, FILES.state, FILES.schedule]) {
        const entry = await this._entry(this.dataDir, name, name, errors)
        if (entry) entries.push(entry)
      }
      // 图片：平铺在 images/ 下，文件名 <sha1>.<ext>，逐张读、单张失败就跳过。
      let imageNames = []
      try {
        imageNames = await readdir(this.imagesDir)
      } catch (error) {
        this.log('warn', `备份：图片目录不可读（${this.imagesDir}）：${error?.message ?? error}`)
      }
      for (const name of imageNames.sort()) {
        const entry = await this._entry(this.imagesDir, name, `images/${name}`, errors)
        if (entry) entries.push(entry)
      }

      const buffer = await createZip(entries, { deflate: cfg.deflate })

      const at = new Date(this.now())
      const stamp = stampOf(at)
      let fileName = `${FILE_PREFIX}${stamp}.zip`
      // 同一分钟跑多次时不能重名：既排除已在磁盘上的，也排除本进程已经用过的
      // （否则 pruneKeep 删掉最旧那份后，下一次又拿回同一个名字，保留的就成了「同一时刻」）。
      const taken = await this._namesOnDisk(backupDir)
      for (let index = 2; taken.has(fileName) || this._usedNames.has(fileName); index++) {
        fileName = `${FILE_PREFIX}${stamp}-${index}.zip`
        if (index > 999) throw new Error('同一分钟内备份次数过多，文件名排不下')
      }
      this._usedNames.add(fileName)
      const file = path.join(backupDir, fileName)
      // 先写临时文件再 rename：避免面板/别的进程读到半截 zip。
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, buffer)
      try {
        await rename(tmp, file)
      } catch (error) {
        try { await unlink(tmp) } catch { /* ignore */ }
        throw error
      }

      const removed = await this.pruneKeep()
      this.schedule.lastRunAt = this.now()
      this.schedule.lastFile = fileName
      this.schedule.lastResult = {
        ok: true, at: this.schedule.lastRunAt, file: fileName, bytes: buffer.length, entries: entries.length,
      }
      await this.saveSchedule()
      await this.refreshBackups()

      const kept = (this._cachedBackups ?? []).length
      const result = {
        ok: true,
        reason,
        file,
        bytes: buffer.length,
        entries: entries.length,
        kept,
        removed,
        errors,
      }
      this.log('info', `备份完成：${fileName}（${entries.length} 项 / ${buffer.length} 字节，清理 ${removed.length} 份旧备份）`)
      return result
    } catch (error) {
      this.log('warn', `备份失败：${error?.message ?? error}`)
      return { ok: false, reason: `备份失败：${error?.message ?? error}`, errors, kept: 0, removed: [] }
    } finally {
      this._running = false
    }
  }

  /** 只保留最近 cfg.backup.keep 份。返回被删文件名列表。 */
  async pruneKeep() {
    const cfg = this.cfg()
    const keep = Math.max(1, cfg.keep)
    const list = await this.listBackups()
    if (list.length <= keep) return []
    const dir = this.backupDir(cfg)
    const removed = []
    for (const entry of list.slice(keep)) {
      try {
        await unlink(path.join(dir, entry.name))
        removed.push(entry.name)
      } catch (error) {
        this.log('warn', `删除旧备份失败 ${entry.name}：${error?.message ?? error}`)
      }
    }
    return removed
  }

  dispose() {
    if (this._timer) { try { this._timer() } catch { /* ignore */ } this._timer = null }
  }
}
