/**
 * 离线用例：不联网、不起 DSH、不 spawn。
 *
 * 跑：`node test-offline.mjs`
 *
 * 覆盖范围（都是纯逻辑，假 ctx / 临时目录）：
 *  1. Config：Schema 与 DEFAULTS 逐项一致；readConfig 归一化/夹值/默认；
 *  2. 库：sha1 去重、软隐藏、容量淘汰（张数/字节双阈值）、blockedIds、原子写、文件丢失自愈；
 *  3. 收图启发式：GIF 收、大图跳、stickerOnly 关都收、每小时/每日预算；
 *  4. 发送闸：四档 × 五档缩放逐格断言、每分钟窗口、每日/间隔；
 *  5. 挑选：评分单调性、最近排除、softmax 分布（固定随机源）；
 *  6. 提示词段：compact 截断、off 不生成、encourage 文案；
 *  7. 视觉：单次删除上限 25、可疑批次不删、JSON 解析（含代码块/尾逗号）；
 *  8. 工具定义：11 个都过 defineTool 兜底编译，根 type=object 且 required 正确；
 *  9. 互动结算：3 分钟窗口、计数写回；
 * 10. 收集：parseRange、schedule 计算、collectTopUsed（假依赖）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, Config, readConfig, MOOD_WORDS } from './src/config.js'
import { Library, shortId, normalizeTag, dimensionsOf } from './src/library.js'
import {
  activityOf, effectiveLimits, emptyState, markSent, sendGate, FREQ_LEVELS,
} from './src/gate.js'
import { pickCandidates, weightedPick, scoreItem } from './src/pick.js'
import { buildCandidateContext, encourageLine } from './src/prompt.js'
import { parseJsonArray, buildPrompt, MAX_DELETE_PER_RUN, Vision } from './src/vision.js'
import { parseRange, Collector, summarizeResult } from './src/collect.js'
import { SessionTracker } from './src/tracker.js'
import { RewardSettler, interactionScore } from './src/reward.js'
import { buildTools, TOOL, TOOL_NAMES, compileParameterMap } from './src/tools.js'
import { isLikelySticker, textOfContent, Ingestor, effectiveDimensions } from './src/ingest.js'
import { plain, sha1, todayKey, hourKey } from './src/util.js'

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
  } catch (error) {
    fail++
    failures.push({ name, error })
    console.log(`  x ${name}\n      ${error?.message ?? error}`)
  }
}

async function group(title, fn) {
  console.log(`\n== ${title}`)
  await fn()
}

/** 临时目录。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-test-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

/**
 * 造一张最小的合法 PNG（宽高可控）。
 * 只要文件头正确能被 sniffImage + dimensionsOf 认出来就够，不追求真能渲染。
 */
function makePng(width = 64, height = 64, pad = 0) {
  const buf = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)          // IHDR 长度
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8                        // bit depth
  buf[25] = 6                        // color type RGBA
  return buf
}

/** 造一张 GIF 头（宽高可控）。 */
function makeGif(width = 100, height = 100) {
  const buf = Buffer.alloc(20)
  buf.write('GIF89a', 0, 'ascii')
  buf.writeUInt16LE(width, 6)
  buf.writeUInt16LE(height, 8)
  return buf
}

/** 默认配置（测试用）。 */
function cfgOf(overrides = {}) {
  return readConfig({ ...DEFAULTS, ...overrides })
}

// ───────────────────────────────────────────────────────────── 1. Config

await group('Config', async () => {
  await check('Schema 的每个叶子都有 volatile（不然设置页看不到、写不回去）', () => {
    // 真 schemastery：Config.dict 里每个条目是 schema 对象（`.meta` + 嵌套 `.dict`）
    // 兜底垫片：链式 API 对象，真值挂在 `._meta`
    const isReal = typeof Config === 'function' || !!Config?.dict
    const metaOf = (node) => (isReal ? (node?.meta ?? {}) : (node?._meta ?? node ?? {}))
    const childrenOf = (node) => (isReal ? node?.dict : (metaOf(node).items))
    const walk = (node, trail) => {
      const meta = metaOf(node)
      const children = childrenOf(node)
      // 有子项 = 分组节点（真 schemastery 的 object 节点 meta.type 可能是空的，靠 dict 判断）
      if (children && Object.keys(children).length > 0) {
        for (const [key, child] of Object.entries(children)) walk(child, `${trail}.${key}`)
        return
      }
      assert.equal(meta.volatile, true, `${trail} 缺 .volatile()`)
    }
    for (const [key, node] of Object.entries(Config.dict ?? metaOf(Config).items)) walk(node, `Config.${key}`)
  })

  await check('DEFAULTS 与 Schema 默认值一致', () => {
    const isReal = typeof Config === 'function' || !!Config?.dict
    const metaOf = (node) => (isReal ? (node?.meta ?? {}) : (node?._meta ?? node ?? {}))
    const childrenOf = (node) => (isReal ? node?.dict : (metaOf(node).items))
    // 每一段都必须在这里登记；加了新段忘了登记，这条会直接报「不存在」
    const sections = [
      'library', 'collect', 'vision', 'send', 'prompt', 'maintenance',
      // v2 新增段
      'store', 'proactive', 'battle', 'backup', 'gif',
    ]
    const top = isReal ? Config.dict : metaOf(Config).items
    assert.ok(top, '拿不到 Schema 顶层结构')
    assert.equal(metaOf(top.enabled).default, DEFAULTS.enabled)
    assert.equal(metaOf(top.debug).default, DEFAULTS.debug)
    let leafCount = 0
    for (const section of sections) {
      assert.ok(top[section], `${section} 不存在`)
      const children = childrenOf(top[section])
      assert.ok(children, `${section} 没有子项`)
      for (const [key, child] of Object.entries(children)) {
        const meta = metaOf(child)
        assert.notEqual(meta.default, undefined, `${section}.${key} 缺 .default()`)
        assert.deepEqual(meta.default, DEFAULTS[section][key], `${section}.${key} 默认值与 DEFAULTS 不一致`)
        leafCount++
      }
    }
    // v1 是 40 项；v2 只增不减，所以这里断言"不少于 40"而不是写死数字，
    // 避免每加一个配置项就要改一次测试。
    const total = 2 + leafCount
    assert.ok(total >= 40, `配置项总数不应少于 v1 的 40，实际 ${total}`)
  })

  await check('真 schemastery 下：解析 Config 得到 {get()} 包装，readConfig 能解包', () => {
    const isReal = typeof Config === 'function' || !!Config?.dict
    if (!isReal) return   // 兜底模式跳过（这条只在装了真包时有意义）
    const resolved = Config({ library: { maxCount: 123 } })
    assert.notEqual(resolved, undefined)
    const cfg = readConfig(resolved)
    assert.equal(cfg.enabled, true, '默认 enabled 应为 true')
    assert.equal(cfg.library.maxCount, 123, '用户值应生效')
    assert.equal(cfg.send.frequency, 'occasional', '未给的字段用默认')
  })

  await check('readConfig：空配置也给出完整默认', () => {
    const cfg = readConfig(undefined)
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.library.maxCount, DEFAULTS.library.maxCount)
    assert.equal(cfg.send.frequency, 'occasional')
    assert.equal(cfg.prompt.candidatesLevel, 'compact')
  })

  await check('readConfig：超范围夹值、非法 enum 回落', () => {
    const cfg = readConfig({
      library: { maxCount: 99999, maxItemMB: 999 },
      send: { frequency: 'nope', keepRecentCount: 0, dailyLimit: -5 },
      prompt: { candidatesLevel: 'what', maxCandidates: 200 },
      vision: { organizeOnTagFail: 'boom' },
    })
    assert.equal(cfg.library.maxCount, 5000)
    assert.equal(cfg.library.maxItemMB, 12)
    assert.equal(cfg.send.frequency, 'occasional')
    assert.equal(cfg.send.keepRecentCount, 1)
    assert.equal(cfg.send.dailyLimit, 0)
    assert.equal(cfg.prompt.candidatesLevel, 'compact')
    assert.equal(cfg.prompt.maxCandidates, 20)
    assert.equal(cfg.vision.organizeOnTagFail, 'delete')
  })

  await check('readConfig：解 {get()} 包装（volatile 字段）', () => {
    const wrapped = { get: () => ({ enabled: false, library: { maxCount: { get: () => 12 } } }) }
    const cfg = readConfig(wrapped)
    assert.equal(cfg.enabled, false)
    assert.equal(cfg.library.maxCount, 12)
  })

  await check('adminIds 支持逗号/分号/空格分隔', () => {
    const cfg = readConfig({ send: { adminIds: '123, 456;789 1011' } })
    assert.deepEqual(cfg.send.adminIds, ['123', '456', '789', '1011'])
  })
})

