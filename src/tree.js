/**
 * 物理文件夹分类：把 images/ 从「一堆哈希平铺」改成看得懂的目录树。
 *
 * 布局（相对 images/）：
 *   · 已识别/<标签名>/<标签名>_<哈希前4位>.<ext>      正常已分类
 *   · 已识别/待确认分类/待确认分类_<哈希前4位>.<ext>  ← 人工改标签的唯一入口
 *   · 无意义/无意义_<哈希前4位>.<ext>                 自动判「无意义」
 *   · 无意义/真/<...>                                 人工复核：确实无意义，转待确认
 *   · 无意义/假/<...>                                 人工复核：误判，直接物理删除
 *   · 待删除/待删除_<哈希前4位>.<ext>                 同步时物理删除
 *   · 未识别/未识别_<哈希前4位>.<ext>                 收进来还没打标
 *
 * 人工改标签的约定（2026-10-27 最终版）：
 *   把图从别的目录剪切到 `已识别/待确认分类/`，改名为 `新标签_原哈希.jpg`。
 *   例如 `生气_1d5f.jpg`；也可以在原名后面追加新标签，如 `沙雕_1d5f_生气.jpg`。
 *   解析规则：非哈希词只有一个 → 就是新标签；有多个 → 取**最后一个**
 *   （用户在原名后追加新标签的写法）。占位名 `待确认分类_1d5f.jpg` 不产生标签。
 *
 * 已识别 根目录不再接受散图：扫描到就统一搬进 待确认分类 并清空标签。
 *
 * 约定：item.file 一律存**相对 images/ 的 POSIX 路径**（`已识别/开心/开心_a1b2.jpg`）。
 * Windows 上 `path.join(imagesDir, item.file)` 照样能用；比较/落盘前统一 toPosix()。
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rename } from 'node:fs/promises'

import { fileInfo, removeFile, sha1 } from './util.js'

/** 物理目录名（直接给用户看）。 */
export const TREE_DIRS = {
  identified: '已识别',
  pending: '待确认分类',
  reviewTrue: '真',
  reviewFalse: '假',
  meaningless: '无意义',
  pendingDelete: '待删除',
  untagged: '未识别',
}

/** 顶层分类目录（不含 待确认分类、真、假 —— 它们是嵌套的）。 */
export const TREE_ROOT_NAMES = [
  TREE_DIRS.identified,
  TREE_DIRS.meaningless,
  TREE_DIRS.pendingDelete,
  TREE_DIRS.untagged,
]

/** 图片扩展名（含大小写）。 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i

/** 哈希 token 形态（4~40 位十六进制，允许 `-2` 这类重名后缀）。 */
const HASH_TOKEN_RE = /^[0-9a-f]{4,40}(?:-\d+)?$/i

/** 路径 → POSIX 分隔符（索引里统一用这个）。 */
export function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/** 两个路径是否指同一个文件（Windows 大小写不敏感）。 */
export function samePath(a, b) {
  const left = path.resolve(String(a ?? ''))
  const right = path.resolve(String(b ?? ''))
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/** 绝对路径 → 相对 images/ 的 POSIX 路径。 */
export function relOf(imagesDir, abs) {
  return toPosix(path.relative(imagesDir, abs))
}

/**
 * 标签名 → 能直接当目录名/文件名的安全串。
 *
 * 保留中文（用户就是要看中文目录），只清 Windows 不允许的字符；
 * 顺手挡掉 CON/PRN 这类保留名，免得建目录直接 EINVAL。
 */
export function sanitizeTagName(raw) {
  let text = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!text) text = '未命名'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = `_${text}`
  return text.slice(0, 30)
}

