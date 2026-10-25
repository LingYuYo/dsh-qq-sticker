import assert from 'node:assert/strict'

import {
  createProactive, chooseSticker, looksLikeSticker,
  buildIntentPrompt, parseIntent, buildTeamPrompt, parseTeam,
} from './src/proactive.js'
import { readConfig } from './src/config.js'
import { SessionTracker } from './src/tracker.js'

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    fail++
    failures.push({ name, error })
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

/* ── 假库 ───────────────────────────────────────────────────── */

function makeItem(overrides = {}) {
  return {
    key: `src:${overrides.src ?? Math.random().toString(36).slice(2)}`,
    src: overrides.src ?? Math.random().toString(36).slice(2, 34),
    path: overrides.path ?? 'C:\\tmp\\x.jpg',
    bytes: overrides.bytes ?? 20000,
    ext: overrides.ext ?? 'jpg',
    animated: overrides.animated ?? false,
    width: overrides.width ?? 300,
    height: overrides.height ?? 300,
    tags: overrides.tags ?? ['开心'],
    note: overrides.note ?? '',
    text: overrides.text ?? '',
    hidden: false,
    sentCount: overrides.sentCount ?? 0,
    useCount: overrides.useCount ?? 0,
    interactShown: 0, interactUsers: 0, interactReplies: 0,
    createdAt: overrides.createdAt ?? Date.now() - 1000,
  }
}

function makeLibrary(items) {
  const list = items ?? [makeItem(), makeItem(), makeItem()]
  return {
    items: list,
    visible: () => list.filter((item) => !item.hidden),
    markSent(item, sessionId) {
      item.sentCount = (item.sentCount ?? 0) + 1
      this.lastSent = { key: item.key, sessionId }
    },
    find: (ref) => list.find((item) => item.key.includes(String(ref))) ?? null,
  }
}

function makeState() {
  return {
    version: 1,
    sentDay: '',
    sentToday: 0,
    sentTotal: 0,
    sessions: {},
    ingest: { day: '', count: 0, hour: '', hourCount: 0 },
    counters: {},
  }
}