// ───────────────────────────────────────────────────────────── 2. 库

await group('Library', async () => {
  await check('sha1 内容寻址：同一张图只存一份', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const bytes = makePng(64, 64)
      const first = await lib.ingest({ bytes })
      assert.equal(first.ok, true)
      assert.equal(first.duplicate, undefined)
      const second = await lib.ingest({ bytes })
      assert.equal(second.ok, true)
      assert.equal(second.duplicate, true)
      assert.equal(lib.size, 1)
      assert.equal(lib.counters.duplicates, 1)
    })
  })

  await check('重复收图会补齐此前未知的来源信息', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const bytes = makePng(32, 32)
      const first = await lib.ingest({ bytes, sessionId: 's1' })
      const again = await lib.ingest({ bytes, sessionId: 's2', srcHint: '在聊加班' })
      assert.equal(again.duplicate, true)
      assert.equal(first.item.sessionId, 's1')      // 已有值不覆盖
      assert.equal(again.item.srcHint, '在聊加班')  // 空值补上
    })
  })

  await check('单张超过 maxItemMB 直接拒收', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf({ library: { maxItemMB: 1 } }) })
      await lib.load()
      const bytes = makePng(10, 10, 2 * 1024 * 1024)
      const result = await lib.ingest({ bytes })
      assert.equal(result.ok, false)
      assert.match(result.reason, /单张太大/)
    })
  })

  await check('不识别的格式拒收', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const result = await lib.ingest({ bytes: Buffer.from('not an image at all') })
      assert.equal(result.ok, false)
    })
  })

  await check('容量：张数上限触发淘汰（优先删没发过的）', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf({ library: { maxCount: 10 } }) })
      await lib.load()
      // 先塞 10 张；第 3 张标成"发过很多次"
      for (let i = 0; i < 10; i++) {
        const result = await lib.ingest({ bytes: makePng(32, 32, i * 4) })
        assert.equal(result.ok, true)
        if (i === 3) { result.item.sentCount = 9; result.item.useCount = 9 }
      }
      assert.equal(lib.size, 10)
      const keeper = lib.items.find((item) => item.sentCount === 9)
      const before = shortId(keeper)
      const added = await lib.ingest({ bytes: makePng(32, 32, 999) })
      assert.equal(added.ok, true)
      assert.equal(lib.size, 10)                       // 保持上限
      assert.ok(lib.items.includes(keeper), '发过的图不该被淘汰')
      assert.equal(shortId(keeper), before)
    })
  })

  await check('容量：字节上限也会触发淘汰', async () => {
    await withTempDir(async (dir) => {
      // 每张 ~64KB 填充；上限压到 1MB（最低档），maxCount 给大 —— 应只受字节约束
      const lib = new Library({ dataDir: dir, config: cfgOf({ library: { maxCount: 500, maxTotalMB: 1 } }) })
      await lib.load()
      let okCount = 0
      for (let i = 0; i < 40; i++) {
        const result = await lib.ingest({ bytes: makePng(16, 16, 64 * 1024 + i * 8) })
        if (result.ok) okCount++
      }
      assert.equal(okCount, 40, '每次 ingest 都应成功（旧图被淘汰腾地方）')
      // 关键断言：库不能无限长，稳定在 1MB 上下
      assert.ok(lib.counters.evicted > 0, '应该有淘汰发生')
      assert.ok(lib.size * 64 * 1024 <= 1024 * 1024 + 128 * 1024, `库里放太多：${lib.size} 张`)
      assert.ok(lib.totalBytes() <= 1024 * 1024 + 128 * 1024, `字节超限：${lib.totalBytes()}`)
      assert.ok(lib.totalBytes() >= 1024 * 1024 - 200 * 1024, `淘汰太狠：${lib.totalBytes()}`)
    })
  })

  await check('blockedIds：永久剔除（可见列表里不出现）', async () => {
    await withTempDir(async (dir) => {
      const bytes = makePng(48, 48)
      const src = sha1(bytes)
      const lib = new Library({
        dataDir: dir,
        config: cfgOf({ library: { blockedIds: src.slice(0, 10) } }),
      })
      await lib.load()
      await lib.ingest({ bytes })
      assert.equal(lib.size, 1)
      assert.equal(lib.visible().length, 0)
    })
  })

  await check('软隐藏可恢复', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(20, 20) })
      assert.equal(lib.visible().length, 1)
      lib.hide(item)
      assert.equal(lib.visible().length, 0)
      lib.unhide(item)
      assert.equal(lib.visible().length, 1)
    })
  })

  await check('写盘后能读回（字段不丢）', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(24, 24) })
      lib.annotate(item, { tags: ['开心', '沙雕'], note: '笑死用', text: '笑死' })
      lib.markSent(item, 'session-x')
      await lib.saveNow()

      const lib2 = new Library({ dataDir: dir, config: cfgOf() })
      await lib2.load()
      assert.equal(lib2.size, 1)
      const back = lib2.items[0]
      assert.equal(back.src, item.src)
      assert.deepEqual(back.tags, ['开心', '沙雕'])
      assert.equal(back.note, '笑死用')
      assert.equal(back.text, '笑死')
      assert.equal(back.sentCount, 1)
      assert.ok(back.sentTo['session-x'] > 0)
      assert.equal(back.animated, false)
    })
  })

  await check('文件丢失自愈：索引条目被清掉', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(12, 12) })
      await rm(item.path, { force: true })
      const removed = await lib.pruneMissingFiles()
      assert.equal(removed, 1)
      assert.equal(lib.size, 0)
    })
  })

  await check('短编号稳定（sha1 前 10 位）且能反查', async () => {
    await withTempDir(async (dir) => {
      const lib = new Library({ dataDir: dir, config: cfgOf() })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(30, 30) })
      const id = shortId(item)
      assert.equal(id.length, 10)
      assert.equal(lib.find(id)?.key, item.key)
      assert.equal(lib.find(`#${id}`)?.key, item.key)
    })
  })

  await check('normalizeTag：闭合词表对齐', () => {
    assert.equal(normalizeTag('开心'), '开心')
    assert.equal(normalizeTag('有点不高兴'), '开心') // 子串「高兴」→ 开心
    assert.equal(normalizeTag('无语'), '无奈')
    assert.equal(normalizeTag('纯色块看不出内容'), '无意义')
    assert.equal(normalizeTag('外星语言'), '其他')
    assert.equal(normalizeTag(''), '')
  })

  await check('dimensionsOf：PNG/GIF 尺寸解析', () => {
    assert.deepEqual(dimensionsOf(makePng(123, 45), 'png'), { width: 123, height: 45 })
    assert.deepEqual(dimensionsOf(makeGif(200, 150), 'gif'), { width: 200, height: 150 })
  })
})

