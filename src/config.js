/**
 * 配置：默认值 + Config Schema + 读取器。
 *
 * DSH 的两条硬规矩（踩过就废）：
 *  1. 所有用户可调项 **必须** `.volatile()`，否则不进设置页、也拒绝写回；
 *  2. 读到的值是 `{get()}` 包装，必须递归解包，否则 `JSON.stringify` 变 `{}`。
 * 本文件里 DEFAULTS 与 Schema 逐项对应，改一处要改两处（有断言兜底，见 assertSchemaCovers）。
 */
import { Schema } from './schema.js'
import { clamp, num, plain } from './util.js'

/** 出厂默认（与 Schema 的 .default 逐字一致；offline 测试会断言这点）。 */
export const DEFAULTS = {
  enabled: true,
  debug: false,

  library: {
    maxCount: 500,
    maxTotalMB: 200,
    maxItemMB: 6,
    blockedIds: '',
    hiddenIds: '',
  },

  collect: {
    enabled: true,
    everyHours: 12,
    windowMin: 30,
    topHours: 24,
    topCount: 10,
    maxPerHour: 10,
    stickerOnly: true,
    stickerMaxDim: 1920,
    stickerMaxBytes: 10485760,
  },

  vision: {
    recognizeOnIngest: true,
    ingestBudgetPerDay: 20,
    autoTagAfterScan: true,
    organizeBatchSize: 4,
    organizeMaxAttempts: 2,
    organizeOnTagFail: 'delete',
    providerId: '',
    model: '',
    tagCategories: '',
    customTags: '',
  },

  send: {
    frequency: 'occasional',
    minIntervalSec: 30,
    globalIntervalSec: 15,
    dailyLimit: 40,
    keepRecentCount: 5,
    showTextInContext: true,
    sendAsSticker: true,
    subType: 1,
    imagePosition: 'after',
    adminOnly: true,
    adminIds: '',
  },

  prompt: {
    encourage: 3,
    maxCandidates: 8,
    candidatesLevel: 'compact',
    blockOtherSticker: true,
  },

  maintenance: {
    deleteOldestCount: 25,
    deleteOldestKeep: 10,
  },

  // ── v2 ──────────────────────────────────────────────────────
  store: {
    dataDir: '',
  },

  proactive: {
    enabled: false,
    mode: 'serial',
    probability: 0.25,
    stickerOnly: true,
    embedMode: false,
    maxPerTurn: 1,
    idleTurns: 2,
    model: '',
  },

  battle: {
    joinEnabled: true,
    joinWindowSec: 30,
    joinThreshold: 3,
    burstEnabled: true,
    burstCount: 2,
    burstProbability: 0.2,
    teamEnabled: false,
    teamBudgetPerDay: 10,
  },

  backup: {
    enabled: false,
    at: '06:00',
    dir: '',
    keep: 7,
    deflate: false,
  },

  gif: {
    normalizeOnSend: false,
  },
}

const MOODS = [
  '开心', '无奈', '生气', '难过', '害羞', '惊讶', '嘲讽',
  '赞同', '拒绝', '打招呼', '关心', '沙雕',
  '发呆', '困', '偷看', '紧张', '插画', '其他',
  '无意义',
]

/** 可写在标签里的情绪词（供工具 description 与校验共用）。 */
export const MOOD_WORDS = MOODS

/** 四档配图频率（值域）。 */
export const FREQ_LEVELS = ['rare', 'occasional', 'normal', 'often']