/** 文件名去掉扩展名后的 token（`沙雕_1d5f_生气` → ['沙雕','1d5f','生气']）。 */
function tokensOfName(name) {
  return path.basename(String(name ?? ''))
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/_+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

/**
 * 文件名里的哈希 token（4~40 位十六进制）。认不出返回 ''。
 *
 * 不要求哈希在末尾：`沙雕_1d5f_生气.jpg` 也要能认出 1d5f，否则用户按最终
 * 规则改名后，重启自愈会找不到文件。
 */
export function hashInName(name) {
  const base = path.basename(String(name ?? ''))
  for (const token of tokensOfName(base)) {
    if (HASH_TOKEN_RE.test(token)) return token.toLowerCase()
  }
  // 旧版平铺文件名（`a1b2c3d4e5f6.jpg`）没有下划线，token 循环已经覆盖；
  // 这里再兜一次 `-2` 后缀被点号截断之类的情况。
  const match = /^([0-9a-f]{4,40})(?:-\d+)?\.[a-z0-9]+$/i.exec(base)
  return match?.[1]?.toLowerCase() ?? ''
}

/**
 * 从 `已识别/待确认分类/` 里的文件名解析新标签。
 *
 *   `生气_1d5f.jpg`        → 生气        （只有一个非哈希词）
 *   `沙雕_1d5f_生气.jpg`   → 生气        （多个非哈希词取最后一个）
 *   `待确认分类_1d5f.jpg`  → ''          （占位名，还没想好标签）
 *   `1d5f.jpg`             → ''          （只有哈希）
 *
 * @param {string} name 文件名
 * @returns {string} 标签名，或 '' 表示还没指定
 */
export function pendingTagFromName(name) {
  const tokens = tokensOfName(name)
  const words = tokens.filter((token) => !HASH_TOKEN_RE.test(token))
  if (words.length === 0) return ''
  const tag = words[words.length - 1]
  if (!tag || tag === TREE_DIRS.pending) return ''
  return sanitizeTagName(tag)
}

/** 取条目哈希（默认前 4 位；没有 src 时回退到文件名里的哈希）。 */
export function hashOf(item, len = 4) {
  const src = String(item?.src ?? '').trim()
  if (src) return src.slice(0, Math.max(1, len))
  const hash = hashInName(item?.file ?? '')
  return (hash || 'xxxx').slice(0, Math.max(1, len))
}

/** 条目的图片扩展名（不带点）。 */
export function extOf(item) {
  const ext = String(item?.ext ?? '').trim().toLowerCase()
  if (ext) return ext
  const match = /\.([a-z0-9]+)$/i.exec(toPosix(item?.file ?? ''))
  return (match?.[1] ?? 'jpg').toLowerCase()
}

/** 按分类拼相对路径。 */
export function placementRel(category, tag, hash, ext) {
  const suffix = `.${ext || 'jpg'}`
  if (category === 'meaningless') {
    const label = TREE_DIRS.meaningless
    return `${label}/${label}_${hash}${suffix}`
  }
  if (category === 'identified') {
    const label = sanitizeTagName(tag)
    return `${TREE_DIRS.identified}/${label}/${label}_${hash}${suffix}`
  }
  if (category === 'pending') {
    const label = TREE_DIRS.pending
    return `${TREE_DIRS.identified}/${label}/${label}_${hash}${suffix}`
  }
  const label = TREE_DIRS.untagged
  return `${label}/${label}_${hash}${suffix}`
}

/**
 * 条目**应该**放在哪。
 *
 * `item.pending === true` 优先级最高：这是「等着人工分类」的图，哪怕 tags
 * 里还残留旧值，也先待在 待确认分类。其次是「无意义」哨兵，再按第一个标签。
 *
 * @returns {{category:string, tag:string, rel:string, ext:string}}
 */
export function placementFor(item) {
  const tags = Array.isArray(item?.tags) ? item.tags.map(String) : []
  const ext = extOf(item)
  if (item?.pending === true) {
    return { category: 'pending', tag: '', rel: placementRel('pending', '', hashOf(item, 4), ext), ext }
  }
  if (tags.includes('无意义')) {
    return { category: 'meaningless', tag: '', rel: placementRel('meaningless', '', hashOf(item, 4), ext), ext }
  }
  const tag = tags.find((entry) => entry && entry !== '无意义')
  if (tag) {
    return { category: 'identified', tag, rel: placementRel('identified', tag, hashOf(item, 4), ext), ext }
  }
  return { category: 'untagged', tag: '', rel: placementRel('untagged', '', hashOf(item, 4), ext), ext }
}

/** 是不是我们命名的图片文件（清理孤儿时用；用户自己丢进来的文件不碰）。 */
export function isOurFileName(name) {
  const base = path.basename(String(name ?? ''))
  if (tokensOfName(base).some((token) => HASH_TOKEN_RE.test(token))) return true
  return /^[0-9a-f]{4,40}(?:-\d+)?\.[a-z0-9]+$/i.test(base)
}

/** 建好基础目录（幂等）：四个顶层 + 待确认分类 + 无意义真/假。 */
export async function ensureTreeDirs(imagesDir) {
  for (const name of TREE_ROOT_NAMES) {
    await mkdir(path.join(imagesDir, name), { recursive: true })
  }
  await mkdir(path.join(imagesDir, TREE_DIRS.identified, TREE_DIRS.pending), { recursive: true })
  await mkdir(path.join(imagesDir, TREE_DIRS.meaningless, TREE_DIRS.reviewTrue), { recursive: true })
  await mkdir(path.join(imagesDir, TREE_DIRS.meaningless, TREE_DIRS.reviewFalse), { recursive: true })
}

/**
 * 递归列出图片文件。
 *
 * @param {string} imagesDir
 * @param {{maxDepth?:number, includeImageDirs?:boolean}} [opts]
 *   includeImageDirs=true 时，名字像图片的**目录**也会返回（备份要把它当读取失败记一条）
 * @returns {Promise<Array<{rel:string, abs:string, name:string, dirRel:string, bytes:number, isDir?:boolean}>>}
 */
export async function walkImageFiles(imagesDir, { maxDepth = 5, includeImageDirs = false } = {}) {
  const out = []
  const walk = async (dir, dirRel, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (includeImageDirs && IMAGE_EXT_RE.test(entry.name)) {
          out.push({ rel, abs: path.join(dir, entry.name), name: entry.name, dirRel, bytes: 0, isDir: true })
        }
        if (depth < maxDepth) await walk(path.join(dir, entry.name), rel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!IMAGE_EXT_RE.test(entry.name)) continue
      const info = await fileInfo(path.join(dir, entry.name))
      out.push({ rel, abs: path.join(dir, entry.name), name: entry.name, dirRel, bytes: info.bytes })
    }
  }
  await walk(imagesDir, '', 0)
  return out
}