// ───────────────────────────────────────────────────────────── 3. 收图启发式

await group('Ingest 判定', async () => {
  await check('GIF 一律算表情', () => {
    const cfg = cfgOf()
    assert.equal(isLikelySticker({ mediaType: 'image/gif', width: 4000, height: 4000, bytes: 999 }, cfg), true)
  })

  await check('大尺寸照片不算表情', () => {
    const cfg = cfgOf({ collect: { stickerMaxDim: 640 } })
    assert.equal(isLikelySticker({ mediaType: 'image/jpeg', width: 1080, height: 1260, bytes: 200_000 }, cfg), false)
  })

  await check('小图算表情', () => {
    const cfg = cfgOf({ collect: { stickerMaxDim: 640, stickerMaxBytes: 1_000_000 } })
    assert.equal(isLikelySticker({ mediaType: 'image/jpeg', width: 240, height: 240, bytes: 12_000 }, cfg), true)
  })

  await check('尺寸未知时按字节数兜底', () => {
    const cfg = cfgOf({ collect: { stickerMaxBytes: 1000 } })
    assert.equal(isLikelySticker({ mediaType: 'image/png', bytes: 500 }, cfg), true)
    assert.equal(isLikelySticker({ mediaType: 'image/png', bytes: 5000 }, cfg), false)
  })

  await check('effectiveDimensions：归一化后的 ref 也要看原始尺寸', () => {
    // DSH 附件服务会把大图压小；只看 ref.width 会把 1080×1260 的照片误判成表情
    const scaled = { width: 640, height: 747, originalDimensions: { width: 1080, height: 1260 } }
    assert.deepEqual(effectiveDimensions(scaled), { width: 1080, height: 1260 })
    assert.deepEqual(effectiveDimensions({ width: 240, height: 240 }), { width: 240, height: 240 })
    assert.deepEqual(effectiveDimensions({}), { width: 0, height: 0 })
    // 用它判定：压小过的照片仍然被排除
    const cfg = cfgOf({ collect: { stickerMaxDim: 640 } })
    const dim = effectiveDimensions(scaled)
    assert.equal(isLikelySticker({ mediaType: 'image/jpeg', bytes: 200_000, ...dim }, cfg), false)
  })

  await check('textOfContent 取文本、去掉 [图片] 占位', () => {
    const text = textOfContent([
      { type: 'text', text: '笑死 [图片]' },
      { type: 'image', attachment: { attachmentId: 'x' } },
    ])
    assert.equal(text, '笑死')
  })

  await check('每小时上限：超了不再入队', async () => {
    const cfg = cfgOf({ collect: { maxPerHour: 2 } })
    const state = emptyState()
    const ingestor = new Ingestor({
      library: null,
      getConfig: () => cfg,
      state,
      markStateDirty: () => { },
      deps: {},
    })
    // 手动把这一小时用满
    ingestor._rollIngestWindows()
    state.ingest.hourCount = 2
    const result = ingestor.onUserMessage({
      sessionId: 's',
      content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 10, height: 10 } }],
    })
    assert.equal(result.queued, 0)
    assert.ok(result.skipped.includes('hour-limit'))
  })

  await check('同一条消息重放不重复入队', async () => {
    const cfg = cfgOf()
    const state = emptyState()
    const ingestor = new Ingestor({
      library: null, getConfig: () => cfg, state, markStateDirty: () => { }, deps: {},
    })
    const content = [{ type: 'image', attachment: { attachmentId: 'same', mediaType: 'image/png', bytes: 10, width: 10, height: 10 } }]
    const first = ingestor.onUserMessage({ sessionId: 's', content })
    const second = ingestor.onUserMessage({ sessionId: 's', content })
    assert.equal(first.queued, 1)
    assert.equal(second.queued, 0)
    assert.ok(second.skipped.includes('replay'))
  })

  await check('每日预算计数与重置', () => {
    const cfg = cfgOf({ vision: { ingestBudgetPerDay: 2 } })
    const state = emptyState()
    const ingestor = new Ingestor({ library: null, getConfig: () => cfg, state, markStateDirty: () => { }, deps: {} })
    assert.equal(ingestor.budgetLeft(), 2)
    ingestor.useVisionBudget()
    assert.equal(ingestor.budgetLeft(), 1)
    // 换一天就重置
    const tomorrow = Date.now() + 24 * 3600 * 1000
    ingestor._rollIngestWindows(tomorrow)
    assert.equal(ingestor.budgetLeft(tomorrow), 2)
  })
})