/**
 * Config 声明。
 *
 * ⚠️ 每一个叶子都要 `.volatile()`。`role` 这类身份开关不要加 `.default()`
 * （默认值会让没声明的实例也拿到它），本插件没有这类字段。
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .description('总开关。关掉后不再收图、不再把表情列进提示词、模型工具也全部拒绝（已有库留在磁盘上不删）。')
    .default(DEFAULTS.enabled).volatile(),
  debug: Schema.boolean()
    .description('调试日志：收图/挑选/发送闸每次判定都打一行。排「为什么这次没发出去」时打开。')
    .default(DEFAULTS.debug).volatile(),

  library: Schema.object({
    maxCount: Schema.number()
      .description('库最多多少张。到上限后收新的会先淘汰「最少发、最久没用」的旧图。')
      .default(DEFAULTS.library.maxCount).min(10).max(5000).volatile(),
    maxTotalMB: Schema.number()
      .description('图片总占用上限（MB）。与张数哪个先到算哪个。')
      .default(DEFAULTS.library.maxTotalMB).min(1).max(4000).volatile(),
    maxItemMB: Schema.number()
      .description('单张图片大小上限（MB），超过直接不收。动图（GIF）放宽到硬顶 12MB。')
      .default(DEFAULTS.library.maxItemMB).min(1).max(12).volatile(),
    blockedIds: Schema.string()
      .description('永久剔除名单：填表情编号（#后面那串），逗号分隔。这些人永远不收、也不会进候选。')
      .default(DEFAULTS.library.blockedIds).volatile(),
    hiddenIds: Schema.string()
      .description('手工隐掉的编号（逗号分隔）。软删除会自己落盘维护，这里只做兜底。')
      .default(DEFAULTS.library.hiddenIds).volatile(),
  }).description('表情库').default(DEFAULTS.library),

  collect: Schema.object({
    enabled: Schema.boolean()
      .description('聊天时顺带收表情（群友发的表情包自动入库）。关掉后只靠手动/定时收。')
      .default(DEFAULTS.collect.enabled).volatile(),
    everyHours: Schema.number()
      .description('每隔几小时按「最常用」自动收一次（0 = 关掉定时，只用工具手动收）。')
      .default(DEFAULTS.collect.everyHours).min(0).max(168).volatile(),
    windowMin: Schema.number()
      .description('聊天时顺带收：只看最近多少分钟的消息。')
      .default(DEFAULTS.collect.windowMin).min(5).max(1440).volatile(),
    topHours: Schema.number()
      .description('统计「最常用」时往回看几小时（定时与手动收集共用）。')
      .default(DEFAULTS.collect.topHours).min(1).max(720).volatile(),
    topCount: Schema.number()
      .description('每次最多收几个「最常用的」。已在库里的会跳过并顺延，候选不够就提前结束。')
      .default(DEFAULTS.collect.topCount).min(1).max(60).volatile(),
    maxPerHour: Schema.number()
      .description('每小时最多收几张（防刷屏式收藏）。0 = 不限。')
      .default(DEFAULTS.collect.maxPerHour).min(0).max(999).volatile(),
    stickerOnly: Schema.boolean()
      .description('只收表情包：按尺寸/格式/视觉判定过滤掉照片与截图。关掉则群里的图都收。')
      .default(DEFAULTS.collect.stickerOnly).volatile(),
    stickerMaxDim: Schema.number()
      .description('只收表情包时，最长边不超过多少像素才算表情（照片通常更大）。默认 1920，基本不会误杀聊天表情；'
        + '动图（GIF）不受这一项限制。')
      .default(DEFAULTS.collect.stickerMaxDim).min(64).max(4096).volatile(),
    stickerMaxBytes: Schema.number()
      .description('只收表情包时，单张字节上限（比库的硬上限更严，用于判定「不像表情」）。默认 10MB；'
        + '动图（GIF）不受这一项限制。')
      .default(DEFAULTS.collect.stickerMaxBytes).min(1024).max(12582912).volatile(),
  }).description('自动收集').default(DEFAULTS.collect),

  vision: Schema.object({
    recognizeOnIngest: Schema.boolean()
      .description('每收进一张新图就让模型看一遍，记下图上的文字与适用场合（每张多一次视觉调用）。')
      .default(DEFAULTS.vision.recognizeOnIngest).volatile(),
    ingestBudgetPerDay: Schema.number()
      .description('「收录时识图」每天最多花多少次（0 = 不限）。超出的图不丢，之后可用「整理」补。')
      .default(DEFAULTS.vision.ingestBudgetPerDay).min(0).max(500).volatile(),
    autoTagAfterScan: Schema.boolean()
      .description('往回翻聊天收完之后，自动把没打标签的图看一遍并写好标签。')
      .default(DEFAULTS.vision.autoTagAfterScan).volatile(),
    organizeBatchSize: Schema.number()
      .description('「整理」一批看几张（1~8）。越大越快，但一次失败影响面也越大。')
      .default(DEFAULTS.vision.organizeBatchSize).min(1).max(8).volatile(),
    organizeMaxAttempts: Schema.number()
      .description('某张图被判定「无意义」累计几次后才按下面策略处理（默认 2 次）。')
      .default(DEFAULTS.vision.organizeMaxAttempts).min(1).max(5).volatile(),
    organizeOnTagFail: Schema.union(['delete', 'keep'])
      .description('认不出来的图（累计达标后）：delete = 删掉，keep = 留着但不再当候选。')
      .default(DEFAULTS.vision.organizeOnTagFail).volatile(),
    providerId: Schema.string()
      .description('看图用的模型 route（provider id）。留空 = 用当前会话的模型。')
      .default(DEFAULTS.vision.providerId).volatile(),
    model: Schema.string()
      .description('看图用的具体模型名。留空 = 用当前会话的模型；必须支持图片输入。')
      .default(DEFAULTS.vision.model).volatile(),
    tagCategories: Schema.string()
      .description('预设标签类别。一行一个类别，格式「类别: 词1, 词2」。'
        + '例：\\n情绪: 开心, 无奈, 生气\\n人物: 猫娘, 大叔\\n动作: 挥手, 比心。'
        + '留空则只用内置的 18 个情绪词。')
      .default(DEFAULTS.vision.tagCategories).volatile(),
    customTags: Schema.string()
      .description('不属于任何类别的自定义标签，逗号分隔。打标时模型可以从中选。')
      .default(DEFAULTS.vision.customTags).volatile(),
  }).description('视觉识别 / 打标').default(DEFAULTS.vision),

  send: Schema.object({
    frequency: Schema.union(FREQ_LEVELS)
      .description('聊天配图频率档位：rare 每群日 15 张 / occasional 30 / normal 每分钟最多 2 / often 不限。')
      .default(DEFAULTS.send.frequency).volatile(),
    minIntervalSec: Schema.number()
      .description('同一个群两次发表情的最小间隔（秒）。0 = 不限制。')
      .default(DEFAULTS.send.minIntervalSec).min(0).max(3600).volatile(),
    globalIntervalSec: Schema.number()
      .description('不管哪个群，两次发表情之间至少隔多久（秒）。0 = 不限制。')
      .default(DEFAULTS.send.globalIntervalSec).min(0).max(3600).volatile(),
    dailyLimit: Schema.number()
      .description('每天最多发几张（所有群合计）。0 = 不限。')
      .default(DEFAULTS.send.dailyLimit).min(0).max(2000).volatile(),
    keepRecentCount: Schema.number()
      .description('每轮给模型几个候选（1~8）。给太少挑不到合适的，给太多会挑花眼。')
      .default(DEFAULTS.send.keepRecentCount).min(1).max(8).volatile(),
    showTextInContext: Schema.boolean()
      .description('候选行里带上识别出的「图上的文字」，挑得更准（省一点 token 可关）。')
      .default(DEFAULTS.send.showTextInContext).volatile(),
    sendAsSticker: Schema.boolean()
      .description('按「小表情」形式发送：图片段带 sub_type=1，QQ 里显示为小表情而不是大图。关掉则按普通图片发（sub_type 跟着下项走）。')
      .default(DEFAULTS.send.sendAsSticker).volatile(),
    subType: Schema.number()
      .description('写入图片段的 sub_type 值：1 = 表情（QQ 里显示为小表情，可长按收藏），0 = 普通图片。')
      .default(DEFAULTS.send.subType).min(0).max(1).volatile(),
    imagePosition: Schema.union(['after', 'before'])
      .description('图片相对文字的位置：after = 等文字发完再发图（默认）；before = 先发图再发文字。'
        + '需要桥接层的延迟队列配合，桥接不支持时按 after 处理。')
      .default(DEFAULTS.send.imagePosition).volatile(),
    adminOnly: Schema.boolean()
      .description('只有管理员能改标签/整理清除：群主、群管理员、主人与下面填的 QQ 号。关掉则任何人都能让机器人整理。')
      .default(DEFAULTS.send.adminOnly).volatile(),
    adminIds: Schema.string()
      .description('额外授权的 QQ 号（逗号分隔），即使不是群管理也能改标签。')
      .default(DEFAULTS.send.adminIds).volatile(),
  }).description('发送与权限').default(DEFAULTS.send),

  prompt: Schema.object({
    encourage: Schema.number()
      .description('提示词层面「引导」模型多发表情的积极度：0 保守 / 1 偶尔 / 2 较积极 / 3 很积极。不是强制。')
      .default(DEFAULTS.prompt.encourage).min(0).max(3).volatile(),
    maxCandidates: Schema.number()
      .description('每轮列进上下文的候选张数。')
      .default(DEFAULTS.prompt.maxCandidates).min(3).max(20).volatile(),
    candidatesLevel: Schema.union(['full', 'compact', 'off'])
      .description('候选段详细程度：full 带统计 / compact 只列编号标签 / off 不注入（模型自己调工具看）。')
      .default(DEFAULTS.prompt.candidatesLevel).volatile(),
    blockOtherSticker: Schema.boolean()
      .description('声明「发表情只用本库」：隐藏别的表情类工具（只能藏全局层注册的，且只对 QQ 会话生效）。')
      .default(DEFAULTS.prompt.blockOtherSticker).volatile(),
  }).description('提示词').default(DEFAULTS.prompt),

  maintenance: Schema.object({
    deleteOldestCount: Schema.number()
      .description('「删除最早」一次删几张（按入库时间，优先删从没被发过的）。')
      .default(DEFAULTS.maintenance.deleteOldestCount).min(1).max(500).volatile(),
    deleteOldestKeep: Schema.number()
      .description('删除时的保底留存张数：无论删多少，库里至少留这么多。')
      .default(DEFAULTS.maintenance.deleteOldestKeep).min(0).max(500).volatile(),
  }).description('维护').default(DEFAULTS.maintenance),

  // ══ v2 ══════════════════════════════════════════════════════

  store: Schema.object({
    dataDir: Schema.string()
      .description('自定义存储目录（绝对路径）。留空 = 默认 %DSH_HOME%/plugin-data/dsh-qq-sticker。'
        + '改完下次启动生效；新目录为空时会自动把现有库搬过去。')
      .default(DEFAULTS.store.dataDir).volatile(),
  }).description('存储').default(DEFAULTS.store),

  proactive: Schema.object({
    enabled: Schema.boolean()
      .description('主动发图：模型回完话、回合即将结束时，自己再从库里挑一张补发（不需要模型主动调工具）。'
        + '⚠️ 只能在文字回复之后补发，做不成图文同气泡（发送链一条消息只能是一张图）。')
      .default(DEFAULTS.proactive.enabled).volatile(),
    mode: Schema.union(['serial', 'prefetch'])
      .description('serial = 等文字生成完再做意图分析（更准）；prefetch = 生成期间先预取候选（更省时间，判断仍是回合末做）。')
      .default(DEFAULTS.proactive.mode).volatile(),
    probability: Schema.number()
      .description('触发概率 0~1。0.25 = 大约四轮里补一张。概率闸过了仍要过发送闸（档位/间隔/每日上限）。')
      .default(DEFAULTS.proactive.probability).min(0).max(1).volatile(),
    stickerOnly: Schema.boolean()
      .description('只发表情包：按图片尺寸/格式排除照片与截图。关掉则库里所有图都可能被发。')
      .default(DEFAULTS.proactive.stickerOnly).volatile(),
    embedMode: Schema.boolean()
      .description('嵌入模式（降级实现）：图和文字尽量同一回合紧邻发出，缩短间隔。'
        + '⚠️ 当前桥接不支持图文同气泡，这里只是把补发时机压到回合末尾。')
      .default(DEFAULTS.proactive.embedMode).volatile(),
    maxPerTurn: Schema.number()
      .description('单个回合最多补发几张（含连发）。1 = 不连发。')
      .default(DEFAULTS.proactive.maxPerTurn).min(1).max(3).volatile(),
    idleTurns: Schema.number()
      .description('至少隔几个回合没发过图才补发（防连着每轮都甩图）。0 = 不限制。')
      .default(DEFAULTS.proactive.idleTurns).min(0).max(20).volatile(),
    model: Schema.string()
      .description('做意图分析的 providerId/model（格式 provider/model）。留空 = 跟随当前会话模型。'
        + '这里只做纯文本判断，不需要视觉模型，用便宜的就行。')
      .default(DEFAULTS.proactive.model).volatile(),
  }).description('主动发图').default(DEFAULTS.proactive),

  battle: Schema.object({
    joinEnabled: Schema.boolean()
      .description('加入队形：一小段时间内多个不同的人连续发同一张图时，机器人也跟发一张。')
      .default(DEFAULTS.battle.joinEnabled).volatile(),
    joinWindowSec: Schema.number()
      .description('滑动窗口（秒）：在这个时间范围内出现同一张图才算"队形"。')
      .default(DEFAULTS.battle.joinWindowSec).min(5).max(300).volatile(),
    joinThreshold: Schema.number()
      .description('触发阈值：至少几个不同的人发了同一张图才跟发（2 太容易误触，建议 3）。')
      .default(DEFAULTS.battle.joinThreshold).min(2).max(20).volatile(),
    burstEnabled: Schema.boolean()
      .description('图片连发：触发配图时，有一定概率一次连发 2~3 张。')
      .default(DEFAULTS.battle.burstEnabled).volatile(),
    burstCount: Schema.number()
      .description('连发几张（2~3）。')
      .default(DEFAULTS.battle.burstCount).min(2).max(3).volatile(),
    burstProbability: Schema.number()
      .description('连发概率 0~1。0.2 = 五分之一的机会连发。')
      .default(DEFAULTS.battle.burstProbability).min(0).max(1).volatile(),
    teamEnabled: Schema.boolean()
      .description('团战模式：群里连续出现多张图时，让视觉模型看懂它们在表达什么，再从库里找相似图一起上。'
        + '⚠️ 每次消耗一次多模态调用，默认关闭。')
      .default(DEFAULTS.battle.teamEnabled).volatile(),
    teamBudgetPerDay: Schema.number()
      .description('团战模式每天最多触发几次（控制 token 开销）。0 = 不限。')
      .default(DEFAULTS.battle.teamBudgetPerDay).min(0).max(200).volatile(),
  }).description('斗图与连发').default(DEFAULTS.battle),

  backup: Schema.object({
    enabled: Schema.boolean()
      .description('定时备份：每天固定时间把整个库（索引 + 全部图片）打成一个 zip。')
      .default(DEFAULTS.backup.enabled).volatile(),
    at: Schema.string()
      .description('每天几点备份，格式 HH:MM（24 小时制），如 06:00。')
      .default(DEFAULTS.backup.at).volatile(),
    dir: Schema.string()
      .description('备份输出目录（绝对路径）。留空 = 数据目录下的 backups/。')
      .default(DEFAULTS.backup.dir).volatile(),
    keep: Schema.number()
      .description('最多保留几份备份，超出删最旧的。')
      .default(DEFAULTS.backup.keep).min(1).max(200).volatile(),
    deflate: Schema.boolean()
      .description('压缩备份（deflate）。图片本身已经压过，开了体积差不多但更费 CPU，默认关。')
      .default(DEFAULTS.backup.deflate).volatile(),
  }).description('定时备份').default(DEFAULTS.backup),

  gif: Schema.object({
    normalizeOnSend: Schema.boolean()
      .description('发送时统一图片格式：把非 GIF 的动图标记出来并记一条日志。'
        + '⚠️ Node 里没有图像库，做不了真实转码；这里只做「标记 + 统计」，不会改文件内容。')
      .default(DEFAULTS.gif.normalizeOnSend).volatile(),
  }).description('格式统一').default(DEFAULTS.gif),
}).description('QQ 表情包库：收集群友发的表情、给它们打标签、在聊天里自然用出来。')

/**
 * 读取并归一化配置。
 *
 * 每个字段都过一遍类型/范围收敛（设置页能填任何东西，代码不能信它）。
 * @param {unknown} raw Config 解析结果（可能是 {get()} 包装的嵌套对象）
 * @returns {object} 与 DEFAULTS 同形的普通对象
 */
