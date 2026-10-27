/**
 * dsh-qq-sticker —— 「QQ 表情包库」侧边栏面板（Client 半）。
 *
 * 设计文档：D:\DeepSeekHarness_workarea\Work\dsh-qq-sticker-UI-设计.md
 * 接口契约：D:\DeepSeekHarness_workarea\Work\sticker-ui-contract.md
 *
 * 结构：
 *   sidebar.panellist  → QqStickerIcon   （侧边栏图标，id = 'qq-sticker'）
 *   main               → StickerPanel    （点图标后的整块面板，key = 'qq-sticker'）
 *      ├─ PanelHeader   标题 / 状态灯 / 刷新
 *      ├─ TabBar        概览 · 操作 · 设置
 *      ├─ StatusTab     4 统计卡 + 容量条 + 组成 + 健康 + 数据目录
 *      ├─ ActionsTab    5 个动作卡 + 危险区（清空库）+ 任务进度
 *      └─ ConfigTab     4 个折叠分类：发送 / 收集 / 视觉 / 高级
 *
 * 红线：
 *   · 零外部依赖（React 由宿主模块表提供，其余全手写）；
 *   · 只用 --dsw-alias-* 主题令牌，深浅色自动适配；
 *   · 类名统一 qqs- 前缀，不写全局选择器，样式在 ctx.effect 里注册/清理。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-qq-sticker',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ───────────────────────────────────────────── 常量

    /** profile 里本插件的 patch id，同时也是 settings namespace。 */
    const ENTRY_ID = 'qq-sticker'
    /** 主面板 key 与侧边栏 id 必须一致，宿主靠它配对按钮与面板。 */
    const PANEL_KEY = 'qq-sticker'
    /** 紧挨 qq-bridge（order 26）下面。 */
    const SIDEBAR_ORDER = 27
    const API = '/dsh-qq-sticker'
    const POLL_MS = 5000
    const MAX_ERR_BACKOFF_MS = 60_000

    const TABS = [
      { id: 'status', label: '概览' },
      { id: 'actions', label: '操作' },
      { id: 'config', label: '设置' },
    ]

    /** 四档配图频率：值与 Host 的 FREQ_LEVELS 对齐，说明抄 gate.js。 */
    const FREQ_OPTIONS = [
      { value: 'rare', label: '很少', desc: '每群每天约 15 张，最小间隔 60 分钟' },
      { value: 'occasional', label: '偶尔', desc: '每群每天约 30 张，最小间隔 20 分钟' },
      { value: 'normal', label: '一般', desc: '每分钟最多 2 张' },
      { value: 'often', label: '经常', desc: '基本不限量，别连着刷同一张' },
    ]

    /** 打标失败策略。 */
    const TAG_FAIL_OPTIONS = [
      { value: 'delete', label: '删掉', desc: '认不出来的图直接移除' },
      { value: 'keep', label: '留着', desc: '保留但不再当候选' },
    ]

    /** 候选段详细程度。 */
    const CANDIDATE_LEVEL_OPTIONS = [
      { value: 'full', label: '完整（带统计）', desc: '最准，占 token 最多' },
      { value: 'compact', label: '精简（只列编号标签）', desc: '默认，省 token' },
      { value: 'off', label: '关闭注入', desc: '模型自己调工具看' },
    ]

    /** 主动发图的检索模式（v2）。 */
    const PROACTIVE_MODE_OPTIONS = [
      { value: 'serial', label: '串行检索', desc: '等文字生成完再分析意图（更准，推荐）' },
      { value: 'prefetch', label: '并发检索', desc: '生成期间先预取候选（更省时间，判断仍在回合末）' },
    ]

    /** 图片相对文字的位置（v2.1）。 */
    const IMAGE_POSITION_OPTIONS = [
      { value: 'after', label: '文字之后', desc: '等文字发完再补图（默认，和现有发送链一致）' },
      { value: 'before', label: '文字之前', desc: '先发图再发文字（需要桥接延迟队列配合）' },
    ]

    /**
     * 配置字段元数据。
     *
     * primary = true 的常显；其余进同 Section 的「展开更多」里。
     * 默认值抄 Host 的 src/config.js DEFAULTS（离线回读时兜底显示用）。
     * unit 只用于输入框右侧装饰，不参与任何提交。
     */
    const FIELDS = [
      // ── 发送 ──────────────────────────────────────
      { path: 'send.frequency', label: '配图频率', type: 'select', options: FREQ_OPTIONS, section: 'send', primary: true },      { path: 'send.minIntervalSec', label: '单群间隔', type: 'number', min: 0, max: 3600, unit: '秒', section: 'send', primary: true, desc: '同一群两次发表情至少隔多久' },
      { path: 'send.globalIntervalSec', label: '全局间隔', type: 'number', min: 0, max: 3600, unit: '秒', section: 'send', primary: true, desc: '不分群，两次发表情之间至少隔多久' },
      { path: 'send.dailyLimit', label: '每日上限', type: 'number', min: 0, max: 2000, unit: '张', section: 'send', primary: true, desc: '所有群合计，0 = 不限' },
      { path: 'send.keepRecentCount', label: '每轮候选数', type: 'number', min: 1, max: 8, unit: '张', section: 'send', group: 'context', desc: '给模型挑的范围，太少挑不到、太多挑花眼' },
      { path: 'send.showTextInContext', label: '候选带图上的文字', type: 'switch', section: 'send', group: 'context', desc: '挑得更准，关掉省一点 token' },
      { path: 'send.sendAsSticker', label: '按小表情发送', type: 'switch', section: 'send', group: 'context', desc: '当前桥接未透传 sub_type，打开也发大图' },
      { path: 'send.subType', label: '图片段 sub_type', type: 'number', min: 0, max: 1, section: 'send', group: 'context', desc: '1 = 表情（QQ 里显示为小表情，可长按收藏），0 = 普通图片' },
      { path: 'send.imagePosition', label: '图片位置', type: 'select', options: IMAGE_POSITION_OPTIONS, section: 'send', group: 'context', desc: '图和文字哪个先发；桥接不支持时按「文字之后」处理' },
      { path: 'send.adminOnly', label: '仅管理员可改库', type: 'switch', section: 'send', group: 'permission', desc: '关掉则任何人能让机器人整理' },
      { path: 'send.adminIds', label: '额外管理员 QQ', type: 'text', placeholder: '逗号分隔', section: 'send', group: 'permission', desc: '即使不是群管也授权' },

      // ── 收集 ──────────────────────────────────────
      { path: 'collect.enabled', label: '自动收集', type: 'switch', section: 'collect', primary: true, desc: '群友发的表情包自动入库' },
      { path: 'collect.maxPerHour', label: '每小时上限', type: 'number', min: 0, max: 999, unit: '张', section: 'collect', primary: true, desc: '0 = 不限，防刷屏式收藏' },
      { path: 'collect.everyHours', label: '定时收集间隔', type: 'number', min: 0, max: 168, unit: '小时', section: 'collect', group: 'schedule', desc: '按「最常用」自动收一次，0 = 关掉定时' },
      { path: 'collect.windowMin', label: '顺带收集窗口', type: 'number', min: 5, max: 1440, unit: '分钟', section: 'collect', group: 'schedule', desc: '聊天时只看最近多少分钟的消息' },
      { path: 'collect.topHours', label: '统计回溯时长', type: 'number', min: 1, max: 720, unit: '小时', section: 'collect', group: 'schedule', desc: '统计「最常用」时往回看几小时' },
      { path: 'collect.topCount', label: '每次收几张', type: 'number', min: 1, max: 60, unit: '张', section: 'collect', group: 'schedule', desc: '每次最多收几个「最常用的」' },
      { path: 'collect.stickerOnly', label: '只收表情包', type: 'switch', section: 'collect', group: 'filter', desc: '过滤掉照片与截图' },
      { path: 'collect.stickerMaxDim', label: '表情最大边长', type: 'number', min: 64, max: 2048, unit: 'px', section: 'collect', group: 'filter', desc: '超过就判定「不像表情」' },
      { path: 'collect.stickerMaxBytes', label: '表情最大字节', type: 'number', min: 1024, max: 12582912, unit: '字节', section: 'collect', group: 'filter', desc: '比库硬上限更严，用于判定「不像表情」' },

      // ── 视觉 ──────────────────────────────────────
      { path: 'vision.recognizeOnIngest', label: '收录时识图', type: 'switch', section: 'vision', primary: true, desc: '每收一张就让模型看一遍，多一次视觉调用' },
      { path: 'vision.providerId', label: '视觉模型 provider', type: 'model-provider', section: 'vision', primary: true, desc: '选一个能看图的 provider；留空 = 跟随当前会话' },
      { path: 'vision.model', label: '视觉模型 ID', type: 'model', modelMode: 'id', providerPath: 'vision.providerId', section: 'vision', primary: true, desc: '必须支持图片输入；留空 = 跟随当前会话' },
      { path: 'vision.ingestBudgetPerDay', label: '识图日额度', type: 'number', min: 0, max: 500, unit: '次', section: 'vision', group: 'tagging', desc: '0 = 不限；超出的图之后可用「整理」补' },
      { path: 'vision.autoTagAfterScan', label: '回扫后自动打标', type: 'switch', section: 'vision', group: 'tagging', desc: '往回翻聊天收完后，自动补标签' },
      { path: 'vision.organizeBatchSize', label: '整理批大小', type: 'number', min: 1, max: 8, unit: '张', section: 'vision', group: 'tagging', desc: '越大越快，单次失败影响面也越大' },
      { path: 'vision.organizeMaxAttempts', label: '判无意义阈值', type: 'number', min: 1, max: 5, unit: '次', section: 'vision', group: 'tagging', desc: '累计几次「无意义」后才按策略处理' },
      { path: 'vision.organizeOnTagFail', label: '认不出来怎么办', type: 'select', options: TAG_FAIL_OPTIONS, section: 'vision', group: 'tagging' },

      // ── 高级 ──────────────────────────────────────
      { path: 'library.maxCount', label: '库容量上限', type: 'number', min: 10, max: 5000, unit: '张', section: 'advanced', group: 'storage', desc: '到上限先淘汰「最少发、最久没用」的' },
      { path: 'library.maxTotalMB', label: '总占用上限', type: 'number', min: 1, max: 4000, unit: 'MB', section: 'advanced', group: 'storage' },
      { path: 'library.maxItemMB', label: '单张大小上限', type: 'number', min: 1, max: 12, unit: 'MB', section: 'advanced', group: 'storage', desc: '硬顶 12MB' },
      { path: 'library.blockedIds', label: '永久剔除名单', type: 'text', placeholder: '表情编号，逗号分隔', section: 'advanced', group: 'storage', desc: '这些人永远不收、不进候选' },
      { path: 'library.hiddenIds', label: '手工隐藏名单', type: 'text', placeholder: '表情编号，逗号分隔', section: 'advanced', group: 'storage' },
      { path: 'prompt.encourage', label: '配图积极度', type: 'number', min: 0, max: 3, section: 'advanced', group: 'prompt', desc: '提示词层面的引导：0 保守 / 3 很积极' },
      { path: 'prompt.maxCandidates', label: '上下文候选数', type: 'number', min: 3, max: 20, unit: '张', section: 'advanced', group: 'prompt' },
      { path: 'prompt.candidatesLevel', label: '候选段详细度', type: 'select', options: CANDIDATE_LEVEL_OPTIONS, section: 'advanced', group: 'prompt' },
      { path: 'prompt.blockOtherSticker', label: '只用本库表情', type: 'switch', section: 'advanced', group: 'prompt', desc: '隐藏别的表情类工具（仅 QQ 会话）' },
      { path: 'maintenance.deleteOldestCount', label: '「删最早」每次张数', type: 'number', min: 1, max: 500, unit: '张', section: 'advanced', group: 'maintenance' },
      { path: 'maintenance.deleteOldestKeep', label: '「删最早」保底留存', type: 'number', min: 0, max: 500, unit: '张', section: 'advanced', group: 'maintenance' },

      // ── v2：视觉标签体系（放 vision 段，独立子分组）─────────────
      { path: 'vision.tagCategories', label: '预设标签类别', type: 'textarea', section: 'vision', group: 'labels', desc: '一行一个类别，格式「类别: 词1, 词2」' },
      { path: 'vision.customTags', label: '自定义标签', type: 'text', placeholder: '逗号分隔，不属于任何类别', section: 'vision', group: 'labels' },

      // ── v2：主动发图 ─────────────────────────────────
      { path: 'proactive.enabled', label: '主动发图', type: 'switch', section: 'proactive', primary: true, desc: '模型回完话后，插件自己从库里补一张（不用它主动调工具）' },
      { path: 'proactive.probability', label: '触发概率', type: 'number', min: 0, max: 1, step: 0.05, unit: '', section: 'proactive', primary: true, desc: '0~1。0.25 = 大约四轮补一张；概率没过就不花任何 token' },
      { path: 'proactive.mode', label: '检索模式', type: 'select', options: PROACTIVE_MODE_OPTIONS, section: 'proactive', group: 'trigger' },
      { path: 'proactive.model', label: '意图分析模型', type: 'model', modelMode: 'ref', section: 'proactive', group: 'trigger', desc: '只做纯文本判断，用便宜的模型就够；留空跟随当前' },
      { path: 'proactive.maxPerTurn', label: '单回合最多几张', type: 'number', min: 1, max: 3, unit: '张', section: 'proactive', group: 'trigger' },
      { path: 'proactive.idleTurns', label: '冷却回合数', type: 'number', min: 0, max: 20, unit: '回合', section: 'proactive', group: 'trigger', desc: '至少隔几个回合没发图才补发，0 = 不限制' },
      { path: 'proactive.stickerOnly', label: '只发表情包', type: 'switch', section: 'proactive', group: 'limits', desc: '排除照片与截图' },
      { path: 'proactive.embedMode', label: '嵌入模式', type: 'switch', section: 'proactive', group: 'limits', desc: '图和时间尽量同一回合紧邻发（⚠️ 桥接不支持图文同气泡）' },

      // ── v2：斗图与连发 ───────────────────────────────
      { path: 'battle.joinEnabled', label: '加入队形', type: 'switch', section: 'battle', primary: true, desc: '多个人连续发同一张图时，机器人也跟一张' },
      { path: 'battle.joinThreshold', label: '队形阈值', type: 'number', min: 2, max: 20, unit: '人', section: 'battle', group: 'join', desc: '至少几个不同的人发了同一张' },
      { path: 'battle.joinWindowSec', label: '队形窗口', type: 'number', min: 5, max: 300, unit: '秒', section: 'battle', group: 'join' },
      { path: 'battle.burstEnabled', label: '图片连发', type: 'switch', section: 'battle', group: 'burst', desc: '触发配图时有机会一次发 2~3 张' },
      { path: 'battle.burstCount', label: '连发张数', type: 'number', min: 2, max: 3, unit: '张', section: 'battle', group: 'burst' },
      { path: 'battle.burstProbability', label: '连发概率', type: 'number', min: 0, max: 1, step: 0.05, section: 'battle', group: 'burst' },
      { path: 'battle.teamEnabled', label: '团战模式', type: 'switch', section: 'battle', group: 'team', desc: '⚠️ 看图分析语境再找相似图，每次消耗一次多模态调用' },
      { path: 'battle.teamBudgetPerDay', label: '团战日额度', type: 'number', min: 0, max: 200, unit: '次', section: 'battle', group: 'team', desc: '0 = 不限，控制 token 开销' },

      // ── v2：定时备份 ─────────────────────────────────
      { path: 'backup.enabled', label: '定时备份', type: 'switch', section: 'backup', primary: true, desc: '每天固定时间把整库打包成 zip' },
      { path: 'backup.at', label: '备份时间', type: 'text', placeholder: 'HH:MM，如 06:00', section: 'backup', group: 'schedule' },
      { path: 'backup.dir', label: '备份目录', type: 'text', placeholder: '留空 = 数据目录下 backups/', section: 'backup', group: 'schedule' },
      { path: 'backup.keep', label: '保留份数', type: 'number', min: 1, max: 200, unit: '份', section: 'backup', group: 'schedule', desc: '超出删最旧的' },
      { path: 'backup.deflate', label: '压缩备份', type: 'switch', section: 'backup', group: 'schedule', desc: '图片已压过，开了体积差不多但更费 CPU' },

      // ── v2：存储与格式（放 advanced）─────────────────
      { path: 'store.dataDir', label: '自定义存储目录', type: 'path', placeholder: '绝对路径，留空用默认', section: 'advanced', group: 'storage', desc: '改完要重启 DSH 才生效；新目录为空时会自动搬迁现有库' },
      { path: 'gif.normalizeOnSend', label: '发送时统一格式', type: 'switch', section: 'advanced', group: 'misc', desc: '⚠️ Node 无图像库，只做标记与统计，不做真实转码' },

      { path: 'enabled', label: '插件总开关', type: 'switch', section: 'advanced', group: 'misc', desc: '关掉后不收图、不进提示词、工具全拒（库不删）' },
      { path: 'debug', label: '调试日志', type: 'switch', section: 'advanced', group: 'misc', desc: '收图/挑选/发送每次判定都打一行' },
    ]

    /**
     * 配置缺省值（点分路径）。
     *
     * 只在 remote 还没回读完成、或某个字段在回读值里缺失时用于显示兜底。
     * 必须与 Host 的 `src/config.js` DEFAULTS 保持逐字一致 ——
     * 不一致的后果是「界面显示的一个值、实际生效的是另一个」。
     */
    const DEFAULTS = {
      'enabled': true,
      'debug': false,
      'library.maxCount': 500,
      'library.maxTotalMB': 200,
      'library.maxItemMB': 6,
      'library.blockedIds': '',
      'library.hiddenIds': '',
      'collect.enabled': true,
      'collect.everyHours': 12,
      'collect.windowMin': 30,
      'collect.topHours': 24,
      'collect.topCount': 10,
      'collect.maxPerHour': 10,
      'collect.stickerOnly': true,
      'collect.stickerMaxDim': 640,
      'collect.stickerMaxBytes': 1572864,
      'vision.recognizeOnIngest': true,
      'vision.ingestBudgetPerDay': 20,
      'vision.autoTagAfterScan': true,
      'vision.organizeBatchSize': 4,
      'vision.organizeMaxAttempts': 2,
      'vision.organizeOnTagFail': 'delete',
      'vision.providerId': '',
      'vision.model': '',
      'send.frequency': 'occasional',
      'send.minIntervalSec': 30,
      'send.globalIntervalSec': 15,
      'send.dailyLimit': 40,
      'send.keepRecentCount': 5,
      'send.showTextInContext': true,
      'send.sendAsSticker': true,
      'send.subType': 1,
      'send.imagePosition': 'after',
      'send.adminOnly': true,
      'send.adminIds': '',
      'prompt.encourage': 3,
      'prompt.maxCandidates': 8,
      'prompt.candidatesLevel': 'compact',
      'prompt.blockOtherSticker': true,
      'maintenance.deleteOldestCount': 25,
      'maintenance.deleteOldestKeep': 10,
      // v2（必须与 Host 的 src/config.js DEFAULTS 逐字一致）
      'vision.tagCategories': '',
      'vision.customTags': '',
      'store.dataDir': '',
      'proactive.enabled': false,
      'proactive.mode': 'serial',
      'proactive.probability': 0.25,
      'proactive.stickerOnly': true,
      'proactive.embedMode': false,
      'proactive.maxPerTurn': 1,
      'proactive.idleTurns': 2,
      'proactive.model': '',
      'battle.joinEnabled': true,
      'battle.joinWindowSec': 30,
      'battle.joinThreshold': 3,
      'battle.burstEnabled': true,
      'battle.burstCount': 2,
      'battle.burstProbability': 0.2,
      'battle.teamEnabled': false,
      'battle.teamBudgetPerDay': 10,
      'backup.enabled': false,
      'backup.at': '06:00',
      'backup.dir': '',
      'backup.keep': 7,
      'backup.deflate': false,
      'gif.normalizeOnSend': false,
    }

    /**
     * 设置页分组。
     *
     * `tone` 是卡片标题左侧装饰条用的色系（ok / warn / danger / accent），
     * 走 state 令牌，深浅色自动跟随。
     * `groups` 声明这一张卡片内部的子分组，渲染成「左侧缩进 + 淡灰竖线」的父子层级。
     */
    const SECTIONS = [
      {
        id: 'send', title: '发送设置', tone: 'accent', primaryCount: 4,
        hint: '多久用一次表情，别刷屏',
        groups: {
          ratelimit: { title: '频率与间隔', desc: '控制刷屏风险的四道闸' },
          context: { title: '上下文与协议', desc: '给模型看多少候选、按什么形式发' },
          permission: { title: '权限', desc: '谁能改动这个表情库' },
        },
      },
      {
        id: 'collect', title: '收集设置', tone: 'ok', primaryCount: 2,
        hint: '群友发的表情什么时候自动入库',
        groups: {
          schedule: { title: '定时与回扫', desc: '自动去群里收图的时机' },
          filter: { title: '筛选条件', desc: '什么才算「表情包」，别把照片和截图收进来' },
        },
      },
      {
        id: 'vision', title: '视觉打标', tone: 'accent', primaryCount: 3,
        hint: '让模型看图补标签 + 标签体系',
        groups: {
          tagging: { title: '打标策略', desc: '认不出来的图怎么处理、一次看几张' },
          labels: { title: '标签体系', desc: '预设类别与自定义词表，打标时从这里选' },
        },
      },
      {
        id: 'proactive', title: '主动发图', tone: 'warn', primaryCount: 2,
        hint: '模型说完话后自己补一张，不用它主动调工具',
        groups: {
          trigger: { title: '触发与检索', desc: '什么时候补、补几张、用哪个模型判断' },
          limits: { title: '范围限制', desc: '发什么类型的图、要不要紧邻文字' },
        },
      },
      {
        id: 'battle', title: '斗图与连发', tone: 'warn', primaryCount: 1,
        hint: '跟队形、连发、团战',
        groups: {
          join: { title: '跟队形', desc: '一群人在刷同一张图时插一脚' },
          burst: { title: '连发', desc: '一次甩出 2~3 张' },
          team: { title: '团战', desc: '看图理解语境再找相似图（最贵）' },
        },
      },
      {
        id: 'backup', title: '定时备份', tone: 'ok', primaryCount: 1,
        hint: '每天把整库打包成 zip',
        groups: {
          schedule: { title: '备份策略', desc: '什么时候备份、存到哪、留几份' },
        },
      },
      {
        id: 'advanced', title: '高级设置', tone: 'danger', primaryCount: 0,
        hint: '存储目录、库容量、提示词、维护策略',
        groups: {
          storage: { title: '存储与库容量', desc: '⚠️ 改目录要重启 DSH 才生效' },
          prompt: { title: '提示词与候选', desc: '往模型上下文里塞什么、塞多少' },
          maintenance: { title: '维护与清理', desc: '容量吃紧时先删谁' },
          misc: { title: '其它', desc: '' },
        },
      },
    ]

    /** 各动作的展示元数据。 */
    const ACTIONS = [
      {
        kind: 'organize',
        icon: 'wand',
        title: '一键整理打标',
        desc: '把还没认识的图交给视觉模型看一遍，自动写标签和图上的文字。每张一次视觉调用，会花 token。',
        primary: '开始整理',
        danger: false,
        options: [{ key: 'limit', label: '整理张数', type: 'number', min: 1, max: 60, value: 12, unit: '张' }],
        dryRun: true,
      },
      {
        kind: 'cleanup',
        icon: 'broom',
        title: '清理无意义图',
        desc: '删重复份、删所有被标「无意义」的图（与状态卡统计同口径）、剔除黑名单、清掉文件已丢失的条目。默认先试运行，看清了再真删。',
        primary: '试运行',
        danger: false,
        dryRun: true,
      },
      {
        kind: 'collect',
        icon: 'inbox',
        title: '立即收集',
        desc: '按「最近最常用」回扫各会话，把群友发过的表情收进库。和定时收集是同一套逻辑。',
        primary: '开始收集',
        danger: false,
        dryRun: null,
      },
      {
        kind: 'delete_oldest',
        icon: 'clock',
        title: '删除最早的图',
        desc: '按入库时间从早往晚删，优先删从没被发过的，并保留设置的「保底留存」张数。不可撤销。',
        primary: '开始删除',
        danger: false,
        options: [{ key: 'count', label: '删除张数', type: 'number', min: 1, max: 500, value: 25, unit: '张' }],
        dryRun: true,
      },
      {
        kind: 'report',
        icon: 'chart',
        title: '生成报表',
        desc: '统计库里哪些图真能带动群友回应、被发得最多的是哪几张。不花 token、不删不改。',
        primary: '生成报表',
        danger: false,
        dryRun: null,
      },
      // v2：立即备份
      {
        kind: 'backup',
        icon: 'db',
        title: '立即备份',
        desc: '把索引、状态和全部图片打成一个 zip 存到备份目录，按设置的份数保留最近几份。打包前会先把内存里的改动落盘。',
        primary: '立即备份',
        danger: false,
        dryRun: null,
      },
    ]

    // ───────────────────────────────────────────── 样式

    const CSS = `
/* ══ 主题变量层 ═══════════════════════════════════════════════
   只用 cordis Theme 目录里列出的 --dsw-alias-* 令牌。
   目录里没有 hover / 选中底这类令牌，用 color-mix 从 ink 派生 ——
   深浅色都自动跟随，不硬编码任何颜色。 */
.qqs-root {
  --qqs-surface: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  --qqs-surface-2: var(--dsw-alias-bg-layer-2, var(--qqs-surface));
  --qqs-line: var(--dsw-alias-border-l1);
  --qqs-line-strong: var(--dsw-alias-border-l2);
  --qqs-ink: var(--dsw-alias-label-primary);
  --qqs-ink-2: var(--dsw-alias-label-secondary);
  --qqs-accent: var(--dsw-alias-brand-primary);
  --qqs-danger: var(--dsw-alias-state-error-primary);
  --qqs-ok: var(--dsw-alias-state-success-primary);
  --qqs-warn: var(--dsw-alias-state-warn-primary);
  --qqs-hover: color-mix(in oklab, var(--qqs-ink) 7%, transparent);
  --qqs-active: color-mix(in oklab, var(--qqs-ink) 12%, transparent);
  --qqs-accent-soft: color-mix(in oklab, var(--qqs-accent) 14%, transparent);
  --qqs-danger-soft: color-mix(in oklab, var(--qqs-danger) 12%, transparent);

  box-sizing: border-box;
  display: flex; flex-direction: column;
  width: 100%; height: 100%; min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--qqs-ink);
  font-size: 13px; line-height: 1.5;
}
.qqs-root *, .qqs-root *::before, .qqs-root *::after { box-sizing: border-box; }

/* ── 头部 ─────────────────────────────────────────────────── */
.qqs-head {
  flex: 0 0 auto;
  display: flex; align-items: flex-start; gap: 14px;
  padding: 22px clamp(20px, 3vw, 40px) 0;
}
.qqs-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.qqs-title { display: flex; align-items: center; gap: 9px; font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.qqs-title-icon { display: inline-flex; color: var(--qqs-accent); }
.qqs-sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--qqs-ink-2); font-variant-numeric: tabular-nums; }
.qqs-head-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }

/* 状态灯 */
.qqs-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-idle-primary); }
.qqs-dot-ok { background: var(--qqs-ok); }
.qqs-dot-warn { background: var(--qqs-warn); }
.qqs-dot-err { background: var(--qqs-danger); }
.qqs-dot-live { animation: qqs-pulse 2s ease-in-out infinite; }
@keyframes qqs-pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

/* ── Tab ──────────────────────────────────────────────────── */
.qqs-tabs {
  flex: 0 0 auto;
  display: flex; align-items: stretch; gap: 2px;
  padding: 16px clamp(20px, 3vw, 40px) 0;
  border-bottom: 1px solid var(--qqs-line);
}
.qqs-tab {
  position: relative;
  font: inherit; font-size: 13px;
  color: var(--qqs-ink-2);
  background: transparent; border: 0; border-radius: 7px 7px 0 0;
  padding: 7px 14px 9px; cursor: pointer;
  transition: color .12s ease, background .12s ease;
  white-space: nowrap;
}
.qqs-tab:hover { color: var(--qqs-ink); background: var(--qqs-hover); }
.qqs-tab:focus-visible { outline: 2px solid var(--qqs-accent); outline-offset: -2px; }
.qqs-tab-on, .qqs-tab-on:hover { color: var(--qqs-ink); font-weight: 600; background: transparent; }
.qqs-tab-on::after {
  content: ''; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px;
  border-radius: 2px; background: var(--qqs-accent);
}
.qqs-tab-badge {
  display: inline-block; margin-left: 6px; min-width: 15px; height: 15px; padding: 0 4px;
  border-radius: 999px; background: var(--qqs-danger); color: var(--dsw-alias-label-primary);
  font-size: 9.5px; font-weight: 700; line-height: 15px; text-align: center; vertical-align: 1px;
}

/* ── 内容区 ───────────────────────────────────────────────── */
.qqs-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 18px clamp(20px, 3vw, 40px) 36px;
  display: flex; flex-direction: column; gap: 16px;
  scrollbar-gutter: stable;
}
.qqs-pane { display: flex; flex-direction: column; gap: 16px; }

/* ── 卡片 / 统计 ──────────────────────────────────────────── */
.qqs-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; }
.qqs-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px 18px;
  background: var(--qqs-surface);
  border: 1px solid var(--qqs-line);
  border-radius: 12px;
  transition: border-color .14s ease;
}
.qqs-card:hover { border-color: color-mix(in oklab, var(--qqs-ink) 18%, transparent); }
.qqs-card-flat { background: transparent; }
.qqs-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.qqs-card-title {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; font-weight: 650; letter-spacing: -.005em;
}
.qqs-card-title-icon { display: inline-flex; color: var(--qqs-accent); }
.qqs-card-desc { font-size: 11.5px; line-height: 1.55; color: var(--qqs-ink-2); }

.qqs-stat { display: flex; flex-direction: column; gap: 2px; }
.qqs-stat-value {
  display: flex; align-items: baseline; gap: 4px;
  font-size: 25px; font-weight: 650; letter-spacing: -.02em;
  font-variant-numeric: tabular-nums; line-height: 1.15;
}
.qqs-stat-unit { font-size: 11.5px; font-weight: 500; color: var(--qqs-ink-2); letter-spacing: 0; }
.qqs-stat-label { font-size: 11.5px; color: var(--qqs-ink-2); }
.qqs-stat-hint { font-size: 11px; color: var(--qqs-ink-2); opacity: .8; }
.qqs-stat-tone-warn .qqs-stat-value { color: var(--qqs-warn); }
.qqs-stat-tone-err .qqs-stat-value { color: var(--qqs-danger); }
.qqs-stat-tone-ok .qqs-stat-value { color: var(--qqs-ok); }

/* ── 容量条 ───────────────────────────────────────────────── */
.qqs-meter { display: flex; flex-direction: column; gap: 6px; }
.qqs-meter-track {
  position: relative; height: 7px; border-radius: 999px; overflow: hidden;
  background: var(--qqs-surface-2);
}
.qqs-meter-fill {
  height: 100%; border-radius: 999px; background: var(--qqs-accent);
  transition: width .35s cubic-bezier(.22,.61,.36,1);
}
.qqs-meter-fill-warn { background: var(--qqs-warn); }
.qqs-meter-fill-err { background: var(--qqs-danger); }
.qqs-meter-legend { display: flex; justify-content: space-between; gap: 10px;
  font-size: 11px; color: var(--qqs-ink-2); font-variant-numeric: tabular-nums; }

/* ── 组成徽章 ─────────────────────────────────────────────── */
.qqs-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.qqs-chip {
  display: inline-flex; align-items: baseline; gap: 5px;
  padding: 3px 9px; border-radius: 999px;
  background: var(--qqs-surface-2); border: 1px solid transparent;
  font-size: 11.5px; color: var(--qqs-ink-2); font-variant-numeric: tabular-nums;
}
.qqs-chip-v { font-weight: 650; color: var(--qqs-ink); }
.qqs-chip-warn { background: var(--qqs-danger-soft); color: var(--qqs-danger); }
.qqs-chip-warn .qqs-chip-v { color: var(--qqs-danger); }
.qqs-chip-ok { background: var(--qqs-accent-soft); }
.qqs-chip-ok .qqs-chip-v { color: var(--qqs-accent); }

/* ── 行（设置项）─────────────────────────────────────────────
   两列网格：说明文字占第一列第一行、控件占第二列第一行，
   两边共用同一条基线（align-items: baseline），说明的补充文字落到第二行。
   这样无论左侧是一行还是两行，右侧控件都不会上下飘。 */
.qqs-rows { display: flex; flex-direction: column; }
.qqs-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: 18px; row-gap: 2px;
  padding: 10px 0; border-top: 1px solid var(--qqs-line);
}
.qqs-row:first-child { border-top: 0; padding-top: 2px; }
.qqs-row-main {
  grid-column: 1; grid-row: 1;
  font-size: 12.5px; font-weight: 550; color: var(--qqs-ink);
  min-width: 0; overflow-wrap: anywhere;
}
.qqs-row-desc {
  grid-column: 1; grid-row: 2;
  font-size: 11px; line-height: 1.5; color: var(--qqs-ink-2);
  overflow-wrap: anywhere;
}
.qqs-row-ctl {
  grid-column: 2; grid-row: 1;
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  flex-wrap: nowrap;
}
/* 右侧控件统一 30px 高，和 12.5px 的行名对齐时不会忽高忽低 */
.qqs-row-ctl > .qqs-input,
.qqs-row-ctl > .qqs-select,
.qqs-row-ctl > .qqs-model { min-height: 30px; }

/* ── 输入控件 ─────────────────────────────────────────────── */
.qqs-input, .qqs-select {
  font: inherit; font-size: 12px; color: var(--qqs-ink);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--qqs-line-strong);
  border-radius: 8px; padding: 5px 10px;
  transition: border-color .12s ease, box-shadow .12s ease, background .12s ease;
  min-width: 0;
}
.qqs-input { width: 152px; }
.qqs-input:hover:not(:disabled), .qqs-select:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--qqs-ink) 34%, transparent);
}
.qqs-input:focus, .qqs-select:focus, .qqs-textarea:focus {
  outline: none;
  border-color: var(--qqs-accent);
  box-shadow: 0 0 0 3px var(--qqs-accent-soft);
}
.qqs-input:disabled, .qqs-select:disabled { opacity: .55; cursor: not-allowed; }
.qqs-input-num { width: 88px; text-align: right; font-variant-numeric: tabular-nums; }
.qqs-input-wide { width: 210px; }
.qqs-select {
  width: 196px; cursor: pointer;
  /* 原生的箭头在深色主题下几乎看不见，这里画一个纯 CSS 的 v 形 */
  padding-right: 26px;
  background-image:
    linear-gradient(45deg, transparent 50%, currentColor 50%),
    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position:
    calc(100% - 14px) calc(50% - 1px),
    calc(100% - 9px) calc(50% - 1px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  -webkit-appearance: none; appearance: none;
}
.qqs-select:disabled { background-image: none; }
.qqs-input-dirty { border-color: var(--qqs-accent); }
.qqs-unit { font-size: 11px; color: var(--qqs-ink-2); flex: 0 0 auto; padding-left: 1px; }
.qqs-num-wrap { display: inline-flex; align-items: center; gap: 6px; }

/* 模型选择：下拉 + （选「自定义」时才出现的）输入框，纵向叠在控件列 */
.qqs-model { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.qqs-model .qqs-select { width: 232px; }
.qqs-model .qqs-input { width: 232px; }
.qqs-model-hint { font-size: 10.5px; color: var(--qqs-ink-2); text-align: right; max-width: 232px; }

/* ── 路径输入（存储目录）───────────────────────────────────── */
.qqs-path { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.qqs-path-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qqs-path-input {
  flex: 1 1 260px; width: auto; min-width: 180px; max-width: 520px;
  font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace);
  font-size: 11.5px;
}
.qqs-path-hint { font-size: 10.5px; line-height: 1.5; color: var(--qqs-ink-2); }
.qqs-path-default { font-size: 10.5px; color: var(--qqs-ink-2); display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }

/* ── 本地文件夹卡（操作页顶上）─────────────────────────────── */
.qqs-card .qqs-inline > .qqs-btn { margin-left: 0; }

/* ── 多行文本（tags）与整行控件（模型选择）────────────────────
   不能塞进行右列，改成单列：说明在上、控件占满整行。 */
.qqs-row-block {
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch; row-gap: 7px;
}
.qqs-row-block .qqs-row-main { grid-column: 1; grid-row: 1; }
.qqs-row-block .qqs-row-desc { grid-column: 1; grid-row: 2; }
.qqs-row-block > .qqs-textarea-wrap,
.qqs-row-block > .qqs-model { grid-column: 1; grid-row: 3; }
.qqs-row-block > .qqs-muted { grid-column: 1; grid-row: 3; }
.qqs-row-block .qqs-model { align-items: stretch; }
.qqs-row-block .qqs-model .qqs-select,
.qqs-row-block .qqs-model .qqs-input { width: 100%; max-width: 340px; }
.qqs-row-block .qqs-model-hint { text-align: left; max-width: 340px; }
.qqs-row-block-ctl { display: flex; align-items: center; gap: 8px; }

/* 字段在 Host 侧 Schema 里还不存在（改了 config.js 没重启 DSH）：淡出 + 标记 */
.qqs-row-unknown .qqs-row-main,
.qqs-row-unknown .qqs-row-desc { opacity: .62; }
.qqs-need-restart {
  display: inline-block; margin-left: 7px; padding: 0 6px;
  border-radius: 999px; font-size: 9.5px; font-weight: 650; letter-spacing: .02em;
  color: var(--qqs-warn); background: color-mix(in oklab, var(--qqs-warn) 15%, transparent);
  vertical-align: 1px;
}

/* ── 提示条（需要重启 / 保存失败的原因）────────────────────── */
.qqs-notice {
  display: flex; align-items: flex-start; gap: 9px;
  padding: 11px 14px; border-radius: 10px;
  font-size: 11.5px; line-height: 1.55; overflow-wrap: anywhere;
}
.qqs-notice-warn {
  background: color-mix(in oklab, var(--qqs-warn) 11%, transparent);
  border: 1px solid color-mix(in oklab, var(--qqs-warn) 42%, transparent);
  color: var(--qqs-ink);
}
.qqs-notice-warn .qqs-notice-icon { color: var(--qqs-warn); }
.qqs-notice-err {
  background: var(--qqs-danger-soft);
  border: 1px solid color-mix(in oklab, var(--qqs-danger) 42%, transparent);
  color: var(--qqs-danger);
}
.qqs-notice-icon { flex: 0 0 auto; display: inline-flex; margin-top: 1px; }
.qqs-notice-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.qqs-notice-title { font-weight: 650; }
.qqs-notice-detail { font-size: 10.5px; opacity: .88; }
.qqs-notice-code {
  font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace);
  font-size: 10.5px; opacity: .95;
}
.qqs-textarea-wrap { display: flex; flex-direction: column; gap: 4px; }
.qqs-textarea {
  box-sizing: border-box; width: 100%; min-height: 76px; resize: vertical;
  font: inherit; font-size: 12px; line-height: 1.6;
  color: var(--qqs-ink); background: var(--qqs-surface-2);
  border: 1px solid var(--qqs-line-strong); border-radius: 6px;
  padding: 7px 9px;
  font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace);
  transition: border-color .12s ease, box-shadow .12s ease;
  tab-size: 2;
}
.qqs-textarea:focus {
  outline: none; border-color: var(--qqs-accent);
  box-shadow: 0 0 0 2px var(--qqs-accent-soft);
}
.qqs-textarea:disabled { opacity: .55; cursor: not-allowed; }
.qqs-textarea-hint { font-size: 10.5px; line-height: 1.45; color: var(--qqs-ink-2); }

/* 开关 */
.qqs-switch {
  position: relative; flex: 0 0 auto;
  width: 34px; height: 19px; padding: 0; border-radius: 999px;
  border: 1px solid var(--qqs-line-strong);
  background: var(--qqs-surface-2);
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.qqs-switch:focus-visible { outline: 2px solid var(--qqs-accent); outline-offset: 2px; }
.qqs-switch i {
  position: absolute; top: 2px; left: 2px;
  width: 13px; height: 13px; border-radius: 50%;
  background: var(--qqs-ink-2);
  transition: transform .15s cubic-bezier(.22,.61,.36,1), background .15s ease;
}
.qqs-switch[aria-checked="true"] { background: var(--qqs-accent); border-color: transparent; }
.qqs-switch[aria-checked="true"] i { transform: translateX(15px); background: var(--dsw-alias-bg-base); }
.qqs-switch:disabled { opacity: .5; cursor: not-allowed; }

/* ── 按钮 ─────────────────────────────────────────────────── */
.qqs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 500;
  color: var(--qqs-ink);
  background: var(--qqs-surface-2);
  border: 1px solid var(--qqs-line-strong);
  border-radius: 7px; padding: 5px 12px;
  cursor: pointer; white-space: nowrap;
  transition: background .12s ease, border-color .12s ease, opacity .12s ease;
}
.qqs-btn:hover:not(:disabled) { background: var(--qqs-active); }
.qqs-btn:focus-visible { outline: 2px solid var(--qqs-accent); outline-offset: 1px; }
.qqs-btn:disabled { opacity: .5; cursor: not-allowed; }
.qqs-btn-primary { background: var(--qqs-accent); border-color: transparent; color: var(--dsw-alias-bg-base); font-weight: 600; }
.qqs-btn-primary:hover:not(:disabled) { background: var(--qqs-accent); opacity: .88; }
.qqs-btn-danger { color: var(--qqs-danger); border-color: var(--qqs-danger); background: transparent; }
.qqs-btn-danger:hover:not(:disabled) { background: var(--qqs-danger-soft); }
.qqs-btn-ghost { background: transparent; border-color: transparent; color: var(--qqs-ink-2); }
.qqs-btn-ghost:hover:not(:disabled) { background: var(--qqs-hover); color: var(--qqs-ink); }
.qqs-btn-sm { font-size: 11.5px; padding: 3px 9px; border-radius: 6px; }
.qqs-btn-icon { padding: 5px; width: 28px; height: 28px; }
.qqs-btn-icon .qqs-spin { margin: 0; }

/* 转圈 */
.qqs-spin {
  display: inline-block; width: 11px; height: 11px; flex: 0 0 auto;
  border: 2px solid currentColor; border-top-color: transparent;
  border-radius: 50%; opacity: .8;
  animation: qqs-spin .7s linear infinite;
}
@keyframes qqs-spin { to { transform: rotate(360deg) } }

/* ── 折叠分类卡（Vercel 控制台风格）──────────────────────────
   每个分类是一张有圆角、有底色、有内边距的独立卡片；
   标题左侧一条 3px 彩色装饰条，标题加粗。整行卡片头可点击。 */
.qqs-sec {
  background: var(--qqs-surface);
  border: 1px solid var(--qqs-line);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color .14s ease, box-shadow .14s ease;
}
.qqs-sec:hover { border-color: color-mix(in oklab, var(--qqs-ink) 20%, transparent); }
.qqs-sec-on {
  border-color: color-mix(in oklab, var(--qqs-accent) 34%, var(--qqs-line));
  box-shadow: 0 1px 2px color-mix(in oklab, var(--dsw-alias-bg-base) 60%, transparent);
}
/* 标题左侧彩色装饰：用 accent 的色带，每个分类靠 --qqs-sec-hue 各自偏一点色 */
.qqs-sec-head {
  position: relative;
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 13px 16px 13px 20px;
  background: transparent; border: 0;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  user-select: none;
  transition: background .12s ease;
}
.qqs-sec-head::before {
  content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--qqs-sec-accent, var(--qqs-accent));
}
.qqs-sec-head:hover { background: var(--qqs-hover); }
.qqs-sec-head:focus-visible { outline: 2px solid var(--qqs-accent); outline-offset: -2px; }
.qqs-sec-titles { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.qqs-sec-title {
  font-size: 13.5px; font-weight: 700; letter-spacing: -.005em;
  color: var(--qqs-ink);
  display: flex; align-items: center; gap: 7px;
}
.qqs-sec-hint { font-size: 11px; line-height: 1.45; color: var(--qqs-ink-2); }
.qqs-sec-count {
  flex: 0 0 auto; font-size: 10.5px; color: var(--qqs-ink-2);
  font-variant-numeric: tabular-nums;
  padding: 1px 7px; border-radius: 999px;
  background: var(--qqs-surface-2); border: 1px solid var(--qqs-line);
}
/* 右侧箭头：收起时 v，展开时 ^ —— 比旋转 90° 更像"折叠"语义 */
.qqs-sec-chev {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 6px;
  color: var(--qqs-ink-2);
  transition: transform .18s ease, background .12s ease, color .12s ease;
}
.qqs-sec-head:hover .qqs-sec-chev { background: var(--qqs-active); color: var(--qqs-ink); }
.qqs-sec-on .qqs-sec-chev { transform: rotate(180deg); color: var(--qqs-accent); }
.qqs-sec-body { padding: 2px 18px 14px 20px; border-top: 1px solid var(--qqs-line); }
.qqs-sec-body.qqs-sec-more { border-top: 0; padding-top: 0; }
/* 常显区有内容、折叠区也有内容时，两者之间给一条分隔 */
.qqs-sec-body.qqs-sec-more.qqs-sec-after-always { border-top: 1px dashed var(--qqs-line); padding-top: 10px; }

/* ── 父子层级（「斗图与连发」里的子分组）────────────────────
   左侧缩进 + 一条淡灰竖线，形成明显的父子关系。 */
.qqs-group {
  position: relative;
  margin: 10px 0 2px; padding: 2px 0 2px 16px;
  border-left: 2px solid var(--qqs-line);
}
.qqs-group:first-child { margin-top: 2px; }
.qqs-group-head {
  display: flex; align-items: center; gap: 7px;
  font-size: 11.5px; font-weight: 600; color: var(--qqs-ink-2);
  text-transform: none; letter-spacing: .01em;
  margin-bottom: 2px;
}
.qqs-group-head::before {
  content: ''; width: 5px; height: 5px; border-radius: 50%;
  background: var(--qqs-ink-2); opacity: .7; flex: 0 0 auto;
}
.qqs-group-desc { font-size: 10.5px; line-height: 1.45; color: var(--qqs-ink-2); opacity: .9; margin-bottom: 4px; }
.qqs-group .qqs-row, .qqs-group .qqs-row-block { padding-left: 2px; }
.qqs-group .qqs-row:first-child { padding-top: 6px; }

/* ── 折叠区结尾的「展开/收起」按钮行 ──────────────────────── */
.qqs-more-row { display: flex; justify-content: flex-start; padding-top: 10px; margin-top: 4px; border-top: 1px solid var(--qqs-line); }
.qqs-more-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; font-size: 11.5px; font-weight: 550;
  color: var(--qqs-accent);
  background: transparent; border: 1px solid transparent; border-radius: 7px;
  padding: 3px 9px 3px 7px; cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.qqs-more-btn:hover { background: var(--qqs-accent-soft); border-color: color-mix(in oklab, var(--qqs-accent) 28%, transparent); }
.qqs-more-btn:focus-visible { outline: 2px solid var(--qqs-accent); outline-offset: 1px; }
.qqs-more-chev { display: inline-flex; transition: transform .18s ease; }
.qqs-more-btn-on .qqs-more-chev { transform: rotate(180deg); }

/* ── 动作卡 ───────────────────────────────────────────────── */
.qqs-action { display: flex; gap: 14px; align-items: flex-start; }
.qqs-action-icon {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 9px;
  background: var(--qqs-accent-soft); color: var(--qqs-accent);
}
.qqs-action-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.qqs-action-title { font-size: 13px; font-weight: 600; }
.qqs-action-desc { font-size: 11.5px; line-height: 1.55; color: var(--qqs-ink-2); }
.qqs-action-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }

/* 危险区 */
.qqs-danger-card {
  background: var(--qqs-danger-soft);
  border: 1px solid var(--qqs-danger);
  border-radius: 10px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.qqs-danger-title { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; color: var(--qqs-danger); }
.qqs-danger-desc { font-size: 11.5px; line-height: 1.55; color: var(--qqs-ink-2); }
.qqs-danger-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* ── 任务进度 ─────────────────────────────────────────────── */
.qqs-job {
  display: flex; flex-direction: column; gap: 7px;
  padding: 11px 14px; border-radius: 9px;
  background: var(--qqs-surface-2); border: 1px solid var(--qqs-line);
}
.qqs-job-head { display: flex; align-items: center; gap: 9px; }
.qqs-job-title { flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 550; }
.qqs-job-meta { flex: 0 0 auto; font-size: 10.5px; color: var(--qqs-ink-2); font-variant-numeric: tabular-nums; }
.qqs-job-track { height: 5px; border-radius: 999px; overflow: hidden; background: var(--qqs-hover); }
.qqs-job-fill { height: 100%; border-radius: 999px; background: var(--qqs-accent);
  transition: width .3s ease; }
.qqs-job-fill-indet {
  /* 不定进度：不设内联 width，靠动画自己跑；不需要 !important */
  width: 35%; animation: qqs-indet 1.25s ease-in-out infinite;
}
@keyframes qqs-indet {
  0% { transform: translateX(-100%) } 100% { transform: translateX(320%) }
}
.qqs-job-detail { font-size: 11px; color: var(--qqs-ink-2); }
.qqs-job-err { color: var(--qqs-danger); }

/* ── 弹窗 ─────────────────────────────────────────────────── */
.qqs-mask {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: color-mix(in oklab, var(--dsw-alias-bg-base) 62%, transparent);
  backdrop-filter: blur(2px);
  animation: qqs-fade .14s ease;
}
@keyframes qqs-fade { from { opacity: 0 } to { opacity: 1 } }
.qqs-modal {
  width: 100%; max-width: 460px; max-height: 82vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-overlay, var(--qqs-surface));
  border: 1px solid var(--qqs-line-strong);
  border-radius: 12px;
  box-shadow: 0 16px 48px color-mix(in oklab, var(--dsw-alias-bg-base) 55%, transparent);
  animation: qqs-pop .16s cubic-bezier(.22,.61,.36,1);
}
@keyframes qqs-pop { from { transform: scale(.97); opacity: .6 } to { transform: scale(1); opacity: 1 } }
.qqs-modal-head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 10px; }
.qqs-modal-title { flex: 1 1 auto; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
.qqs-modal-body { padding: 0 18px 14px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.qqs-modal-body p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--qqs-ink-2); }
.qqs-modal-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; border-top: 1px solid var(--qqs-line); }
.qqs-modal-pre {
  margin: 0; padding: 11px 13px; max-height: 46vh; overflow: auto;
  background: var(--qqs-surface-2); border: 1px solid var(--qqs-line); border-radius: 8px;
  font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace);
  font-size: 11px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
  color: var(--qqs-ink);
}
.qqs-modal-input { width: 100%; }

/* ── Toast ────────────────────────────────────────────────── */
.qqs-toasts {
  position: fixed; right: 20px; bottom: 20px; z-index: 70;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
  pointer-events: none;
}
.qqs-toast {
  pointer-events: auto;
  display: flex; align-items: center; gap: 8px;
  max-width: 380px; padding: 8px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--qqs-surface));
  border: 1px solid var(--qqs-line-strong);
  box-shadow: 0 6px 20px color-mix(in oklab, var(--dsw-alias-bg-base) 45%, transparent);
  font-size: 11.5px; color: var(--qqs-ink);
  animation: qqs-toast-in .18s cubic-bezier(.22,.61,.36,1);
}
@keyframes qqs-toast-in { from { transform: translateY(6px); opacity: 0 } to { transform: none; opacity: 1 } }
.qqs-toast-icon { display: inline-flex; flex: 0 0 auto; }
.qqs-toast-ok .qqs-toast-icon { color: var(--qqs-ok); }
.qqs-toast-err .qqs-toast-icon { color: var(--qqs-danger); }
.qqs-toast-text { flex: 1 1 auto; min-width: 0; }
.qqs-toast-x { flex: 0 0 auto; padding: 0 2px; background: none; border: 0; color: var(--qqs-ink-2); cursor: pointer; font: inherit; }

/* ── 杂项 ─────────────────────────────────────────────────── */
.qqs-muted { color: var(--qqs-ink-2); }
.qqs-mono { font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace); font-size: 11px; }
.qqs-code {
  display: inline-block; max-width: 100%; padding: 1px 6px; border-radius: 5px;
  background: var(--qqs-surface-2); border: 1px solid var(--qqs-line);
  font-family: var(--ds-font-family-code, Consolas, ui-monospace, monospace);
  font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  vertical-align: middle;
}
.qqs-err-line {
  display: flex; align-items: flex-start; gap: 7px;
  padding: 9px 12px; border-radius: 8px;
  background: var(--qqs-danger-soft); color: var(--qqs-danger);
  font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere;
}
.qqs-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 28px 12px; text-align: center; color: var(--qqs-ink-2);
}
.qqs-empty-icon { opacity: .5; }
.qqs-empty-title { font-size: 12.5px; color: var(--qqs-ink); }
.qqs-empty-desc { font-size: 11px; max-width: 320px; line-height: 1.55; }
.qqs-sep { height: 1px; background: var(--qqs-line); margin: 2px 0; }
.qqs-inline { display: inline-flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.qqs-sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
`

    // ───────────────────────────────────────────── 图标

    /** 内联 SVG 图标表（不引外部资源，全部 stroke=currentColor）。 */
    const ICON_PATHS = {
      sticker: [
        ['path', { d: 'M4.5 7.5A3 3 0 0 1 7.5 4.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3z' }],
        ['path', { d: 'M16 4.5v3a1.5 1.5 0 0 0 1.5 1.5h3' }],
        ['circle', { cx: 9.5, cy: 11, r: 0.7, fill: 'currentColor', stroke: 'none' }],
        ['circle', { cx: 14.5, cy: 11, r: 0.7, fill: 'currentColor', stroke: 'none' }],
        ['path', { d: 'M9 14.5c1.6 1.4 4.4 1.4 6 0' }],
      ],
      refresh: [
        ['path', { d: 'M20 11.5a8 8 0 1 1-2.6-5.9' }],
        ['path', { d: 'M20 4.5v4.2h-4.2' }],
      ],
      wand: [
        ['path', { d: 'M5 19l9.5-9.5' }],
        ['path', { d: 'M13.5 4.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z' }],
        ['path', { d: 'M18.5 12.5l.7 1.4 1.4.7-1.4.7-.7 1.4-.7-1.4-1.4-.7 1.4-.7z' }],
      ],
      broom: [
        ['path', { d: 'M14 4l6 6' }],
        ['path', { d: 'M11 7l6 6-3.2 3.2a3 3 0 0 1-4.3 0l-1.7-1.7a3 3 0 0 1 0-4.3z' }],
        ['path', { d: 'M6.5 18.5c1-1.6 2.6-2.6 4.5-2.9' }],
      ],
      inbox: [
        ['path', { d: 'M4.5 12.5h4l1.2 2.2h5l1.2-2.2h4' }],
        ['path', { d: 'M6.2 5.5h11.6l3 7v5a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2v-5z' }],
      ],
      clock: [
        ['circle', { cx: 12, cy: 12, r: 8 }],
        ['path', { d: 'M12 7.5V12l3 2' }],
      ],
      chart: [
        ['path', { d: 'M4.5 19.5h15' }],
        ['path', { d: 'M7.5 16V10' }],
        ['path', { d: 'M12 16V6.5' }],
        ['path', { d: 'M16.5 16v-4' }],
      ],
      trash: [
        ['path', { d: 'M4.5 7h15' }],
        ['path', { d: 'M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7' }],
        ['path', { d: 'M6.5 7l.8 11.3A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.7L17.5 7' }],
        ['path', { d: 'M10.5 11v5M13.5 11v5' }],
      ],
      chevron: [['path', { d: 'M9 5.5l6.5 6.5L9 18.5' }]],
      // 折叠面板用真正朝下/朝上的箭头：收起 = v，展开 = ^（CSS 里旋转 180°）
      'chevron-down': [['path', { d: 'M6.5 9.5l5.5 5.5 5.5-5.5' }]],
      'chevron-up': [['path', { d: 'M6.5 14.5L12 9l5.5 5.5' }]],
      alert: [
        ['path', { d: 'M12 4.5l8.5 15H3.5z' }],
        ['path', { d: 'M12 9.5v4.5' }],
        ['circle', { cx: 12, cy: 16.6, r: 0.8, fill: 'currentColor', stroke: 'none' }],
      ],
      check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
      x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
      db: [
        ['ellipse', { cx: 12, cy: 6, r: 7, ry: 2.6 }],
        ['path', { d: 'M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6' }],
        ['path', { d: 'M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6' }],
      ],
      spark: [
        ['path', { d: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z' }],
      ],
      heart: [
        ['path', { d: 'M12 19.5s-7-4.3-7-9a3.8 3.8 0 0 1 7-2.1 3.8 3.8 0 0 1 7 2.1c0 4.7-7 9-7 9z' }],
      ],
      folder: [
        ['path', { d: 'M4 7.5a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.6.8l1 1.4H18a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z' }],
      ],
      image: [
        ['rect', { x: 4, y: 5, width: 16, height: 14, rx: 2 }],
        ['circle', { cx: 9, cy: 10, r: 1.4 }],
        ['path', { d: 'M5 17l4.5-4.5 3 3 2.5-2.5L20 18' }],
      ],
      download: [
        ['path', { d: 'M12 4v10' }],
        ['path', { d: 'M8 11l4 4 4-4' }],
        ['path', { d: 'M5 19h14' }],
      ],
    }

    function Glyph({ name, size = 16 }) {
      const parts = ICON_PATHS[name] ?? ICON_PATHS.sticker
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      }, parts.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })))
    }

    // ───────────────────────────────────────────── 纯函数工具

    const MB = 1048576

    function fmtMB(bytes) {
      const value = Number(bytes) || 0
      if (value < MB) return (value / 1024).toFixed(value < 10240 ? 1 : 0) + ' KB'
      return (value / MB).toFixed(1) + ' MB'
    }

    function fmtNum(value) {
      const n = Number(value) || 0
      if (n < 10000) return String(n)
      return n.toLocaleString('zh-CN')
    }

    /** 剩余时长 → 「约 2 小时 15 分」。 */
    function fmtDuration(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 60000))
      if (total < 1) return '不到 1 分钟'
      if (total < 60) return `${total} 分钟`
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours < 24) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
      const days = Math.floor(hours / 24)
      const restHours = hours % 24
      return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`
    }

    /** 时间戳 → 「14:32」或「10-24 14:32」。 */
    function fmtTime(at) {
      const n = Number(at) || 0
      if (n <= 0) return '—'
      const date = new Date(n)
      const pad = (v) => String(v).padStart(2, '0')
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      const now = new Date()
      const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate()
      return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`
    }

    /**
     * 把 `collect.lastResult` 渲染成一句话。
     *
     * Host 侧存的是对象（`collect.js` 的 `summarizeResult()`）：
     *   { ok, at, collected, already, failed, considered, stopReason }
     * 失败时是 `{ ok: false, reason }`。
     * 也兼容更早版本可能落盘的纯字符串，避免老 schedule.json 显示成对象。
     */
    function describeCollectResult(result) {
      if (result === null || result === undefined) return '还没跑过'
      if (typeof result === 'string') return result || '还没跑过'
      if (typeof result !== 'object') return String(result)

      if (result.ok === false) return `上次失败了：${result.reason ?? '未知原因'}`

      const parts = []
      if (Number(result.collected) > 0) parts.push(`收了 ${result.collected} 张`)
      else parts.push('没收到新图')
      if (Number(result.already) > 0) parts.push(`跳过已入库 ${result.already} 张`)
      if (Number(result.failed) > 0) parts.push(`失败 ${result.failed} 张`)
      if (result.stopReason) parts.push(String(result.stopReason))
      // 失败明细：直接接在后面，让用户一眼看到「为什么失败」。
      // 以前只有「失败 16 张」这个数字，完全无从下手。
      if (Array.isArray(result.failures) && result.failures.length > 0) {
        parts.push(`失败原因：${result.failures.slice(0, 2).join('；')}`)
      }
      return parts.join('，')
    }

    /** 点分路径取值。 */
    function getPath(obj, path) {
      let cur = obj
      for (const key of String(path).split('.')) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
        cur = cur[key]
      }
      return cur
    }

    function sameJSON(a, b) {
      if (a === b) return true
      try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
    }

    // ───────────────────────────────────────────── 数据层

    /** 读一次状态。失败抛错，交给 hook 做退避。 */
    async function fetchState(signal) {
      const res = await fetch(`${API}/state`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
        signal,
      })
      if (!res.ok) throw new Error(`GET /state → HTTP ${res.status}`)
      const body = await res.json()
      if (body?.ok !== true) throw new Error(body?.reason ?? '状态返回格式不符')
      return body
    }

    /** 兜底读配置（remote.settings 不可用时）。 */
    async function fetchConfig(signal) {
      const res = await fetch(`${API}/config`, {
        headers: { accept: 'application/json' },
        credentials: 'include',
        signal,
      })
      if (!res.ok) throw new Error(`GET /config → HTTP ${res.status}`)
      const body = await res.json()
      if (body?.ok !== true || !body.config) throw new Error(body?.reason ?? '配置路由返回格式不符')
      return body.config
    }

    /** 触发动作。返回 {ok:true, job} 或 {ok:false, reason:'already-running', job}。 */
    async function postAction(kind, args, signal) {
      const res = await fetch(`${API}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'include',
        signal,
        body: JSON.stringify({ kind, args: args ?? {} }),
      })
      let body = {}
      try { body = await res.json() } catch { /* 空响应 */ }
      if (res.status === 409) return { ok: false, reason: 'already-running', job: body?.job }
      if (!res.ok || body?.ok !== true) throw new Error(body?.reason ?? `HTTP ${res.status}`)
      return { ok: true, job: body.job }
    }

    /**
     * 让系统文件管理器打开插件的数据目录。
     *
     * 走插件自己的 Host 路由 `/open-path`（浏览器页面没有 shell 权限，
     * 而宿主的 openWorkspacePath 只认工作区内的路径，数据目录在 ~/.dsh 下）。
     *
     * @param {{sub?:string}} [options] sub = 子目录（如 'images' / 'backups'）
     * @returns {Promise<{ok:boolean, path?:string, reason?:string}>}
     */
    async function openDataFolder(options = {}) {
      const res = await fetch(`${API}/open-path`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sub: options.sub ?? '' }),
      })
      let body = {}
      try { body = await res.json() } catch { /* 空响应 */ }
      if (!res.ok || body?.ok !== true) {
        throw new Error(body?.reason ?? `HTTP ${res.status}`)
      }
      return body
    }

    /**
     * 从宿主下发的 Config Schema 信封里取顶层字段名。
     *
     * 信封形状是 `{uid, refs: {<id>: <node>}}`，`refs[uid]` 是根对象节点，
     * 它的 `dict` 的 key 就是「宿主认得的配置段」。取不到就返回 undefined，
     * 这时界面不做「字段不存在」的推断（宁可显示正常的可写状态）。
     *
     * 为什么需要它：改了 Host 侧 `src/config.js` 但没重启 DSH 时，运行中的
     * Host 用的还是旧 Schema —— 界面上新加的段点了保存会被 settings 服务拒。
     * 有了这份清单，界面可以提前标出来并说明「要重启 DSH」，而不是等报错。
     */
    function topKeysOf(schema) {
      try {
        if (!schema || typeof schema !== 'object') return undefined
        const root = schema.refs?.[schema.uid]
        const dict = root?.dict
        if (!dict || typeof dict !== 'object') return undefined
        return Object.keys(dict)
      } catch {
        return undefined
      }
    }

    /**
     * provider 选择：真下拉，选项来自模型目录的 provider 列表。
     * 目录拿不到时退化成手填文本框。
     */
    function ProviderPicker({ value, catalog, disabled, ariaLabel, onChange, hint }) {
      const [view, setView] = React.useState(() => (catalog ? catalog.snapshot() : { status: 'error', providers: [] }))
      const text = String(value ?? '')

      React.useEffect(() => {
        let alive = true
        if (!catalog) { setView({ status: 'error', providers: [] }); return undefined }
        const sync = () => { if (alive) setView(catalog.snapshot()) }
        sync()
        const unsubscribe = catalog.subscribe?.(sync)
        catalog.load().catch(() => { if (alive) setView({ status: 'error', providers: [] }) })
        return () => { alive = false; if (typeof unsubscribe === 'function') unsubscribe() }
      }, [catalog])

      const known = Array.isArray(view.providers) ? view.providers : []
      const usable = view.status === 'ready' && known.length > 0
      if (!usable) {
        return h(TextField, {
          value: text,
          placeholder: '留空 = 跟随当前会话',
          disabled,
          ariaLabel,
          onCommit: (next) => onChange(String(next).trim()),
        })
      }

      const options = [{ value: '', label: '留空（跟随当前会话）' }]
      for (const id of known) options.push({ value: id, label: id })
      // 当前值不在目录里（或已下线）也要能显示出来，不能被吞掉
      if (text && !known.includes(text)) options.push({ value: text, label: `${text}（当前）` })

      return h(Select, {
        value: text,
        options,
        disabled,
        ariaLabel,
        onChange: (next) => onChange(next),
      })
    }

    /**
     * 配置表单适配器（与 guard 的 createRemoteForm 同接口，可直接给 UI 用）。
     *
     * 读：`ctx.remote.settings.describe()` → 找 ns 行；
     * 写：`ctx.remote.settings.mutate(ns, ops, revision)`。
     * 两条都失败时退到只读 HTTP `/config`（此模式不可写）。
     */
    function createRemoteForm(ctx, ns) {
      let snapshot = {
        status: 'loading',
        value: {},
        writable: false,
        revision: undefined,
        source: undefined,
        error: undefined,
        /** Host 侧 Config Schema 的序列化信封（`{uid, refs}`），用于判断字段是否已知。 */
        schema: undefined,
        /** 该 ns 在 Host Schema 里真实存在的顶层字段集合。 */
        knownTopKeys: undefined,
      }
      const listeners = new Set()
      let revision
      let pending = Promise.resolve()

      const emit = () => {
        for (const fn of listeners) {
          try { fn() } catch { /* 单个订阅方异常不影响其它 */ }
        }
      }
      const set = (next) => { snapshot = { ...snapshot, ...next }; emit() }

      const remoteSettings = () => {
        try { return ctx?.remote?.settings } catch { return undefined }
      }

      /**
       * 读一次。tries 用于等 remote 服务就绪（刚开面板时可能还没 bind 完）。
       * 失败时**优先报 remote 的错误** —— 它更具体（权限 / 未被投影）。
       */
      const load = async ({ tries = 1, delayMs = 140 } = {}) => {
        let remoteError
        let httpError
        for (let attempt = 1; attempt <= tries; attempt++) {
          const settings = remoteSettings()
          if (settings && typeof settings.describe === 'function') {
            try {
              const res = await settings.describe()
              // 形状：{ ok, value: { namespaces: [{ ns, revision, value }] } }
              if (!res?.ok) throw new Error(`describe 未成功：${JSON.stringify(res?.error ?? res)}`)
              const rows = res.value?.namespaces
              if (!Array.isArray(rows)) throw new Error('describe 返回缺少 namespaces 数组')
              const row = rows.find((entry) => entry?.ns === ns)
              if (!row) throw new Error(`describe 里没有 ns="${ns}"（该行可能没被 Settings 投影）`)
              revision = row.revision
              set({
                status: 'ready',
                value: row.value ?? {},
                writable: true,
                source: 'remote',
                error: undefined,
                revision: row.revision,
                schema: row.schema,
                knownTopKeys: topKeysOf(row.schema),
              })
              return
            } catch (error) {
              remoteError = error
              console.error('[qq-sticker] remote.settings.describe 失败：', error)
            }
          } else {
            remoteError = new Error(
              'ctx.remote.settings 不可用（inject 里需同时声明 "remote" 与 "remote.settings"）',
            )
          }

          // 退到只读 HTTP（不可写）
          try {
            const config = await fetchConfig()
            set({ status: 'ready', value: config, writable: false, source: 'http', error: undefined })
            return
          } catch (error) {
            httpError = error
          }

          if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        const primary = remoteError ?? httpError
        const detail = remoteError && httpError
          ? `${primary?.message ?? primary}（HTTP 兜底也失败：${httpError?.message ?? httpError}）`
          : String(primary?.message ?? primary)
        console.error('[qq-sticker] 读取配置最终失败：', primary, httpError ?? '')
        set({ status: 'error', writable: false, source: undefined, error: detail })
      }

      void load({ tries: 6, delayMs: 150 })

      // 配置文档变化时重读（含本插件自己写入成功后），保证多端一致。
      try {
        ctx.effect(
          () => ctx.on('settings/document-updated', (changedNs) => {
            if (changedNs === ns) void load()
          }),
          'qq-sticker: settings document updates',
        )
      } catch { /* 假 ctx 没有 on 也无所谓 */ }

      return {
        getSnapshot: () => snapshot,
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        mutate(ops) {
          pending = pending.then(async () => {
            const settings = remoteSettings()
            if (!settings || typeof settings.mutate !== 'function') {
              console.error('[qq-sticker] 写入失败：ctx.remote.settings 不可用（只读兜底模式不能写）')
              return { ok: false, reason: 'remote.settings 不可用（只读兜底模式不能写）' }
            }
            try {
              const res = await settings.mutate(ns, ops, revision)
              if (!res?.ok) {
                // 宿主的拒绝原因非常有信息量（例如 `Config field "proactive.enabled"
                // is not volatile` —— 说明运行中的 Host 用的是旧 Schema，要重启 DSH），
                // 一定要带到界面上，不能只显示「保存失败」。
                const reason = describeMutateError(res?.error ?? res)
                console.error('[qq-sticker] mutate 未成功：', reason, res?.error ?? res)
                await load()   // 重读拿最新 revision，下一次写入不被拒
                return { ok: false, reason }
              }
              revision = res.value?.revision ?? revision
              await load()
              return { ok: true }
            } catch (error) {
              console.error('[qq-sticker] mutate 抛错：', error)
              await load()
              return { ok: false, reason: String(error?.message ?? error) }
            }
          })
          return pending
        },
      }
    }

    /**
     * 把宿主拒绝写入的原因翻译成用户能看懂的一句话。
     *
     * 最常见的两类：
     *   · `Config field "x.y" is not volatile` —— 运行中的 Host 的 Config Schema
     *     里没有这个字段（旧版代码还在跑）。这不是界面 bug，是「改了 Host 侧
     *     src/config.js 但没重启 DSH」，要明确告诉用户去重启；
     *   · `SETTINGS_CONFLICT` —— revision 过期，重读后重试就好。
     */
    function describeMutateError(error) {
      const code = String(error?.code ?? '')
      const message = String(error?.message ?? error ?? '未知原因')
      const volatile = /Config field "([^"]+)" is not volatile/.exec(message)
      if (volatile) {
        return `Host 的 Config Schema 里没有「${volatile[1]}」这个字段 —— 运行中的 DSH 还是旧代码，重启 DSH 后这一项才可写。`
      }
      if (code.includes('conflict') || /changed since it was read/i.test(message)) {
        return '配置被别处改过（revision 过期），已重新读取最新值，再点一次即可。'
      }
      if (/arguments-invalid|bad-request/i.test(code)) {
        return `写入参数被宿主拒绝（${code}）。如果是刚加的配置项，重启 DSH 让新 Schema 生效。`
      }
      return message
    }

    /** 订阅一个 form 的快照。 */
    function useForm(form) {
      const [snap, setSnap] = React.useState(() => (form ? form.getSnapshot() : undefined))
      React.useEffect(() => {
        if (!form) return undefined
        setSnap(form.getSnapshot())
        return form.subscribe(() => setSnap(form.getSnapshot()))
      }, [form])
      return snap
    }

    /**
     * 模型目录数据源：读 `ctx.remote.session.modelCatalog()`。
     *
     * 为什么要它：`vision.model` / `proactive.model` 这两项如果只渲染成
     * 一个自由输入框，用户得自己记住 provider 与 model 的准确 id，很容易填错。
     * 宿主本来就有 `session/modelCatalog`（model-selection 插件用的同一个），
     * 这里复用它，把「能选的模型」做成真下拉。
     *
     * 注意：inject 里必须声明 `remote.session`，只写 `remote` 时
     * `ctx.remote.session` 是 undefined（和 `remote.settings` 同一个坑）。
     */
    function createModelCatalog(ctx) {
      let snapshot = { status: 'idle', groups: [], providers: [], defaultSelection: undefined, error: undefined }
      const listeners = new Set()
      let inflight

      const emit = () => {
        for (const fn of listeners) { try { fn() } catch { /* 订阅方异常不影响别人 */ } }
      }
      const set = (next) => { snapshot = { ...snapshot, ...next }; emit() }
      const remoteSession = () => {
        try { return ctx?.remote?.session } catch { return undefined }
      }

      const load = () => {
        if (snapshot.status === 'ready' && snapshot.groups.length > 0) return Promise.resolve(snapshot)
        if (inflight) return inflight
        set({ status: 'loading', error: undefined })
        inflight = Promise.resolve()
          .then(async () => {
            const session = remoteSession()
            if (!session || typeof session.modelCatalog !== 'function') {
              throw new Error('ctx.remote.session.modelCatalog 不可用（inject 里需同时声明 "remote" 与 "remote.session"）')
            }
            const res = await session.modelCatalog()
            if (!res?.ok) throw new Error(res?.error?.message ?? 'modelCatalog 未成功')
            const value = res.value ?? {}
            set({
              status: 'ready',
              groups: Array.isArray(value.groups) ? value.groups : [],
              providers: Array.isArray(value.routableProviders) ? value.routableProviders : [],
              defaultSelection: value.default,
              error: undefined,
            })
            return snapshot
          })
          .catch((error) => {
            console.error('[qq-sticker] 读取模型目录失败：', error)
            set({ status: 'error', groups: [], error: String(error?.message ?? error) })
            return snapshot
          })
          .finally(() => { inflight = undefined })
        return inflight
      }

      return {
        snapshot: () => snapshot,
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
        load,
        /** 模型目录变化（切 provider / 加凭据）后清空缓存，下次打开重读。 */
        invalidate() { set({ status: 'idle' }); inflight = undefined },
      }
    }

    /**
     * 轮询 `/state`。
     *
     * 规矩：
     *   · 5 秒一次；页面隐藏时停，回到前台立刻补一次；
     *   · 失败退避 5 → 10 → 20 → 40 → 60 秒封顶，成功归位；
     *   · 有旧数据时失败只标 stale，不把整页清空；
     *   · unmount 时 abort + clearTimeout，避免过时 setState。
     */
    function useStickerState() {
      const [state, setState] = React.useState({
        status: 'loading', data: undefined, error: undefined, at: 0,
      })
      const [nonce, setNonce] = React.useState(0)
      const timerRef = React.useRef(0)
      const failuresRef = React.useRef(0)

      React.useEffect(() => {
        let alive = true
        let controller = new AbortController()

        const schedule = (delay) => {
          if (!alive) return
          timerRef.current = setTimeout(tick, delay)
        }

        const tick = async () => {
          if (!alive) return
          controller = new AbortController()
          try {
            const data = await fetchState(controller.signal)
            if (!alive) return
            failuresRef.current = 0
            setState({ status: 'ready', data, error: undefined, at: Date.now() })
          } catch (error) {
            if (!alive || error?.name === 'AbortError') return
            failuresRef.current += 1
            setState((prev) => ({
              ...prev,
              status: prev.data ? 'stale' : 'error',
              error: String(error?.message ?? error),
            }))
          }
          if (!alive) return
          const failures = failuresRef.current
          const delay = failures === 0
            ? POLL_MS
            : Math.min(MAX_ERR_BACKOFF_MS, POLL_MS * (2 ** Math.min(failures, 4)))
          schedule(delay)
        }

        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            clearTimeout(timerRef.current)
            void tick()
          }
        }

        void tick()
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          controller.abort()
          clearTimeout(timerRef.current)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [nonce])

      const refresh = React.useCallback(() => setNonce((n) => n + 1), [])
      return [state, refresh]
    }

    /**
     * 配置读写：乐观覆盖 + 串行队列 + 失败回滚。
     *
     * get(path) 先看 overrides（点开关立刻变），再读回读值，最后兜 DEFAULTS。
     * write(path, next) 记覆盖 → mutate → 成功等回读一致后退休覆盖 / 失败立刻回滚。
     */
    function useConfigWriter(form) {
      const snap = useForm(form)
      const [overrides, setOverrides] = React.useState({})
      const [saveError, setSaveError] = React.useState(null)
      const [savingCount, setSavingCount] = React.useState(0)
      const inflight = React.useRef(new Map())
      const queue = React.useRef(new Map())
      const overridesRef = React.useRef(overrides)
      overridesRef.current = overrides

      const value = snap?.value ?? {}
      const writable = snap?.writable === true

      const get = (path) => {
        const key = String(path)
        if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key]
        const hit = getPath(value, path)
        return hit === undefined ? DEFAULTS[key] : hit
      }

      const dropOverrideIf = (key, expected) => {
        setOverrides((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, key)) return prev
          if (!sameJSON(prev[key], expected)) return prev
          const next = { ...prev }
          delete next[key]
          return next
        })
      }

      const beginSaving = () => setSavingCount((n) => n + 1)
      const endSaving = () => setSavingCount((n) => (n > 0 ? n - 1 : 0))

      const settle = (key, op, ok, reason) => {
        endSaving()
        inflight.current.delete(key)
        dropOverrideIf(key, op.value)
        if (ok) {
          setSaveError(null)
        } else {
          // 结构化：标题一句话 + 明细（宿主原始拒绝原因）
          const fields = op.path.join('.')
          setSaveError({
            path: key,
            title: `「${op.label ?? fields}」保存失败，已回滚到原值`,
            message: reason
              ? `${reason}（字段 ${fields}）`
              : `宿主没有返回原因；字段 ${fields}。按 F12 看 Console 里 [qq-sticker] 的完整错误。`,
          })
        }
        const queued = queue.current.get(key)
        if (queued) { queue.current.delete(key); runOne(key, queued) }
      }

      const runOne = (key, op) => {
        inflight.current.set(key, true)
        beginSaving()
        let result
        try {
          result = form.mutate([op])
        } catch (error) {
          console.error('[qq-sticker] 写入抛错：', error)
          result = { ok: false, reason: String(error?.message ?? error) }
        }
        Promise.resolve(result).then(
          (value) => {
            // 兼容两种返回值：boolean（旧适配器）与 {ok, reason}（新适配器）
            const ok = value === true || value?.ok === true
            settle(key, op, ok, value?.reason)
          },
          (error) => { console.error('[qq-sticker] 写入失败：', error); settle(key, op, false, String(error?.message ?? error)) },
        )
        return result
      }

      const write = (path, next, label) => {
        if (!form || !writable) return undefined
        const key = String(path)
        const op = { op: 'set', path: key.split('.'), value: next, label: label ?? key }
        setOverrides((prev) => ({ ...prev, [key]: next }))
        setSaveError(null)
        // 同字段连点时只保留最后一次
        if (inflight.current.has(key)) { queue.current.set(key, op); return undefined }
        return runOne(key, op)
      }

      return { snap, get, write, writable, saveError, savingCount }
    }

    /** Toast 队列。 */
    function useToasts() {
      const [items, setItems] = React.useState([])
      const timers = React.useRef(new Map())

      const dismiss = React.useCallback((id) => {
        setItems((prev) => prev.filter((item) => item.id !== id))
        const timer = timers.current.get(id)
        if (timer) { clearTimeout(timer); timers.current.delete(id) }
      }, [])

      const push = React.useCallback((tone, text) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        setItems((prev) => [...prev.slice(-3), { id, tone, text }])
        const timer = setTimeout(() => dismiss(id), 4200)
        timer.unref?.()
        timers.current.set(id, timer)
      }, [dismiss])

      React.useEffect(() => () => {
        for (const timer of timers.current.values()) clearTimeout(timer)
        timers.current.clear()
      }, [])

      return { items, push, dismiss }
    }

    // ───────────────────────────────────────────── 通用控件

    function Button({ variant = 'default', size, busy, disabled, icon, children, ...rest }) {
      const cls = ['qqs-btn']
      if (variant === 'primary') cls.push('qqs-btn-primary')
      else if (variant === 'danger') cls.push('qqs-btn-danger')
      else if (variant === 'ghost') cls.push('qqs-btn-ghost')
      if (size === 'sm') cls.push('qqs-btn-sm')
      return h('button', {
        ...rest,
        type: rest.type ?? 'button',
        className: cls.join(' '),
        disabled: disabled === true || busy === true,
      },
      busy ? h('span', { className: 'qqs-spin', 'aria-hidden': true }) : null,
      icon && !busy ? h(Glyph, { name: icon, size: 13 }) : null,
      children)
    }

    function Switch({ checked, disabled, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'qqs-switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        onClick: () => { if (!disabled) onChange(!checked) },
      }, h('i'))
    }

    function Select({ value, options, disabled, onChange, ariaLabel }) {
      return h('select', {
        className: 'qqs-select',
        value: String(value ?? ''),
        disabled: disabled === true,
        'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    /**
     * 模型选择控件（真 <select>，不是一行灰字）。
     *
     * ⚠️ 两种取值形态，不能混：
     *   · `mode: 'ref'`  → 值是 `provider/model` 复合串（proactive.model 这种，
     *     Host 侧 parseModelRef 负责拆）；
     *   · `mode: 'id'`   → 值只是裸模型 id，provider 由**另一个字段**单独给
     *     （vision.providerId / vision.model 就是这样）。这种模式要传
     *     `provider` 进来，选项只列该 provider 下的模型，写回的是 model.id。
     *
     * 选项来自 `ctx.remote.session.modelCatalog()`；目录拿不到时退回自由输入，
     * 离线或旧宿主也不会变成一个死控件。
     */
    function ModelPicker({
      value, catalog, mode = 'ref', provider, allowEmpty = true, emptyLabel = '留空（跟随当前会话）',
      disabled, ariaLabel, onChange, hint,
    }) {
      // 初值直接从数据源同步取：首帧就能显示 loading / 已有目录，
      // 不会先渲染成一排空选项再跳一下（effect 只负责触发异步加载）。
      const [view, setView] = React.useState(() => (
        catalog ? catalog.snapshot() : { status: 'error', groups: [] }
      ))
      const [manual, setManual] = React.useState(false)
      const text = String(value ?? '')

      React.useEffect(() => {
        let alive = true
        if (!catalog) { setView({ status: 'error', groups: [] }); return undefined }
        const sync = () => { if (alive) setView(catalog.snapshot()) }
        sync()
        const unsubscribe = catalog.subscribe?.(sync)
        catalog.load().catch(() => { if (alive) setView({ status: 'error', groups: [] }) })
        return () => { alive = false; if (typeof unsubscribe === 'function') unsubscribe() }
      }, [catalog])

      const groups = Array.isArray(view.groups) ? view.groups : []
      // id 模式只列指定 provider 的模型；provider 空着就列全部（也允许，跟着会话走）
      const visibleGroups = mode === 'id' && provider
        ? groups.filter((group) => group.id === provider)
        : groups
      const toOptionValue = (groupId, modelId) => (mode === 'id' ? modelId : `${groupId}/${modelId}`)
      const known = visibleGroups.some((group) => (group.models ?? [])
        .some((model) => toOptionValue(group.id, model.id) === text))
      // 有值但目录里没有它 → 直接进手动模式，别让 select 显示成一个空选项
      const inManual = manual || (text !== '' && view.status === 'ready' && !known) || view.status === 'error'
      const selectValue = inManual ? '__custom__' : text

      const selectOptions = []
      if (allowEmpty) selectOptions.push({ value: '', label: emptyLabel })
      for (const group of visibleGroups) {
        for (const model of group.models ?? []) {
          selectOptions.push({
            value: toOptionValue(group.id, model.id),
            label: mode === 'id' || !group.name || group.name === group.id
              ? (model.name || model.id)
              : `${model.name || model.id} · ${group.name}`,
          })
        }
      }
      selectOptions.push({ value: '__custom__', label: mode === 'id' ? '手动输入模型 ID…' : '手动输入 provider/model…' })

      return h('div', { className: 'qqs-model' },
        h('select', {
          className: 'qqs-select',
          value: selectValue,
          disabled: disabled === true,
          'aria-label': ariaLabel,
          title: text || emptyLabel,
          onChange: (event) => {
            const next = event.target.value
            if (next === '__custom__') { setManual(true); return }
            setManual(false)
            onChange(next)
          },
        },
        selectOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        inManual
          ? h(TextField, {
            value: text,
            placeholder: mode === 'id' ? '模型 ID，如 deepseek-v4.1-flash' : 'provider/model，如 opencode-go/deepseek-v4.1-flash',
            disabled,
            wide: true,
            ariaLabel: `${ariaLabel}（手动输入）`,
            onCommit: (next) => onChange(String(next).trim()),
          })
          : null,
        view.status === 'loading'
          ? h('div', { className: 'qqs-model-hint' }, '正在读取模型目录…')
          : view.status === 'error'
            ? h('div', { className: 'qqs-model-hint' },
              mode === 'id' ? '拿不到模型目录，可手动填模型 ID' : '拿不到模型目录，可手动填 provider/model')
            : hint
              ? h('div', { className: 'qqs-model-hint' }, hint)
              : null)
    }

    /**
     * 数字输入：聚焦用本地草稿，失焦/回车才提交，越界夹紧。
     * 这样打字不写盘、外部回读也不会把光标里的值顶掉。
     */
    function NumberField({ value, min, max, step, unit, disabled, placeholder, onCommit, ariaLabel }) {
      const text = String(value ?? '')
      const [draft, setDraft] = React.useState({ focused: false, text })
      const shown = draft.focused ? draft.text : text

      const commit = () => {
        const raw = draft.text.trim()
        const parsed = Number(raw)
        const base = Number(value)
        // 小数（概率/积极度这类 0~1 的字段）不能 trunc，否则 0.25 会被压成 0
        const isFloat = Number(step) < 1 || !Number.isInteger(base)
        const clamped = raw === '' || !Number.isFinite(parsed)
          ? base
          : Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? Number.MIN_SAFE_INTEGER,
            isFloat ? parsed : Math.trunc(parsed)))
        setDraft({ focused: false, text: String(clamped) })
        if (clamped !== base) onCommit(clamped)
        void unit
      }

      return h('span', { className: 'qqs-num-wrap' },
        h('input', {
          type: 'number',
          className: 'qqs-input qqs-input-num',
          value: shown,
          min,
          max,
          step: step ?? (Number.isInteger(Number(value)) ? 1 : 0.01),
          placeholder,
          disabled: disabled === true,
          'aria-label': ariaLabel,
          onFocus: () => setDraft({ focused: true, text }),
          onChange: (event) => setDraft({ focused: true, text: event.target.value }),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
            if (event.key === 'Escape') setDraft({ focused: false, text })
          },
        }),
        unit ? h('span', { className: 'qqs-unit' }, unit) : null)
    }

    /** 文本输入：同上，失焦/回车提交。 */
    /**
     * 多行文本输入（v2：标签类别用）。
     *
     * 与 TextField 的差别：**回车不提交**（要多行），只在失焦时提交；
     * Esc 放弃草稿。这个差异很重要 —— 标签类别本来就是一行一个类别，
     * 回车提交的话用户根本没法输入第二行。
     */
    function TextAreaField({ value, placeholder, disabled, rows = 4, onCommit, ariaLabel, hint }) {
      const text = String(value ?? '')
      const [draft, setDraft] = React.useState({ focused: false, text })
      const shown = draft.focused ? draft.text : text
      const commit = () => {
        const next = draft.text
        setDraft({ focused: false, text: next })
        if (next !== text) onCommit(next)
      }
      return h('div', { className: 'qqs-textarea-wrap' },
        h('textarea', {
          className: 'qqs-textarea',
          value: shown,
          placeholder,
          rows,
          disabled: disabled === true,
          'aria-label': ariaLabel,
          spellCheck: false,
          onFocus: () => setDraft({ focused: true, text }),
          onChange: (event) => setDraft({ focused: true, text: event.target.value }),
          onBlur: commit,
          onKeyDown: (event) => {
            // 只有 Ctrl/Cmd + Enter 才提交（普通回车是换行）
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') setDraft({ focused: false, text })
          },
        }),
        hint ? h('div', { className: 'qqs-textarea-hint' }, hint) : null)
    }

    /** 单行文本输入：失焦/回车提交。 */
    function TextField({ value, placeholder, disabled, wide, onCommit, ariaLabel }) {
      const text = String(value ?? '')
      const [draft, setDraft] = React.useState({ focused: false, text })
      const shown = draft.focused ? draft.text : text
      const commit = () => {
        const next = draft.text
        setDraft({ focused: false, text: next })
        if (next !== text) onCommit(next)
      }
      return h('input', {
        type: 'text',
        className: 'qqs-input' + (wide ? ' qqs-input-wide' : ''),
        value: shown,
        placeholder,
        disabled: disabled === true,
        'aria-label': ariaLabel,
        onFocus: () => setDraft({ focused: true, text }),
        onChange: (event) => setDraft({ focused: true, text: event.target.value }),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
          if (event.key === 'Escape') setDraft({ focused: false, text })
        },
      })
    }

    /**
     * 路径输入框 + 「浏览」按钮（高级设置里的存储目录用）。
     *
     * 「浏览」不弹系统原生目录选择器（浏览器页面没这个能力），而是：
     *   ① 打开当前生效的数据目录，让用户先在资源管理器里看/建目标目录；
     *   ② 同时把「可填的绝对路径」示例和「需要重启」的提示显示在下方。
     * 用户把路径粘进输入框、失焦提交 → 走正常配置写回（热写入 profile）。
     */
    function PathField({
      value, placeholder, disabled, onCommit, ariaLabel, hint, defaultPath,
      onBrowse, onReset,
    }) {
      const text = String(value ?? '')
      const [draft, setDraft] = React.useState({ focused: false, text })
      const shown = draft.focused ? draft.text : text
      const commit = () => {
        const next = draft.text.trim()
        setDraft({ focused: false, text: next })
        if (next !== text) onCommit(next)
      }
      const changed = text !== '' && text !== String(defaultPath ?? '')

      return h('div', { className: 'qqs-path' },
        h('div', { className: 'qqs-path-row' },
          h('input', {
            type: 'text',
            className: 'qqs-input qqs-path-input',
            value: shown,
            placeholder,
            disabled: disabled === true,
            spellCheck: false,
            'aria-label': ariaLabel,
            onFocus: () => setDraft({ focused: true, text }),
            onChange: (event) => setDraft({ focused: true, text: event.target.value }),
            onBlur: commit,
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() }
              if (event.key === 'Escape') setDraft({ focused: false, text })
            },
          }),
          h(Button, {
            size: 'sm',
            icon: 'folder',
            disabled: disabled === true,
            title: '在资源管理器里打开当前生效的数据目录',
            onClick: onBrowse,
          }, '浏览'),
          changed
            ? h(Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: disabled === true,
              title: '清空自定义路径，回到默认目录',
              onClick: () => { setDraft({ focused: false, text: '' }); onReset?.() },
            }, '恢复默认')
            : null),
        h('div', { className: 'qqs-path-hint' },
          changed
            ? '⚠️ 保存后需重启 DSH 才生效；新目录为空时会把现有库自动搬过去。'
            : (hint || '留空 = 默认目录（插件数据目录）。')),
        defaultPath
          ? h('div', { className: 'qqs-path-default' },
            '当前默认：', h('span', { className: 'qqs-code', title: defaultPath }, defaultPath))
          : null)
    }

    function StatCard({ label, value, unit, hint, tone }) {
      const cls = ['qqs-card', 'qqs-stat']
      if (tone) cls.push(`qqs-stat-tone-${tone}`)
      return h('div', { className: cls.join(' ') },
        h('div', { className: 'qqs-stat-value' },
          h('span', null, value),
          unit ? h('span', { className: 'qqs-stat-unit' }, unit) : null),
        h('div', { className: 'qqs-stat-label' }, label),
        hint ? h('div', { className: 'qqs-stat-hint' }, hint) : null)
    }

    function Meter({ value, max, label, warnAt = 0.8, dangerAt = 0.97 }) {
      const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
      const pct = Math.round(ratio * 100)
      const tone = ratio >= dangerAt ? 'qqs-meter-fill-err'
        : ratio >= warnAt ? 'qqs-meter-fill-warn' : ''
      return h('div', { className: 'qqs-meter' },
        h('div', {
          className: 'qqs-meter-track',
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': pct,
          'aria-label': label,
        }, h('div', {
          className: `qqs-meter-fill ${tone}`.trim(),
          style: { width: `${Math.max(pct, value > 0 ? 2 : 0)}%` },
        })),
        h('div', { className: 'qqs-meter-legend' },
          h('span', null, `${fmtMB(value)} 已用`),
          h('span', null, `上限 ${fmtMB(max)}`)))
    }

    function Chip({ label, value, tone }) {
      const cls = ['qqs-chip']
      if (tone) cls.push(`qqs-chip-${tone}`)
      return h('span', { className: cls.join(' ') },
        h('span', null, label),
        h('span', { className: 'qqs-chip-v' }, value))
    }

    function Row({ label, desc, children }) {
      return h('div', { className: 'qqs-row' },
        h('div', { className: 'qqs-row-main' }, label),
        desc ? h('div', { className: 'qqs-row-desc' }, desc) : null,
        h('div', { className: 'qqs-row-ctl' }, children))
    }

    /**
     * 折叠分类卡。
     *
     * `always` 是常显区（最常用的几项）：不受折叠状态影响，永远可见；
     * `children` 是折叠区：只有展开时才渲染。这样默认打开页面时既能看到
     * 关键配置，又不会把几十项全平铺出来。
     *
     * 整行（顶部整条卡片头）可点击，右侧箭头收起时 v、展开时 ^。
     * `tone` 控制标题左侧那条彩色装饰，`SecIcon` 用这个色系。
     */
    function Section({ title, hint, tone, icon, open, onToggle, count, always, children }) {
      const accent = tone === 'ok' ? 'var(--qqs-ok)'
        : tone === 'warn' ? 'var(--qqs-warn)'
          : tone === 'danger' ? 'var(--qqs-danger)'
            : 'var(--qqs-accent)'
      return h('div', {
        className: 'qqs-sec' + (open ? ' qqs-sec-on' : ''),
        style: { '--qqs-sec-accent': accent },
      },
      h('button', {
        type: 'button',
        className: 'qqs-sec-head',
        'aria-expanded': open ? 'true' : 'false',
        title: open ? '收起这一组' : '展开这一组',
        onClick: onToggle,
      },
      h('span', { className: 'qqs-sec-titles' },
        h('span', { className: 'qqs-sec-title' },
          icon ? h('span', { className: 'qqs-card-title-icon', style: { color: accent } }, h(Glyph, { name: icon, size: 14 })) : null,
          title),
        hint ? h('span', { className: 'qqs-sec-hint' }, hint) : null),
      count !== undefined && count !== null
        ? h('span', { className: 'qqs-sec-count' }, `${count} 项`)
        : null,
      h('span', { className: 'qqs-sec-chev' }, h(Glyph, { name: 'chevron-down', size: 14 }))),
      always ? h('div', { className: 'qqs-sec-body' }, always) : null,
      open && children ? h('div', { className: 'qqs-sec-body qqs-sec-more' }, children) : null)
    }

    /**
     * 卡片内的子分组：左侧缩进 + 淡灰竖线，画出父子层级。
     * 只在展开态渲染，避免收起时留下一排空标题。
     */
    function Group({ title, desc, children }) {
      return h('div', { className: 'qqs-group' },
        title ? h('div', { className: 'qqs-group-head' }, title) : null,
        desc ? h('div', { className: 'qqs-group-desc' }, desc) : null,
        children)
    }

    /**
     * 确认弹窗。
     *
     * · Esc 关闭；点遮罩关闭；
     * · requireText 非空时必须一字不差输入才能确认（用于「清空」）；
     * · 打开时把焦点放到输入框或取消按钮，避免回车误触。
     */
    function ConfirmModal({
      open, title, icon, children, confirmLabel = '确认', variant = 'danger',
      requireText, busy, onCancel, onConfirm,
    }) {
      const [typed, setTyped] = React.useState('')
      const inputRef = React.useRef(null)
      const cancelRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) { setTyped(''); return undefined }
        const focusTimer = setTimeout(() => {
          if (inputRef.current) inputRef.current.focus()
          else if (cancelRef.current) cancelRef.current.focus()
        }, 30)
        focusTimer.unref?.()
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel()
        }
        document.addEventListener('keydown', onKey)
        return () => {
          clearTimeout(focusTimer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, onCancel])

      if (!open) return null
      const canConfirm = busy !== true && (!requireText || typed === requireText)

      return h('div', { className: 'qqs-mask', role: 'presentation', onMouseDown: (event) => {
        if (event.target === event.currentTarget) onCancel()
      } },
      h('div', {
        className: 'qqs-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
      },
      h('div', { className: 'qqs-modal-head' },
        h('div', { className: 'qqs-modal-title' },
          icon ? h(Glyph, { name: icon, size: 17 }) : null,
          title)),
      h('div', { className: 'qqs-modal-body' },
        children,
        requireText
          ? h('div', null,
            h('p', null, `请键入 `, h('span', { className: 'qqs-code' }, requireText), ` 以确认：`),
            h('input', {
              ref: inputRef,
              type: 'text',
              className: 'qqs-input qqs-modal-input',
              value: typed,
              placeholder: requireText,
              'aria-label': `键入 ${requireText} 确认`,
              onChange: (event) => setTyped(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && canConfirm) onConfirm()
              },
            }))
          : null),
      h('div', { className: 'qqs-modal-actions' },
        h('button', {
          ref: cancelRef,
          type: 'button',
          className: 'qqs-btn',
          onClick: onCancel,
        }, '取消'),
        h('button', {
          type: 'button',
          className: 'qqs-btn ' + (variant === 'danger' ? 'qqs-btn-danger' : 'qqs-btn-primary'),
          disabled: !canConfirm,
          onClick: onConfirm,
        }, busy ? h('span', { className: 'qqs-spin', 'aria-hidden': true }) : null, confirmLabel))))
    }

    function Toasts({ items, onDismiss }) {
      if (!items || items.length === 0) return null
      return h('div', { className: 'qqs-toasts', role: 'status', 'aria-live': 'polite' },
        items.map((item) => h('div', {
          key: item.id,
          className: `qqs-toast qqs-toast-${item.tone === 'err' ? 'err' : 'ok'}`,
        },
        h('span', { className: 'qqs-toast-icon' },
          h(Glyph, { name: item.tone === 'err' ? 'alert' : 'check', size: 14 })),
        h('span', { className: 'qqs-toast-text' }, item.text),
        h('button', {
          type: 'button',
          className: 'qqs-toast-x',
          'aria-label': '关闭提示',
          onClick: () => onDismiss(item.id),
        }, h(Glyph, { name: 'x', size: 12 })))))
    }

    function Empty({ title, desc, icon = 'inbox' }) {
      return h('div', { className: 'qqs-empty' },
        h('span', { className: 'qqs-empty-icon' }, h(Glyph, { name: icon, size: 26 })),
        h('div', { className: 'qqs-empty-title' }, title),
        desc ? h('div', { className: 'qqs-empty-desc' }, desc) : null)
    }

    // ───────────────────────────────────────────── 概览

    /**
     * 「视觉识别通道」状态行。
     *
     * 关键原则：**只报真实情况**。
     *  - 静态检查失败 → 直接说原因（模型不支持图片 / 没有 handler）；
     *  - 静态检查过、但上一次真实调用失败过 → 显示失败原因，而不是「就绪」；
     *  - 都没问题且从没失败过 → 才显示「就绪」。
     * 之前的版本只要 handler 存在就显示就绪，真机上一打标就报错，属于虚假状态。
     */
    function visionRow(vision, diag) {
      const last = diag?.lastCall
      const lastFailed = last && last.ok === false
      const route = diag?.route || ''
      let tone = 'qqs-dot-ok'
      let label = '就绪'
      let desc
      if (vision?.ok !== true) {
        tone = 'qqs-dot-warn'
        label = '受限'
        desc = vision?.reason || '当前没有可用的看图路由'
      } else if (lastFailed) {
        tone = 'qqs-dot-err'
        label = '上次失败'
        desc = `上次打标失败：${last.reason || '未知原因'}${route ? `（${route}）` : ''}`
      } else if (!diag?.canSee) {
        tone = 'qqs-dot-warn'
        label = '无路由'
        desc = '找不到能看图的模型路由：设置里指定 provider/model，或确认会话有默认模型'
      } else {
        desc = `可以看图打标${route ? `（${route}）` : ''}${last?.at ? ` · 上次成功 ${fmtTime(last.at)}` : ''}`
      }
      return h(Row, { label: '视觉识别通道', desc }, h('span', { className: 'qqs-inline' },
        h('span', { className: `qqs-dot ${tone}` }),
        h('span', { className: 'qqs-muted' }, label)))
    }

    /**
     * 「收图链路」状态行：把 ingestDiag 翻译成人话。
     *
     * 排「群友发了图但库里没有」的关键信息：事件有没有到、图片块有没有、
     * 入队多少、被哪个条件挡下（not-sticker / hour-limit / collect-disabled...）。
     */
    function ingestRow(ingest, diag) {
      const events = Number(diag?.events) || 0
      const withImage = Number(diag?.withImage) || 0
      const queued = Number(diag?.queuedTotal) || 0
      const skipped = diag?.skipped ?? {}
      const reasons = Object.entries(skipped)
        .filter(([, count]) => Number(count) > 0)
        .map(([reason, count]) => `${ingestSkipLabel(reason)}×${count}`)
      let tone = 'qqs-dot-ok'
      let label = '正常'
      const parts = []
      parts.push(ingest?.queued > 0 ? `${ingest.queued} 张待处理` : '无积压')
      if (events === 0) {
        tone = 'qqs-dot-warn'
        label = '没收到事件'
        parts.push('插件重启后还没收到任何会话事件 —— 发条消息试试')
      } else if (withImage === 0) {
        tone = 'qqs-dot-warn'
        label = '没有带图消息'
        parts.push(`已收到 ${events} 个事件，但都没有图片块（桥接可能没把图转给 DSH）`)
      } else {
        parts.push(`收到 ${withImage} 条带图消息 · 入队 ${queued}`)
        if (reasons.length) {
          tone = 'qqs-dot-warn'
          label = '有图被跳过'
          parts.push(`跳过：${reasons.join(' ')}`)
        }
      }
      if (diag?.lastSkip && withImage > 0 && !reasons.length) parts.push(`最近一次：${ingestSkipLabel(diag.lastSkip)}`)
      return h(Row, { label: '收图链路', desc: parts.join(' · ') }, h('span', { className: 'qqs-inline' },
        h('span', { className: `qqs-dot ${tone}` }),
        h('span', { className: 'qqs-muted' }, label)))
    }

    /** 收图跳过原因 → 人话。 */
    function ingestSkipLabel(reason) {
      const text = String(reason ?? '')
      const map = {
        disabled: '插件或收集已关闭',
        'no-image': '这条消息没图',
        'no-ref': '图没有附件 id',
        replay: '重复消息',
        'hour-limit': '触到每小时上限',
        'not-sticker': '判定不像表情',
        'collect-disabled': '收集开关关着',
        'plugin-disabled': '插件总开关关着',
        'no-message': '消息体为空',
        'no-session-id': '拿不到会话 id',
      }
      return map[text] ?? text
    }

    function StatusTab({ data, onGoto, onOpenError }) {      if (!data) return h(Empty, { title: '还没有数据', desc: '等第一次状态轮询完成；如果一直停在加载中，看顶部错误提示。' })

      const library = data.library ?? {}
      const limits = data.limits ?? {}
      const send = data.send ?? {}
      const collect = data.collect ?? {}
      const ingest = data.ingest ?? {}
      const vision = data.vision ?? {}

      const maxBytes = (Number(limits.maxTotalMB) || 0) * MB
      const total = Number(library.total) || 0
      const visible = Number(library.visible) || 0
      const alive = Number(library.alive ?? library.visible) || 0
      const tagged = Number(library.tagged) || 0
      const untagged = Number(library.untagged) || 0
      const meaningless = Number(library.meaningless) || 0
      const pending = Number(library.pending) || 0
      const animated = Number(library.animated) || 0
      const hidden = Number(library.hidden) || 0
      const usedToday = Number(send.usedToday) || 0
      const dailyLimit = Number(send.dailyLimit) || 0
      const nextRunInMin = Number(collect.nextRunInMin) || 0
      const collectEnabled = collect.enabled === true

      return h('div', { className: 'qqs-pane' },
        h('div', { className: 'qqs-grid' },
          h(StatCard, {
            label: '库里的表情',
            value: fmtNum(total),
            unit: '张',
            hint: `可发 ${visible} · 在库 ${alive} · 隐藏 ${hidden}`,
          }),
          h(StatCard, {
            label: '占用容量',
            value: fmtMB(library.bytes ?? 0).replace(/\s(MB|KB)$/, ''),
            unit: (fmtMB(library.bytes ?? 0).match(/(MB|KB)$/) ?? ['', 'MB'])[1],
            hint: maxBytes > 0
              ? `上限 ${limits.maxTotalMB} MB（已用 ${maxBytes > 0 ? Math.round(((Number(library.bytes) || 0) / maxBytes) * 100) : 0}%）`
              : '未设置上限',
          }),
          h(StatCard, {
            label: '今日发送',
            value: fmtNum(usedToday),
            unit: '次',
            hint: dailyLimit > 0 ? `每日上限 ${dailyLimit} 次` : '不限量',
            tone: dailyLimit > 0 && usedToday >= dailyLimit ? 'warn' : undefined,
          }),
          h(StatCard, {
            label: '下次自动收集',
            value: collectEnabled ? fmtDuration(nextRunInMin * 60000) : '已关闭',
            hint: collectEnabled
              ? `${collect.nextRunAt ? fmtTime(collect.nextRunAt) : '待排程'} · 每 ${collect.everyHours} 小时`
              : '到设置里可以重新打开',
            tone: collectEnabled ? undefined : 'soft',
          })),

        h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-head' },
            h('div', { className: 'qqs-card-title' },
              h('span', { className: 'qqs-card-title-icon' }, h(Glyph, { name: 'db', size: 14 })),
              '容量与清洗状态'),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: 'chart',
              onClick: () => onGoto('actions'),
            }, '去处理')),
          maxBytes > 0
            ? h(Meter, {
              value: Number(library.bytes) || 0,
              max: maxBytes,
              label: '表情库占用',
            })
            : h('div', { className: 'qqs-card-desc' }, `已占用 ${fmtMB(library.bytes ?? 0)}，未设置总量上限。`),
          h('div', { className: 'qqs-chips' },
            h(Chip, { label: '已打标', value: fmtNum(tagged), tone: tagged > 0 ? 'ok' : undefined }),
            h(Chip, { label: '待打标', value: fmtNum(untagged), tone: untagged > 0 ? 'warn' : undefined }),
            h(Chip, { label: '判无意义', value: fmtNum(meaningless), tone: meaningless > 0 ? 'warn' : undefined }),
            h(Chip, { label: '待确认', value: fmtNum(pending), tone: pending > 0 ? 'warn' : undefined }),
            h(Chip, { label: '动图', value: fmtNum(animated) }),
            h(Chip, { label: '已隐藏', value: fmtNum(hidden) }))),

        h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-title' }, '运行状态'),
          h('div', { className: 'qqs-rows' },
            // ⚠️ 诚实显示：静态检查通过 ≠ 真能打标。上一次真实调用失败过就照实说，
            //    不要因为 handler 存在就显示"就绪"（那会在真机上给虚假希望）。
            visionRow(vision, data?.visionDiag),
            ingestRow(ingest, data?.ingestDiag),
            h(Row, {
              label: '上次自动收集',
              // ⚠️ lastResult 的实际形状是对象（collect.js 的 summarizeResult）：
              //    { ok, at, collected, already, failed, considered, stopReason }
              //    直接 String() 会渲染成 [object Object]。这里分类处理，并且
              //    兼容老版本可能存的纯文本 —— 两种都认得。
              desc: describeCollectResult(collect.lastResult),
            }, h('span', { className: 'qqs-muted' }, collect.lastRunAt ? fmtTime(collect.lastRunAt) : '—')),
            h(Row, { label: '插件开关', desc: data.enabled ? '正在工作' : '已在设置里关闭' },
              h('span', { className: `qqs-dot ${data.enabled ? 'qqs-dot-ok' : 'qqs-dot-err'}` })),
            // ── v2 状态行 ────────────────────────────────────────
            data.proactive
              ? h(Row, {
                label: '主动发图',
                desc: data.proactive.enabled
                  ? `概率 ${data.proactive.probability} · 大概一天补 ${data.proactive.expectedPerDay} 次`
                  : '已关闭（模型只能自己调工具发）',
              }, h('span', {
                className: `qqs-dot ${data.proactive.enabled ? 'qqs-dot-ok' : 'qqs-dot-warn'}`,
              }))
              : null,
            data.proactive?.battle
              ? h(Row, {
                label: '斗图',
                desc: [
                  data.proactive.battle.joinEnabled ? `跟队形（${data.proactive.battle.joinThreshold} 人）` : '不跟队形',
                  data.proactive.battle.burstEnabled ? `连发（${data.proactive.battle.burstProbability} 概率）` : '不连发',
                  data.proactive.battle.teamEnabled ? `团战（日限 ${data.proactive.battle.teamBudgetPerDay || '不限'}）` : '不团战',
                ].join(' · '),
              }, h('span', {
                className: `qqs-dot ${data.proactive.battle.joinEnabled || data.proactive.battle.burstEnabled || data.proactive.battle.teamEnabled ? 'qqs-dot-ok' : 'qqs-dot-warn'}`,
              }))
              : null,
            data.backup
              ? h(Row, {
                label: '定时备份',
                desc: data.backup.enabled
                  ? `每天 ${data.backup.at} · 下次约 ${fmtDuration((Number(data.backup.nextRunInMin) || 0) * 60000)}后`
                  : '已关闭',
              }, h('span', {
                className: `qqs-dot ${data.backup.enabled ? 'qqs-dot-ok' : 'qqs-dot-warn'}`,
              }))
              : null,
            data.store?.custom
              ? h(Row, {
                label: '存储目录',
                desc: data.store.note || '已使用自定义绝对路径',
              }, h('span', { className: 'qqs-code', title: data.store.dataDir },
                String(data.store.dataDir).length > 28
                  ? `…${String(data.store.dataDir).slice(-26)}`
                  : data.store.dataDir))
              : null,
            data.gif?.marked > 0
              ? h(Row, {
                label: '格式标记',
                desc: `「统一格式」开着，已标记 ${data.gif.marked} 张（⚠️ 只标记不转码）`,
              }, h('span', { className: 'qqs-muted' }, data.gif.lastMarkedAt ? fmtTime(data.gif.lastMarkedAt) : '—'))
              : null),
          data.dataDir
            ? h('div', { className: 'qqs-card-desc qqs-inline' },
              h('span', null, '数据目录：', h('span', { className: 'qqs-code', title: data.dataDir }, data.dataDir)),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: 'folder',
                title: '在资源管理器里打开这个目录',
                onClick: async () => {
                  try {
                    await openDataFolder()
                  } catch (error) {
                    onOpenError?.(`打不开目录：${error?.message ?? error}`)
                  }
                },
              }, '打开本地文件夹'))
            : null),

        data.tools && data.tools.length > 0
          ? h('div', { className: 'qqs-card' },
            h('div', { className: 'qqs-card-title' }, '模型工具'),
            h('div', { className: 'qqs-card-desc' },
              `已注册 ${data.tools.length} 个工具，仅对 QQ 会话可见：`),
            h('div', { className: 'qqs-chips' },
              data.tools.map((name) => h('span', {
                key: name,
                className: 'qqs-code',
                title: name,
              }, String(name).replace('qq_ext_sticker_', '')))))
          : null)
    }

    // ───────────────────────────────────────────── 操作

    /** 从 jobs 里挑出这个 kind 的最新一条。 */
    function latestJob(jobs, kind) {
      if (!Array.isArray(jobs)) return undefined
      for (const job of jobs) {
        if (job?.kind === kind) return job
      }
      return undefined
    }

    function JobPanel({ job, onDismiss }) {
      if (!job) return null
      const running = job.status === 'running'
      const total = Number(job.progress?.total) || 0
      const done = Number(job.progress?.done) || 0
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
      const indeterminate = running && total === 0
      const elapsed = Math.max(0, ((job.endedAt || Date.now()) - (job.startedAt || Date.now())) / 1000)

      return h('div', { className: 'qqs-job' },
        h('div', { className: 'qqs-job-head' },
          running ? h('span', { className: 'qqs-spin', 'aria-hidden': true }) : null,
          h('span', { className: 'qqs-job-title' }, job.label || job.kind),
          h('span', { className: 'qqs-job-meta' },
            running
              ? `${elapsed.toFixed(0)}s${total > 0 ? ` · ${done}/${total}` : ''}`
              : job.status === 'done' ? `完成 · ${elapsed.toFixed(1)}s` : '失败'),
          !running && onDismiss
            ? h(Button, { size: 'sm', variant: 'ghost', onClick: onDismiss }, '收起')
            : null),
        running
          ? h('div', { className: 'qqs-job-track' },
            h('div', {
              className: 'qqs-job-fill' + (indeterminate ? ' qqs-job-fill-indet' : ''),
              style: indeterminate ? undefined : { width: `${pct}%` },
            }))
          : null,
        job.progress?.label
          ? h('div', { className: 'qqs-job-detail' }, job.progress.label)
          : null,
        job.error
          ? h('div', { className: 'qqs-job-detail qqs-job-err' }, job.error)
          : null)
    }

    /** 把 job.result 渲染成人能读的几行摘要。 */
    function resultLines(kind, result) {
      if (!result) return []
      if (kind === 'organize') {
        const tryRun = result.dryRun === true || result.persisted === false
        const lines = tryRun
          // 试运行时这些数字只是"如果写入会怎样"，必须说清楚，否则用户会以为
          // 打标成功了（真机踩过：显示 60/60 完成，刷新后仍「待打标 118」）。
          ? [`试运行：看了 ${result.tried ?? 0} 张，本来可以打上标签 ${result.tagged ?? 0} 张`]
          : [`看了 ${result.tried ?? 0} 张，打上标签 ${result.tagged ?? 0} 张（已写入库）`]
        if (result.meaningless) lines.push(`判「无意义」${result.meaningless} 张`)
        if (result.deleted) lines.push(`删除 ${result.deleted} 张`)
        if (result.failures) lines.push(`失败 ${result.failures} 张`)
        if (result.suspicious) lines.push('本批失败比例偏高，判为可疑批次（未自动删图）')
        if (tryRun) lines.push('⚠️ 这是试运行，库没改。关掉「试运行」再跑才会真的写标签。')
        if (result.detail) lines.push(String(result.detail))
        return lines
      }
      if (kind === 'cleanup') {
        const lines = [
          `重复 ${result.duplicates ?? 0} 张 · 无意义 ${result.meaningless ?? 0} 张 · 黑名单 ${result.blocked ?? 0} 处 · 丢失 ${result.missing ?? 0} 条`,
          `可释放 ${result.freedMB ?? 0} MB，处理后库里 ${result.after ?? 0} 张`,
        ]
        if (result.dryRun) lines.push('这是试运行，库未改动')
        if (result.detail) lines.push(String(result.detail))
        return lines
      }
      if (kind === 'collect') {
        if (result.ok === false) return [String(result.reason ?? '收集没有跑起来')]
        const lines = [
          `从 ${result.considered ?? 0} 个候选里收了 ${result.collected ?? 0} 张`,
        ]
        if (result.already) lines.push(`跳过已在库的 ${result.already} 张`)
        if (result.failed) lines.push(`失败 ${result.failed} 张`)
        // 失败明细：说清是"读不到字节"还是"太大/格式不认/容量满"
        if (Array.isArray(result.failures) && result.failures.length > 0) {
          for (const line of result.failures.slice(0, 5)) lines.push(`· ${line}`)
          if (result.failureCount > 5) lines.push(`（还有 ${result.failureCount - 5} 条，见 Console）`)
        }
        if (result.stopReason) lines.push(String(result.stopReason))
        return lines
      }
      if (kind === 'sync_tree') {
        const lines = [
          `扫描 ${result.scanned ?? 0} 个文件：改标签 ${result.retagged ?? 0} 张、换位置 ${result.moved ?? 0} 张、物理删除 ${result.deleted ?? 0} 张`
            + `${result.reviewDeleted ? `（含无意义/待删除 ${result.reviewDeleted} 张）` : ''}`
            + `${result.pending ? `、转入待确认 ${result.pending} 张` : ''}`
            + `${result.restored ? `、退回未识别 ${result.restored} 张` : ''}`,
        ]
        if (Array.isArray(result.newTags) && result.newTags.length > 0) {
          lines.push(`新标签目录：${result.newTags.join('、')}${result.tagsSaved === false ? '（已记进库；写配置词表失败，重启后可再同步一次）' : ''}`)
        }
        if (Array.isArray(result.corrections) && result.corrections.length > 0) {
          for (const row of result.corrections.slice(0, 3)) {
            lines.push(`· #${row.id}：${(row.from ?? []).join('/') || '未分类'} → ${(row.to ?? []).join('/') || '待确认分类'}`)
          }
          if (result.corrections.length > 3) lines.push(`（还有 ${result.corrections.length - 3} 条人工修正）`)
        }
        if (result.unknown) lines.push(`有 ${result.unknown} 个文件没对上库（没动它们，可在目录里核对）`)
        if (result.duplicates) lines.push(`有 ${result.duplicates} 个重复文件（同一张图放了多份，没动）`)
        if (Array.isArray(result.errors) && result.errors.length > 0) {
          lines.push(`失败 ${result.errors.length} 项：${result.errors.slice(0, 2).join('；')}`)
        }
        if (result.dryRun) lines.push('这是试运行，库和文件都没改')
        if (result.detail) lines.push(String(result.detail))
        return lines
      }
      if (kind === 'delete_oldest') {
        const lines = [`删除 ${result.deleted ?? 0} 张，库里还剩 ${result.kept ?? 0} 张`]
        if (result.freedMB) lines.push(`释放 ${result.freedMB} MB`)
        if (result.dryRun) lines.push('这是试运行，库未改动')
        if (result.detail) lines.push(String(result.detail))
        return lines
      }
      if (kind === 'clear') {
        return [
          `删除 ${result.removed ?? 0} 张，释放 ${result.freedMB ?? 0} MB`,
          result.failed ? `有 ${result.failed} 张删除失败，稍后可重试` : `库里现在 ${result.after ?? 0} 张`,
        ]
      }
      if (kind === 'backup') {
        const mb = (Number(result.bytes) || 0) / 1048576
        const lines = [
          `打包 ${result.entries ?? 0} 个文件，${mb < 0.1 ? (mb * 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'}`,
          result.file ? `文件：${String(result.file)}` : '',
          `保留最近 ${result.kept ?? 0} 份${result.removed ? `，删掉旧的 ${result.removed} 份` : ''}`,
        ].filter(Boolean)
        if (Array.isArray(result.errors) && result.errors.length > 0) {
          lines.push(`有 ${result.errors.length} 个文件没读到（已跳过）：${result.errors.slice(0, 3).join('；')}`)
        }
        return lines
      }
      return []
    }

    function ActionsTab({ data, onRun, onRefresh, onToast }) {
      const jobs = data?.jobs ?? []
      const library = data?.library ?? {}
      const [drafts, setDrafts] = React.useState({})     // kind → 动作参数
      const [cleanupPreview, setCleanupPreview] = React.useState(null)
      const [clearOpen, setClearOpen] = React.useState(false)
      const [reportOpen, setReportOpen] = React.useState(false)
      const [reportText, setReportText] = React.useState('')
      const [busyKind, setBusyKind] = React.useState('')
      const [dryRun, setDryRun] = React.useState({ organize: true, cleanup: true, delete_oldest: true })

      // 任务结束 → 收结果。organize / report 用 job.result，cleanup 需要「先试运行再确认」。
      React.useEffect(() => {
        for (const job of jobs) {
          if (job.status === 'done' && job.kind === 'cleanup' && job.result?.dryRun === true) {
            setCleanupPreview(job.result)
          }
          if (job.status === 'done' && job.kind === 'report' && typeof job.result?.report === 'string') {
            setReportText(job.result.report)
            setReportOpen(true)
          }
        }
      }, [jobs])

      const running = jobs.filter((job) => job.status === 'running')
      const latestDone = jobs.filter((job) => job.status !== 'running').slice(0, 1)

      const trigger = async (kind, args) => {
        setBusyKind(kind)
        try {
          const result = await onRun(kind, args)
          if (result?.ok === false && result.reason === 'already-running') {
            onToast('err', `「${kind}」已经有一轮在跑，等它结束`)
          } else if (result?.ok !== false) {
            onToast('ok', '任务已开始，进度看下方')
            // 立刻刷新一次，让 jobs 出现（避免等 5 秒轮询）
            if (onRefresh) onRefresh()
          }
        } catch (error) {
          onToast('err', `启动失败：${error?.message ?? error}`)
        } finally {
          setBusyKind('')
        }
      }

      const runAction = (action) => {
        const draft = drafts[action.kind] ?? {}
        const args = {}
        for (const option of action.options ?? []) {
          // 草稿为空时用元数据里的默认值，保证请求里始终带全参数
          // （不然「用默认张数」得靠 Host 猜，容易出现两边默认值不一致）
          const value = draft[option.key] ?? option.value
          if (value !== undefined && value !== '') args[option.key] = Number(value)
        }
        // 只有 organize / cleanup / delete_oldest 支持试运行；
        // collect / report 的 dryRun 是 null，不带这个参数。
        if (action.dryRun === true) args.dryRun = dryRun[action.kind] !== false
        void trigger(action.kind, args).catch(() => {})
      }

      return h('div', { className: 'qqs-pane' },
        running.length > 0
          ? h('div', { className: 'qqs-pane' },
            running.map((job) => h(JobPanel, { key: job.id, job })))
          : latestDone.length > 0
            ? h(JobPanel, {
              job: latestDone[0],
              onDismiss: () => { /* 轮询会自动滚走；这里只是个视觉收起 */ },
            })
            : null,

        // 本地文件：直接调系统资源管理器打开数据目录
        h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-head' },
            h('div', { className: 'qqs-card-title' },
              h('span', { className: 'qqs-card-title-icon' }, h(Glyph, { name: 'folder', size: 14 })),
              '本地文件'),
            h('div', { className: 'qqs-inline' },
              h(Button, {
                size: 'sm',
                variant: 'primary',
                icon: 'folder',
                busy: busyKind === 'open-folder',
                onClick: async () => {
                  setBusyKind('open-folder')
                  try {
                    const result = await openDataFolder()
                    onToast('ok', `已在资源管理器打开：${result.path ?? '数据目录'}`)
                  } catch (error) {
                    onToast('err', `打不开文件夹：${error?.message ?? error}`)
                  } finally {
                    setBusyKind('')
                  }
                },
              }, '打开本地文件夹'),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: 'image',
                onClick: async () => {
                  try {
                    await openDataFolder({ sub: 'images' })
                    onToast('ok', '已打开图片目录')
                  } catch (error) {
                    onToast('err', `打不开图片目录：${error?.message ?? error}`)
                  }
                },
              }, '图片目录'))),
          h('div', { className: 'qqs-card-desc' },
            '直接跳到磁盘上看库里的图片文件。',
            data?.dataDir ? ['目录：', h('span', { className: 'qqs-code', title: data.dataDir }, data.dataDir)] : '')),

        // ── 人机协作：用户在资源管理器里挪图，点这里把意图写回库 ────────
        h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-head' },
            h('div', { className: 'qqs-card-title' },
              h('span', { className: 'qqs-card-title-icon' }, h(Glyph, { name: 'folder', size: 14 })),
              '确认应用本地整理')),
          h('div', { className: 'qqs-card-desc' },
            '目录：images/ 根目录 = 未识别（还没打标的图）、已识别/<标签名>/、已识别/待确认分类/、',
            '无意义/（待恢复/、待删除/）、待删除/。**只有 已识别/<标签>/ 里的图会被发出去**。',
            '改错标签就把图剪切到 已识别/待确认分类/，重命名为 新标签_原哈希.jpg（如 生气_1d5f.jpg；',
            '也可以在原名后追加，如 沙雕_1d5f_生气.jpg），再点这个按钮。',
            '无意义/待恢复/ 里的图会退回根目录并清空标签（重新当未识别）；无意义/待删除/ 里的图物理删除；',
            '待确认分类 里新建的 开心/ 这种文件夹，目录名就是新标签。'),
          h('div', { className: 'qqs-action-ctl' },
            h(Button, {
              variant: 'primary',
              busy: busyKind === 'sync_tree',
              disabled: latestJob(jobs, 'sync_tree')?.status === 'running',
              style: { width: '100%' },
              onClick: () => { void trigger('sync_tree', {}) },
            }, latestJob(jobs, 'sync_tree')?.status === 'running' ? '正在扫描目录…' : '确认应用本地整理')),
          latestJob(jobs, 'sync_tree')?.status === 'done' && latestJob(jobs, 'sync_tree')?.result
            ? h('div', { className: 'qqs-card-desc', style: { marginTop: 6 } },
              resultLines('sync_tree', latestJob(jobs, 'sync_tree').result)
                .map((line, index) => h('div', { key: index }, line)))
            : null),

        ACTIONS.map((action) => {
          const job = latestJob(jobs, action.kind)
          const isRunning = job?.status === 'running'
          return h('div', { key: action.kind, className: 'qqs-card' },
            h('div', { className: 'qqs-action' },
              h('span', { className: 'qqs-action-icon' }, h(Glyph, { name: action.icon, size: 17 })),
              h('div', { className: 'qqs-action-main' },
                h('div', { className: 'qqs-action-title' }, action.title),
                h('div', { className: 'qqs-action-desc' }, action.desc),
                h('div', { className: 'qqs-action-ctl' },
                  (action.options ?? []).map((option) => h('span', {
                    key: option.key,
                    className: 'qqs-inline',
                  },
                  h('span', { className: 'qqs-muted' }, option.label),
                  h(NumberField, {
                    value: drafts[action.kind]?.[option.key] ?? option.value,
                    min: option.min,
                    max: option.max,
                    unit: option.unit,
                    ariaLabel: option.label,
                    disabled: isRunning,
                    onCommit: (next) => setDrafts((prev) => ({
                      ...prev,
                      [action.kind]: { ...(prev[action.kind] ?? {}), [option.key]: next },
                    })),
                  }))),
                  action.dryRun === true
                    ? h('label', { className: 'qqs-inline qqs-muted' },
                      h(Switch, {
                        checked: dryRun[action.kind] !== false,
                        disabled: isRunning,
                        onChange: (next) => setDryRun((prev) => ({ ...prev, [action.kind]: next })),
                        label: '试运行',
                      }),
                      '试运行')
                    : null,
                  h(Button, {
                    variant: 'primary',
                    size: 'sm',
                    busy: busyKind === action.kind,
                    disabled: isRunning,
                    onClick: () => runAction(action),
                  }, isRunning ? '运行中…' : action.primary)),
                job && job.status === 'done' && job.result
                  ? h('div', { className: 'qqs-card-desc', style: { marginTop: 4 } },
                    resultLines(action.kind, job.result).map((line, index) => h('div', { key: index }, line)))
                  : null))) 
        }),

        // 清理的「试运行 → 真删」二段确认
        cleanupPreview && cleanupPreview.dryRun === true
          ? h('div', { className: 'qqs-card' },
            h('div', { className: 'qqs-card-title' },
              h('span', { className: 'qqs-card-title-icon' }, h(Glyph, { name: 'alert', size: 14 })),
              '清理试运行结果'),
            resultLines('cleanup', cleanupPreview).map((line, index) => h('div', { key: index, className: 'qqs-card-desc' }, line)),
            h('div', { className: 'qqs-action-ctl' },
              h(Button, {
                variant: 'danger',
                size: 'sm',
                busy: busyKind === 'cleanup-hard',
                onClick: async () => {
                  setBusyKind('cleanup-hard')
                  try {
                    const result = await onRun('cleanup', { dryRun: false })
                    if (result?.ok === false) onToast('err', `清理没开始：${result.reason}`)
                    else { onToast('ok', '已开始清理'); setCleanupPreview(null); onRefresh?.() }
                  } catch (error) {
                    onToast('err', `清理失败：${error?.message ?? error}`)
                  } finally {
                    setBusyKind('')
                  }
                },
              }, '确认删除这些图'),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                onClick: () => setCleanupPreview(null),
              }, '先不动')))
          : null,

        // 危险区
        h('div', { className: 'qqs-danger-card' },
          h('div', { className: 'qqs-danger-title' },
            h(Glyph, { name: 'trash', size: 15 }),
            '清空表情库'),
          h('div', { className: 'qqs-danger-desc' },
            `会删除全部 ${fmtNum(library.total ?? 0)} 张图和它们的标签记录，不可撤销、也不进回收站。`,
            ' 索引文件保留结构，但库会变成空的。'),
          h('div', { className: 'qqs-danger-row' },
            h(Button, {
              variant: 'danger',
              size: 'sm',
              disabled: (library.total ?? 0) === 0,
              onClick: () => setClearOpen(true),
            }, (library.total ?? 0) === 0 ? '库已经是空的' : '清空整个库'))),

        h(ConfirmModal, {
          open: clearOpen,
          title: '清空整个表情库？',
          icon: 'alert',
          variant: 'danger',
          confirmLabel: '永久删除',
          requireText: 'CLEAR',
          busy: busyKind === 'clear',
          onCancel: () => setClearOpen(false),
          onConfirm: async () => {
            setBusyKind('clear')
            try {
              const result = await onRun('clear', { confirm: 'CLEAR' })
              if (result?.ok === false) {
                onToast('err', `清空失败：${result.reason ?? '未知原因'}`)
              } else {
                onToast('ok', '已开始清空，进度看下方')
                setClearOpen(false)
                onRefresh?.()
              }
            } catch (error) {
              onToast('err', `清空失败：${error?.message ?? error}`)
            } finally {
              setBusyKind('')
            }
          },
        },
        h('p', null,
          '这会物理删除 ',
          h('strong', null, `${fmtNum(library.total ?? 0)} 张`),
          ' 图片文件和它们的标签、使用记录。删掉就找不回来了。'),
        h('p', null, '如果你的意思是「只删没用的」，用上面的「清理无意义图」更安全。')),

        h(ConfirmModal, {
          open: reportOpen,
          title: '表情库报表',
          icon: 'chart',
          variant: 'primary',
          confirmLabel: '知道了',
          onCancel: () => setReportOpen(false),
          onConfirm: () => setReportOpen(false),
        }, h('pre', { className: 'qqs-modal-pre' }, reportText)))
    }

    // ───────────────────────────────────────────── 设置

    function ConfigTab({ form, catalog, data, onToast }) {
      const writer = useConfigWriter(form)
      const { snap, get, write, writable, saveError, savingCount } = writer
      // 默认全部收起：每个分类的常显区（primary 项）始终可见，
      // 其余项目点分类头展开。这样首屏只露最常用的十几项，不会糊一脸。
      const [open, setOpen] = React.useState({
        send: false, collect: false, vision: false,
        proactive: false, battle: false, backup: false, advanced: false,
      })

      /**
       * Host Schema 里没有的字段（改完 Host 侧 config.js 但没重启 DSH 的典型症状）。
       * 这些字段不渲染成可点控件 —— 渲染了也只会换来一条「保存失败」的报错。
       */
      const knownTop = Array.isArray(snap?.knownTopKeys) ? new Set(snap.knownTopKeys) : undefined
      const fieldKnown = (field) => {
        if (!knownTop) return true            // 没拿到 Schema，不做推断
        const top = String(field.path).split('.')[0]
        return knownTop.has(top)
      }
      const missingTopKeys = (() => {
        if (!knownTop) return []
        const tops = new Set(FIELDS.map((field) => String(field.path).split('.')[0]))
        return [...tops].filter((top) => !knownTop.has(top))
      })()

      if (!form) {
        return h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-desc' }, '设置表单不可用（组件没拿到数据源）。按 F12 看 Console 里 [qq-sticker] 的报错。'))
      }
      if (snap?.status === 'loading') {
        return h('div', { className: 'qqs-card' },
          h('div', { className: 'qqs-card-desc' }, '正在读取配置…'))
      }
      if (snap?.status === 'error') {
        return h('div', { className: 'qqs-err-line' },
          h(Glyph, { name: 'alert', size: 14 }),
          h('div', null,
            h('div', null, '读取配置失败。'),
            h('div', { className: 'qqs-mono' }, String(snap.error ?? '未知错误')),
            h('div', null, '按 F12 打开 Console 可看到 [qq-sticker] 前缀的完整错误。')))
      }

      const renderField = (field) => {
        const value = get(field.path)
        const known = fieldKnown(field)
        const disabled = !writable || !known
        const label = field.label
        const onChange = (next) => write(field.path, next, label)

        let control
        if (field.type === 'switch') {
          control = h(Switch, {
            checked: value === true,
            disabled,
            label,
            onChange,
          })
        } else if (field.type === 'select') {
          const options = field.options ?? []
          control = h(Select, {
            value,
            options,
            disabled,
            ariaLabel: label,
            onChange,
          })
        } else if (field.type === 'model-provider') {
          control = h(ProviderPicker, {
            value,
            catalog,
            disabled,
            ariaLabel: label,
            onChange,
            hint: field.desc,
          })
        } else if (field.type === 'model') {
          // vision.model 是裸模型 id（provider 在 vision.providerId 里）；
          // proactive.model 才是 provider/model 复合串。
          const provider = field.providerPath ? String(get(field.providerPath) ?? '') : ''
          control = h(ModelPicker, {
            value,
            catalog,
            mode: field.modelMode ?? 'ref',
            provider,
            allowEmpty: true,
            disabled,
            ariaLabel: label,
            onChange,
            hint: field.desc,
          })
        } else if (field.type === 'path') {
          control = h(PathField, {
            value,
            placeholder: field.placeholder,
            disabled,
            ariaLabel: label,
            hint: field.desc,
            defaultPath: data?.store?.defaultDataDir ?? data?.dataDir ?? '',
            onCommit: onChange,
            onReset: () => onChange(''),
            onBrowse: async () => {
              try {
                await openDataFolder()
                onToast?.('ok', '已在资源管理器打开当前数据目录')
              } catch (error) {
                onToast?.('err', `打不开目录：${error?.message ?? error}`)
              }
            },
          })
        } else if (field.type === 'number') {
          control = h(NumberField, {
            value,
            min: field.min,
            max: field.max,
            step: field.step,
            unit: field.unit,
            disabled,
            ariaLabel: label,
            onCommit: onChange,
          })
        } else if (field.type === 'textarea') {
          control = h(TextAreaField, {
            value,
            placeholder: field.placeholder,
            disabled,
            rows: field.rows ?? 4,
            ariaLabel: label,
            hint: field.hint,
            onCommit: onChange,
          })
        } else {
          control = h(TextField, {
            value,
            placeholder: field.placeholder,
            disabled,
            wide: field.path.length > 22,
            ariaLabel: label,
            onCommit: onChange,
          })
        }

        const selectedOption = field.type === 'select'
          ? (field.options ?? []).find((option) => option.value === value)
          : undefined
        const desc = field.desc ?? selectedOption?.desc

        // 字段未知 / 只读时，用一句占位文字代替控件本体（点了也只会失败）
        const placeholder = unknownFieldHint(known, writable)
        const body = placeholder ?? control

        // textarea / 模型选择 / 路径输入太宽，塞在行右列会挤成一条缝 —— 单独整行渲染
        if (field.type === 'textarea' || field.type === 'model' || field.type === 'path') {
          return h('div', { key: field.path, className: 'qqs-row qqs-row-block' + (known ? '' : ' qqs-row-unknown') },
            h('div', { className: 'qqs-row-main' },
              label,
              known ? null : h('span', { className: 'qqs-need-restart', title: 'Host 侧 Config Schema 还没有这个字段' }, '需重启')),
            desc && field.type !== 'model' ? h('div', { className: 'qqs-row-desc' }, desc) : null,
            placeholder ?? h('div', { className: 'qqs-row-block-ctl' }, control))
        }

        return h('div', { key: field.path, className: 'qqs-row' + (known ? '' : ' qqs-row-unknown') },
          h('div', { className: 'qqs-row-main' },
            label,
            known ? null : h('span', { className: 'qqs-need-restart', title: 'Host 侧 Config Schema 还没有这个字段，重启 DSH 后生效' }, '需重启')),
          desc ? h('div', { className: 'qqs-row-desc' }, desc) : null,
          h('div', { className: 'qqs-row-ctl' }, body))
      }

      /** 字段未知 / 只读时右侧的占位文字；正常可写返回 null（照常渲染控件）。 */
      const unknownFieldHint = (known, isWritable) => {
        if (!known) return h('span', { className: 'qqs-muted', title: '运行中的 Host 还是旧代码，Schema 里没有这个字段' }, '重启 DSH 后可改')
        if (!isWritable) return h('span', { className: 'qqs-muted', title: '当前为只读兜底模式' }, '只读')
        return null
      }

      /**
       * 把一组字段按 group 拆开渲染：没声明 group 的排最前，
       * 有 group 的各自包一层 Group（左侧缩进 + 淡灰竖线）。
       */
      const renderFields = (fields, section) => {
        const loose = fields.filter((field) => !field.group)
        const grouped = []
        const seen = new Set()
        for (const field of fields) {
          if (!field.group || seen.has(field.group)) continue
          seen.add(field.group)
          const bucket = fields.filter((entry) => entry.group === field.group)
          const meta = section.groups?.[field.group] ?? { title: field.group }
          grouped.push({ id: field.group, meta, bucket })
        }
        return h('div', { className: 'qqs-rows' },
          loose.map(renderField),
          grouped.map((entry) => h(Group, {
            key: entry.id,
            title: entry.meta.title,
            desc: entry.meta.desc,
          }, entry.bucket.map(renderField))))
      }

      const errors = []
      if (!writable) {
        errors.push(snap?.source === 'http'
          ? '只读模式：remote.settings 不可用，正在用 HTTP 兜底读取，改动无法保存。'
          : '当前配置不可写（可能被更高优先级的配置层覆盖）。')
      }

      return h('div', { className: 'qqs-pane' },
        // ① 旧 Host Schema 导致的「字段暂时不可写」——这不是保存失败，是没重启
        missingTopKeys.length > 0
          ? h('div', { className: 'qqs-notice qqs-notice-warn', role: 'status' },
            h('span', { className: 'qqs-notice-icon' }, h(Glyph, { name: 'alert', size: 14 })),
            h('div', { className: 'qqs-notice-body' },
              h('div', { className: 'qqs-notice-title' }, '有配置项要重启 DSH 之后才能保存'),
              h('div', null,
                '运行中的 Host 还在用旧版 Config Schema，认不出这几段：',
                h('span', { className: 'qqs-notice-code' }, missingTopKeys.join(' · ')),
                '。相关的行已标「需重启」，现在点了也不会写进去。'),
              h('div', { className: 'qqs-notice-detail' },
                '改的是 Host 侧 src/config.js，必须完全退出 DSH 再启动才会加载新 Schema（只刷新页面不够）。')))
          : null,

        // ② 保存失败时把宿主给的具体原因带出来
        saveError
          ? h('div', { className: 'qqs-notice qqs-notice-err', role: 'alert' },
            h('span', { className: 'qqs-notice-icon' }, h(Glyph, { name: 'alert', size: 14 })),
            h('div', { className: 'qqs-notice-body' },
              h('div', { className: 'qqs-notice-title' }, typeof saveError === 'string' ? saveError : saveError.title),
              typeof saveError === 'string'
                ? null
                : h('div', null, saveError.message)))
          : null,

        errors.length > 0
          ? h('div', { className: 'qqs-err-line', role: 'alert' },
            h(Glyph, { name: 'alert', size: 14 }),
            h('div', null, errors.join(' ')))
          : null,

        h('div', { className: 'qqs-card qqs-card-flat' },
          h('div', { className: 'qqs-inline' },
            h('span', { className: `qqs-dot ${writable ? 'qqs-dot-ok' : 'qqs-dot-warn'}` }),
            h('span', { className: 'qqs-muted' },
              writable ? '改动会立即写入 profile 配置（热生效）' : '只读模式'),
            savingCount > 0
              ? h('span', { className: 'qqs-inline qqs-muted' },
                h('span', { className: 'qqs-spin' }), '正在保存…')
              : null)),

        SECTIONS.map((section) => {
          const fields = FIELDS.filter((field) => field.section === section.id)
          const primary = section.primaryCount > 0
            ? fields.filter((field) => field.primary === true)
            : []
          const rest = section.primaryCount > 0
            ? fields.filter((field) => field.primary !== true)
            : fields
          const expanded = open[section.id] === true
          const toggle = () => setOpen((prev) => ({ ...prev, [section.id]: !prev[section.id] }))

          return h(Section, {
            key: section.id,
            title: section.title,
            hint: section.hint,
            tone: section.tone,
            icon: section.icon,
            count: fields.length,
            open: expanded,
            onToggle: toggle,
            // 常显区：最常用的几项，折叠时也在
            always: primary.length > 0
              ? h('div', { className: 'qqs-rows' }, primary.map(renderField))
              : null,
          },
          // 折叠区：其余项，展开才渲染；组内字段按 group 缩进成子分组
          rest.length > 0
            ? h('div', null,
              renderFields(rest, section),
              h('div', { className: 'qqs-more-row' },
                h('button', {
                  type: 'button',
                  className: 'qqs-more-btn' + (expanded ? ' qqs-more-btn-on' : ''),
                  onClick: toggle,
                },
                h('span', { className: 'qqs-more-chev' }, h(Glyph, { name: 'chevron-down', size: 12 })),
                expanded ? '收起这些项' : `展开另外 ${rest.length} 项`)))
            : null)
        }),

        h('div', { className: 'qqs-card qqs-card-flat' },
          h('div', { className: 'qqs-card-desc' },
            '配置最终落在 profile 的 cordis.patch.yml 里（', h('span', { className: 'qqs-code' }, 'id: qq-sticker'),
            '）。改完立刻生效，不用重启。')))
    }

    // ───────────────────────────────────────────── 面板壳

    function TabBar({ active, onChange }) {
      return h('div', { className: 'qqs-tabs', role: 'tablist', 'aria-label': '表情包库分区' },
        TABS.map((tab) => h('button', {
          key: tab.id,
          type: 'button',
          role: 'tab',
          id: `qqs-tab-${tab.id}`,
          'aria-selected': active === tab.id ? 'true' : 'false',
          'aria-controls': `qqs-pane-${tab.id}`,
          className: 'qqs-tab' + (active === tab.id ? ' qqs-tab-on' : ''),
          onClick: () => onChange(tab.id),
        }, tab.label)))
    }

    function PanelHeader({ data, status, error, at, refreshing, onRefresh }) {
      const dot = status === 'error' ? 'qqs-dot-err'
        : status === 'stale' ? 'qqs-dot-warn'
          : refreshStatusTone(data)
      const label = status === 'error' ? '状态不可用'
        : status === 'stale' ? '连接不稳'
          : data?.enabled === false ? '插件已关闭'
            : '在线'

      return h('div', { className: 'qqs-head' },
        h('div', { className: 'qqs-head-main' },
          h('div', { className: 'qqs-title' },
            h('span', { className: 'qqs-title-icon' }, h(Glyph, { name: 'sticker', size: 19 })),
            'QQ 表情包库'),
          h('div', { className: 'qqs-sub' },
            h('span', { className: 'qqs-inline' },
              h('span', { className: `qqs-dot ${dot}${status === 'loading' ? ' qqs-dot-live' : ''}` }),
              label),
            data?.library
              ? h('span', null, `${fmtNum(data.library.total ?? 0)} 张`)
              : null,
            data?.send
              ? h('span', null, `今日已发 ${fmtNum(data.send.usedToday ?? 0)} 次`)
              : null,
            at ? h('span', null, `刷新于 ${fmtTime(at)}`) : null,
            error ? h('span', { className: 'qqs-muted', title: error }, '· 有错误') : null)),
        h('div', { className: 'qqs-head-actions' },
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            icon: 'refresh',
            busy: refreshing,
            onClick: onRefresh,
            title: '立即刷新状态',
            'aria-label': '立即刷新状态',
          }, refreshing ? null : '刷新')))

      function refreshStatusTone(data) {
        if (!data) return ''
        if (data.vision && data.vision.ok === false) return 'qqs-dot-warn'
        if (data.enabled === false) return 'qqs-dot-err'
        return 'qqs-dot-ok'
      }
    }

    function StickerPanel(props) {
      const form = props?.remoteForm ?? props?.form
      const catalog = props?.modelCatalog
      const [tab, setTab] = React.useState('status')
      const [state, refresh] = useStickerState()
      const { items: toasts, push: pushToast, dismiss: dismissToast } = useToasts()
      const [refreshing, setRefreshing] = React.useState(false)
      const data = state.data

      const handleRefresh = () => {
        setRefreshing(true)
        refresh()
        const timer = setTimeout(() => setRefreshing(false), 600)
        timer.unref?.()
      }

      const run = React.useCallback(async (kind, args) => postAction(kind, args), [])

      return h('div', { className: 'qqs-root' },
        h(PanelHeader, {
          data,
          status: state.status,
          error: state.error,
          at: state.at,
          refreshing,
          onRefresh: handleRefresh,
        }),
        h(TabBar, { active: tab, onChange: setTab }),
        h('div', {
          className: 'qqs-body',
          id: `qqs-pane-${tab}`,
          role: 'tabpanel',
          'aria-labelledby': `qqs-tab-${tab}`,
        },
        state.status === 'error' && !data
          ? h('div', { className: 'qqs-err-line' },
            h(Glyph, { name: 'alert', size: 14 }),
            h('div', null,
              h('div', null, '读取状态失败，面板现在没有数据。'),
              h('div', { className: 'qqs-mono' }, String(state.error ?? '未知错误')),
              h('div', null, '检查 Host 侧路由是否注册（重启 DSH 后再试）。')))
          : null,
        state.status === 'stale' && data
          ? h('div', { className: 'qqs-err-line' },
            h(Glyph, { name: 'alert', size: 14 }),
            h('div', null, `状态刷新失败，显示的是 ${fmtTime(state.at)} 的旧数据。`, state.error ? `（${state.error}）` : ''))
          : null,

        tab === 'status'
          ? h(StatusTab, { data, onGoto: setTab, onOpenError: (message) => pushToast('err', message) })
          : tab === 'actions'
            ? h(ActionsTab, {
              data,
              onRun: run,
              onRefresh: refresh,
              onToast: pushToast,
            })
            : h(ConfigTab, { form, catalog, data, onToast: pushToast })),
        h(Toasts, { items: toasts, onDismiss: dismissToast }))
    }

    /** 侧边栏图标（ownerProps 给 size / active）。 */
    function QqStickerIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      const active = props?.active === true
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.85 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', opacity: active ? 1 : undefined },
      },
      // 圆角贴纸主体 + 右上翘角
      h('path', { d: 'M4.5 7.5A3 3 0 0 1 7.5 4.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3z' }),
      h('path', { d: 'M16 4.5v3a1.5 1.5 0 0 0 1.5 1.5h3' }),
      // 两只眼睛 + 笑嘴
      h('circle', { cx: 9.4, cy: 11, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 14.6, cy: 11, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M9 14.4c1.7 1.5 4.3 1.5 6 0' }))
    }

    // ───────────────────────────────────────────── 装配

    return {
      // ⚠️ 必须同时声明 'remote' 与 'remote.settings'：只写 'remote' 时
      //    ctx.remote.settings 是 undefined（guard 2026-10-20 实测）。
      //    'remote.session' 同理 —— 模型目录（session/modelCatalog）靠它。
      inject: ['slots', 'remote', 'remote.settings', 'remote.session'],
      apply(ctx) {
        // ① 样式：随 effect 注册、卸载即移除。前缀 qqs-，不碰全局选择器。
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = '@local/dsh-qq-sticker'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'qq-sticker: panel css')

        // ② 配置数据源：settings.section / main 两个槽位框架都不给 form，
        //    所以自己造一个（读 remote.settings，写 mutate，失败退 HTTP 只读）。
        const remoteForm = createRemoteForm(ctx, ENTRY_ID)

        // ③ 模型目录数据源（给 vision.model / proactive.model 的真下拉用）
        const modelCatalog = createModelCatalog(ctx)

        // ④ 主面板（keyed by 'qq-sticker'）
        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_KEY,
            inject: () => ({ remoteForm, modelCatalog }),
          }, StickerPanel)),
          'qq-sticker: main panel',
        )

        // ⑤ 侧边栏图标（list，id 与 main 的 key 必须一致）
        ctx.effect(
          () => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: SIDEBAR_ORDER,
            label: () => 'QQ 表情包库',
          }, QqStickerIcon)),
          'qq-sticker: sidebar entry',
        )
      },
    }
  },
})