// ───────────────────────────────────────────────────────────── 4. 发送闸

await group('Gate', async () => {
  await check('活跃度五档边界', () => {
    assert.equal(activityOf(0).id, 'cold')
    assert.equal(activityOf(3).id, 'cold')
    assert.equal(activityOf(4).id, 'quiet')
    assert.equal(activityOf(11).id, 'quiet')
    assert.equal(activityOf(12).id, 'active')
    assert.equal(activityOf(29).id, 'active')
    assert.equal(activityOf(30).id, 'hot')
    assert.equal(activityOf(69).id, 'hot')
    assert.equal(activityOf(70).id, 'burst')
  })

  await check('四档 × 五档缩放数值表（原插件用户调过的值）', () => {
    const table = {
      'rare:cold': { perSessionDaily: 8, minIntervalMin: 120 },
      'rare:quiet': { perSessionDaily: 12, minIntervalMin: 72 },
      'rare:active': { perSessionDaily: 15, minIntervalMin: 60 },
      'rare:hot': { perSessionDaily: 23, minIntervalMin: 36 },
      'rare:burst': { perSessionDaily: 30, minIntervalMin: 21 },
      'occasional:cold': { perSessionDaily: 15, minIntervalMin: 40 },
      'occasional:active': { perSessionDaily: 30, minIntervalMin: 20 },
      'occasional:burst': { perSessionDaily: 60, minIntervalMin: 7 },
    }
    for (const [key, expect] of Object.entries(table)) {
      const [freq, act] = key.split(':')
      const limits = effectiveLimits(freq, act)
      assert.equal(limits.perSessionDaily, expect.perSessionDaily, `${key} 日额度`)
      assert.equal(limits.minIntervalMin, expect.minIntervalMin, `${key} 间隔`)
    }
    // normal / often 不受活跃度影响（本来就不限日额度/间隔）
    for (const act of ['cold', 'quiet', 'active', 'hot', 'burst']) {
      assert.equal(effectiveLimits('normal', act).perMinute, 2)
      assert.equal(effectiveLimits('normal', act).perSessionDaily, 0)
      assert.equal(effectiveLimits('often', act).perMinute, 0)
    }
  })

  await check('全局每日上限拒绝', () => {
    const cfg = cfgOf({ send: { dailyLimit: 2, globalIntervalSec: 0, minIntervalSec: 0 } })
    const state = emptyState()
    state.sentDay = todayKey()
    state.sentToday = 2
    const verdict = sendGate({ config: cfg, state, sessionId: 's', activityBySession: 0 })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /今天全局已经发了/)
    assert.match(verdict.reason, /不要重试/)   // 必须带"别重试/别编原因"的引导
  })

  await check('全局最小间隔拒绝并在到点后放行', () => {
    const cfg = cfgOf({ send: { globalIntervalSec: 15, dailyLimit: 0, minIntervalSec: 0 } })
    const state = emptyState()
    const now = Date.now()
    state.lastGlobalSendAt = now - 5000
    assert.equal(sendGate({ config: cfg, state, sessionId: 's', now }).ok, false)
    assert.equal(sendGate({ config: cfg, state, sessionId: 's', now: now + 11_000 }).ok, true)
  })

  await check('同会话间隔拒绝', () => {
    const cfg = cfgOf({ send: { globalIntervalSec: 0, minIntervalSec: 30, dailyLimit: 0 } })
    const state = emptyState()
    const now = Date.now()
    state.sessions.s = { ...emptyState().sessions.s, lastAt: now - 1000, day: todayKey() }
    const verdict = sendGate({ config: cfg, state, sessionId: 's', now })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /秒前刚发过/)
  })

  await check('档位日额度拒绝（rare 活跃群）', () => {
    const cfg = cfgOf({ send: { frequency: 'rare', globalIntervalSec: 0, minIntervalSec: 0, dailyLimit: 0 } })
    const state = emptyState()
    state.sessions.s = { ...emptyState().sessions.s, day: todayKey(), sentToday: 15, lastAt: 0 }
    // 活跃 12 条 → active 档 → rare 上限 15
    const verdict = sendGate({ config: cfg, state, sessionId: 's', activityBySession: 12 })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /今天已经发了 15 张/)
  })

  await check('normal 档每分钟 2 张（滑动窗口）', () => {
    const cfg = cfgOf({ send: { frequency: 'normal', globalIntervalSec: 0, minIntervalSec: 0, dailyLimit: 0 } })
    const state = emptyState()
    const now = Date.now()
    state.sessions.s = {
      ...emptyState().sessions.s,
      day: todayKey(),
      recentAt: [now - 5000, now - 10_000],
      lastAt: 0,
      recentIds: [],
    }
    const verdict = sendGate({ config: cfg, state, sessionId: 's', now })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /这一分钟已经发了 2 张/)
    // 窗口外的旧记录不算
    state.sessions.s.recentAt = [now - 61_000, now - 62_000]
    assert.equal(sendGate({ config: cfg, state, sessionId: 's', now }).ok, true)
  })

  await check('跨天重置：昨天的用量不算今天', () => {
    const cfg = cfgOf({ send: { frequency: 'rare', globalIntervalSec: 0, minIntervalSec: 0, dailyLimit: 0 } })
    const state = emptyState()
    state.sessions.s = { ...emptyState().sessions.s, day: '2000-01-01', sentToday: 999, lastAt: 0 }
    const verdict = sendGate({ config: cfg, state, sessionId: 's', activityBySession: 12 })
    assert.equal(verdict.ok, true)
  })

  await check('markSent：全会话与每会话记账、每日重置', () => {
    const state = emptyState()
    const now = Date.now()
    markSent(state, 's1', { now, itemKey: 'src:aa' })
    markSent(state, 's1', { now, itemKey: 'src:bb' })
    assert.equal(state.sentToday, 2)
    assert.equal(state.sessions.s1.sentToday, 2)
    assert.deepEqual(state.sessions.s1.recentIds, ['src:aa', 'src:bb'])
    assert.equal(state.sessions.s1.recentAt.length, 2)
    // 跨天
    const tomorrow = now + 24 * 3600 * 1000
    markSent(state, 's1', { now: tomorrow, itemKey: 'src:cc' })
    assert.equal(state.sessions.s1.sentToday, 1)
  })

  await check('空会话 state 的字段齐全（漏字段会让「最近发送」静默归零）', () => {
    const session = emptyState().sessions
    assert.deepEqual(session, {})
    const state = emptyState()
    markSent(state, 's')
    assert.ok(Array.isArray(state.sessions.s.recentIds))
    assert.ok(Array.isArray(state.sessions.s.recentAt))
    assert.equal(typeof state.sessions.s.lastStickerAt, 'number')
  })
})