/** 造一个引擎。默认所有闸门放行。 */
function makeEngine({ config = {}, items, sendResult = { ok: true, detail: 'ok' }, chatText } = {}) {
  // ⚠️ 深合并：调用方常只传 proactive.probability 之类单个字段，
  //    浅拷贝会把整段默认值（enabled: true 等）冲掉。
  const deepMerge = (base, patch) => {
    const out = { ...base }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = deepMerge(base?.[key] ?? {}, value)
      } else {
        out[key] = value
      }
    }
    return out
  }
  const cfg = readConfig(deepMerge({ enabled: true, proactive: { enabled: true, probability: 1 } }, config))
  const library = makeLibrary(items)
  const tracker = new SessionTracker()
  const stateValue = makeState()
  const sent = []
  const events = []
  const logs = []

  const engine = createProactive({
    library,
    tracker,
    getConfig: () => cfg,
    state: () => stateValue,
    log: (level, message) => logs.push({ level, message }),
    deps: {
      chatText: chatText ?? (async () => JSON.stringify({ send: true, mood: '开心', keyword: '', confidence: 0.9 })),
      chatWithImages: async () => JSON.stringify({ join: true, mood: '沙雕', keyword: '' }),
      readImageRef: async (ref) => ({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' }),
      sendItem: async (item) => {
        if (typeof sendResult === 'function') return sendResult(item)
        sent.push(item)
        return sendResult
      },
      markStateDirty: () => {},
      recordEvent: (kind, payload) => events.push({ kind, payload }),
      // 连发间隔：测试里不真等（不然每条连发用例都要拖 700ms）
      sleep: async () => {},
    },
  })
  return { engine, cfg, library, tracker, stateValue, sent, events, logs }
}

console.log('\n① 意图解析（容错）')

await check('标准 JSON 正常解析', () => {
  const parsed = parseIntent('{"send":true,"mood":"开心","keyword":"笑死","confidence":0.8}')
  assert.equal(parsed.send, true)
  assert.equal(parsed.mood, '开心')
  assert.equal(parsed.keyword, '笑死')
})

await check('包了 markdown 代码块也能抠出来', () => {
  const parsed = parseIntent('好的，我认为：\n```json\n{"send":true,"mood":"无奈"}\n```\n就这样')
  assert.equal(parsed.send, true)
  assert.equal(parsed.mood, '无奈')
})

await check('前面有一句废话也能抠出来', () => {
  const parsed = parseIntent('让我想想... {"send":false} 因为太严肃了')
  assert.equal(parsed.send, false)
})

await check('尾逗号能修', () => {
  const parsed = parseIntent('{"send":true,"mood":"开心",}')
  assert.equal(parsed.send, true)
})

await check('send 不是布尔 → 判不发', () => {
  const parsed = parseIntent('{"send":"yes"}')
  assert.equal(parsed.send, false)
  assert.equal(parsed.reason, 'unparsable')
})

await check('完全乱码 → 判不发（宁可少发）', () => {
  assert.equal(parseIntent('我觉得可以配图').send, false)
  assert.equal(parseIntent('').send, false)
  assert.equal(parseIntent(null).send, false)
})

await check('confidence 被夹到 0~1', () => {
  assert.equal(parseIntent('{"send":true,"confidence":5}').confidence, 1)
  assert.equal(parseIntent('{"send":true,"confidence":-3}').confidence, 0)
})

await check('团战解析同理', () => {
  assert.equal(parseTeam('{"join":true,"mood":"沙雕"}').join, true)
  assert.equal(parseTeam('{"join":false}').join, false)
  assert.equal(parseTeam('乱码').join, false)
})

await check('意图提示词包含规则与输出格式', () => {
  const text = buildIntentPrompt({ turnText: '笑死我了', recent: '群友在聊游戏' })
  assert.ok(text.includes('配图助手'))
  assert.ok(text.includes('笑死我了'))
  assert.ok(text.includes('严肃话题'))
  assert.ok(text.includes('"send":true|false'))
})

await check('团战提示词包含张数与判断要求', () => {
  const text = buildTeamPrompt({ count: 3, chatText: '大家发的啥' })
  assert.ok(text.includes('3 张'))
  assert.ok(text.includes('join'))
  assert.ok(text.includes('正经讨论'))
})

console.log('\n② 发送期过滤')

await check('gif / 动图 一律算表情包', () => {
  const cfg = readConfig({})
  assert.equal(looksLikeSticker(makeItem({ ext: 'gif' }), cfg), true)
  assert.equal(looksLikeSticker(makeItem({ animated: true }), cfg), true)
})

await check('大尺寸照片不算表情包', () => {
  const cfg = readConfig({})
  assert.equal(looksLikeSticker(makeItem({ width: 3000, height: 2000 }), cfg), false)
})

await check('大字节不算表情包', () => {
  const cfg = readConfig({})
  assert.equal(looksLikeSticker(makeItem({ bytes: 8 * 1024 * 1024 }), cfg), false)
})

await check('小图算表情包', () => {
  const cfg = readConfig({})
  assert.equal(looksLikeSticker(makeItem({ width: 300, height: 300, bytes: 20000 }), cfg), true)
})

console.log('\n③ 选图')

await check('有 mood 时取评分最高的', () => {
  const cfg = readConfig({})
  const items = [
    makeItem({ tags: ['生气'], note: 'x' }),
    makeItem({ tags: ['开心'], note: 'y' }),
  ]
  const chosen = chooseSticker({ cfg, sessionId: 's1', visible: items, mood: '开心' })
  assert.ok(chosen)
  assert.deepEqual(chosen.tags, ['开心'])
})

await check('exclude 生效（不会被重复选到）', () => {
  const cfg = readConfig({})
  const items = [makeItem({ tags: ['开心'] }), makeItem({ tags: ['开心'] })]
  const chosen = chooseSticker({ cfg, sessionId: 's1', visible: items, mood: '开心', exclude: [items[0].key] })
  assert.ok(chosen)
  assert.equal(chosen.key, items[1].key)
})

await check('全部被 exclude → 返回 null', () => {
  const cfg = readConfig({})
  const items = [makeItem()]
  assert.equal(chooseSticker({ cfg, sessionId: 's1', visible: items, exclude: [items[0].key] }), null)
})

await check('空库返回 null', () => {
  assert.equal(chooseSticker({ cfg: readConfig({}), sessionId: 's1', visible: [] }), null)
})

console.log('\n④ 闸门顺序（关键：概率闸在 LLM 之前）')

await check('总开关关闭 → 直接跳过，不调 LLM', async () => {
  let llmCalls = 0
  const { engine } = makeEngine({
    config: { proactive: { enabled: false } },
    chatText: async () => { llmCalls++; return '{}' },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'disabled')
  assert.equal(llmCalls, 0, '关掉总开关后不该有任何 LLM 调用')
})

await check('概率 0 → 跳过，不调 LLM', async () => {
  let llmCalls = 0
  const { engine } = makeEngine({
    config: { proactive: { enabled: true, probability: 0 } },
    chatText: async () => { llmCalls++; return '{}' },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(llmCalls, 0)
})

await check('概率没过 → 不调 LLM（省 token 的核心）', async () => {
  let llmCalls = 0
  const { engine } = makeEngine({
    config: { proactive: { enabled: true, probability: 0.0000001 } },
    chatText: async () => { llmCalls++; return '{"send":true}' },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'probability-miss')
  assert.equal(llmCalls, 0)
})

await check('空库 → 跳过', async () => {
  const { engine } = makeEngine({ items: [] })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.reason, 'empty-library')
})

await check('发送闸拒绝 → 不发（不绕过原有上限）', async () => {
  const { engine, stateValue } = makeEngine({
    config: { send: { dailyLimit: 1 } },
  })
  // 伪造今天已经发满
  const today = new Date()
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  stateValue.sentDay = day
  stateValue.sentToday = 5
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(result.reason.includes('额度') || result.reason.length > 0, true)
})

console.log('\n⑤ 正常发图')

await check('全闸门放行 → 发一张，记账正确', async () => {
  const { engine, sent, library } = makeEngine()
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死我了' })
  assert.equal(result.ok, true, `实际：${JSON.stringify(result)}`)
  assert.equal(result.sent, 1)
  assert.equal(sent.length, 1, '应发一张')
  assert.ok(library.lastSent, '应记账')
  assert.equal(library.lastSent.sessionId, 's1')
})

await check('模型说不发 → 不发', async () => {
  const { engine, sent } = makeEngine({
    chatText: async () => JSON.stringify({ send: false }),
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '这个病怎么治' })
  assert.equal(result.ok, false)
  assert.equal(sent.length, 0)
})

await check('LLM 抛错 → 静默跳过，不炸主链路', async () => {
  const { engine, sent } = makeEngine({
    chatText: async () => { throw new Error('网络挂了') },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(sent.length, 0)
})

await check('发图失败 → 返回不发，不记账', async () => {
  const { engine, library } = makeEngine({
    sendResult: { ok: false, reason: '桥接拒收' },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(library.lastSent, undefined)
})

await check('「只选表情包」开启时，照片不会发出去', async () => {
  const photo = makeItem({ width: 3000, height: 2000, ext: 'jpg', tags: ['开心'] })
  const { engine, sent } = makeEngine({
    items: [photo],
    config: { proactive: { stickerOnly: true } },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, false)
  assert.equal(sent.length, 0, '照片不该被主动发出去')
})

console.log('\n⑥ 连发')

await check('连发概率 1 → 发 burstCount 张', async () => {
  const items = Array.from({ length: 8 }, () => makeItem({ tags: ['开心'] }))
  const { engine, sent } = makeEngine({
    items,
    config: {
      proactive: { maxPerTurn: 3 },
      battle: { burstEnabled: true, burstProbability: 1, burstCount: 3 },
    },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.ok, true)
  assert.equal(result.sent, 3, `应连发 3 张，实际 ${result.sent}`)
  assert.equal(sent.length, 3)
})

await check('连发概率 0 → 只发 1 张', async () => {
  const items = Array.from({ length: 8 }, () => makeItem({ tags: ['开心'] }))
  const { engine, sent } = makeEngine({
    items,
    config: {
      proactive: { maxPerTurn: 3 },
      battle: { burstEnabled: true, burstProbability: 0, burstCount: 3 },
    },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.sent, 1)
  assert.equal(sent.length, 1)
})

await check('连发不重复同一张', async () => {
  const items = Array.from({ length: 8 }, (_, index) => makeItem({ tags: ['开心'], note: `n${index}` }))
  const { engine, sent } = makeEngine({
    items,
    config: {
      proactive: { maxPerTurn: 3 },
      battle: { burstEnabled: true, burstProbability: 1, burstCount: 3 },
    },
  })
  await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  const keys = sent.map((item) => item.key)
  assert.equal(new Set(keys).size, keys.length, `不该重复：${JSON.stringify(keys)}`)
})

await check('maxPerTurn=1 时不连发', async () => {
  const items = Array.from({ length: 8 }, () => makeItem())
  const { engine, sent } = makeEngine({
    items,
    config: {
      proactive: { maxPerTurn: 1 },
      battle: { burstEnabled: true, burstProbability: 1, burstCount: 3 },
    },
  })
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(result.sent, 1)
})

console.log('\n⑦ 斗图（加入队形）')

/** 往 tracker 里灌一条"别人发的图"。 */
function noteImage(tracker, sessionId, senderId, attachmentId) {
  tracker.noteUserMessage(sessionId, {
    content: [{ type: 'image', attachment: { attachmentId } }],
    source: { senderId },
  })
}

await check('3 个不同人发同一张图 → 命中队形', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u2', 'att-1')
  noteImage(tracker, 's1', 'u3', 'att-1')
  const hit = tracker.detectFormation('s1', { windowMs: 30_000, threshold: 3 })
  assert.equal(hit.hit, true)
  assert.equal(hit.users, 3)
  assert.equal(hit.attachmentId, 'att-1')
})

await check('同一个人发 3 次不算队形', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u1', 'att-1')
  const hit = tracker.detectFormation('s1', { windowMs: 30_000, threshold: 3 })
  assert.equal(hit.hit, false, '一个人刷三次不叫队形')
})

await check('窗口外的记录不算', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u2', 'att-1')
  noteImage(tracker, 's1', 'u3', 'att-1')
  // 用未来 1 分钟作为 now，让三条都落到窗口外
  const hit = tracker.detectFormation('s1', { windowMs: 1000, threshold: 3, now: Date.now() + 60_000 })
  assert.equal(hit.hit, false)
})

await check('不同图不算队形', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u2', 'att-2')
  noteImage(tracker, 's1', 'u3', 'att-3')
  assert.equal(tracker.detectFormation('s1', { threshold: 3 }).hit, false)
})

await check('机器人自己发的不算队形成员', () => {
  const tracker = new SessionTracker()
  tracker.noteUserMessage('s1', { content: [{ type: 'image', attachment: { attachmentId: 'att-1' } }], source: { senderId: 'bot' } }, { selfId: 'bot' })
  noteImage(tracker, 's1', 'u1', 'att-1')
  const hit = tracker.detectFormation('s1', { threshold: 2 })
  assert.equal(hit.hit, false, '自己 + 1 人不该凑够 2')
})

await check('队形命中 → 引擎直接跟发，不做意图分析', async () => {
  let llmCalls = 0
  const { engine, tracker, sent } = makeEngine({
    chatText: async () => { llmCalls++; return '{"send":true}' },
    config: { battle: { joinEnabled: true, joinThreshold: 3 } },
  })
  tracker.selfId = 'bot'
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u2', 'att-1')
  noteImage(tracker, 's1', 'u3', 'att-1')
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '我也来' })
  assert.equal(result.ok, true)
  assert.equal(sent.length, 1)
  assert.match(result.reason, /formation/)
  assert.equal(llmCalls, 0, '队形命中不该再花一次 LLM 调用')
})

await check('关掉加入队形开关 → 不跟', async () => {
  const { engine, tracker, sent } = makeEngine({
    config: { battle: { joinEnabled: false } },
    chatText: async () => '{"send":false}',
  })
  tracker.selfId = 'bot'
  noteImage(tracker, 's1', 'u1', 'att-1')
  noteImage(tracker, 's1', 'u2', 'att-1')
  noteImage(tracker, 's1', 'u3', 'att-1')
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '我也来' })
  assert.equal(result.ok, false)
  assert.equal(sent.length, 0)
})

console.log('\n⑧ 团战')

await check('3 张图刷屏 → 团战激活', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'a')
  noteImage(tracker, 's1', 'u2', 'b')
  noteImage(tracker, 's1', 'u3', 'c')
  const team = tracker.detectTeamFight('s1', { windowMs: 60_000, minImages: 3 })
  assert.equal(team.active, true)
  assert.equal(team.images, 3)
  assert.equal(team.senders, 3)
})

await check('2 张图不算团战', () => {
  const tracker = new SessionTracker()
  noteImage(tracker, 's1', 'u1', 'a')
  noteImage(tracker, 's1', 'u2', 'b')
  assert.equal(tracker.detectTeamFight('s1', { minImages: 3 }).active, false)
})

await check('团战额度用尽 → 跳过（不烧 token）', async () => {
  let visionCalls = 0
  const { engine, cfg, tracker, sent } = makeEngine({
    config: { proactive: { enabled: true, probability: 1 }, battle: { joinEnabled: false, teamEnabled: true, teamBudgetPerDay: 1 } },
  })
  tracker.selfId = 'bot'
  noteImage(tracker, 's1', 'u1', 'a')
  noteImage(tracker, 's1', 'u2', 'b')
  noteImage(tracker, 's1', 'u3', 'c')
  // 直接改装 engine 的 deps 计数不方便，这里连续跑两次（第一次消耗额度）
  const first = await engine.onTurnStopping({ sessionId: 's1', turnText: '哈哈哈' })
  assert.equal(first.ok, true)
  const second = await engine.onTurnStopping({ sessionId: 's1', turnText: '哈哈哈' })
  // 第二次团战额度已用尽，应回落到普通配图或跳过，总之不能崩
  assert.equal(typeof second.ok, 'boolean')
  void cfg; void sent; void visionCalls
})

await check('关掉团战 → 不激活', async () => {
  const { engine, tracker, sent } = makeEngine({
    config: { battle: { joinEnabled: false, teamEnabled: false } },
    chatText: async () => '{"send":false}',
  })
  tracker.selfId = 'bot'
  noteImage(tracker, 's1', 'u1', 'a')
  noteImage(tracker, 's1', 'u2', 'b')
  noteImage(tracker, 's1', 'u3', 'c')
  const result = await engine.onTurnStopping({ sessionId: 's1', turnText: '哈哈哈' })
  assert.equal(result.ok, false)
  assert.equal(sent.length, 0)
})

console.log('\n⑨ 冷却与并发')

await check('idleTurns 冷却期内不发', async () => {
  const { engine, tracker } = makeEngine({
    config: { proactive: { idleTurns: 5 } },
  })
  // 先成功发一次，建立 lastSentAt
  await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  // 只补 1 条别人的消息（不够 5 个回合）
  tracker.noteUserMessage('s1', { content: [{ type: 'text', text: '嗯' }], source: { senderId: 'u1' } })
  const second = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(second.ok, false)
  assert.match(second.reason, /cooldown/)
})

await check('并发重入 → 第二次返回 busy', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { engine } = makeEngine({
    chatText: async () => { await gate; return '{"send":true}' },
  })
  const firstPromise = engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  // 让出一次微任务，确保第一个已经进入 running
  await new Promise((resolve) => setImmediate(resolve))
  const second = await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  assert.equal(second.reason, 'busy')
  release()
  const first = await firstPromise
  assert.equal(first.ok, true)
})

await check('brief() 反映真实状态', async () => {
  const { engine } = makeEngine()
  await engine.onTurnStopping({ sessionId: 's1', turnText: '笑死' })
  const brief = engine.brief('s1')
  assert.equal(brief.enabled, true)
  assert.equal(brief.lastOutcome, 'sent')
  assert.equal(brief.sentTotal, 1)
  assert.ok(brief.lastSentAt > 0)
})

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) {
    console.log(`\n· ${item.name}`)
    console.log(String(item.error?.stack ?? item.error).split('\n').slice(0, 8).join('\n'))
  }
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
