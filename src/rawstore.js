/**
 * 原始图池：桥接转交的**未转码图片字节**（GIF 动画保真的关键）。
 *
 * 为什么需要它（2026-10-25 实测结论）：
 *   DSH 的附件服务 `@deepseek-ai/dsh-attachment-local` 会强制"归一化"每一张图 ——
 *   `canPassThroughNormalization()` 对 `mediaType==='image/gif'` 或 `animated` 一律
 *   返回 false，`encodingLadder()` 只产出 `image/webp`（有 alpha）或 `image/jpeg`。
 *   于是 `ctx.attachments.readImage(ref)` 拿回来的永远是**单帧**，GIF 的 28 帧全丢了。
 *
 *   桥接进程本来就下载了原始 Buffer，它把原字节通过 POST /dsh-qq-sticker/raw-image
 *   送过来（best-effort，失败不影响聊天），这里按 token 落盘成临时池：
 *   `plugin-data/dsh-qq-sticker/raw/<token>.<ext>`
 *
 * 生命周期：
 *   · `put()` 写入后 10 分钟内有效（够一次 ingest + 一次发送）；
 *   · `take()` 取出（**不删**，因为一次收图可能触发多次使用）；
 *   · `sweep()` 定期清过期文件，由 library 的落盘节奏顺手调用。
 *
 * 安全：
 *   · token 必须是 8~64 位 `[A-Za-z0-9_-]`，防止路径穿越；
 *   · 只落 `.gif/.png/.jpg/.webp` 四种后缀，后缀由 mediaType 决定，不信调用方；
 *   · 单张硬顶 12MB。
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 池内条目有效期（毫秒）。 */
export const RAW_TTL_MS = 10 * 60 * 1000

/** 单张硬顶（与 library.maxItemMB 的硬顶一致）。 */
const MAX_BYTES = 12 * 1024 * 1024

/** token 白名单字符集（写死，防路径穿越）。 */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/

/** mediaType → 落盘后缀（不信调用方给的后缀）。 */
const EXT_BY_MEDIA_TYPE = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** 后缀 → mediaType（读回时用）。 */
const MEDIA_TYPE_BY_EXT = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
}