// ───────────────────────────────────────────────────────────── 5. 挑选

await group('Pick', async () => {
  const makeItem = (overrides) => ({
    key: `src:${'a'.repeat(40)}`,
    src: 'a'.repeat(40),
    file: 'x.png',
    bytes: 100,
    ext: 'png',
    animated: false,
    tags: [],
    note: '',
    text: '',
    hidden: false,
    createdAt: 0,
    usedAt: 0,
    useCount: 0,
    sentCount: 0,
    sentTo: {},
    interactShown: 0,
    interactUsers: 0,
    interactReplies: 0,
    ...overrides,
  })

  await check('语境：标签精确命中 > 未命中 > 无标签', () => {
    const hit = scoreItem(makeItem({ tags: ['开心'] }), { mood: '开心' }).total
    const miss = scoreItem(makeItem({ tags: ['生气'] }), { mood: '开心' }).total
    const untagged = scoreItem(makeItem({ tags: [] }), { mood: '开心' }).total
    assert.ok(hit > untagged, `命中 ${hit} 应大于无标签 ${untagged}`)
    assert.ok(untagged > miss, `无标签 ${untagged} 应大于未命中 ${miss}`)
  })

  await check('新颖度：没发过的分数高于发过多次的', () => {
    const fresh = scoreItem(makeItem({ sentCount: 0 }), {}).total
    const used = scoreItem(makeItem({ sentCount: 20, useCount: 20, usedAt: Date.now() }), {}).total
    assert.ok(fresh > used, `fresh ${fresh} 应大于 used ${used}`)
  })

  await check('互动期望：有正面互动的分数更高（贝叶斯，样本少不会暴涨）', () => {
    const good = scoreItem(makeItem({ interactShown: 10, interactUsers: 8, interactReplies: 10 }), {}).total
    const bad = scoreItem(makeItem({ interactShown: 10, interactUsers: 0, interactReplies: 0 }), {}).total
    assert.ok(good > bad)
    const oneShot = scoreItem(makeItem({ interactShown: 1, interactUsers: 1, interactReplies: 1 }), {}).total
    const many = scoreItem(makeItem({ interactShown: 50, interactUsers: 40, interactReplies: 50 }), {}).total
    assert.ok(many > oneShot)
  })

  await check('最近排除：本会话刚发过的排不进候选（排空了放宽）', () => {
    const items = [
      makeItem({ key: 'src:a', src: 'a'.repeat(40), tags: ['开心'] }),
      makeItem({ key: 'src:b', src: 'b'.repeat(40), tags: ['开心'] }),
    ]
    items[0].sentTo = { 'session-1': Date.now() }
    const picked = pickCandidates(items, { sessionId: 'session-1', limit: 5 })
    assert.equal(picked.length, 1)
    assert.equal(picked[0].item.key, 'src:b')
    // 所有都被排除 → 放宽，仍然返回候选而不是空
    items[1].sentTo = { 'session-1': Date.now() }
    assert.equal(pickCandidates(items, { sessionId: 'session-1', limit: 5 }).length, 2)
  })

  await check('softmax 加权随机：固定随机源结果确定', () => {
    const scored = [
      { item: makeItem({ key: 'src:high' }), score: { total: 0.9 } },
      { item: makeItem({ key: 'src:low' }), score: { total: 0.2 } },
    ]
    const alwaysLow = weightedPick(scored, () => 0.0001)
    assert.equal(alwaysLow.key, 'src:high')       // 随机数极小 → 第一个（最高分）
    const alwaysHigh = weightedPick(scored, () => 0.9999)
    assert.equal(alwaysHigh.key, 'src:low')       // 随机数接近 1 → 最后一个
  })

  await check('softmax 真的会给低分机会（分布不退化）', () => {
    const scored = [
      { item: makeItem({ key: 'src:high' }), score: { total: 0.85 } },
      { item: makeItem({ key: 'src:low' }), score: { total: 0.30 } },
    ]
    let lowCount = 0
    let seed = 12345
    const rand = () => {
      // xorshift-ish 确定性伪随机
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 400; i++) {
      if (weightedPick(scored, rand).key === 'src:low') lowCount++
    }
    assert.ok(lowCount > 5 && lowCount < 200, `低分被选中 ${lowCount}/400 次，分布不合理`)
  })

  await check('单元素候选直接返回', () => {
    const scored = [{ item: makeItem({ key: 'src:only' }), score: { total: 0.1 } }]
    assert.equal(weightedPick(scored, () => 0.5).key, 'src:only')
  })

  await check('无意义图不进候选', () => {
    const items = [makeItem({ key: 'src:x', src: 'x'.repeat(40), tags: ['无意义'] })]
    assert.equal(pickCandidates(items, { limit: 5 }).length, 0)
  })
})

// ───────────────────────────────────────────────────────────── 6. 提示词段

