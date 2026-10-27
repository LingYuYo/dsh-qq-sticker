/**
 * 物理文件夹分类：把 images/ 从「一堆哈希平铺」改成看得懂的目录树。
 *
 * 布局（相对 images/）——2026-10-27 定稿版：
 *   · images/未识别_<哈希前4位>.<ext>                 收进来还没打标（**根目录 = 未识别**）
 *   · 已识别/<标签名>/<标签名>_<哈希前4位>.<ext>      正常已分类（唯一可发送来源）
 *   · 已识别/待确认分类/<...>                         人工改标签的唯一入口
 *   · 无意义/无意义_<哈希前4位>.<ext>                  自动判「无意义」
 *   · 无意义/待恢复/<...>                             人工复核：误判，退回根目录重新当未识别
 *   · 无意义/待删除/<...>                             人工复核：确实没用，物理删除
 *   · 待删除/待删除_<哈希前4位>.<ext>                  同步时物理删除
 *
 * ⚠️ 不再有 `images/未识别/` 子目录：根目录下的图片文件一律视为未识别。
 *
 * 人工改标签的约定：
 *   把图从别的目录剪切到 `已识别/待确认分类/`，改名为 `新标签_原哈希.jpg`。
 *   例如 `生气_1d5f.jpg`；也可以在原名后面追加新标签，如 `沙雕_1d5f_生气.jpg`。
 *   解析规则：非哈希词只有一个 → 就是新标签；有多个 → 取**最后一个**
 *   （用户在原名后追加新标签的写法）。占位名 `待确认分类_1d5f.jpg` 不产生标签。
 *
 * 约定：item.file 一律存**相对 images/ 的 POSIX 路径**（`已识别/开心/开心_a1b2.jpg`、
 * 根目录的图就是 `未识别_a1b2.jpg`）。Windows 上 `path.join(imagesDir, item.file)`
 * 照样能用；比较/落盘前统一 toPosix()。
 */
import path from 'node:path'
import { mkdir, readFile, readdir, rename, rmdir } from 'node:fs/promises'

import { fileInfo, removeFile, sha1 } from './util.js'

/**
 * 物理目录名（直接给用户看）。
 *
 * 注意 `待删除` 出现两次：顶层 `images/待删除/` 与 `images/无意义/待删除/`。
 * 两者在目录树里位置不同，判断一律用路径段，不靠名字区分。
 */
export const TREE_DIRS = {
  identified: '已识别',
  pending: '待确认分类',
  reviewRestore: '待恢复',
  reviewDelete: '待删除',
  meaningless: '无意义',
  pendingDelete: '待删除',
  /** 根目录文件名前缀（不再有同名子目录）。 */
  untagged: '未识别',
}

/** 顶层分类目录（待确认分类 / 待恢复 / 无意义下的待删除 是嵌套的，不在这里）。 */
export const TREE_ROOT_NAMES = [
  TREE_DIRS.identified,
  TREE_DIRS.meaningless,
  TREE_DIRS.pendingDelete,
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
  return stripCopySuffix(path.basename(String(name ?? '')).replace(/\.[a-z0-9]+$/i, ''))
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
  // 整名先剥副本尾巴再切片：`震惊 (2)_1d5f.jpg` 剥完是 `震惊_1d5f`，
  // 不先剥的话最后一个词会变成「震惊 (2)」，建出带括号的目录。
  const base = stripCopySuffix(path.basename(String(name ?? '')).replace(/\.[a-z0-9]+$/i, ''))
  const tokens = base.split(/_+/).map((token) => stripCopySuffix(token)).filter(Boolean)
  const words = tokens.filter((token) => !HASH_TOKEN_RE.test(token))
  if (words.length === 0) return ''
  const tag = words[words.length - 1]
  if (!tag || tag === TREE_DIRS.pending) return ''
  return normalizeTagName(tag)
}

/** 取条目哈希（默认前 4 位；没有 src 时回退到文件名里的哈希）。 */
export function hashOf(item, len = 4) {
  const src = String(item?.src ?? '').trim()
  if (src) return src.slice(0, Math.max(1, len))
  const hash = hashInName(item?.file ?? '')
  return (hash || 'xxxx').slice(0, Math.max(1, len))
}

/**
 * 条目的图片扩展名（不带点）。
 *
 * 优先用**磁盘上文件名**的后缀：用户把图改名为 `开心_随便打的字.jpg` 时，规范化
 * 后的目标名也该保留他这个后缀（而不是偷偷改成 sniff 出来的真格式）。文件名后缀
 * 不是图片格式时再退回 `item.ext`（入库时 sniff 出来的真格式）。
 */