export function readConfig(raw) {
  const cfg = plain(raw) && typeof plain(raw) === 'object' ? plain(raw) : {}
  const pick = (section) => (cfg[section] && typeof cfg[section] === 'object' ? cfg[section] : {})
  const lib = pick('library')
  const collect = pick('collect')
  const vision = pick('vision')
  const send = pick('send')
  const prompt = pick('prompt')
  const maintenance = pick('maintenance')
  // v2 新段
  const store = pick('store')
  const proactive = pick('proactive')
  const battle = pick('battle')
  const backup = pick('backup')
  const gif = pick('gif')

  return {
    enabled: cfg.enabled !== false,
    debug: cfg.debug === true,
    library: {
      maxCount: Math.round(clamp(lib.maxCount, 10, 5000, DEFAULTS.library.maxCount)),
      maxTotalMB: clamp(lib.maxTotalMB, 1, 4000, DEFAULTS.library.maxTotalMB),
      maxItemMB: Math.min(12, clamp(lib.maxItemMB, 1, 12, DEFAULTS.library.maxItemMB)),
      blockedIds: stringOfList(lib.blockedIds),
      hiddenIds: stringOfList(lib.hiddenIds),
    },
    collect: {
      enabled: collect.enabled !== false,
      everyHours: Math.round(clamp(collect.everyHours, 0, 168, DEFAULTS.collect.everyHours)),
      windowMin: Math.round(clamp(collect.windowMin, 5, 1440, DEFAULTS.collect.windowMin)),
      topHours: Math.round(clamp(collect.topHours, 1, 720, DEFAULTS.collect.topHours)),
      topCount: Math.round(clamp(collect.topCount, 1, 60, DEFAULTS.collect.topCount)),
      maxPerHour: Math.round(clamp(collect.maxPerHour, 0, 999, DEFAULTS.collect.maxPerHour)),
      stickerOnly: collect.stickerOnly !== false,
      stickerMaxDim: Math.round(clamp(collect.stickerMaxDim, 64, 4096, DEFAULTS.collect.stickerMaxDim)),
      stickerMaxBytes: Math.round(clamp(collect.stickerMaxBytes, 1024, 12582912, DEFAULTS.collect.stickerMaxBytes)),
    },
    vision: {
      recognizeOnIngest: vision.recognizeOnIngest !== false,
      ingestBudgetPerDay: Math.round(clamp(vision.ingestBudgetPerDay, 0, 500, DEFAULTS.vision.ingestBudgetPerDay)),
      autoTagAfterScan: vision.autoTagAfterScan !== false,
      organizeBatchSize: Math.round(clamp(vision.organizeBatchSize, 1, 8, DEFAULTS.vision.organizeBatchSize)),
      organizeMaxAttempts: Math.round(clamp(vision.organizeMaxAttempts, 1, 5, DEFAULTS.vision.organizeMaxAttempts)),
      organizeOnTagFail: vision.organizeOnTagFail === 'keep' ? 'keep' : 'delete',
      providerId: String(vision.providerId ?? '').trim(),
      model: String(vision.model ?? '').trim(),
      tagCategories: String(vision.tagCategories ?? '').trim(),
      customTags: String(vision.customTags ?? '').trim(),
    },
    send: {
      frequency: FREQ_LEVELS.includes(send.frequency) ? send.frequency : DEFAULTS.send.frequency,
      minIntervalSec: Math.round(clamp(send.minIntervalSec, 0, 3600, DEFAULTS.send.minIntervalSec)),
      globalIntervalSec: Math.round(clamp(send.globalIntervalSec, 0, 3600, DEFAULTS.send.globalIntervalSec)),
      dailyLimit: Math.round(clamp(send.dailyLimit, 0, 2000, DEFAULTS.send.dailyLimit)),
      keepRecentCount: Math.round(clamp(send.keepRecentCount, 1, 8, DEFAULTS.send.keepRecentCount)),
      showTextInContext: send.showTextInContext !== false,
      sendAsSticker: send.sendAsSticker !== false,
      // 发送形态：sendAsSticker 关掉时强制 0（普通大图）；开着时按 subType 走，默认 1
      subType: send.sendAsSticker === false
        ? 0
        : (num(send.subType, DEFAULTS.send.subType) === 0 ? 0 : 1),
      imagePosition: send.imagePosition === 'before' ? 'before' : 'after',
      adminOnly: send.adminOnly !== false,
      adminIds: stringOfList(send.adminIds),
    },
    prompt: {
      encourage: Math.round(clamp(prompt.encourage, 0, 3, DEFAULTS.prompt.encourage)),
      maxCandidates: Math.round(clamp(prompt.maxCandidates, 3, 20, DEFAULTS.prompt.maxCandidates)),
      candidatesLevel: ['full', 'compact', 'off'].includes(prompt.candidatesLevel)
        ? prompt.candidatesLevel : DEFAULTS.prompt.candidatesLevel,
      blockOtherSticker: prompt.blockOtherSticker !== false,
    },
    maintenance: {
      deleteOldestCount: Math.round(clamp(maintenance.deleteOldestCount, 1, 500, DEFAULTS.maintenance.deleteOldestCount)),
      deleteOldestKeep: Math.round(clamp(maintenance.deleteOldestKeep, 0, 500, DEFAULTS.maintenance.deleteOldestKeep)),
    },

    // ── v2 ────────────────────────────────────────────────────
    store: {
      dataDir: normalizeAbsolutePath(store.dataDir),
    },
    proactive: {
      enabled: proactive.enabled === true,
      mode: proactive.mode === 'prefetch' ? 'prefetch' : 'serial',
      probability: clamp(proactive.probability, 0, 1, DEFAULTS.proactive.probability),
      stickerOnly: proactive.stickerOnly !== false,
      embedMode: proactive.embedMode === true,
      maxPerTurn: Math.round(clamp(proactive.maxPerTurn, 1, 3, DEFAULTS.proactive.maxPerTurn)),
      idleTurns: Math.round(clamp(proactive.idleTurns, 0, 20, DEFAULTS.proactive.idleTurns)),
      model: String(proactive.model ?? '').trim(),
    },
    battle: {
      joinEnabled: battle.joinEnabled !== false,
      joinWindowSec: Math.round(clamp(battle.joinWindowSec, 5, 300, DEFAULTS.battle.joinWindowSec)),
      joinThreshold: Math.round(clamp(battle.joinThreshold, 2, 20, DEFAULTS.battle.joinThreshold)),
      burstEnabled: battle.burstEnabled !== false,
      burstCount: Math.round(clamp(battle.burstCount, 2, 3, DEFAULTS.battle.burstCount)),
      burstProbability: clamp(battle.burstProbability, 0, 1, DEFAULTS.battle.burstProbability),
      teamEnabled: battle.teamEnabled === true,
      teamBudgetPerDay: Math.round(clamp(battle.teamBudgetPerDay, 0, 200, DEFAULTS.battle.teamBudgetPerDay)),
    },
    backup: {
      enabled: backup.enabled === true,
      at: normalizeClock(backup.at),
      dir: normalizeAbsolutePath(backup.dir),
      keep: Math.round(clamp(backup.keep, 1, 200, DEFAULTS.backup.keep)),
      deflate: backup.deflate === true,
    },
    gif: {
      normalizeOnSend: gif.normalizeOnSend === true,
    },
  }
}