await group('Prompt', async () => {
  await check('off 档不生成', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ prompt: { candidatesLevel: 'off' } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      await lib.ingest({ bytes: makePng(20, 20) })
      assert.equal(buildCandidateContext({ library: lib, config: cfg, sessionId: 's' }), '')
    })
  })

  await check('库空不生成', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      assert.equal(buildCandidateContext({ library: lib, config: cfg, sessionId: 's' }), '')
    })
  })

  await check('compact 档：有候选、不超 700 字符', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ prompt: { candidatesLevel: 'compact', maxCandidates: 8 } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      for (let i = 0; i < 12; i++) {
        const { item } = await lib.ingest({ bytes: makePng(20, 20, i * 8) })
        lib.annotate(item, { tags: ['开心'], note: `第 ${i} 张测试表情，用来验证提示词长度控制` })
      }
      const text = buildCandidateContext({ library: lib, config: cfg, sessionId: 's' })
      assert.ok(text.length > 0)
      assert.ok(text.length <= 700, `长度 ${text.length} 超上限`)
      assert.match(text, /【表情包库】/)
      assert.match(text, /现成好发的：/)
    })
  })

  await check('剩余额度会出现在段里（rare 档）', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ send: { frequency: 'rare' } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      for (let i = 0; i < 3; i++) await lib.ingest({ bytes: makePng(20, 20, i * 8) })
      const state = emptyState()
      state.sessions.s = { ...emptyState().sessions.s, day: todayKey(), sentToday: 3 }
      const text = buildCandidateContext({
        library: lib, config: cfg, sessionId: 's', state, activityBySession: 12,
      })
      assert.match(text, /今天还能发 12 张/)   // rare/active = 15，已用 3
    })
  })

  await check('encourage 四档文案各不相同', () => {
    const lines = [0, 1, 2, 3].map((n) => encourageLine(n))
    assert.equal(new Set(lines).size, 4)
    assert.match(lines[0], /保守/)
    assert.match(lines[3], /很积极/)
  })
})

// ───────────────────────────────────────────────────────────── 7. 视觉

await group('Vision', async () => {
  await check('JSON 解析：纯数组', () => {
    const out = parseJsonArray('[{"id":"abc","tags":["开心"],"note":"x","text":"y"}]', ['abc'])
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].tags, ['开心'])
  })

  await check('JSON 解析：包 ```json 代码块', () => {
    const out = parseJsonArray('好的，结果如下：\n```json\n[{"id":"abc","tags":["无奈"]}]\n```', ['abc'])
    assert.equal(out.length, 1)
    assert.equal(out[0].tags[0], '无奈')
  })

  await check('JSON 解析：尾逗号', () => {
    const out = parseJsonArray('[{"id":"abc","tags":["开心"],}]', ['abc'])
    assert.equal(out.length, 1)
  })

  await check('JSON 解析：只保留认识的 id', () => {
    const out = parseJsonArray('[{"id":"abc"},{"id":"nope"}]', ['abc'])
    assert.equal(out.length, 1)
    assert.equal(out[0].id, 'abc')
  })

  await check('JSON 解析：完全不是 JSON → 空数组而不是抛错', () => {
    assert.deepEqual(parseJsonArray('我看不出来', ['abc']), [])
  })

  await check('纯对象逐条抠（模型没给数组）', () => {
    const out = parseJsonArray('结果：{"id":"a1","tags":["开心"]} 和 {"id":"a2","tags":["难过"]}', ['a1', 'a2'])
    assert.equal(out.length, 2)
  })

  await check('提示词包含闭合词表且禁止编造', () => {
    const prompt = buildPrompt([{ id: 'abc', hint: '在聊加班' }], cfgOf())
    assert.match(prompt, /JSON 数组/)
    assert.match(prompt, /开心/)
    assert.match(prompt, /不要编/)
    assert.match(prompt, /id=abc/)
  })

  await check('没有 LLM 通道时 available() 明确拒绝（不假装成功）', () => {
    const vision = new Vision({ library: null, getConfig: () => cfgOf(), deps: {} })
    const ability = vision.available()
    assert.equal(ability.ok, false)
    assert.match(ability.reason, /LLM|附件|模型/)
  })

  await check('单次删除硬上限 25 张', async () => {
    assert.equal(MAX_DELETE_PER_RUN, 25)
    await withTempDir(async (dir) => {
      const cfg = cfgOf({
        vision: { organizeMaxAttempts: 1, organizeOnTagFail: 'delete', organizeBatchSize: 8 },
      })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      // 造 40 张，全部先标成「无意义」并累计失败
      const items = []
      for (let i = 0; i < 40; i++) {
        const { item } = await lib.ingest({ bytes: makePng(16, 16, i * 8) })
        lib.annotate(item, { tags: ['无意义'] })
        item.tagFails = 1
        items.push(item)
      }
      const vision = new Vision({
        library: lib,
        getConfig: () => cfg,
        deps: {
          saveImage: async () => ({ attachmentId: 'att-fixed' }),
          // 一次识别全部 40 张（模拟模型一次答完一批）
          chat: async () => JSON.stringify(items.map((item) => ({ id: shortId(item), tags: ['无意义'], note: '', text: '' }))),
          canSee: () => true,
        },
      })
      const result = await vision.recognizeBatch(items, { dryRun: false })
      assert.equal(result.deleted.length, MAX_DELETE_PER_RUN, '单次删除必须被硬上限拦住')
      assert.ok(result.errors.some((error) => error.includes('单次整理最多删')), '应提示"没删完，再跑一次"')
    })
  })

  await check('可疑批次：失败比例高时本批不删', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ vision: { organizeMaxAttempts: 1, organizeOnTagFail: 'delete' } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const items = []
      for (let i = 0; i < 4; i++) {
        const { item } = await lib.ingest({ bytes: makePng(16, 16, i * 8) })
        lib.annotate(item, { tags: ['无意义'] })
        item.tagFails = 1
        items.push(item)
      }
      const vision = new Vision({
        library: lib,
        getConfig: () => cfg,
        deps: {
          saveImage: async () => ({ attachmentId: 'x' }),
          // 只答其中一张 → 3/4 失败 = 0.75 ≥ 0.5
          chat: async () => JSON.stringify([{ id: shortId(items[0]), tags: ['无意义'], note: '', text: '' }]),
          canSee: () => true,
        },
      })
      const before = lib.size
      const result = await vision.recognizeBatch(items)
      assert.equal(result.suspicious, true)
      assert.equal(result.deleted.length, 0, '可疑批次不准删')
      assert.equal(lib.size, before, '库不能被改小')
    })
  })
})

