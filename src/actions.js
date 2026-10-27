/**
 * 面板动作：整理 / 清理 / 收集 / 删最早 / 报表 / 清空库。
 *
 * ⚠️ **与 tools.js 保持同步**：`organize` / `cleanup` / `delete_oldest` 的实现是从
 * `src/tools.js` 里同名工具（ORGANIZE / CLEANUP / DELETE_OLDEST）**抄过来的**。
 * tools.js 保持不动（那 11 个工具已经上线，改它回归面更大）；所以以后改这三处，
 * **两边必须一起改**，否则「模型工具删掉的」和「面板删掉的」口径会漂。
 *
 * 为什么要有这一层：面板 /action 需要进度，而工具是「一次调用、一次结果」。
 * 这里只多做两件事：① 分页调 `vision.recognizeBatch` 并报进度；② 把结果整理成
 * 契约 §4 里的 result 形状。业务判定一行都没改。
 */
import { num, safeService } from './util.js'
import { shortId } from './library.js'
import { stringOfList } from './config.js'
import { tagVocabulary } from './tagging.js'
import { analyzeTree, applyTreePlan } from './tree.js'

/** 一次整理最多看几张（与 tools.js 的 60 上限一致）。 */
const ORGANIZE_MAX = 60
const ORGANIZE_DEFAULT = 12

/** 删除最早一次最多删几张（与 tools.js 的 500 上限一致）。 */
const DELETE_OLDEST_MAX = 500

/** 动作清单（契约 §4 的 kind / label / args 三列）。 */
const KINDS = [
  { kind: 'organize', label: '一键整理打标', args: 'limit 1..60（默认 12）、dryRun（默认 false）' },
  { kind: 'cleanup', label: '清理无意义图', args: 'dryRun（默认 true）' },
  { kind: 'collect', label: '立即收集', args: '无' },
  { kind: 'delete_oldest', label: '删除最早', args: 'count 1..500、dryRun（默认 false）' },
  { kind: 'report', label: '生成报表', args: '无' },
  { kind: 'clear', label: '清空库', args: 'confirm: "CLEAR"（必须）' },
  // v2
  { kind: 'backup', label: '立即备份', args: '无' },
  // v2.2：物理文件夹 ↔ 数据库 人工协作
  { kind: 'sync_tree', label: '确认应用本地整理', args: 'dryRun（默认 false）' },
]

/**
 * 400 类错误：server 看到 `statusCode` 照抄状态码，不当成 500。
 * （契约要求「参数非法 / 未知 kind」是 400，而任务要求 clear 缺确认「抛错由 server 转 400」。）
 */
function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 })
}

/**
 * 把同步时新发现的标签目录写进配置的词表（vision.customTags）。
 *
 * 为什么必须写配置：`tagVocabulary()` 只认 tagCategories / customTags / 内置词，
 * 不写进去的话下次打标模型根本看不到这个新标签，用户建了目录也白建。
 * settings 服务不可用时只返回 false —— 标签本身已经落到条目上、也进了
 * library.extraTags，不会丢。
 *
 * @returns {Promise<boolean>}
 */
async function rememberTags(runtime, cfg, tags) {
  const settings = safeService(runtime.ctx, 'settings')
  if (!settings || typeof settings.update !== 'function') return false
  const existing = stringOfList(cfg?.vision?.customTags)
  const merged = [...new Set([...existing, ...tags.map((tag) => String(tag).trim()).filter(Boolean)])]
  if (merged.length === existing.length) return true
  try {
    await settings.update('qq-sticker', {
      vision: { ...cfg.vision, customTags: merged.join(',') },
    })
    return true
  } catch (error) {
    runtime.log?.('warn', `新标签写配置失败（标签仍在库里）：${error?.message ?? error}`)
    return false
  }
}

/** 轻量文件存在检查（cleanup 用；与 tools.js 的 fileStat 保持同步）。 */
async function fileStat(file) {
  try {
    const { stat } = await import('node:fs/promises')
    const info = await stat(file)
    return { exists: true, bytes: info.size }
  } catch {
    return { exists: false, bytes: 0 }
  }
}

/**
 * 建动作表。
 *
 * @param {object} options
 * @param {object} options.runtime 插件 runtime（library / vision / collector / getConfig …）
 * @param {object} options.jobs createJobs 的返回值
 * @param {(level:string, message:string) => void} [options.log] 插件日志
 * @returns {{
 *   kinds: Array<{kind:string,label:string,args:string}>,
 *   run: (kind: string, args?: object) => {ok:true,job:object} | {ok:false,reason:string,job?:object},
 * }}
 */