export function extOf(item) {
  const match = /\.([a-z0-9]+)$/i.exec(toPosix(item?.file ?? ''))
  if (match) {
    const fromFile = match[1].toLowerCase()
    if (IMAGE_EXT_RE.test(`.${fromFile}`)) return fromFile
  }
  const ext = String(item?.ext ?? '').trim().toLowerCase()
  return ext || 'jpg'
}

/**
 * 按分类拼相对路径。
 *
 * `untagged` 直接落 `images/` 根目录：`未识别_<hash>.<ext>`。
 */
export function placementRel(category, tag, hash, ext) {
  const suffix = `.${ext || 'jpg'}`
  if (category === 'meaningless') {
    const label = TREE_DIRS.meaningless
    return `${label}/${label}_${hash}${suffix}`
  }
  if (category === 'identified') {
    // ⚠️ 用 normalizeTagName（先剥副本尾巴）：`震惊 (2)` 必须落进 `已识别/震惊/`，
    //    而不是建一个带括号的新目录。
    const label = normalizeTagName(tag)
    return `${TREE_DIRS.identified}/${label}/${label}_${hash}${suffix}`
  }
  if (category === 'pending') {
    const label = TREE_DIRS.pending
    return `${TREE_DIRS.identified}/${label}/${label}_${hash}${suffix}`
  }
  const label = TREE_DIRS.untagged
  return `${label}_${hash}${suffix}`
}

/**
 * 条目**应该**放在哪。
 *
 * `item.pending === true` 优先级最高（等着人工分类的图，哪怕 tags 里还残留旧值，
 * 也先待在 待确认分类）。其次是「无意义」哨兵，再按第一个标签，最后是未识别（根目录）。
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

/**
 * 这条条目能不能被模型挑去发送。
 *
 * ⚠️ 这是**唯一**的发送资格判定，pick / send / 提示词候选 / 主动发图全都走它。
 * 条件（全部满足）：
 *   · 没隐藏、不是待确认分类、没进剔除名单；
 *   · 至少一个标签，且不含「无意义」；
 *   · 物理上确实躺在 `已识别/<标签>/` 里（不在根目录、无意义/、待删除/、待确认分类/）。
 *
 * 2026-10-27 真机事故：未识别目录里的图被模型发出去了 —— 当时只挡了
 * hidden / pending / 无意义，没挡「没标签」，也没看物理目录。
 *
 * @param {object} item
 * @param {object} [config] 归一化配置（用来读剔除名单）
 * @returns {boolean}
 */
export function isSendable(item, config) {
  if (!item || item.hidden === true) return false
  if (item.pending === true) return false
  const tags = Array.isArray(item.tags) ? item.tags.map(String) : []
  if (tags.length === 0) return false
  if (tags.includes('无意义')) return false
  const blocked = new Set(config?.library?.blockedIds ?? [])
  const hiddenIds = new Set(config?.library?.hiddenIds ?? [])
  const sid = String(item.src ?? '').slice(0, 10) || path.basename(toPosix(item.file ?? '')).replace(/\.[a-z0-9]+$/i, '')
  if (blocked.has(sid) || (item.src && blocked.has(String(item.src)))) return false
  if (hiddenIds.has(sid)) return false
  // 物理目录必须是 已识别/<标签>/，不能是 已识别/待确认分类/ 或根目录
  const parts = toPosix(item.file).split('/').filter(Boolean)
  if (parts.length < 3) return false
  if (parts[0] !== TREE_DIRS.identified) return false
  if (parts[1] === TREE_DIRS.pending) return false
  return true
}

