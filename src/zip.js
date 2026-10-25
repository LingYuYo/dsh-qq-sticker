/**
 * 手写 ZIP 归档：零第三方依赖，只用 `node:zlib`。
 *
 * 为什么自己写：本项目 Host 侧零运行时依赖（见 util.js 顶部说明）。备份只需要
 * 「把一串文件原样打成一个 zip」，ZIP 规范里够用的只有 4 个结构：
 *   · local file header (0x04034b50)
 *   · 文件数据
 *   · central directory (0x02014b50) 每项一条
 *   · EOCD (0x06054b50)
 * 支持 store（0）与 deflate（8）两种压缩方式，不做 zip64、加密、data descriptor、
 * 分卷 —— 备份几十 MB 的库用不到，真遇到超 4GB 会明确抛错，不静默截断。
 *
 * 文件名的 UTF-8：所有条目都置通用标志位 bit 11（0x0800），并显式按 utf8 编码。
 * 不置这个位时 Windows 资源管理器/Expand-Archive 会按本地代码页解释，中文名会乱码。
 *
 * 解压侧只用于「读回自己产出的备份」，所以只实现 store/deflate，并且逐条校验
 * 长度与 CRC —— 校验失败宁可大声抛错，也不把半截数据当成恢复源。
 */
import zlib from 'node:zlib'
import { promisify } from 'node:util'

/** local file header 签名。 */
const SIG_LOCAL = 0x04034b50
/** central directory header 签名。 */
const SIG_CENTRAL = 0x02014b50
/** end of central directory 签名。 */
const SIG_EOCD = 0x06054b50

/** ZIP 规范要求的最小版本（2.0 = 支持 deflate）。 */
const VERSION_NEEDED = 20
/** "made by" 主机号 0 = MS-DOS/FAT，版本 2.0。低字节版本、高字节主机。 */
const VERSION_MADE_BY = (0 << 8) | 20

/** 通用标志位 bit 11：文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800

/** 单个条目 / 整个归档的上限（不做 zip64）。 */
const MAX_ENTRIES = 0xfffe
const MAX_UINT32 = 0xffffffff

const deflateRawAsync = promisify(zlib.deflateRaw)

/** 混合实现：Node ≥20.15 有原生 crc32，没有就退到查表版。 */
const crc32 = typeof zlib.crc32 === 'function'
  ? (buf) => zlib.crc32(buf) >>> 0
  : crc32Table()

/** 纯 JS CRC32（反射多项式 0xEDB88320），只作为老 Node 的兜底。 */
function crc32Table() {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
}

/** Buffer / Uint8Array / 字符串 → Buffer。字符串按 utf8（调用方自己保证语义）。 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  return Buffer.alloc(0)
}

/**
 * 归档内路径归一化：`\` → `/`、去掉开头斜杠、折叠空段、拒绝 `..`。
 * ZIP 规范只认 `/`，用 `\` 写进去在 Linux 侧会被当成文件名的一部分。
 */
export function normalizeZipName(name) {
  const raw = String(name ?? '').replace(/\\/g, '/')
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0) throw new Error('ZIP 条目名为空')
  if (parts.some((part) => part === '..')) throw new Error(`ZIP 条目名越界：${name}`)
  return parts.join('/')
}

/** JS Date → DOS 日期/时间（1980 起算，2 秒精度）。非法日期用当前时间。 */
function dosDateTime(input) {
  const date = input instanceof Date && Number.isFinite(input.getTime()) ? input : new Date()
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  return { dosDate: dosDate & 0xffff, dosTime: dosTime & 0xffff }
}

/**
 * 打包成一个 ZIP。
 *
 * @param {Array<{name:string, data:Buffer|Uint8Array|string, mtime?:Date}>} entries
 * @param {{deflate?:boolean}} [opts] deflate=true 时对「压得动」的条目用 deflate，
 *   压不动（或空文件）仍存 store —— 这是 ZIP 工具的通行取舍，解压侧两种都支持。
 * @returns {Promise<Buffer>}
 */