export function createActions({ runtime, jobs, log } = {}) {
  const note = (level, message) => {
    try { log?.(level, message) } catch { /* 日志失败不影响动作 */ }
  }
  const library = () => runtime.library
  const getConfig = () => runtime.getConfig()

  /** 规整 args 对象（拿不到就空对象）。 */
  const argsOf = (args) => (args && typeof args === 'object' && !Array.isArray(args) ? args : {})

  /**
   * 各动作：normalize(args) 抛 400；run(normalized, progress) 返回契约 §4 的 result。
   * runner 抛错 → jobs 里 status='error'、error=message。
   */
  const specs = {
    // ── 整理（打标）────────────────────────────────────────────────────
    organize: {
      label: '一键整理打标',
      normalize(args) {
        const raw = argsOf(args)
        const limit = Math.min(ORGANIZE_MAX, Math.max(1, Math.round(num(raw.limit, ORGANIZE_DEFAULT))))
        return { limit, dryRun: raw.dryRun === true }
      },
      async run({ limit, dryRun }, progress) {
        const cfg = getConfig()
        const batchSize = Math.max(1, Math.round(num(cfg?.vision?.organizeBatchSize, 4)))
        const lib = library()
        // 候选筛选与 tools.js ORGANIZE 逐行一致：可见 + 无标签/备注/文字 + 入库早的优先
        const candidates = lib.visible()
          .filter((item) => item.tags.length === 0 && !item.note && !item.text)
          .sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0))
          .slice(0, limit)
        const total = candidates.length
        const summary = {
          tried: 0, tagged: 0, meaningless: 0, failures: 0, deleted: 0, suspicious: false, errors: [],
        }
        progress(0, total, total > 0 ? `已看 0/${total} 张` : '没有需要整理的图')

        for (let offset = 0; offset < total; offset += batchSize) {
          const page = candidates.slice(offset, offset + batchSize)
          const result = await runtime.vision.recognizeBatch(page, { dryRun })
          summary.tried += num(result?.tried, page.length)
          summary.tagged += num(result?.tagged, 0)
          summary.meaningless += num(result?.meaningless, 0)
          summary.failures += num(result?.failures, 0)
          summary.deleted += Array.isArray(result?.deleted) ? result.deleted.length : 0
          if (result?.suspicious === true) summary.suspicious = true
          for (const line of result?.errors ?? []) if (line) summary.errors.push(String(line))
          // ⚠️ 每批都落盘（不是等全部跑完）：
          //    organize 一次可能跑几分钟，中途用户可能刷新面板、甚至进程被关掉。
          //    只靠结束时的 flush，看到的就是「任务显示 60/60 完成，刷新后标签全没了」。
          //    dryRun 不写库，也没必要 flush。
          if (!dryRun) await lib.flush()
          progress(Math.min(total, offset + page.length), total, `已看 ${Math.min(total, offset + page.length)}/${total} 张`)
        }

        await lib.flush()
        return {
          tried: summary.tried,
          tagged: summary.tagged,
          meaningless: summary.meaningless,
          failures: summary.failures,
          deleted: summary.deleted,
          suspicious: summary.suspicious,
          dryRun,
          // 试运行时上面那些数字都是"如果写入会怎样"，实际没有改库。
          // 明确标出来，免得用户以为打标成功了（真机踩过：试运行 60/60，刷新后
          // 仍是「待打标 118 / 已打标 2」）。
          persisted: dryRun !== true,
          detail: [
            ...(dryRun === true ? ['这是试运行：没有真的写入标签。关掉「试运行」再跑一次才会落盘。'] : []),
            ...summary.errors,
          ].join('；'),
        }
      },
    },

    // ── 清理（重复 / 无意义达标 / 剔除名单 / 文件丢失）───────────────────
    cleanup: {
      label: '清理无意义图',
      normalize(args) {
        return { dryRun: argsOf(args).dryRun !== false }
      },
      async run({ dryRun }, progress) {
        const cfg = getConfig()
        const lib = library()
        // 以下四类判定与 tools.js CLEANUP 逐行一致
        const blocked = new Set(cfg.library.blockedIds)
        const hiddenIds = new Set(cfg.library.hiddenIds)
        const items = [...lib.items]
        const total = items.length

        // ① 重复：索引按 sha1 建键，理论上不会有；这里防手改/迁移残留
        const bySrc = new Map()
        const duplicates = []
        for (const item of items) {
          if (!item.src) continue
          const prev = bySrc.get(item.src)
          if (!prev) { bySrc.set(item.src, item); continue }
          const score = (x) => (x.tags.length || x.note ? 1000 : 0) + x.sentCount * 10 + x.useCount
          const keep = score(prev) >= score(item) ? prev : item
          const drop = keep === prev ? item : prev
          bySrc.set(item.src, keep)
          duplicates.push(drop)
        }
        // ② 无意义：**按标签判定**，与状态卡/报表的统计口径保持一致。
        //
        //    以前这里还要求 tagFails >= organizeMaxAttempts，结果真机 71 张
        //    「无意义」的图 tagFails 最多只有 1（收录识图那条路压根不累计，
        //    而已经打上标签的图又永远不会再进「整理」候选），试运行永远报 0 张。
        //    人工点「清理」本来就是明确动作，阈值只该管整理时的自动删除。
        const meaningless = items.filter((item) => item.tags.includes('无意义'))
        // ③ 剔除名单
        const blockedItems = items.filter((item) => {
          const sid = shortId(item)
          return blocked.has(sid) || blocked.has(item.src) || hiddenIds.has(sid)
        })

        // ④ 文件丢失：逐条检查，顺便把进度报出去（总数 = 库条目数）
        const missing = []
        progress(0, total, total > 0 ? `检查 0/${total} 条` : '库是空的')
        let scanned = 0
        for (const item of items) {
          scanned++
          if (item.path) {
            const { exists } = await fileStat(item.path)
            if (!exists) missing.push(item)
          }
          progress(scanned, total, `检查 ${scanned}/${total} 条`)
        }

        const victims = [...new Set([...duplicates, ...meaningless, ...blockedItems, ...missing])]
        const freedBytes = victims.reduce((sum, item) => sum + num(item.bytes, 0), 0)

        if (!dryRun) {
          progress(0, victims.length, victims.length > 0 ? `删除 0/${victims.length} 条` : '没有要删的')
          let removed = 0
          for (const item of victims) {
            await lib.removeItem(item)
            removed++
            progress(removed, victims.length, `删除 ${removed}/${victims.length} 条`)
          }
          await lib.pruneOrphanFiles()
          await lib.flush()
        }

        const detail = dryRun && victims.length > 0
          ? `要删的是这些：${victims.slice(0, 12).map((item) => `#${shortId(item)}`).join('、')}${victims.length > 12 ? ` 等 ${victims.length} 张` : ''}。确认无误后关掉试运行再跑一次。`
          : ''
        return {
          dryRun,
          duplicates: duplicates.length,
          meaningless: meaningless.length,
          blocked: blockedItems.length,
          missing: missing.length,
          freedMB: Number((freedBytes / 1048576).toFixed(1)),
          after: lib.items.length,
          detail,
        }
      },
    },

    // ── 立即收集 ───────────────────────────────────────────────────────
    collect: {
      label: '立即收集',
      normalize() {
        return {}
      },
      async run(_normalized, progress) {
        progress(0, 0, '正在收集…')
        const result = await runtime.collector.collectTopUsed({ reason: 'panel' })
        if (result?.ok === false) throw new Error(`收集没跑起来：${result?.reason ?? '原因未知'}`)
        progress(0, 0, '收集完成')
        return {
          ok: true,
          considered: num(result?.considered, 0),
          collected: num(result?.collected, 0),
          already: num(result?.already, 0),
          failed: num(result?.failed, 0),
          stopReason: String(result?.stopReason ?? ''),
          // 失败明细（为什么这 N 张没收进来）：下载失败 / 读不到字节 / 太大 / 格式不认…
          ...(Array.isArray(result?.failures) && result.failures.length
            ? { failures: result.failures.slice(0, 20), failureCount: num(result?.failureCount, result.failures.length) }
            : {}),
          // ⚠️ 把回扫诊断原样带出来。「considered=0」光看这个数字没法判断是
          //    没会话、没消息、还是消息里没图片块 —— 排障全靠这几个计数。
          ...(result?.diag ? { diag: result.diag } : {}),
        }
      },
    },

    // ── 删最早 ─────────────────────────────────────────────────────────
    delete_oldest: {
      label: '删除最早',
      normalize(args) {
        const raw = argsOf(args)
        const cfg = getConfig()
        const fallback = Math.max(1, Math.round(num(cfg?.maintenance?.deleteOldestCount, 25)))
        const count = Math.min(DELETE_OLDEST_MAX, Math.max(1, Math.round(num(raw.count, fallback))))
        return { count, dryRun: raw.dryRun === true }
      },
      async run({ count, dryRun }, progress) {
        const cfg = getConfig()
        const lib = library()
        // 保底留存与「优先删从没发过的」逻辑与 tools.js DELETE_OLDEST 一致
        const want = count
        const keep = Math.max(0, cfg.maintenance.deleteOldestKeep)
        const visible = lib.visible()
        const byCreatedAt = [...visible].sort((a, b) => num(a.createdAt, 0) - num(b.createdAt, 0))
        const candidates = byCreatedAt.filter((item) => num(item.sentCount, 0) === 0)
          .concat(byCreatedAt.filter((item) => num(item.sentCount, 0) > 0))
        const allow = Math.max(0, lib.items.length - keep)
        const victims = candidates.slice(0, Math.min(want, allow))
        const freedBytes = victims.reduce((sum, item) => sum + num(item.bytes, 0), 0)

        progress(0, victims.length, victims.length > 0 ? `处理 0/${victims.length} 张` : '没有可删的')
        if (!dryRun) {
          let removed = 0
          for (const item of victims) {
            await lib.removeItem(item)
            removed++
            progress(removed, victims.length, `处理 ${removed}/${victims.length} 张`)
          }
          await lib.flush()
        } else {
          progress(victims.length, victims.length, '试运行：未删除')
        }

        const capped = victims.length < want
        return {
          dryRun,
          deleted: victims.length,
          kept: lib.items.length,
          freedMB: Number((freedBytes / 1048576).toFixed(1)),
          ids: victims.slice(0, 20).map((item) => shortId(item)),
          detail: capped
            ? `要到 ${want} 张，但保底留存 ${keep} 张 / 库里不够，只处理了 ${victims.length} 张。`
            : (dryRun ? '确认后关掉试运行再跑一次。' : ''),
        }
      },
    },

    // ── 报表 ───────────────────────────────────────────────────────────
    report: {
      label: '生成报表',
      normalize() {
        return {}
      },
      run(_normalized, progress) {
        progress(0, 0, '生成报表…')
        return { report: String(library().reportText() ?? '') }
      },
    },

    // ── v2：立即备份 ───────────────────────────────────────────────────
    backup: {
      label: '立即备份',
      normalize() { return {} },
      async run(_normalized, progress) {
        const backup = runtime.backup
        if (!backup || typeof backup.runNow !== 'function') {
          throw badRequest('备份模块不可用（插件还在初始化？）')
        }
        // ⚠️ 先 flush 再打包：state.json / library.json 都是防抖落盘的（1.5s），
        //    刚记的账可能还在内存里。不 flush 会备份出一份"比实际旧几秒"的快照。
        //    失败只 warn —— 备份仍然继续，只是可能少最后几秒的改动。
        try {
          progress(0, 0, '正在落盘…')
          await runtime.library?.flush?.()
          await runtime.flushState?.()
          await runtime.collector?.saveSchedule?.()
        } catch (error) {
          runtime.log?.('warn', `备份前落盘失败（继续备份）：${error?.message ?? error}`)
        }
        progress(0, 0, '正在打包…')
        const result = await backup.runNow({ reason: 'panel' })
        if (result?.ok !== true) {
          // busy / 失败都给出可读理由，不抛 500（这是用户能理解的状态）
          throw badRequest(String(result?.reason ?? '备份没有完成'))
        }
        return {
          file: String(result.file ?? ''),
          bytes: num(result.bytes, 0),
          entries: num(result.entries, 0),
          kept: num(result.kept, 0),
          removed: Array.isArray(result.removed) ? result.removed.length : 0,
          freedMB: Number((num(result.bytes, 0) / 1048576).toFixed(2)),
          errors: Array.isArray(result.errors) ? result.errors.slice(0, 5) : [],
        }
      },
    },

    // ── 确认应用本地整理（物理文件夹 → 数据库）──────────────────────────
    //
    // 用户直接在资源管理器里挪图：无意义/ → 已识别/哈基米/，或者丢进 待删除/。
    // 这个动作扫描目录树，把用户的意图写回库：
    //   · 已识别/<标签> → 标签改成该目录名（人工修正留痕）
    //   · 无意义/       → 标签改成「无意义」
    //   · 未识别/       → 清空标签
    //   · 待删除/       → 物理删文件 + 删条目
    //   · 新建的标签目录 → 登记进标签词表
    sync_tree: {
      label: '确认应用本地整理',
      normalize(args) {
        return { dryRun: argsOf(args).dryRun === true }
      },
      async run({ dryRun }, progress) {
        const cfg = getConfig()
        const lib = library()
        await lib.load()

        // 「新标签」判定：配置里的词表 + 库里已用过的标签 + 之前登记过的
        const knownTags = new Set(tagVocabulary(cfg))
        for (const tag of lib.extraTags ?? []) knownTags.add(tag)
        for (const item of lib.items) {
          for (const tag of item.tags ?? []) knownTags.add(String(tag))
        }

        progress(0, 0, '正在扫描图片目录…')
        const plan = await analyzeTree({
          imagesDir: lib.imagesDir,
          items: lib.items,
          knownTags,
        })
        const total = plan.changes.length + plan.deletes.length
        progress(0, total, total > 0 ? `准备同步 0/${total} 项` : '目录和库里一致')

        const result = await applyTreePlan(plan, {
          library: lib,
          imagesDir: lib.imagesDir,
          dryRun,
        })
        progress(total, total, dryRun ? '试运行完成（未改动）' : '同步完成')

        // 新标签写进配置词表：以后打标时模型也能选到它
        let tagsSaved = false
        if (!dryRun && result.newTags.length > 0) {
          tagsSaved = await rememberTags(runtime, cfg, result.newTags)
        }
        await lib.flush()

        const parts = []
        if (result.retagged > 0) parts.push(`改标签 ${result.retagged} 张`)
        if (result.deleted > 0) parts.push(`物理删除 ${result.deleted} 张`)
        if (result.moved > 0) parts.push(`换位置 ${result.moved} 张`)
        if (result.newTags.length > 0) parts.push(`新标签 ${result.newTags.join('、')}`)
        if (result.unknown > 0) parts.push(`${result.unknown} 个文件没对上库（未动）`)
        const detail = dryRun
          ? (parts.length > 0 ? `试运行：${parts.join('，')}。确认后关掉试运行再点一次才会真的改。` : '试运行：目录和库里一致，没有要改的。')
          : (parts.length > 0 ? `${parts.join('，')}。` : '目录和库里一致，没有要改的。')
        return {
          dryRun,
          scanned: result.scanned,
          matched: result.matched,
          unchanged: result.unchanged,
          deleted: result.deleted,
          retagged: result.retagged,
          moved: result.moved,
          adopted: result.adopted,
          unknown: result.unknown,
          duplicates: result.duplicates,
          newTags: result.newTags,
          tagsSaved,
          corrections: result.corrections.slice(0, 10),
          errors: result.errors.slice(0, 10),
          after: lib.items.length,
          detail,
        }
      },
    },

    // ── 清空库（危险动作，必须二次确认）─────────────────────────────────
    clear: {
      label: '清空库',
      normalize(args) {
        const raw = argsOf(args)
        // 契约 §4：confirm 必须**是字符串** "CLEAR"，否则 400
        if (raw.confirm !== 'CLEAR') {
          throw badRequest('清空库需要二次确认（请求体里要带 confirm: "CLEAR"）')
        }
        return {}
      },
      async run(_normalized, progress) {
        const lib = library()
        const items = [...lib.items]
        const total = items.length
        let removed = 0
        let failed = 0
        let freedBytes = 0

        progress(0, total, total > 0 ? `已删 0/${total} 张` : '库是空的')
        for (const item of items) {
          const ok = await lib.removeItem(item)
          if (ok) {
            removed++
            freedBytes += num(item.bytes, 0)
          } else {
            failed++
          }
          progress(removed + failed, total, `已删 ${removed}/${total} 张`)
        }
        await lib.pruneOrphanFiles()
        await lib.flush()

        return {
          removed,
          failed,
          freedMB: Number((freedBytes / 1048576).toFixed(1)),
          after: lib.items.length,
        }
      },
    },
  }

  /**
   * 跑一个动作。
   *
   * 返回：
   *  · `{ ok: true, job }` —— 已启动（job.status 从 running 开始）
   *  · `{ ok: false, reason: 'already-running', job }` —— 同 kind 已在跑（server → 409）
   *  · 参数非法 / 未知 kind → **抛**错（带 statusCode=400，server 转 400）
   */
  const run = (kind, args) => {
    const key = String(kind ?? '').trim()
    const spec = Object.hasOwn(specs, key) ? specs[key] : undefined
    if (!spec) throw badRequest(`未知动作：${key === '' ? '(空)' : key}`)
    const normalized = spec.normalize(args)
    const started = jobs.start(key, spec.label, (progress) => spec.run(normalized, progress))
    if (started?.ok !== true && started?.reason !== 'already-running') {
      note('warn', `动作启动失败：${key} —— ${started?.reason ?? '未知原因'}`)
    }
    return started
  }

  return { kinds: KINDS, run }
}