/**
 * 去掉所有「副本 / 重名」尾巴：`(1)`、`(2)`、`（3）`、`- 副本`、`_副本`。
 *
 * 资源管理器里再存一份会自动加这些后缀：
 *   `震惊.jpg` → `震惊 (2).jpg`、`震惊(3).jpg`、`震惊（4）.jpg`（中文输入法全角括号）
 *   `震惊.jpg` → `震惊 - 副本.jpg`
 *
 * ⚠️ 必须**先剥再解析**，否则 `震惊 (2)` 会变成一个叫「震惊 (2)」的标签、
 * 建出 `已识别/震惊 (2)/` 这种脏目录。2026-10-27 真机就是这么炸的：
 * 根目录放 `震惊 (1).jpg` / `震惊 (2).jpg`，同步后多出两个带括号的目录。
 *
 * ⚠️ 与旧版的区别：**不再只剥结尾**。旧的 `$` 锚定版本对
 * `震惊 (2)_1d5f.jpg`（括号在中间）无效，而且目录名
 * `已识别/震惊 (2)/` 完全走的是另一条路（目录名当标签），压根没过这个函数。
 * 现在改成全文替换，文件名与目录名共用。
 *
 * `副本` 仍要求带分隔符（`- 副本` / `_副本` / ` - 副本`），
 * 免得把真叫「震惊副本」的标签吃掉。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCopySuffix(text) {
  let out = String(text ?? '').trim()
  // 连剥几轮：`震惊 (2) (3)` 这类叠了两层的也要干净（replace 带 g 已能一次去多个，
  // 但括号里套括号这种残缺写法要靠第二轮回稳）
  for (let round = 0; round < 5; round++) {
    const next = out
      .replace(/[\s_\-—]*[（(]\s*\d{1,3}\s*[)）]/gu, '')
      .replace(/[\s_\-—]+副本/gu, '')
      .trim()
    if (next === out) break
    out = next
  }
  return out
}

/**
 * 标签名统一清洗：去副本尾巴 → 清非法字符 → 限长。
 *
 * 文件名的标签解析、目录名的标签解析、以及入库时的标签，全都走这里，
 * 保证「同一个标签只有一种写法」（不会同时存在 `震惊` 和 `震惊 (2)`）。
 */
export function normalizeTagName(raw) {
  return sanitizeTagName(stripCopySuffix(raw))
}

/** 是不是我们命名的图片文件（**只用于识别命名格式，绝不能用来决定删不删**）。 */
export function isOurFileName(name) {
  const base = path.basename(String(name ?? ''))
  if (tokensOfName(base).some((token) => HASH_TOKEN_RE.test(token))) return true
  return /^[0-9a-f]{4,40}(?:-\d+)?\.[a-z0-9]+$/i.test(base)
}

/**
 * 从**根目录**文件名解析新标签（铁律二）。
 *
 *   `开心.jpg`            → 开心      （去掉扩展名就是标签）
 *   `开心_1d5f.jpg`       → 开心      （第一个下划线前的词）
 *   `开心_随便打的字.jpg`  → 开心
 *   `开心_1d5f_未识别.jpg` → 开心      （只看第一段）
 *   `震惊 (2).jpg`        → 震惊      （Windows 重名尾巴先剥掉）
 *   `震惊（2）.jpg`       → 震惊      （全角括号同样处理）
 *   `震惊 - 副本.jpg`     → 震惊
 *   `未识别_1d5f.jpg`     → ''        （未识别占位名，不产生标签）
 *   `a1b2c3d4.jpg`        → ''        （纯哈希/乱码，当未识别）
 *
 * @param {string} name 文件名
 * @returns {string} 标签名，或 '' 表示没有标签（当未识别）
 */
export function rootTagFromName(name) {
  // ⚠️ 顺序：**先 trim、去扩展名，再剥副本尾巴**。
  //    反过来的话 `震惊 - 副本.jpg` 里的 `.jpg` 还挂在末尾，
  //    正则匹配「- 副本」后面有 `.jpg`，剥不干净 → 得到 `震惊.jpg`。
  //    同理 ` 震惊 (2).jpg ` 这种带空格的，不 trim 则扩展名正则也匹配不上。
  const base = stripCopySuffix(path.basename(String(name ?? '')).trim().replace(/\.[a-z0-9]+$/i, ''))
  // 按「第一个空格或下划线」切：`震惊 (1)` 剥完是 `震惊`；
  // 万一括号没剥干净（`震惊 别的`），空格也能兜住。
  const first = base.split(/[\s_]+/u)[0].trim()
  if (!first) return ''
  // 占位名 / 纯哈希 → 没有标签
  if (first === TREE_DIRS.untagged) return ''
  if (first === TREE_DIRS.pending) return ''
  if (first === TREE_DIRS.identified) return ''
  if (first === TREE_DIRS.meaningless) return '无意义'
  if (HASH_TOKEN_RE.test(first)) return ''
  return normalizeTagName(first)
}

/**
 * 根目录文件名是不是已经规范。
 *
 * 规范 = `未识别_<4~40位hex>.<ext>`，或 `<标签>_<4~40位hex>.<ext>`。
 * 不规范就要改名（用户随便写 `开心.jpg` / `dsfgsdfg.jpg` 都算）。
 */
export function isCanonicalRootName(name) {
  const base = path.basename(String(name ?? ''))
  const match = /^(.+?)_([0-9a-f]{4,40}(?:-\d+)?)\.[a-z0-9]+$/i.exec(base)
  return Boolean(match)
}