// ───────────────────────────────────────────────────────────── 8. 工具定义

await group('Tools', async () => {
  await check('11 个工具名都在 qq_ext_sticker_ 下（qq-guard 白名单前缀）', () => {
    assert.equal(TOOL_NAMES.length, 11)
    for (const name of TOOL_NAMES) {
      assert.match(name, /^qq_ext_sticker_/, `${name} 不带白名单前缀`)
    }
    assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, '工具名不能重复')
  })

  await check('compileParameterMap：required 抽到根、object 补 additionalProperties', () => {
    const schema = compileParameterMap('parameters', {
      stickerId: { type: 'string', required: true, description: '编号' },
      opt: { type: 'object', properties: { a: { type: 'string' } } },
    })
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['stickerId'])
    assert.equal(schema.properties.opt.additionalProperties, false)
  })

  await check('buildTools：11 个定义都过 defineTool 兜底编译且 schema 合法', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const tracker = new SessionTracker()
      const state = emptyState()
      const runtime = {
        ctx: fakeCtx(),
        library: lib,
        tracker,
        getConfig: () => cfg,
        log: () => { },
        state: () => state,
        markStateDirty: () => { },
        collector: { brief: () => ({ enabled: false }), scanSession: async () => ({ ok: true, seen: 0, collected: 0, duplicates: 0, skipped: 0, items: [] }) },
        vision: { available: () => ({ ok: false, reason: 'test' }), recognizeBatch: async () => ({ tried: 0, tagged: 0, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: true, errors: [] }) },
        settler: { register: () => { } },
        attachments: null,
        readImageBytes: async () => null,
        guards: {},
      }
      const defs = await buildTools(runtime)
      assert.equal(defs.length, 11)
      for (const def of defs) {
        assert.equal(typeof def.name, 'string')
        assert.ok(def.description.length > 20, `${def.name} description 太短`)
        assert.equal(def.parameters.type, 'object', `${def.name} 根节点必须是 object`)
        assert.ok(def.parameters.properties, `${def.name} 缺 properties`)
        assert.ok(def.output?.schema, `${def.name} 缺 output.schema`)
        assert.equal(typeof def.output.render, 'function')
        assert.equal(typeof def.execute, 'function')
      }
    })
  })

  await check('工具执行期：插件关闭时统一拒绝', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ enabled: false })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const defs = await buildTools({
        ctx: fakeCtx(),
        library: lib,
        tracker: new SessionTracker(),
        getConfig: () => cfg,
        log: () => { },
        state: () => emptyState(),
        markStateDirty: () => { },
        collector: { brief: () => ({}), scanSession: async () => ({ ok: false, reason: 'x' }) },
        vision: { available: () => ({ ok: false, reason: 'x' }), recognizeBatch: async () => ({}) },
        settler: { register: () => { } },
        attachments: null,
        readImageBytes: async () => null,
        guards: {},
      })
      const pick = defs.find((def) => def.name === TOOL.PICK)
      await assert.rejects(() => pick.execute({}, {}), /已在设置里关闭/)
    })
  })

  await check('pick 工具：返回候选与额度', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(20, 20) })
      lib.annotate(item, { tags: ['开心'], note: '笑' })
      const defs = await buildTools(minimalRuntime(lib, cfg))
      const pick = defs.find((def) => def.name === TOOL.PICK)
      const out = await pick.execute({ limit: 5 }, {})
      assert.equal(out.total, 1)
      assert.equal(out.candidates.length, 1)
      assert.equal(out.candidates[0].id, shortId(item))
      assert.equal(out.quota.level, '偶尔')
    })
  })

  await check('send 工具：编号不存在时抛可读错误（不乱发空气）', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const defs = await buildTools(minimalRuntime(lib, cfg))
      const send = defs.find((def) => def.name === TOOL.SEND)
      await assert.rejects(
        () => send.execute({ stickerId: 'nope' }, { agent: { id: 'session-1' } }),
        /库里没有这个编号/,
      )
    })
  })

  await check('stats 工具：返回报表文本', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      await lib.ingest({ bytes: makePng(20, 20) })
      const defs = await buildTools(minimalRuntime(lib, cfg))
      const stats = defs.find((def) => def.name === TOOL.STATS)
      const out = await stats.execute({}, {})
      assert.match(out.report, /表情库：1 张/)
      assert.equal(out.total, 1)
    })
  })
})

// ───────────────────────────────────────────────────────────── 9. 互动结算

await group('Reward', async () => {
  await check('互动分数公式（满分 0.25）', () => {
    assert.equal(interactionScore(0, 0), 0)
    assert.equal(interactionScore(3, 5), 0.25)
    assert.equal(interactionScore(99, 99), 0.25)  // 封顶
    assert.ok(interactionScore(1, 0) > 0)
  })

  await check('3 分钟窗口内统计不同人数与回复条数，写回那张图', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(20, 20) })
      const tracker = new SessionTracker()
      tracker.selfId = 'bot'
      // 模拟：机器人发图，然后 3 个群友、5 条回复（含机器人自己的话）
      tracker.push('s', { at: Date.now() - 200_000, senderId: 'bot', self: true, text: '旧消息', content: [] })
      for (let i = 0; i < 5; i++) {
        tracker.push('s', {
          at: Date.now() - 100_000 + i * 1000,
          senderId: `u${i % 3}`,
          self: false,
          text: `回复${i}`,
          content: [],
        })
      }
      const settler = new RewardSettler({ library: lib, tracker, log: () => { } })
      settler.pending.push({ sessionId: 's', itemKey: item.key, at: Date.now() - 120_000, baseGapOk: true, timer: null })
      const result = await settler.settle('s', item.key, Date.now() - 120_000)
      assert.equal(result.ok, true)
      assert.equal(result.users, 3)
      assert.equal(result.replies, 5)
      assert.equal(item.interactShown, 1)
      assert.equal(item.interactUsers, 3)
      assert.equal(item.interactReplies, 5)
      assert.ok(item.lastReward > 0)
    })
  })

  await check('统计窗口只算发出去之后的消息', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf()
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const { item } = await lib.ingest({ bytes: makePng(20, 20) })
      const tracker = new SessionTracker()
      const sentAt = Date.now() - 100_000
      // 发图之前说了很多（不该计入）
      for (let i = 0; i < 10; i++) {
        tracker.push('s', { at: sentAt - 5000 - i, senderId: 'u1', self: false, text: 'x', content: [] })
      }
      // 发之后只有 1 条
      tracker.push('s', { at: sentAt + 30_000, senderId: 'u2', self: false, text: 'y', content: [] })
      const settler = new RewardSettler({ library: lib, tracker, log: () => { } })
      settler.pending.push({ sessionId: 's', itemKey: item.key, at: sentAt, baseGapOk: true, timer: null })
      const result = await settler.settle('s', item.key, sentAt)
      assert.equal(result.replies, 1)
    })
  })

  await check('会话窗口：humanCount 排除机器人自己', () => {
    const tracker = new SessionTracker()
    tracker.selfId = 'bot'
    const now = Date.now()
    tracker.push('s', { at: now, senderId: 'bot', self: true, text: '我', content: [] })
    tracker.push('s', { at: now, senderId: 'u1', self: false, text: '你', content: [] })
    tracker.push('s', { at: now - 31 * 60_000, senderId: 'u2', self: false, text: '旧', content: [] })
    assert.equal(tracker.humanCount('s'), 1)  // 只算 30 分钟内的真人
  })
})