/**
 * 绝对路径归一化：只接受绝对路径，其它一律当"没填"。
 *
 * 为什么不用 `path.isAbsolute` 就完：设置页能填任何东西，而且用户在 Windows 上
 * 可能填 `D:\x` 也可能填 `D:/x`。这里只做最小判断（盘符或 UNC 或 POSIX / 开头），
 * 真正的路径安全交给调用方（`store.js` 会再校验一次）。
 *
 * @param {unknown} value
 * @returns {string} 绝对路径，或 '' 表示未配置
 */
export function normalizeAbsolutePath(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  // 显式拒绝相对路径（相对路径的基准不确定，容易在别的 cwd 下写到意外位置）
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || text.startsWith('/')
  if (!isAbsolute) return ''
  // 去掉末尾多余的斜杠，但保留根（`D:\` 不能变成 `D:`）
  return text.replace(/[\\/]+$/, (match) => (/^[a-zA-Z]:[\\/]$/.test(text) ? match[0] : '')) || text
}

/**
 * 时钟归一化：'HH:MM' → 'HH:MM'，其它 → DEFAULTS。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeClock(value) {
  const text = String(value ?? '').trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) return DEFAULTS.backup.at
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return DEFAULTS.backup.at
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return DEFAULTS.backup.at
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 逗号/分号/空格分隔的字符串 → 去重数组（blockedIds / adminIds 共用）。 */
export function stringOfList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 配置里是否认某个 QQ 号为管理员额外授权。 */
export function isExtraAdmin(cfg, userId) {
  const id = String(userId ?? '').trim()
  if (!id) return false
  return cfg.send.adminIds.includes(id)
}