export class RawImageStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 池目录（通常是 dataDir/raw）
   * @param {(level:string, message:string)=>void} [opts.log]
   * @param {number} [opts.ttlMs]
   */
  constructor({ dir, log, ttlMs = RAW_TTL_MS }) {
    this.dir = String(dir ?? '')
    this.log = log ?? (() => {})
    this.ttlMs = Math.max(60_000, Number(ttlMs) || RAW_TTL_MS)
    /** token → { file, mediaType, bytes, at } —— 内存索引，避免每次 readdir。 */
    this._index = new Map()
    this._ready = false
    this._lastSweep = 0
  }

  async _ensureDir() {
    if (this._ready) return
    await mkdir(this.dir, { recursive: true })
    this._ready = true
  }

  /** 重启后重建索引：扫一遍目录，把还在有效期内的条目登记回来。 */
  async load() {
    await this._ensureDir()
    let names = []
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of names) {
      const dot = name.lastIndexOf('.')
      if (dot <= 0) continue
      const token = name.slice(0, dot)
      const ext = name.slice(dot + 1).toLowerCase()
      if (!TOKEN_RE.test(token) || !MEDIA_TYPE_BY_EXT[ext]) continue
      const full = path.join(this.dir, name)
      try {
        const info = await stat(full)
        if (now - info.mtimeMs > this.ttlMs) {
          await rm(full, { force: true })
          continue
        }
        this._index.set(token, {
          file: full,
          mediaType: MEDIA_TYPE_BY_EXT[ext],
          bytes: info.size,
          at: info.mtimeMs,
        })
      } catch { /* 单个文件坏了不影响其它 */ }
    }
  }

  /**
   * 写入一张原始图。
   *
   * @param {object} input
   * @param {string} input.token 桥接给的短 token
   * @param {string} input.mediaType 声明类型（只认 gif/png/jpeg/webp）
   * @param {string} [input.ext] 调用方给的后缀（仅作参考，最终以后缀白名单为准）
   * @param {string} input.dataB64 base64（不带 data: 前缀）
   * @returns {Promise<{ok:boolean, reason?:string, token?:string, bytes?:number, mediaType?:string}>}
   */
  async put({ token, mediaType, ext, dataB64 }) {
    const key = String(token ?? '').trim()
    if (!TOKEN_RE.test(key)) return { ok: false, reason: 'token 必须是 8~64 位 [A-Za-z0-9_-]' }
    // mediaType 优先；它不认识时再看后缀（桥接偶尔只给后缀）
    const declared = String(mediaType ?? '').toLowerCase().trim()
    const bySuffix = MEDIA_TYPE_BY_EXT[String(ext ?? '').toLowerCase().replace(/^\./, '')]
    const resolved = EXT_BY_MEDIA_TYPE[declared] ? declared : bySuffix
    if (!resolved) return { ok: false, reason: `不支持的图片类型：${declared || ext || '未知'}` }

    const raw = String(dataB64 ?? '')
    if (!raw) return { ok: false, reason: 'dataB64 是空的' }
    let buffer
    try {
      buffer = Buffer.from(raw, 'base64')
    } catch {
      return { ok: false, reason: 'base64 解码失败' }
    }
    if (buffer.length === 0) return { ok: false, reason: '解码后是空字节' }
    if (buffer.length > MAX_BYTES) {
      return { ok: false, reason: `单张太大（${(buffer.length / 1048576).toFixed(1)}MB > 12MB）` }
    }

    await this._ensureDir()
    const suffix = EXT_BY_MEDIA_TYPE[resolved]
    const file = path.join(this.dir, `${key}.${suffix}`)
    try {
      await writeFile(file, buffer)
    } catch (error) {
      return { ok: false, reason: `写文件失败：${error?.message ?? error}` }
    }
    this._index.set(key, { file, mediaType: resolved, bytes: buffer.length, at: Date.now() })
    this.maybeSweep()
    return { ok: true, token: key, bytes: buffer.length, mediaType: resolved }
  }

  /**
   * 取一张原始图（不删，可能被 ingest 与发送各用一次）。
   *
   * @param {string} token
   * @returns {Promise<{bytes:number, mediaType:string, path:string, data:Uint8Array}|null>}
   */
  async take(token) {
    const key = String(token ?? '').trim()
    if (!TOKEN_RE.test(key)) return null
    const entry = this._index.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this._index.delete(key)
      await rm(entry.file, { force: true }).catch(() => {})
      return null
    }
    try {
      const data = await readFile(entry.file)
      return { bytes: data.length, mediaType: entry.mediaType, path: entry.file, data: new Uint8Array(data) }
    } catch {
      this._index.delete(key)
      return null
    }
  }

  /** 只查元信息（不读字节）。 */
  peek(token) {
    const entry = this._index.get(String(token ?? '').trim())
    if (!entry) return null
    return { bytes: entry.bytes, mediaType: entry.mediaType, path: entry.file, at: entry.at }
  }

  /** 从文本里抠出所有 `[[qqimg:<token>]]` 标记（顺序即图片顺序）。 */
  static tokensInText(text) {
    const out = []
    const re = /\[\[qqimg:([A-Za-z0-9_-]{8,64})\]\]/g
    let match
    const raw = String(text ?? '')
    while ((match = re.exec(raw)) !== null) out.push(match[1])
    return out
  }

  /** 把标记从文本里删掉（给模型/人看的正文不该有它）。 */
  static stripTokens(text) {
    return String(text ?? '').replace(/\[\[qqimg:[A-Za-z0-9_-]{8,64}\]\]\s*/g, '').trim()
  }

  /** 过期清理：最多 60 秒一次。 */
  maybeSweep(now = Date.now()) {
    if (now - this._lastSweep < 60_000) return
    this._lastSweep = now
    void this.sweep(now)
  }

  /** 真正清过期条目（异步、失败只记日志）。 */
  async sweep(now = Date.now()) {
    for (const [token, entry] of [...this._index]) {
      if (now - entry.at <= this.ttlMs) continue
      this._index.delete(token)
      await rm(entry.file, { force: true }).catch(() => {})
    }
  }

  /** 池子统计（给 /state 与 UI 排障）。 */
  stats() {
    let bytes = 0
    for (const entry of this._index.values()) bytes += entry.bytes
    return { count: this._index.size, bytes }
  }

  /** 挪到新数据目录（改 store.dataDir 后调用）。 */
  async relocate(nextDir) {
    this.dir = String(nextDir ?? '')
    this._index.clear()
    this._ready = false
    await this.load()
  }
}