// ───────────────────────────────────────────────────────────── 10. 收集

await group('Collect', async () => {
  await check('parseRange：各种写法', () => {
    assert.equal(parseRange('1h'), 1)
    assert.equal(parseRange('24h'), 24)
    assert.equal(parseRange('all'), Infinity)
    assert.equal(parseRange('6'), 6)
    assert.equal(parseRange('30m'), 0.5)
    assert.equal(parseRange('乱写'), 4)     // 默认 4h
  })

  await check('schedule：0 小时 = 关闭定时', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ collect: { everyHours: 0 } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const collector = new Collector({ library: lib, getConfig: () => cfg, dataDir: dir, deps: {} })
      assert.equal(collector.computeNextRunAt(), 0)
      const brief = collector.brief()
      assert.equal(brief.enabled, false)
    })
  })

  await check('schedule：落盘后能读回', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ collect: { everyHours: 12 } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      const collector = new Collector({ library: lib, getConfig: () => cfg, dataDir: dir, deps: {} })
      collector.schedule.nextRunAt = 123456789
      collector.schedule.lastRunAt = 111
      await collector.saveSchedule()
      const again = new Collector({ library: lib, getConfig: () => cfg, dataDir: dir, deps: {} })
      await again.loadSchedule()
      assert.equal(again.schedule.nextRunAt, 123456789)
    })
  })

  await check('collectTopUsed：按出现次数排序、跳过已有的、不硬凑', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({ collect: { topCount: 3, topHours: 24 } })
      const lib = new Library({ dataDir: dir, config: cfg })
      await lib.load()
      // 先放一张进库（后面再遇到应算"已有"）
      const existingBytes = makePng(20, 20, 111)
      await lib.ingest({ bytes: existingBytes })

      const now = Date.now()
      const pool = [
        { id: 'a', count: 5, bytes: makePng(20, 20, 1) },
        { id: 'b', count: 3, bytes: makePng(20, 20, 2) },
        { id: 'c', count: 1, bytes: makePng(20, 20, 3) },
      ]
      const byId = new Map(pool.map((entry) => [entry.id, entry]))
      // 构造消息流：a 出现 5 次、b 3 次、c 1 次、existing 2 次
      const messages = []
      const push = (id, at) => messages.push({
        time: at,
        sessionId: 's',
        senderId: 'u1',
        content: [{ type: 'text', text: `聊 ${id}` }, { type: 'image', attachment: { attachmentId: id } }],
      })
      let t = now - 3600_000
      for (let i = 0; i < 5; i++) push('a', t += 1000)
      for (let i = 0; i < 3; i++) push('b', t += 1000)
      push('c', t += 1000)
      push('existing', t += 1000)
      push('existing', t += 1000)

      const collector = new Collector({
        library: lib,
        getConfig: () => cfg,
        dataDir: dir,
        log: () => { },
        deps: {
          knownSessions: () => ['s'],
          readMessages: async () => messages,
          readImage: async (ref) => {
            const hit = byId.get(ref.attachmentId)
            if (hit) return { data: hit.bytes }
            if (ref.attachmentId === 'existing') return { data: existingBytes }
            return null
          },
        },
      })
      const result = await collector.collectTopUsed({ hours: 24, limit: 3 })
      assert.equal(result.ok, true)
      assert.equal(result.collected, 3)
      // a 和 b 是该收的（c 的优先级低于 a/b；existing 已存在算 duplicate）
      assert.equal(result.already, 1)
      assert.ok(lib.items.length >= 3)
    })
  })

  await check('summarizeResult：失败结果也结构化', () => {
    const brief = summarizeResult({ ok: false, reason: '忙' })
    assert.equal(brief.ok, false)
    assert.equal(brief.reason, '忙')
  })
})

// ───────────────────────────────────────────────────────────── 收尾

function fakeCtx() {
  return {
    get: () => undefined,
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    on: () => () => { },
    timer: { interval: () => () => { } },
  }
}

/** 工具测试用的最小 runtime（只有工具会碰到的字段）。 */
function minimalRuntime(lib, cfg) {
  const state = emptyState()
  const tracker = new SessionTracker()
  return {
    ctx: fakeCtx(),
    library: lib,
    tracker,
    getConfig: () => cfg,
    log: () => { },
    state: () => state,
    markStateDirty: () => { },
    collector: {
      brief: () => ({ enabled: false }),
      scanSession: async () => ({ ok: true, seen: 0, collected: 0, duplicates: 0, skipped: 0, items: [] }),
    },
    vision: {
      available: () => ({ ok: false, reason: 'test' }),
      recognizeBatch: async () => ({ tried: 0, tagged: 0, meaningless: 0, failures: 0, deleted: [], suspicious: false, dryRun: true, errors: [] }),
    },
    settler: { register: () => { } },
    attachments: null,
    readImageBytes: async () => null,
    guards: {},
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`- ${item.name}`)
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