/**
 * 把相对路径归到某一类（同步时判断用户把图挪到了哪）。
 *
 * 注意 `已识别/待确认分类/<标签>/file` 与 `已识别/<标签>/file` 的区别：
 * 前者是用户手工声明的标签，后者是自动整理结果。
 */
export function categoryOfRel(rel) {
  const parts = toPosix(rel).split('/').filter(Boolean)
  if (parts.length <= 1) return { kind: 'legacy' }
  const top = parts[0]

  if (top === TREE_DIRS.pendingDelete) return { kind: 'pending-delete' }

  if (top === TREE_DIRS.meaningless) {
    if (parts.length === 2) return { kind: 'meaningless', review: '' }
    const review = parts[1]
    if (review === TREE_DIRS.reviewTrue) return { kind: 'meaningless', review: 'true' }
    if (review === TREE_DIRS.reviewFalse) return { kind: 'meaningless', review: 'false' }
    return { kind: 'unknown', reason: `无意义/ 下只认 ${TREE_DIRS.reviewTrue}/ 和 ${TREE_DIRS.reviewFalse}/` }
  }

  if (top === TREE_DIRS.untagged) return { kind: 'untagged' }

  if (top === TREE_DIRS.identified) {
    if (parts.length === 2) return { kind: 'identified-root' }
    const second = parts[1]
    if (second === TREE_DIRS.pending) {
      // 直接放在 待确认分类/ 下 → 从文件名解析；放在子目录里 → 目录名就是标签
      if (parts.length === 3) return { kind: 'pending', tag: '' }
      return { kind: 'pending', tag: parts[2] }
    }
    return { kind: 'identified', tag: second }
  }

  return { kind: 'unknown', reason: `不认识的目录：${top}` }
}