/** 建好基础目录（幂等）：三个顶层 + 待确认分类 + 无意义/待恢复 + 无意义/待删除。 */
export async function ensureTreeDirs(imagesDir) {
  for (const name of TREE_ROOT_NAMES) {
    await mkdir(path.join(imagesDir, name), { recursive: true })
  }
  await mkdir(path.join(imagesDir, TREE_DIRS.identified, TREE_DIRS.pending), { recursive: true })
  await mkdir(path.join(imagesDir, TREE_DIRS.meaningless, TREE_DIRS.reviewRestore), { recursive: true })
  await mkdir(path.join(imagesDir, TREE_DIRS.meaningless, TREE_DIRS.reviewDelete), { recursive: true })
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
 * 根目录（只有文件名、没有目录） = 未识别。
 */
export function categoryOfRel(rel) {
  const parts = toPosix(rel).split('/').filter(Boolean)
  if (parts.length <= 1) return { kind: 'untagged' }
  const top = parts[0]

  if (top === TREE_DIRS.pendingDelete) return { kind: 'pending-delete' }

  if (top === TREE_DIRS.meaningless) {
    if (parts.length === 2) return { kind: 'meaningless', review: '' }
    const review = parts[1]
    if (review === TREE_DIRS.reviewRestore) return { kind: 'meaningless', review: 'restore' }
    if (review === TREE_DIRS.reviewDelete) return { kind: 'meaningless', review: 'delete' }
    return {
      kind: 'unknown',
      reason: `无意义/ 下只认 ${TREE_DIRS.reviewRestore}/ 和 ${TREE_DIRS.reviewDelete}/`,
    }
  }

  if (top === TREE_DIRS.identified) {
    if (parts.length === 2) return { kind: 'identified-root' }
    const second = parts[1]
    if (second === TREE_DIRS.pending) {
      // 直接放在 待确认分类/ 下 → 从文件名解析；放在子目录里 → 目录名就是标签
      if (parts.length === 3) return { kind: 'pending', tag: '' }
      return { kind: 'pending', tag: normalizeTagName(parts[2]) }
    }
    // ⚠️ 目录名也要清洗：`已识别/震惊 (2)/` 是脏目录（早期版本按重名文件名建的），
    //    它的标签必须解析成「震惊」而不是「震惊 (2)」。
    return { kind: 'identified', tag: normalizeTagName(second) }
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
 * 找出 `已识别/` 下的**脏标签目录**并合并回干净的标签目录。
 *
 * 2026-10-27 真机：根目录放 `震惊 (1).jpg` / `震惊 (2).jpg`，早期版本按
 * 文件名里那个没剥干净的词建出了 `已识别/震惊 (2)/`、`已识别/震惊 (3)/`。
 * 修了正则只保证**以后**不再建脏目录，已经建出来的还得收回来。
 *
 * 判定：目录名剥掉副本尾巴后 ≠ 目录名本身，就是脏的。
 *   `震惊 (2)` → 干净名 `震惊`
 *   `开心`     → 不变，不是脏目录
 *
 * @param {string} imagesDir
 * @returns {Promise<Array<{dirty:string, clean:string, abs:string, cleanAbs:string}>>}
 */
export async function findDirtyTagDirs(imagesDir) {
  const out = []
  const identifiedDir = path.join(imagesDir, TREE_DIRS.identified)
  let entries
  try {
    entries = await readdir(identifiedDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name === TREE_DIRS.pending) continue
    const clean = normalizeTagName(entry.name)
    if (!clean || clean === entry.name) continue
    out.push({
      dirty: entry.name,
      clean,
      abs: path.join(identifiedDir, entry.name),
      cleanAbs: path.join(identifiedDir, clean),
    })
  }
  return out
}

/**
 * 把脏目录里的图搬到干净目录，然后删掉空掉的脏目录。
 *
 * ⚠️ 只**移动 + 删空目录**，绝不删里面的图片：
 *   · 目标重名就加 `-2`、`-3` 后缀（不覆盖）；
 *   · 脏目录里还有搬不动的（被占用 / 子目录）：保留，只记 note。
 *
 * @param {string} imagesDir
 * @param {object} [opts]
 * @param {(from:string, to:string)=>void} [opts.onMove] 每搬一张回调（用于同步索引）
 * @returns {Promise<{merged:string[], moved:number, removedDirs:string[], notes:string[]}>}
 */
export async function mergeDirtyTagDirs(imagesDir, { onMove } = {}) {
  const dirty = await findDirtyTagDirs(imagesDir)
  const merged = []
  const removedDirs = []
  const notes = []
  let moved = 0
  for (const entry of dirty) {
    await mkdir(entry.cleanAbs, { recursive: true })
    let names = []
    try {
      names = (await readdir(entry.abs, { withFileTypes: true }))
        .filter((item) => item.isFile() && !item.name.startsWith('.') && IMAGE_EXT_RE.test(item.name))
        .map((item) => item.name)
    } catch {
      continue
    }
    for (const name of names) {
      const sourceAbs = path.join(entry.abs, name)
      // 目标文件名也顺手规范化：脏目录里的文件可能叫 `震惊 (2)_abcd.jpg`
      const cleanName = `${normalizeTagName(name.replace(/\.[a-z0-9]+$/i, ''))}${path.extname(name)}`
      const target = await uniqueAbs(imagesDir, `${TREE_DIRS.identified}/${entry.clean}/${cleanName}`)
      try {
        await mkdir(path.dirname(target.abs), { recursive: true })
        await rename(sourceAbs, target.abs)
        moved++
        onMove?.(`${TREE_DIRS.identified}/${entry.dirty}/${name}`, target.rel)
      } catch (error) {
        notes.push(`${entry.dirty}/${name} 搬不动：${error?.message ?? error}`)
      }
    }
    // 空目录才删（窗口里还开着资源管理器时会失败，忽略即可）
    try {
      const rest = (await readdir(entry.abs)).filter((name) => !name.startsWith('.'))
      if (rest.length === 0) {
        await rmdir(entry.abs)
        removedDirs.push(entry.dirty)
        merged.push(`${entry.dirty} → ${entry.clean}`)
      } else {
        notes.push(`${entry.dirty}/ 里还剩 ${rest.length} 项（不是图片？），目录先留着`)
      }
    } catch { /* 目录不存在 / 被占用：不影响合并结果 */ }
  }
  return { merged, moved, removedDirs, notes }
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

/** 把目录里的文件全搬到另一个目录（同目录重名自动加后缀），成功后删空目录。 */
async function drainDir(imagesDir, fromDirRel, toDirRel) {
  let movedCount = 0
  const fromAbs = path.join(imagesDir, fromDirRel)
  let entries
  try {
    entries = await readdir(fromAbs, { withFileTypes: true })
  } catch {
    return movedCount
  }
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXT_RE.test(entry.name) || entry.name.startsWith('.')) continue
    const sourceAbs = path.join(fromAbs, entry.name)
    const targetName = entry.name
    const target = await uniqueAbs(imagesDir, toDirRel ? `${toDirRel}/${targetName}` : targetName)
    await mkdir(path.dirname(target.abs), { recursive: true })
    try {
      await rename(sourceAbs, target.abs)
      movedCount++
    } catch { /* 单张失败就留着，后面还能手动处理 */ }
  }
  // 空目录就删掉（窗口浏览时被占用会失败，忽略即可）
  try {
    const rest = (await readdir(fromAbs)).filter((name) => !name.startsWith('.'))
    if (rest.length === 0 && fromDirRel) await rmdir(fromAbs)
  } catch { /* 目录不存在 / 被占用：都不影响 */ }
  return movedCount
}

/**
 * 旧布局迁移（启动时跑一次，幂等）：
 *
 *   ① `images/未识别/` 里的图全部搬回 `images/` 根目录，然后删掉这个子目录；
 *   ② `无意义/真` → `无意义/待恢复`，`无意义/假` → `无意义/待删除`；
 *   ③ 两个目录都存在时按文件合并（不覆盖）。
 *
 * @returns {Promise<{movedToRoot:number, renamed:string[], merged:number, notes:string[]}>}
 */
export async function migrateLayout(imagesDir) {
  const notes = []
  const renamed = []
  let merged = 0

  // ⚠️ 顺序很重要：**先改名，后建目录**。ensureTreeDirs 会预建 待恢复/待删除，
  // 先建的话「真→待恢复」会被误判成"目标已存在 → 逐文件合并"，就报不出改名的结果。
  //
  // ① 真 / 假 → 待恢复 / 待删除
  const pairs = [
    { from: '真', to: TREE_DIRS.reviewRestore },
    { from: '假', to: TREE_DIRS.reviewDelete },
  ]
  for (const pair of pairs) {
    const fromAbs = path.join(imagesDir, TREE_DIRS.meaningless, pair.from)
    const toAbs = path.join(imagesDir, TREE_DIRS.meaningless, pair.to)
    if (!(await fileInfo(fromAbs)).exists) continue
    // 目标目录存在但为空（上次建的）也算"没占用"，直接改名
    let targetFree = !(await fileInfo(toAbs)).exists
    if (!targetFree) {
      try {
        targetFree = (await readdir(toAbs)).length === 0
      } catch { targetFree = false }
    }
    if (targetFree) {
      try {
        await mkdir(path.dirname(toAbs), { recursive: true })
        if ((await fileInfo(toAbs)).exists) await rmdir(toAbs)
        await rename(fromAbs, toAbs)
        renamed.push(`无意义/${pair.from} → 无意义/${pair.to}`)
        continue
      } catch (error) {
        notes.push(`无意义/${pair.from} 改名失败：${error?.message ?? error}`)
      }
    }
    // 目标已存在且有东西：逐文件合并，然后清空旧目录
    const moved = await drainDir(imagesDir, `${TREE_DIRS.meaningless}/${pair.from}`, `${TREE_DIRS.meaningless}/${pair.to}`)
    merged += moved
    if (moved > 0) notes.push(`无意义/${pair.from} 的 ${moved} 张图并进 无意义/${pair.to}`)
  }

  await ensureTreeDirs(imagesDir)

  // ② images/未识别/ → 根目录
  const legacyUntagged = path.join(imagesDir, TREE_DIRS.untagged)
  let movedToRoot = 0
  let legacyIsDir = false
  try {
    legacyIsDir = (await readdir(legacyUntagged)) !== undefined
  } catch { legacyIsDir = false }
  if (legacyIsDir) {
    movedToRoot = await drainDir(imagesDir, TREE_DIRS.untagged, '')
    notes.push(`images/未识别/ 里的 ${movedToRoot} 张图已搬回根目录（未识别）`)
    renamed.push(`images/${TREE_DIRS.untagged}/ → images/ 根目录`)
  }

  // ③ 脏标签目录合并（`已识别/震惊 (2)/` → `已识别/震惊/`）
  const dirty = await mergeDirtyTagDirs(imagesDir)
  for (const line of dirty.merged) renamed.push(`已识别/${line}`)
  notes.push(...dirty.notes)
  if (dirty.moved > 0) notes.push(`脏目录里的 ${dirty.moved} 张图已并入干净目录`)

  return {
    movedToRoot,
    renamed,
    merged: merged + dirty.moved,
    notes,
    dirtyDirsMerged: dirty.merged,
    dirtyDirsRemoved: dirty.removedDirs,
  }
}

/**
 * 分析目录树 → 生成一份「同步计划」（只读，不改任何东西）。
 *
 * 规则（定稿版）：
 *   · 根目录下的文件              → 一律视为未识别（清空标签，留在根目录）；
 *   · `待确认分类/新标签_哈希.ext` → 取文件名里的**最后一个非哈希词**当新标签；
 *   · `待确认分类/<新标签>/file`   → 目录名当新标签；
 *   · `待确认分类/` 解析不出标签   → 留在待确认分类（pending）；
 *   · `已识别/` 根目录散图         → 搬进待确认分类，清空标签；
 *   · `无意义/待恢复/`             → 搬回根目录，清空标签（重新当未识别）；
 *   · `无意义/待删除/`             → 物理删除；
 *   · `已识别/<标签>/`             → 只有和自动位置不一致才算人工改标签；
 *   · `待删除/`                    → 物理删除；
 *   · 认不出的文件                  → 只报告，不删不改（待删除/无意义待删除 例外：用户明确要删）。
 *
 * @param {object} opts
 * @param {string} opts.imagesDir
 * @param {Array<object>} opts.items 库条目
 * @param {Set<string>} [opts.knownTags] 已知标签词表（用来判断「新标签目录」）
 * @returns {Promise<object>}
 */
export async function analyzeTree({ imagesDir, items, knownTags } = {}) {
  await ensureTreeDirs(imagesDir)
  // ⚠️ 先把脏标签目录并回干净目录（`震惊 (2)/` → `震惊/`），再列文件。
  //    顺序不能反：先列的话会按脏目录名算出「震惊 (2)」这个标签，
  //    图还没搬就已经被判定成了另一个分类。
  const dirtyMerge = await mergeDirtyTagDirs(imagesDir)
  // 脏目录里的图被挪了位置，索引里还是旧路径 —— 按内容哈希把它们找回来，
  // 不然后面 relocate 会把「旧路径不存在」当成文件丢失。
  if (dirtyMerge.moved > 0) await reconcilePaths(imagesDir, items ?? [])
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
  /** 认不出库条目、但用户明确要求挪位置的文件（按物理路径处理）。 */
  const moves = []
  /** 认不出库条目、但**位置已经正确**的文件（直接登记进库，不动文件）。 */
  const adopts = []
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
      || (category.kind === 'meaningless' && category.review === 'delete')) {
      let owner = item
      if (owner && usedKeys.has(owner.key)) owner = null
      if (owner) usedKeys.add(owner.key)
      deletes.push({
        rel: file.rel,
        abs: file.abs,
        item: owner,
        fromReview: category.kind === 'meaningless',
      })
      continue
    }

    if (!item) {
      // ⚠️ 铁律一：认不出库条目也**绝不删**。根目录的未知文件按名字当未识别/按标签归类。
      if (category.kind === 'untagged') {
        const tag = rootTagFromName(file.name)
        // 读一次字节算哈希（改名要用）。读不出来就跳过，保持原样不动。
        let hash = hashInName(file.name)
        if (!hash) {
          try { hash = sha1(await readFile(file.abs)).slice(0, 4) } catch { hash = '' }
        }
        if (!hash) {
          unknown.push({ rel: file.rel, name: file.name, reason: '读不出这张图（没动它）' })
          continue
        }
        const ext = extOf({ file: file.name })
        if (tag) {
          moves.push({
            from: file.rel,
            fromAbs: file.abs,
            to: placementRel('identified', tag, hash.slice(0, 4), ext),
            tag,
            orphan: true,
          })
        } else {
          const canonicalRel = placementRel('untagged', '', hash.slice(0, 4), ext)
          if (file.rel !== canonicalRel) {
            moves.push({ from: file.rel, fromAbs: file.abs, to: canonicalRel, tag: '', orphan: true })
          } else {
            unknown.push({ rel: file.rel, name: file.name, reason: '库里没有这张图（命名已规范，保持在根目录未识别）' })
          }
        }
        continue
      }
      if (category.kind === 'identified-root'
        || (category.kind === 'meaningless' && category.review === 'restore')) {
        let hash = hashInName(file.name)
        if (!hash) {
          try { hash = sha1(await readFile(file.abs)).slice(0, 4); } catch { hash = ''; }
        }
        if (hash) {
          const to = category.kind === 'meaningless'
            ? placementRel('untagged', '', hash.slice(0, 4), extOf({ file: file.name }))
            : placementRel('pending', '', hash.slice(0, 4), extOf({ file: file.name }))
          moves.push({ from: file.rel, fromAbs: file.abs, to, restore: category.kind === 'meaningless' })
          continue
        }
      }
      if (category.kind === 'identified') {
        // 图已经在 `已识别/<标签>/` 里、但库里没条目（典型：刚从脏目录合并过来、
        // 或者用户手动把图丢进了标签目录）。**位置已经正确，不用挪**，直接登记进库。
        adopts.push({
          rel: file.rel,
          abs: file.abs,
          tag: normalizeTagName(category.tag),
        })
        continue
      }
      unknown.push({ rel: file.rel, name: file.name, reason: '库里没有这张图（没动它）' })
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
    const autoTag = auto.category === 'identified' ? normalizeTagName(auto.tag) : ''
    let desiredTags = [...(item.tags ?? [])]
    let desiredPending = item.pending === true
    let manual = false
    let restored = false

    if (category.kind === 'identified') {
      const folderTag = normalizeTagName(category.tag)
      if (folderTag !== autoTag) {
        desiredTags = [folderTag]
        desiredPending = false
        manual = true
      }
    } else if (category.kind === 'pending') {
      const tag = category.tag ? normalizeTagName(category.tag) : pendingTagFromName(file.name)
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
      if (category.review === 'restore') {
        // 人工复核「其实不是无意义」→ 退回根目录，重新当未识别
        desiredTags = []
        desiredPending = false
        manual = true
        restored = true
      } else {
        // 直接放在 无意义/ 下的图：保持「无意义」
        if (!(item.tags ?? []).includes('无意义')) desiredTags = ['无意义']
        desiredPending = false
      }
    } else if (category.kind === 'untagged') {
      // 根目录 = 未识别。但铁律二：根目录的**文件名本身就是标签声明** ——
      // `开心.jpg` / `开心_1d5f.jpg` / `开心_随便打的字.jpg` 都要按标签归类并规范化改名。
      const fileTag = rootTagFromName(file.name)
      if (fileTag) {
        desiredTags = [fileTag]
        desiredPending = false
        manual = true
      } else if ((item.tags ?? []).length > 0 || item.pending === true) {
        // 文件名不带标签（`未识别_xxx` / 纯哈希）：清空标签，保持在根目录
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
      restored,
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
    adopts,
    newTags,
    tagFolders,
    pendingTagFolders,
    missing,
    // 脏目录自动合并的结果（`已识别/震惊 (2)/` → `震惊/`）
    dirtyMerged: dirtyMerge.merged,
    dirtyRemoved: dirtyMerge.removedDirs,
    dirtyMoved: dirtyMerge.moved,
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
    reviewDeleted: 0,
    retagged: 0,
    moved: 0,
    adopted: 0,
    pending: 0,
    restored: 0,
    unknown: plan.unknown.length,
    duplicates: plan.duplicates.length,
    newTags: plan.newTags,
    // 脏目录合并发生在 analyzeTree 阶段（已经执行完毕），这里只是把结果带出去
    dirtyMerged: plan.dirtyMerged ?? [],
    dirtyMoved: plan.dirtyMoved ?? 0,
    corrections: [],
    errors: [],
  }
  const tagChangedEntries = plan.changes.filter((entry) => entry.tagChanged)
  const pendingEntries = plan.changes.filter((entry) => entry.pendingChanged)
  const restoreEntries = plan.changes.filter((entry) => entry.restored)
  const reviewDeleteEntries = plan.deletes.filter((entry) => entry.fromReview === true)
  if (dryRun) {
    result.deleted = plan.deletes.length
    result.reviewDeleted = reviewDeleteEntries.length
    result.retagged = tagChangedEntries.length
    result.moved = plan.changes.filter((entry) => entry.pathChanged).length + plan.moves.length
    result.pending = pendingEntries.length
    result.restored = restoreEntries.length + plan.moves.filter((entry) => entry.restore).length
    result.corrections = tagChangedEntries.map((entry) => ({
      id: String(entry.item.src ?? '').slice(0, 10),
      from: [...(entry.item.tags ?? [])],
      to: entry.tags,
    }))
    result.adopted = plan.adopts?.length ?? 0
    return result
  }

  // ① 删除区：物理删文件 + 删索引条目。
  //    ⚠️ 铁律一：**只有** 待删除/ 与 无意义/待删除/ 下的文件会走到这里。
  //    根目录、已识别、未识别、无意义（非待删除）里的任何文件都不会被删。
  for (const entry of plan.deletes) {
    try {
      if (entry.item) {
        entry.item.file = entry.rel
        entry.item.path = entry.abs
        const removed = await library.removeItem(entry.item)
        if (removed) {
          if (entry.fromReview) result.reviewDeleted++
          else result.deleted++
        }
      } else {
        await removeFile(entry.abs)
        if (entry.fromReview) result.reviewDeleted++
        else result.deleted++
      }
    } catch (error) {
      result.errors.push(`删除 ${entry.rel} 失败：${error?.message ?? error}`)
    }
  }

  // ② 认不出条目、但按文件名归类的文件（**只移动，绝不删除**），然后登记进库
  for (const entry of plan.moves) {
    try {
      const target = await uniqueAbs(imagesDir, entry.to)
      await mkdir(path.dirname(target.abs), { recursive: true })
      await rename(entry.fromAbs, target.abs)
      result.moved++
      if (entry.restore) result.restored++
      else if (entry.tag) result.retagged++
      else result.pending++
      // 铁律二：扫到用户自己塞的图，要把它真的记进库，否则永远发不了也打不了标
      if (entry.orphan) {
        const adopted = await library.adoptFile?.({
          abs: target.abs,
          rel: target.rel,
          tags: entry.tag ? [entry.tag] : [],
          pending: !entry.tag,
        })
        if (adopted) result.adopted++
      }
    } catch (error) {
      result.errors.push(`移动 ${entry.from} 失败：${error?.message ?? error}`)
    }
  }

  // ③ 位置已经正确、但库里没条目的图：直接登记（不动文件）
  //
  // 典型来源：脏目录合并过来的图（`已识别/震惊 (2)/` → `已识别/震惊/`），
  // 或者用户手动把图丢进了某个标签目录。它们的位置本来就对，只需要补一条库记录。
  for (const entry of plan.adopts ?? []) {
    try {
      const adopted = await library.adoptFile?.({
        abs: entry.abs,
        rel: entry.rel,
        tags: entry.tag ? [entry.tag] : [],
        pending: !entry.tag,
      })
      if (adopted) result.adopted++
    } catch (error) {
      result.errors.push(`登记 ${entry.rel} 失败：${error?.message ?? error}`)
    }
  }

  // ④ 改标签 / 换位置（人工修正要留痕，后续打标不能把它盖回去）
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
      if (entry.restored) result.restored++
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
