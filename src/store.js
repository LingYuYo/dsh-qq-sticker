/**
 * 存储目录解析与搬迁。
 *
 * 为什么要单独一个模块：`dataDir` 现在可以由用户配置（绝对路径），但库里存的
 * **图片路径是绝对路径**（`library.json` 的 `item.path`）。换目录时不搬迁，
 * 老条目全部指向旧位置 —— 表现就是"库里 500 张、一张都发不出去"。
 *
 * 规则（宁可选保守的一侧）：
 *  ① 配置为空 → 用默认 `$DSH_HOME/plugin-data/dsh-qq-sticker`；
 *  ② 配置的路径不可用（相对路径 / 无权限 / 是文件）→ **退回默认**并记 warn，
 *     绝不因为用户填错一个路径就让整个插件起不来；
 *  ③ 新目录与旧目录相同 → 什么都不做；
 *  ④ 新目录为空 → 把旧的 index/state/schedule/report + images 全搬过去；
 *  ⑤ 新目录非空 → **直接切过去，不覆盖**（用户可能指向一个已有库），
 *     只记一条 info 说明没有搬迁。
 *
 * 「空」的判定：目录不存在，或存在但没有任何条目（含隐藏文件）。
 * 注意 `backups/` 是备份产物，不算"用户数据"，判断空目录时忽略它。
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { FILES } from './library.js'
import { defaultDataDir } from './util.js'

/** 搬迁时要带走的顶层文件（相对 dataDir）。 */
const MOVABLE_FILES = [FILES.index, FILES.state, FILES.schedule, FILES.report]

/** 判断空目录时忽略的目录名（备份产物不属于"库数据"）。 */
const IGNORED_ENTRIES = new Set(['backups'])

/**
 * 解析本次实际使用的数据目录。
 *
 * @param {object} opts
 * @param {object} opts.config 归一化配置（读 `config.store.dataDir`）
 * @param {(level:string, message:string)=>void} [opts.log]
 * @param {string} [opts.defaultDir] 默认目录（测试注入用）
 * @returns {Promise<{dataDir:string, configured:string, source:'config'|'default', migrated:boolean, note:string}>}
 */
export async function resolveStore({ config, log, defaultDir } = {}) {
  const note = (level, message) => {
    try { log?.(level, message) } catch { /* 日志失败不影响主流程 */ }
  }
  const fallback = defaultDir ?? defaultDataDir()
  const configured = String(config?.store?.dataDir ?? '').trim()

  // ② 没配置 → 默认
  if (!configured) {
    return { dataDir: fallback, configured: '', source: 'default', migrated: false, note: '' }
  }

  // ② 配置了但不可用 → 退回默认（绝不因为一个坏路径让插件挂掉）
  const problem = await inspectDir(configured)
  if (problem) {
    note('warn', `配置的存储目录不可用（${problem}），已退回默认目录：${fallback}`)
    return {
      dataDir: fallback,
      configured,
      source: 'default',
      migrated: false,
      note: `配置目录不可用：${problem}`,
    }
  }

  // ③ 与默认相同 → 当没配
  if (samePath(configured, fallback)) {
    return { dataDir: fallback, configured, source: 'config', migrated: false, note: '' }
  }

  // ④ / ⑤ 看新目录是否为空
  const empty = await isEmptyDir(configured)
  if (!empty) {
    note('info', `存储目录指向的 ${configured} 里已有内容，直接使用（不做搬迁，避免覆盖）`)
    return {
      dataDir: configured,
      configured,
      source: 'config',
      migrated: false,
      note: '目标目录非空，未搬迁（保留其现有内容）',
    }
  }

  // ④ 搬迁
  try {
    await mkdir(configured, { recursive: true })
    await migrateInto(configured, fallback, note)
    note('info', `已把表情库从 ${fallback} 搬到 ${configured}`)
    return {
      dataDir: configured,
      configured,
      source: 'config',
      migrated: true,
      note: `已搬迁：${fallback} → ${configured}`,
    }
  } catch (error) {
    note('warn', `搬迁到 ${configured} 失败（${error?.message ?? error}），继续用默认目录`)
    return {
      dataDir: fallback,
      configured,
      source: 'default',
      migrated: false,
      note: `搬迁失败：${error?.message ?? error}`,
    }
  }
}

/**
 * 检查一个路径能不能当数据目录。
 *
 * @param {string} target
 * @returns {Promise<string>} 问题描述；空字符串 = 没问题
 */
async function inspectDir(target) {
  try {
    const info = await stat(target)
    if (!info.isDirectory()) return '目标已存在但不是目录'
    return ''
  } catch (error) {
    if (error?.code === 'ENOENT') return ''   // 不存在是正常的（会创建）
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return '没有访问权限'
    if (error?.code === 'EINVAL') return '路径格式非法'
    return `无法访问（${error?.code ?? error?.message ?? '未知'}）`
  }
}

/** 目录是否为空（不存在也算空；忽略 backups/）。 */
async function isEmptyDir(target) {
  let entries
  try {
    entries = await readdir(target)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  return entries.filter((name) => !IGNORED_ENTRIES.has(name)).length === 0
}

/** 把旧目录的数据搬到新目录。失败时抛错，由调用方退回默认。 */
async function migrateInto(target, source, note) {
  // ① 顶层 JSON / 文本文件
  for (const file of MOVABLE_FILES) {
    const from = path.join(source, file)
    const to = path.join(target, file)
    try {
      await stat(from)
    } catch {
      continue   // 不存在就跳过（第一次跑就还没有这些文件）
    }
    await copyFile(from, to)
  }

  // ② images 目录：逐张拷，单张失败只 warn
  const sourceImages = path.join(source, FILES.images)
  const targetImages = path.join(target, FILES.images)
  await mkdir(targetImages, { recursive: true })
  let copied = 0
  let failed = 0
  let files = []
  try {
    files = await readdir(sourceImages)
  } catch {
    return
  }
  for (const name of files) {
    try {
      await copyFile(path.join(sourceImages, name), path.join(targetImages, name))
      copied++
    } catch (error) {
      failed++
      note('warn', `搬迁时拷贝 ${name} 失败：${error?.message ?? error}`)
    }
  }
  note('info', `搬迁图片 ${copied} 张${failed > 0 ? `，失败 ${failed} 张` : ''}（旧目录保留，确认无误后可手动删）`)
}

/** 路径比较（Windows 下大小写不敏感，斜杠方向也统一）。 */
function samePath(a, b) {
  return normalizePathKey(a) === normalizePathKey(b)
}

function normalizePathKey(value) {
  const resolved = path.resolve(String(value ?? ''))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 改配置后能不能立刻切换目录？
 *
 * 结论：**不能热切**。library 实例在创建时就绑定了 dataDir，运行中改目录会让
 * 读写分裂（读新、写旧）。所以这里只提供一个判断给 UI 提示：值变了要重启。
 *
 * @param {object} prev 旧配置
 * @param {object} next 新配置
 * @returns {{changed:boolean, needsRestart:boolean}}
 */
export function dataDirChange(prev, next) {
  const before = String(prev?.store?.dataDir ?? '').trim()
  const after = String(next?.store?.dataDir ?? '').trim()
  const changed = before !== after
  return { changed, needsRestart: changed }
}