/** 列出 已识别/ 下的标签目录（排除 待确认分类；用户新建的空目录也算）。 */
export async function listTagDirs(imagesDir) {
  try {
    const entries = await readdir(path.join(imagesDir, TREE_DIRS.identified), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== TREE_DIRS.pending)
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** 列出 已识别/待确认分类/ 下用户新建的标签目录。 */
export async function listPendingTagDirs(imagesDir) {
  try {
    const entries = await readdir(
      path.join(imagesDir, TREE_DIRS.identified, TREE_DIRS.pending),
      { withFileTypes: true },
    )
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * 把条目搬到它该在的位置（并在重名时自动加长哈希）。
 *
 * 三种情况：
 *   · 源文件在 → rename 到目标；
 *   · 源文件不在、目标在 → 直接认领目标（多半是上次搬完但索引没落盘）；
 *   · 两边都不在 → missing=true，不动条目（交给 pruneMissingFiles 收）。
 *
 * @returns {Promise<{moved:boolean, adopted:boolean, missing:boolean, rel:string, abs:string, placement:object}>}
 */
export async function relocateItemFile(imagesDir, item) {
  const placement = placementFor(item)
  const sourceRel = toPosix(item?.file)
  const sourceAbs = item?.path || (sourceRel ? path.join(imagesDir, sourceRel) : '')
  const sourceExists = sourceAbs ? (await fileInfo(sourceAbs)).exists : false
  const fullHash = String(item?.src ?? '') || hashOf(item, 40)

  let hashLen = 4
  let suffix = 0
  let rel = placement.rel
  let abs = path.join(imagesDir, rel)
  // 目标被别的文件占着（哈希 4 位撞车）→ 逐位加长，最后加序号兜底。
  while ((await fileInfo(abs)).exists && !(sourceExists && samePath(sourceAbs, abs))) {
    if (hashLen < fullHash.length) {
      hashLen++
      rel = placementRel(placement.category, placement.tag, fullHash.slice(0, hashLen), placement.ext)
    } else {
      suffix++
      rel = placementRel(placement.category, placement.tag, fullHash.slice(0, 40), placement.ext)
        .replace(/(\.[a-z0-9]+)$/i, `-${suffix}$1`)
    }
    abs = path.join(imagesDir, rel)
    if (suffix > 99) throw new Error('同名文件太多，排不下新文件名')
  }

  await mkdir(path.dirname(abs), { recursive: true })

  let moved = false
  let adopted = false
  let missing = false
  if (sourceExists && !samePath(sourceAbs, abs)) {
    await rename(sourceAbs, abs)
    moved = true
  } else if (!sourceExists && !(await fileInfo(abs)).exists) {
    missing = true
  } else if (!sourceExists) {
    adopted = true
  }

  if (!missing) {
    item.file = toPosix(rel)
    item.path = abs
  }
  return { moved, adopted, missing, rel: toPosix(rel), abs, placement }
}

/**
 * 索引里记的路径不在时，按内容哈希在目录树里把文件找回来（只改路径，不改标签）。
 *
 * 这一步专门防「用户手动挪了图 → 重启 DSH → 启动自愈把条目当成文件丢失删掉」。
 * 文件名里的哈希 token 可以出现在中间（`沙雕_1d5f_生气.jpg`），hashInName 会认。
 *
 * @returns {Promise<number>} 找回来的条数
 */
export async function reconcilePaths(imagesDir, items) {
  const files = await walkImageFiles(imagesDir)
  if (files.length === 0) return 0
  const claimed = new Set()
  let adopted = 0
  for (const item of items) {
    const current = item?.path || (item?.file ? path.join(imagesDir, toPosix(item.file)) : '')
    if (current && (await fileInfo(current)).exists) {
      item.file = relOf(imagesDir, current)
      claimed.add(item.file)
      continue
    }
    const src = String(item?.src ?? '')
    if (!src) continue
    const candidates = files.filter((file) => !claimed.has(file.rel) && src.startsWith(hashInName(file.name)))
    if (candidates.length === 0) continue
    let hit = null
    if (candidates.length === 1) {
      // 先用字节数挡一道，避免读到别的东西；大小一致再算 sha1 确认。
      if (!item.bytes || candidates[0].bytes === item.bytes) {
        const bytes = await readFile(candidates[0].abs)
        if (sha1(bytes) === src) hit = candidates[0]
      }
    } else {
      for (const candidate of candidates) {
        try {
          const bytes = await readFile(candidate.abs)
          if (sha1(bytes) === src) { hit = candidate; break }
        } catch { /* 读不到就换下一个 */ }
      }
    }
    if (!hit) continue
    item.file = hit.rel
    item.path = hit.abs
    claimed.add(hit.rel)
    adopted++
  }
  return adopted
}

/** 改一条目标的文件名去重（同目录重名时加 -2、-3）。 */
async function uniqueAbs(imagesDir, targetRel) {
  let rel = targetRel
  let abs = path.join(imagesDir, rel)
  let index = 1
  while ((await fileInfo(abs)).exists) {
    index++
    rel = targetRel.replace(/(\.[a-z0-9]+)$/i, `-${index}$1`)
    abs = path.join(imagesDir, rel)
    if (index > 99) throw new Error('同名文件太多，排不下新文件名')
  }
  return { rel, abs }
}

/**
 * 分析目录树 → 生成一份「同步计划」（只读，不改任何东西）。
 *
 * 规则（最终版）：
 *   · `待确认分类/新标签_哈希.ext` → 取文件名里的**最后一个非哈希词**当新标签；
 *   · `待确认分类/<新标签>/file`   → 目录名当新标签；
 *   · `待确认分类/` 下解析不出标签 → 留在待确认分类，清空标签；
 *   · `已识别/` 根目录散图          → 搬进待确认分类，清空标签；
 *   · `无意义/真/`                 → 搬进待确认分类，清空标签；
 *   · `无意义/假/`                 → 物理删除；
 *   · `已识别/<标签>/`             → 只有和自动位置不一致才算人工改标签；
 *   · `待删除/`                    → 物理删除；
 *   · 认不出的文件                  → 只报告，不删不改（假/待删除 例外：用户明确要删）。
 *
 * @param {object} opts
 * @param {string} opts.imagesDir
 * @param {Array<object>} opts.items 库条目
 * @param {Set<string>} [opts.knownTags] 已知标签词表（用来判断「新标签目录」）
 * @returns {Promise<object>}
 */
export async function analyzeTree({ imagesDir, items, knownTags } = {}) {
  await ensureTreeDirs(imagesDir)
  const files = await walkImageFiles(imagesDir)
  const itemBySrc = new Map()
  for (const item of items ?? []) {
    if (item?.src && !itemBySrc.has(item.src)) itemBySrc.set(item.src, item)
  }
  const usedKeys = new Set()
  const unknown = []
  const duplicates = []
  const changes = []
  const deletes = []
  /** 认不出库条目、但用户明确要求挪/删的文件（按物理路径处理）。 */
  const moves = []
  let unchanged = 0

  for (const file of files) {
    const category = categoryOfRel(file.rel)
    let item = null
    const prefix = hashInName(file.name)
    if (prefix) {
      const candidates = (items ?? []).filter((entry) => entry?.src && entry.src.startsWith(prefix))
      if (candidates.length === 1 && (!candidates[0].bytes || candidates[0].bytes === file.bytes)) {
        item = candidates[0]
      }
    }
    if (!item) {
      try {
        const src = sha1(await readFile(file.abs))
        item = itemBySrc.get(src) ?? null
      } catch {
        item = null
      }
    }

    // 用户明确丢进「删除区」的，不管库里有不有都要删
    if (category.kind === 'pending-delete'
      || (category.kind === 'meaningless' && category.review === 'false')) {
      let owner = item
      if (owner && usedKeys.has(owner.key)) owner = null
      if (owner) usedKeys.add(owner.key)
      deletes.push({ rel: file.rel, abs: file.abs, item: owner })
      continue
    }

    if (!item) {
      // 认不出库条目：散图 / 无意义/真 仍按用户意图搬进待确认分类
      if (category.kind === 'identified-root'
        || (category.kind === 'meaningless' && category.review === 'true')) {
        let hash = hashInName(file.name)
        if (!hash) {
          try { hash = sha1(await readFile(file.abs)).slice(0, 4) } catch { hash = '' }
        }
        if (hash) {
          moves.push({
            from: file.rel,
            fromAbs: file.abs,
            to: placementRel('pending', '', hash.slice(0, 4), extOf({ file: file.name })),
          })
          continue
        }
      }
      unknown.push({ rel: file.rel, name: file.name, reason: '库里没有这张图（插件不自动导入陌生文件）' })
      continue
    }

    if (usedKeys.has(item.key)) {
      duplicates.push({ rel: file.rel, id: item.src?.slice(0, 10) ?? '', reason: '同一张图在目录里出现了多份' })
      continue
    }
    usedKeys.add(item.key)

    if (category.kind === 'unknown') {
      unknown.push({ rel: file.rel, name: file.name, reason: category.reason })
      continue
    }

    // 关键：先看「按数据库标签，这张图本来该在哪个目录」。
    // 文件夹和它一致 → 是自动整理的结果，不能动标签（多标签取第一个当目录，
    // 其余标签必须保留）；只有文件夹**跟自动位置不一致**才算用户手动挪过。
    const auto = placementFor(item)
    const autoTag = auto.category === 'identified' ? sanitizeTagName(auto.tag) : ''
    let desiredTags = [...(item.tags ?? [])]
    let desiredPending = item.pending === true
    let manual = false

    if (category.kind === 'identified') {
      const folderTag = sanitizeTagName(category.tag)
      if (folderTag !== autoTag) {
        desiredTags = [folderTag]
        desiredPending = false
        manual = true
      }
    } else if (category.kind === 'pending') {
      const tag = category.tag ? sanitizeTagName(category.tag) : pendingTagFromName(file.name)
      if (tag) {
        desiredTags = [tag]
        desiredPending = false
      } else {
        desiredTags = []
        desiredPending = true
      }
      manual = true
    } else if (category.kind === 'identified-root') {
      // 已识别 根目录不再接受散图：统一进待确认分类，清空标签
      desiredTags = []
      desiredPending = true
      manual = true
    } else if (category.kind === 'meaningless') {
      if (category.review === 'true') {
        desiredTags = []
        desiredPending = true
        manual = true
      } else {
        // 直接放在 无意义/ 下的图：保持「无意义」
        if (!(item.tags ?? []).includes('无意义')) desiredTags = ['无意义']
        desiredPending = false
      }
    } else if (category.kind === 'untagged') {
      if ((item.tags ?? []).length > 0 || item.pending === true) {
        desiredTags = []
        desiredPending = false
        manual = true
      }
    }

    const tagChanged = JSON.stringify(item.tags ?? []) !== JSON.stringify(desiredTags)
    const pendingChanged = (item.pending === true) !== desiredPending
    const desired = placementFor({ ...item, tags: desiredTags, pending: desiredPending })
    const pathChanged = file.rel !== desired.rel
    if (!tagChanged && !pendingChanged && !pathChanged) {
      unchanged++
      continue
    }
    changes.push({
      item,
      from: file.rel,
      fromAbs: file.abs,
      to: desired.rel,
      tags: desiredTags,
      pending: desiredPending,
      tagChanged,
      pendingChanged,
      pathChanged,
      manual,
    })
  }

  // 新标签目录：已识别/ 下的（排除待确认分类）+ 待确认分类/ 下的
  const known = knownTags ?? new Set()
  const tagFolders = await listTagDirs(imagesDir)
  const pendingTagFolders = await listPendingTagDirs(imagesDir)
  const newTags = [...new Set([...tagFolders, ...pendingTagFolders])]
    .filter((tag) => tag && tag !== TREE_DIRS.pending && !known.has(tag))

  const missing = (items ?? []).filter((item) => item?.key && !usedKeys.has(item.key)).length

  return {
    scanned: files.length,
    matched: usedKeys.size,
    unchanged,
    unknown,
    duplicates,
    changes,
    deletes,
    moves,
    newTags,
    tagFolders,
    pendingTagFolders,
    missing,
  }
}

/**
 * 执行同步计划。
 *
 * @param {object} plan analyzeTree 的结果
 * @param {object} opts
 * @param {object} opts.library 库实例（提供 removeItem / touch / rememberTag）
 * @param {string} opts.imagesDir
 * @param {boolean} [opts.dryRun]
 * @returns {Promise<object>}
 */
export async function applyTreePlan(plan, { library, imagesDir, dryRun = false } = {}) {
  const result = {
    dryRun,
    scanned: plan.scanned,
    matched: plan.matched,
    unchanged: plan.unchanged,
    deleted: 0,
    retagged: 0,
    moved: 0,
    adopted: 0,
    pending: 0,
    unknown: plan.unknown.length,
    duplicates: plan.duplicates.length,
    newTags: plan.newTags,
    corrections: [],
    errors: [],
  }
  const tagChangedEntries = plan.changes.filter((entry) => entry.tagChanged)
  const pendingEntries = plan.changes.filter((entry) => entry.pendingChanged)
  if (dryRun) {
    result.deleted = plan.deletes.length
    result.retagged = tagChangedEntries.length
    result.moved = plan.changes.filter((entry) => entry.pathChanged).length + plan.moves.length
    result.pending = pendingEntries.length + plan.moves.length
    result.corrections = tagChangedEntries.map((entry) => ({
      id: String(entry.item.src ?? '').slice(0, 10),
      from: [...(entry.item.tags ?? [])],
      to: entry.tags,
    }))
    return result
  }

  // ① 删除区：物理删文件 + 删索引条目（认不出的文件也删）
  for (const entry of plan.deletes) {
    try {
      if (entry.item) {
        entry.item.file = entry.rel
        entry.item.path = entry.abs
        const removed = await library.removeItem(entry.item)
        if (removed) result.deleted++
      } else {
        await removeFile(entry.abs)
        result.deleted++
      }
    } catch (error) {
      result.errors.push(`删除 ${entry.rel} 失败：${error?.message ?? error}`)
    }
  }

  // ② 认不出条目、但用户要求搬进待确认分类的散图（只动文件）
  for (const entry of plan.moves) {
    try {
      const target = await uniqueAbs(imagesDir, entry.to)
      await mkdir(path.dirname(target.abs), { recursive: true })
      await rename(entry.fromAbs, target.abs)
      result.moved++
      result.pending++
    } catch (error) {
      result.errors.push(`移动 ${entry.from} 失败：${error?.message ?? error}`)
    }
  }

  // ③ 改标签 / 换位置（人工修正要留痕，后续打标不能把它盖回去）
  for (const entry of plan.changes) {
    try {
      const item = entry.item
      const before = [...(item.tags ?? [])]
      item.tags = [...new Set(entry.tags.map(String).map((tag) => tag.trim()).filter(Boolean))].slice(0, 6)
      item.pending = entry.pending === true
      item.tagTriedAt = Date.now()
      if (entry.manual && (entry.tagChanged || entry.pendingChanged)) {
        item.manualTag = item.tags[0] ?? ''
        item.manualTagFrom = before
        item.manualTagAt = Date.now()
        item.manualEdits = Math.max(0, Number(item.manualEdits) || 0) + 1
      }
      if (entry.tagChanged) {
        result.corrections.push({
          id: String(item.src ?? '').slice(0, 10),
          from: before,
          to: [...item.tags],
        })
      }
      // 先把路径对齐到用户实际放的位置，再交给 relocate 统一改名
      item.file = entry.from
      item.path = entry.fromAbs
      const placed = await relocateItemFile(imagesDir, item)
      if (placed.moved) result.moved++
      if (placed.adopted) result.adopted++
      if (entry.tagChanged) result.retagged++
      if (entry.pendingChanged) result.pending++
      library.touch?.()
    } catch (error) {
      result.errors.push(`同步 ${entry.from} 失败：${error?.message ?? error}`)
    }
  }

  // ④ 新标签目录：写进库的额外词表（即使 settings 不可用，也不会丢）
  for (const tag of plan.newTags ?? []) {
    library.rememberTag?.(tag)
  }
  library.touch?.()
  return result
}