export async function createZip(entries, { deflate = false } = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目过多（${list.length} > ${MAX_ENTRIES}），本模块不支持 zip64`)
  }
  // local header 与文件数据必须**交错**排布：local1+data1+local2+data2…，
  // 不能先把所有 local header 拼一起（那样 central directory 里记的 offset 全错）。
  const body = []
  const centrals = []
  let offset = 0

  for (const entry of list) {
    const name = normalizeZipName(entry?.name)
    const data = toBuffer(entry?.data)
    if (data.length > MAX_UINT32) throw new Error(`ZIP 条目过大（${data.length} 字节），本模块不支持 zip64`)

    const nameBuf = Buffer.from(name, 'utf8')
    if (nameBuf.length > 0xffff) throw new Error(`ZIP 条目名过长：${name.slice(0, 40)}…`)
    const { dosDate, dosTime } = dosDateTime(entry?.mtime)
    const checksum = crc32(data)

    let payload = data
    let method = 0
    // 空文件压缩只会变大（deflate 空流 2 字节），直接 store。
    if (deflate && data.length > 0) {
      const compressed = await deflateRawAsync(data, { level: 6 })
      if (compressed.length < data.length) {
        payload = compressed
        method = 8
      }
    }
    if (payload.length > MAX_UINT32) throw new Error(`ZIP 压缩后条目过大：${name}`)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field 长度
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(VERSION_MADE_BY, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // local header offset
    nameBuf.copy(central, 46)

    body.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
    if (offset > MAX_UINT32) throw new Error('ZIP 总大小超过 4GB，本模块不支持 zip64')
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4) // 本磁盘号
  eocd.writeUInt16LE(0, 6) // central directory 起始磁盘号
  eocd.writeUInt16LE(list.length, 8) // 本磁盘条目数
  eocd.writeUInt16LE(list.length, 10) // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16) // central directory 偏移
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...body, centralBuf, eocd])
}

/** 从尾部找 EOCD（允许尾部有注释，最多 65535 字节）。 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) !== SIG_EOCD) continue
    if (i + 22 + buffer.readUInt16LE(i + 20) > buffer.length) continue
    return i
  }
  throw new Error('不是有效的 ZIP：找不到 EOCD')
}

/**
 * 解析 central directory（internal）。
 * @returns {{ entries: Array<object>, centralOffset: number, centralSize: number }}
 */
function readCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = toBuffer(buffer)
  if (buffer.length < 22) throw new Error('不是有效的 ZIP：内容太短')
  const eocd = findEocd(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (total === 0xffff || centralOffset === MAX_UINT32) throw new Error('本模块不支持 zip64 归档')
  if (centralOffset + centralSize > buffer.length) throw new Error('ZIP central directory 越界')

  const entries = []
  let at = centralOffset
  for (let index = 0; index < total; index++) {
    if (at + 46 > buffer.length) throw new Error('ZIP central directory 被截断')
    if (buffer.readUInt32LE(at) !== SIG_CENTRAL) throw new Error('ZIP central directory 签名不对')
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLen = buffer.readUInt16LE(at + 28)
    const extraLen = buffer.readUInt16LE(at + 30)
    const commentLen = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    if (at + 46 + nameLen + extraLen + commentLen > buffer.length) throw new Error('ZIP central directory 条目越界')
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    entries.push({
      name, flags, method, crc, compressedSize, size, localOffset,
    })
    at += 46 + nameLen + extraLen + commentLen
  }
  return { entries, centralOffset, centralSize }
}

/**
 * 列出归档内容（只读 central directory，不解压数据）。
 * @param {Buffer|Uint8Array} buffer
 * @returns {Array<{name:string, size:number, compressedSize:number, crc:number, compression:number, method:'store'|'deflate'}>}
 */
export function listZip(buffer) {
  const { entries } = readCentralDirectory(buffer)
  return entries.map((entry) => ({
    name: entry.name,
    size: entry.size,
    compressedSize: entry.compressedSize,
    crc: entry.crc,
    compression: entry.method,
    method: entry.method === 8 ? 'deflate' : entry.method === 0 ? 'store' : `unknown(${entry.method})`,
  }))
}

/**
 * 解压本模块产出的归档（store / deflate）。
 * 逐条校验解压后长度与 CRC32，不一致直接抛错 —— 备份读回时必须可信。
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<Array<{name:string, data:Buffer}>>}
 */
export async function extractZip(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = toBuffer(buffer)
  const { entries } = readCentralDirectory(buffer)
  const out = []
  for (const entry of entries) {
    const localOffset = entry.localOffset
    if (localOffset + 30 > buffer.length) throw new Error(`ZIP 条目 local header 越界：${entry.name}`)
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`ZIP 条目 local header 签名不对：${entry.name}`)
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const end = start + entry.compressedSize
    if (end > buffer.length) throw new Error(`ZIP 条目数据越界：${entry.name}`)
    const payload = buffer.subarray(start, end)

    let data
    if (entry.method === 0) {
      data = Buffer.from(payload)
    } else if (entry.method === 8) {
      try {
        data = zlib.inflateRawSync(payload)
      } catch (error) {
        throw new Error(`ZIP 条目 deflate 解压失败（${entry.name}）：${error?.message ?? error}`)
      }
    } else {
      throw new Error(`ZIP 条目压缩方式 ${entry.method} 不在支持范围：${entry.name}`)
    }
    if (data.length !== entry.size) {
      throw new Error(`ZIP 条目长度不符（${entry.name}）：期望 ${entry.size}，实际 ${data.length}`)
    }
    if ((crc32(data) >>> 0) !== entry.crc) throw new Error(`ZIP 条目 CRC 不符：${entry.name}`)
    out.push({ name: entry.name, data })
  }
  return out
}
