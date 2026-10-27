# dsh-qq-sticker

把 SnowLuma 的五个表情包插件合并成一个 DSH 原生插件：
群友发的表情包自动收进机器人自己的本地库 → 看图打标签 → 在聊天里自然用出来。

> 来源：`QQ Agent/LB/resources/app/plugins/` 下的
> `sticker`（表情系统）、`sticker-steal`（更好的表情包收集和发送）、
> `sticker-admin`（表情包管理）、`sticker-cap`（库上限）、
> `sticker-send-as-emoji`（按表情发送）。
> 逐项映射与取舍理由见仓库根目录 `MIGRATION_DOC.md`。

---

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 群友发图 → 自动收进本地库（sha1 去重、容量上限、剔除名单） | 不碰 QQ 收藏表情（DSH 侧没有那个接口） |
| 视觉打标（标签 / 备注 / 图上文字），两道保险防清库 | 不包宿主方法、不写核心文件、不打补丁 |
| 按「贴合度 + 历史互动 + 新颖度 + 均衡度」挑图，softmax 抽样 | 不自建 OneBot 连接（发送走 `qq_send_image`） |
| 发送闸：四档频率 × 五档活跃度缩放 + 每日/间隔/每分钟 | 不迁移 SnowLuma 的 `sub_type` 小表情（P2 需改桥接） |
| 发图后 3 分钟回看群友反应，结算进评分 | — |
| **独立侧边栏面板**「QQ 表情包库」：概览 / 快捷操作 / 分类配置 | — |

---

## 目录

```
dsh-qq-sticker/
  package.json          # dsh.bundle.patch 指向 cordis.patch.yml；dsh.client 声明面板
  cordis.patch.yml      # 只一条：profile 顶层行 id=qq-sticker
  index.js              # apply(ctx, config)：装配 + 生命周期 + agent/created 注册
  client.js             # ★ 侧边栏面板（纯手写 React + CSS，零外部依赖）
  src/
    config.js           # Config Schema（40 项，全部 .volatile()）+ readConfig 归一化
    schema.js           # schemastery 加载垫片（缺包时兜底，真机应走真包）
    util.js             # sha1 / 图片类型嗅探 / 尺寸解析 / 原子写 / 防抖落盘
    library.js          # 库：内容寻址、容量淘汰、软隐藏、剔除名单、报表
    tracker.js          # 会话消息窗口（活跃度/互动结算/语境）
    ingest.js           # 实时收图（session/event → 字节 → 启发式 → 入库）
    collect.js          # 定时按频率收 + 回扫历史
    vision.js           # 看图打标（两道保险：单次删 ≤25、可疑批次不删）
    gate.js             # 发送闸（四档 × 五档数值表）
    pick.js             # 评分 + softmax 抽样 + 最近排除
    reward.js           # 互动结算（3 分钟回看）
    prompt.js           # 每轮候选段（required context）
    tools.js            # 11 个模型工具（qq_ext_sticker_*）
    jobs.js             # 面板动作的异步任务表（单飞 + 进度 + 最近 10 条）
    actions.js          # 面板动作实现（与 tools.js 同一套逻辑，供 HTTP 调用）
    server.js           # HTTP：/state、/config、/action、/report
    store.js            # v2：存储目录解析 + 首次搬迁（不覆盖已有库）
    rawstore.js         # v2.1：原始图池（桥接转交的未转码字节，GIF 动画保真）
    tagging.js          # v2：标签体系（预设类别 + 自定义词表 + 提示词拼装）
    proactive.js        # v2：主动发图 / 斗图 / 连发 / 团战（回合末补图）
    zip.js              # v2：手写 ZIP（deflate + crc32，零依赖）
    backup.js           # v2：定时备份 + 保留 N 份 + 调度
  locale/{zh,en}.json   # 插件列表里的标题/描述
  icon.svg
  test-offline.mjs        # 78 条：纯逻辑
  test-integration.mjs    # 17 条：假 ctx 跑装配与事件流
  test-panel-client.mjs   # 76 条：面板槽位 / 三 Tab / 设置页（卡片·层级·下拉·路径）/ 数据通路 / 红线
  test-panel-host.mjs     # 39 条：jobs / actions / 路由 / state 字段
  test-panel-e2e.mjs      # 20 条：真实路由的 HTTP 状态码与响应体
  test-contract.mjs       # 9 条：client 字段 ↔ Host 返回的一致性
  test-store.mjs          # 11 条：存储目录解析 / 搬迁 / 路径归一化
  test-tagging.mjs        # 22 条：标签类别解析 / 词表合成 / 对齐 / 提示词
  test-proactive.mjs      # 46 条：主动发图闸门 / 连发 / 斗图 / 团战 / 并发
  test-zip-backup.mjs     # 36 条：ZIP 往返 + 系统解压器双重验证 + 备份保留策略
  test-config-writable.mjs # 8 条：Config 可写性（13 段 / 65 叶子 volatile + live Schema 比对）
  test-gif.mjs            # 15 条：GIF 收集放宽 / 原始图池 / 发送位置与 sub_type
  test-rawimage.mjs       # 13 条：桥接↔插件原始图转交协议（/raw-image + 冻结对象 + [[qqimg:]] 对齐）
  test-llm-call.mjs       # 7 条：prepareCall 与 stream 配置一致（打标报错的回归守卫）
  test-persist.mjs        # 10 条：打标落盘 / 注入上下文识别 / 收集失败诊断
  docs/
    settings-save-troubleshooting.md  # 「保存失败 / 需重启」的根因与排查（含实测证据）
```

---

## 面板怎么用

装好重启 DSH 后，左侧侧边栏会出现 **「QQ 表情包库」** 图标（紧挨「QQ 桥接」下方）。

| Tab | 内容 |
|---|---|
| **概览** | 总张数 / 占用容量 / 今日发送 / 下次自动收集；容量条、打标组成、视觉通道与收图队列状态、主动发图与斗图与备份状态、数据目录、已注册的模型工具 |
| **操作** | 确认应用本地整理（把资源管理器里手动挪的图同步回库）、一键整理打标、清理无意义图、立即收集、删除最早的图、生成报表、立即备份；清空库在危险区（需键入 `CLEAR` 二次确认）。长任务走异步 job，面板里有进度条与耗时 |
| **设置** | 七张独立卡片（发送 / 收集 / 视觉 / 主动发图 / 斗图与连发 / 定时备份 / 高级）：标题左侧彩色装饰条、整行可点击折叠、右侧 v/^ 箭头；卡内按父子分组缩进（如「斗图与连发」拆成跟队形 / 连发 / 团战）。每类只露最常用的 1~4 项，其余点开才展开 |

设置页的两个细节：

- **模型类字段是真下拉**：「视觉模型 provider / 视觉模型 ID」和「意图分析模型」的选项来自宿主的 `session/modelCatalog`，不用背 provider 与 model 的 id；目录拿不到时自动退化成可手填的输入框。
- **旧 Host Schema 会被提前标出来**：改了 Host 侧 `src/config.js` 但没重启 DSH 时，设置页顶部会出一条黄色提示，缺的段对应的行标「需重启」并禁用 —— 不会点一下才报「保存失败」。真保存失败时也会把宿主给的具体原因（例如 `Config field "x.y" is not volatile`）原样显示出来。

数据通路：
- 状态 → `GET /dsh-qq-sticker/state`，5 秒轮询（页面隐藏自动暂停，失败退避到 60 秒）；
- 配置 → `ctx.remote.settings.describe()` / `mutate()`（DSH 原生设置接口，改完热生效）；读不到时退 `GET /dsh-qq-sticker/config` 只读兜底；
- 动作 → `POST /dsh-qq-sticker/action { kind, args }`，立即返回 jobId，进度从 `/state.jobs` 取。

---

## v2 高级功能

### 自定义存储目录

设置 → 高级 → 「自定义存储目录」填绝对路径（如 `D:\Emoji`）。

- **空目录**：自动把现有的 `library.json / state.json / schedule.json` 和全部图片搬过去（旧目录保留，确认无误后可手动删）；
- **非空目录**：直接切过去，**不覆盖**里面已有的库；
- **路径非法**（相对路径 / 是文件 / 无权限）：退回默认目录并记一条 warn，不会因为填错路径让插件起不来；
- ⚠️ **改完要重启 DSH** 才生效（library 实例在启动时绑定目录，运行中热切会让读写分裂）。

### 主动发图

模型说完话之后，插件自己从库里补一张 —— 不需要模型主动调工具。

挂载点是 `agent/turn-stopping`（回合即将关闭、模型不再欠回应）。三层闸门按顺序：

1. **总开关 + 冷却**（`idleTurns`：至少隔几个回合没发图才补）
2. **概率闸**（`probability`，0~1）—— 先掷骰子，没过就**不花任何 token**
3. **发送闸**（原 `/gate` 的档位 × 活跃度 × 每日上限）—— 主动发图不绕过任何原有硬上限

意图分析用**纯文本** LLM（不是视觉模型），输出强制 JSON；解析不出一律**判不发**（宁可少发，不能乱发）。

⚠️ 限制：**做不成图文同气泡**。`qq_send_image` 一条消息只能是一张图，所以「嵌入模式」只是把补发时机压到回合末尾，不是真的合并。

### 斗图与连发

| 功能 | 说明 |
|---|---|
| **加入队形** | 滑动窗口内（默认 30 秒）多个**不同的人**连发同一张图，机器人也跟一张。默认阈值 3 人（2 人太容易误触） |
| **图片连发** | 触发配图时按 `burstProbability` 一次发 2~3 张。连发时**放宽间隔闸**（否则第二张永远被"刚发过要等 15 秒"拦住），但每日上限仍然生效 |
| **团战模式** | 连续多张图刷屏时，用视觉模型看懂它们在表达什么，再从库里找相似图。**每次消耗一次多模态调用**，有 `teamBudgetPerDay` 硬额度，默认关闭 |

队形检测只比较 `attachmentId`，**不下载图片**、零 IO 零 token。已知局限：同一张图被重新上传会拿到新 id，识别不了。

### 物理文件夹整理（人机协作）

图片按标签分目录，**根目录就是未识别区**：

```
images/未识别_0718.jpg                          ← 刚收进来、还没打标（根目录 = 未识别）
images/已识别/哈基米/哈基米_a1b2.jpg             ← 唯一可被模型发送的来源
images/已识别/待确认分类/待确认分类_c3d4.jpg     ← 人工改标签的唯一入口
images/无意义/无意义_e5f6.jpg                    ← 自动判「无意义」
images/无意义/待恢复/...                         ← 人工复核：误判，退回根目录重新当未识别
images/无意义/待删除/...                         ← 人工复核：确实没用，物理删除
images/待删除/待删除_f7a8.jpg                     ← 物理删除
```

- 收进来的新图直接落**根目录** `未识别_<哈希前4位>.<ext>`；打上标签后自动搬进 `已识别/<标签名>/`，文件名改成 `<标签名>_<哈希前4位>.<ext>`（动图保持原扩展名）；
- **发送范围硬限制**：只有「有标签 + 物理上在 `已识别/<标签>/`」的图能进候选池、能被 `qq_ext_sticker_send` 发出去。根目录的未识别、无意义/、待确认分类/、待删除/ 一律拒绝（`isSendable` 是唯一判定，pick / send / 提示词候选 / 主动发图共用）；
- 多标签取第一个当目录名，其余标签仍留在库里；文件名哈希撞车时自动加长（`_a1b2c`…），不会互相覆盖；
- 启动时自动迁移旧布局：`images/未识别/` 里的图搬回根目录并删掉空目录；`无意义/真`→`待恢复`、`无意义/假`→`待删除`。

**改错标签**：把图从别的目录剪切到 `已识别/待确认分类/`，重命名为 `新标签_原哈希.jpg`：

- `生气_1d5f.jpg` → 标签改成「生气」；
- `沙雕_1d5f_生气.jpg` → 取最后一个非哈希词「生气」（在原名后追加新标签的写法）；
- 文件名解析不出标签（如 `待确认分类_1d5f.jpg`）→ 留在待确认分类，清空旧标签等你分类；
- 也可以建子目录：`待确认分类/哈基米/xxx.jpg` → 目录名「哈基米」就是新标签。

操作页顶部点 **「确认应用本地整理」**：

| 你做的事 | 同步结果 |
|---|---|
| `待确认分类/生气_1d5f.jpg` | 标签改成「生气」，文件搬到 `已识别/生气/生气_1d5f.jpg`，并记下人工修正（`manualTag` / `manualTagAt`，后续自动打标不会盖回去） |
| `待确认分类/哈基米/` 里放图 | 目录名就是新标签；新标签登记进库与配置词表 |
| `已识别/` 根目录的散图 | 统一搬进 `待确认分类/` 并清空标签（不再支持散落放置） |
| `无意义/待恢复/` 里的图 | 搬回 `images/` 根目录，清空标签，重新当未识别 |
| `无意义/待删除/` 里的图 | 文件与库条目**物理删除**，不可撤销 |
| `待删除/` 里的图 | 文件与库条目**物理删除**，不可撤销 |
| 把图放回 `images/` 根目录 | 清空标签，重新当未识别 |
| 认不出的目录 / 库里没有的文件 | 只报告数量，不删不改（`待删除/`、`无意义/待删除/` 例外：明确要删就删） |

同步是幂等的：自动整理出来的目录和配套文件名按设计就与「该在的位置」一致，不会把多标签误改成单标签；待确认分类里的占位图第二次同步不会再动。

### 定时备份

每天 `backup.at`（默认 06:00）把 `library.json + state.json + schedule.json + images/*` 打成一个 zip。

- 零外部依赖：手写 ZIP（`node:zlib` 的 deflate + crc32），已用 **PowerShell Expand-Archive 和 bsdtar 双解压器**逐字节验证
- 默认 **store 模式**（不压缩，图片已压过）；`deflate` 开关可开压缩
- 保留最近 `keep` 份，超出删最旧；同分钟多份自动加 `-2`、`-3` 后缀
- 面板操作页有「立即备份」；手动触发前会**先把内存里的改动落盘**，避免备份出旧快照

### 格式统一（降级实现）

设置 → 高级 → 「发送时统一格式」。

⚠️ **Node 里没有图像库，做不了真实转码**。这个开关目前只做「发送时标记 + 计数」，面板概览会显示"已标记 N 张"，不会改文件内容。真要转 GIF 需要外部 ffmpeg 或纯 JS 编码器（上千行）。

### 标签体系

设置 → 视觉打标 → 「预设标签类别」多行文本框：

```
情绪: 开心, 无奈, 生气
人物: 猫娘, 大叔, 萝莉
动作: 挥手, 比心, 磕头
```

- 用户词**优先于**内置的 18 个情绪词（不会被"插画""其他"之类抢走）
- 「自定义标签」是不属于任何类别的散词，逗号分隔
- 用户扩展过词表后，模型给出对不上的自由词会**保留**（不静默丢弃）；没扩展时保持闭合词表
- 打标提示词会自动按类别分组，并禁止模型自造新词

---

## 装到 DSH

插件要求 **Node ≥ 20**（本机 24）。两种方式：

### 方式 A：`plugin_manager`（推荐）

```
plugin_manager install_bundle { "target": "D:\\DeepSeekHarness_workarea\\Dsh-QQ-Mod\\dsh-qq-sticker" }
```

看返回的 `application`：`applied` = 已生效；`restart-required` = 需要重启 DSH。
装完在 **设置 → 插件** 里能看到「QQ 表情包库」的配置项（40 项）。

### 方式 B：手工 link（本地开发用）

```bash
dsh plugin --profile desktop add "link:D:\\DeepSeekHarness_workarea\\Dsh-QQ-Mod\\dsh-qq-sticker"
```

⚠️ **装之前先退出 DSH 桌面端**（应用运行中 pnpm 重建 `node_modules` 会 EPERM，
目录被清空却装不回来 —— 这条踩过）。

### 依赖

`@deepseek-ai/schemastery` 是唯一依赖。它在 DSH 自己的模块图里已经存在，
所以 `plugin_manager` 安装时会解析到；如果手工 link 后日志出现
「没找到 @deepseek-ai/schemastery，正在用兜底 Schema」，就在插件目录跑一次 `pnpm install`。

### 改代码后

改 Host 侧的 `index.js` / `src/*` 之后**必须重启 DSH**（已加载的 ESM 世代不会热替换）。

---

## 它怎么被装载（为什么这样设计）

1. **一条 profile 顶层行**：只有顶层行的 `Config` 会被 Settings 投影（而且只投影
   `.volatile()` 字段），也只有顶层行拿得到 `webServer`。
2. **工具按 agent 注册**：`agent/created` 里判 `agentPreset === 'qq-chat'`，
   然后往**该 agent 自己的 ctx** 注册 11 个工具。浏览器会话压根看不到这些工具，
   不需要 `tools.restrict`。
3. **绝不注册 `tools.guard`**：plain-context guard 是全 profile 的，会锁死浏览器会话
   （qq-guard 2026-10-20 的真实事故）。
4. **提示词只加 context、不加 section**：qq-guard 的人设是 `complete: true` 的 section，
   DSH 的 assemble 会把 sections 压成只留它一个；唯一活路是 `required: true` 的
   context（最终以一条 runtime-context 的 user 消息进本轮）。
5. **工具名一律 `qq_ext_sticker_*`**：qq-guard 在 QQ 会话里是 deny-by-default 白名单，
   只放行 `ask_user_question` / `todo_write` 与 `mcp__`、`qq_ext_` 两个前缀。
   不带前缀的工具装上就是"每次调用都被拒"。

---

## 数据

全部落在 `~/.dsh/plugin-data/dsh-qq-sticker/`（`$DSH_HOME` 优先）：

```
library.json                    索引（原子写，1.5s 防抖）
images/未识别_<哈希>.<ext>      图片本体（就在 images/ 根目录 = 未识别）
images/已识别/<标签名>/…        已打标的图，文件名 <标签名>_<哈希前4位>.<ext>（唯一可发送）
images/已识别/待确认分类/…      人工改标签的入口，同步后按文件名/子目录分类
images/无意义/…                 标「无意义」的图
images/无意义/待恢复/…          人工复核：误判 → 同步时退回根目录重新当未识别
images/无意义/待删除/…          人工复核：确实没用 → 同步时物理删除
images/待删除/…                 同步时物理删除
state.json                      额度/预算/计数
schedule.json                   定时收集计划
report.txt                      最近一次报表
```

**不写插件包目录**（link 安装时那就是源码目录，HMR/更新会覆盖），也不写 workspace。
卸载插件不会删这些数据。

---

## 工具（11 个，模型侧）

| 工具 | 作用 |
|---|---|
| `qq_ext_sticker_pick` | 挑候选（按情绪/关键词） |
| `qq_ext_sticker_send` | 发一张（受额度与档位限制） |
| `qq_ext_sticker_list` | 看库 |
| `qq_ext_sticker_look` | 看图（图片块直接进工具结果） |
| `qq_ext_sticker_tag` | 写标签/备注/图上文字 |
| `qq_ext_sticker_collect` | 收一张（本会话最近收到的图） |
| `qq_ext_sticker_scan` | 往回翻历史找表情 |
| `qq_ext_sticker_organize` | 一键整理打标（花 token） |
| `qq_ext_sticker_cleanup` | 去重 / 清无意义（默认 dryRun） |
| `qq_ext_sticker_delete_oldest` | 删最早（有保底留存） |
| `qq_ext_sticker_stats` | 表现报表（不花 token） |

HTTP 路由（面板与外部脚本共用）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/dsh-qq-sticker/state` | 库概况 / 额度 / 收集计划 / 任务列表 |
| GET | `/dsh-qq-sticker/config` | 读配置（面板的只读兜底通路） |
| POST | `/dsh-qq-sticker/config` | 写配置（remote.settings 不可用时兜底） |
| POST | `/dsh-qq-sticker/action` | 触发动作（`organize` / `cleanup` / `collect` / `delete_oldest` / `report` / `clear`） |
| GET | `/dsh-qq-sticker/report` | 报表文本 |

---

## 发送链

```
我们的 send 工具
  → gate 判额度/间隔/每分钟
  → tools.execute({ name:'qq_send_image', arguments:{ file:'file:///…' }, agent })
      → qq-guard 的 qq_send_image（它已经带着等桥接回执的逻辑）
          → 桥接 session-ops 队列 → NapCat
  → 记账（库/配额）+ 3 分钟后互动结算
```

失败会把桥接给的真实原因抛给模型（不会假装发出去了）。

---

## 测试

```bash
node test-load.mjs                 # 装载自检：模拟 DSH 的 import → Config → apply(ctx)
node test-load.mjs --real-cordis   # ★ 用真 Cordis 装载（能复现真机的 proxy 陷阱错误）
node test-cordis-regression.mjs    # 回归：Cordis「未声明服务属性」陷阱焊死
node test-offline.mjs              # 78 条：库/闸/评分/解析/工具定义
node test-integration.mjs          # 18 条：假 ctx 跑装配、agent/created、收图、发送、落盘
node test-panel-client.mjs         # 77 条：面板槽位 / 三 Tab / 设置页 / 路径管理 / 数据通路 / CSS 红线
node test-panel-host.mjs           # 40 条：Host 侧 jobs / actions / 路由 / state 字段
node test-tree.mjs                 # 29 条：物理目录 / 待确认分类 / 待恢复-待删除 / 发送范围 / 清理口径回归
node test-panel-e2e.mjs            # 20 条：真实路由跑一遍，验 HTTP 状态码与响应体
node test-contract.mjs             # 9 条：client 读的字段与 Host 返回的一致性
node test-store.mjs                # 11 条：存储目录解析 / 搬迁 / 路径归一化
node test-tagging.mjs              # 22 条：标签类别 / 词表合成 / 对齐 / 提示词
node test-proactive.mjs            # 48 条：主动发图闸门 / 连发 / 斗图 / 团战 / 并发
node test-zip-backup.mjs           # 36 条：ZIP 往返 + 系统解压验证 + 备份保留
node test-config-writable.mjs      # 8 条：Config 可写性（源码 13 段/65 叶子 volatile + live Schema 比对）
node test-gif.mjs                  # 15 条：GIF 收集放宽 / 原始图池 / 发送位置 / sub_type
node test-rawimage.mjs             # 13 条：原始图转交协议（/raw-image + 冻结对象 + [[qqimg:]] 对齐）
node test-llm-call.mjs             # 10 条：prepareCall/stream 配置一致（防「config changed」回归）
node test-persist.mjs              # 10 条：打标落盘 / 注入上下文识别 / 收集失败诊断
```

全部**不联网、不起进程、不碰 DSH**。`--real-cordis` 会自己去找
`@deepseek-ai/cordis`（插件 node_modules → qq-guard → 离线测试依赖），
找不到时可以指路：`--cordis-dir="<装了 @deepseek-ai/cordis 的 node_modules>"`。

### ⚠️ 一个必须记住的坑：Cordis 的 ctx 是 Proxy

读一个**没写进 `inject`** 的服务属性会**抛错**：

```
cannot get property "timer" without inject
```

而且这个抛错发生在 proxy 的 get 陷阱里，**`ctx?.foo` / `ctx.foo ?? fallback` 都兜不住**。
更难发现的是：**根 ctx 不抛**（返回 undefined），只有**插件自己 fiber 里的 ctx** 才抛 ——
所以"在 REPL 里手试好使、装进 DSH 就红点"。

- 必需服务 → 写进 `export const inject`
- 可选服务 → 一律 `safeService(ctx, name)`（内部走 `ctx.get`，不要求 inject）

2026-10-25 插件 `fiberPhase=failed` 就是 `ctx.timer` 这一条踩的。
`test-cordis-regression.mjs` 会扫源码，防止有人把这个写法"优化"回去。

## 出问题时怎么查

DSH 的异常卡片点不开详情，日志里也没有 —— 先跑自检：

```bash
cd D:\DeepSeekHarness_workarea\Dsh-QQ-Mod\dsh-qq-sticker
node test-load.mjs --real-cordis
```

它会把真实 Error、完整 stack、cause 链、以及"崩在哪一步的 ctx 调用"全部打到终端。
如果自检绿而 DSH 还是红点，用 `plugin_manager list_plugins` 看这一行的 `fiberPhase`：

| fiberPhase | 含义 |
|---|---|
| `active` | 装载成功 |
| `failed` | `apply()`/effect 里抛了 —— 自检能复现 |
| `null` + `enabled: true` | 依赖没满足（`inject` 的服务不存在） |
| `null` + `enabled: false` | 被禁用了，不是错误 |

---

## 常见问题：设置页保存失败 / 字段显示「需重启」

**症状**：顶部出现红色 `「xxx」保存失败，已回滚到原值`，或设置页顶部一条黄色「有配置项要重启 DSH 之后才能保存」。

**原因**：DSH 的 settings 服务只接受 Host 侧 `Config` Schema 里**声明过且标了 `.volatile()`** 的字段。改了插件的 Host 代码（`src/config.js` 加新配置段）之后，**运行中的 DSH 进程还加载着旧的 Schema** —— 界面把新字段渲染出来了，点了保存却被服务端拒：

```
Config field "proactive.enabled" is not volatile
```

**解法**：完全退出 DSH 再启动（只刷新页面不够，Host 侧代码不会热替换）。

**已做的防御**：设置页会拿宿主回读的 Schema 信封（`{uid, refs}`）比对顶层字段，缺的段在**点之前**就标出来 —— 顶部黄条 + 行上「需重启」徽标 + 控件禁用；真被拒时也会把宿主给的原始原因显示在红色提示条里（而不是只丢一句「保存失败」）。

排查顺序：
1. 设置页顶部有没有黄条？有 → 直接重启 DSH，不用看别的。
2. 没有黄条但仍保存失败 → 点 F12 看 Console 里 `[qq-sticker] mutate 未成功` 后面带的具体 code / message。
   `SETTINGS_CONFLICT`（revision 过期）重试一次即可；其它按 message 判断。

---

## 2026-10-26 真机排查记录：三个「看起来修好了但没修好」的坑

这一轮上线后真机仍然失败，挖出几个隐藏很深的 bug。记在这里，免得以后重犯。

### 坑一：`prepared LLM call config changed` 有两层

上轮只修了「temperature/maxTokens 只进 stream 不进 prepareCall」。真机还报错，因为
**DSH 会自动补 `reasoningEffort`**：

```js
// dsh-llm/lib/index.js resolveCallWithInfo
const effective = requested ?? reasoning.defaultEffort
if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }
```

模型带 `defaultEffort`（trae 是 `'high'`）而我们不传 reasoningEffort 时，
`resolved.config` 会多出 `reasoningEffort: 'high'`，派发前逐字段比对必然不等。

**正确修法**：不要试图在外面复现 DSH 的默认值补全规则，
用 `prepared.config` 回填 stream 的 options（见 `callViaPrepared`）。

### 坑二：收集的 `skippedSelf` 把全部消息误杀了

`readSessionMessages` 里 `selfId` 硬编码为 `''`，而 `senderId` 拿不到也是 `''`：

```js
if (String(message.senderId ?? '') === String(message.selfId ?? '')) continue  // 每条都命中!
```

真机实测 108 条消息全被当成「自己发的」跳过，`imageBlocks: 0`。
修法：拿不到就返回 `undefined`，且只在**两边都真有值**时才比较。

### 坑三：DSH 的 content 是冻结对象，不能原地加字段

`session.deriveMessages()` 返回的 content/attachment 都是 `Object.freeze` 过的。
`attachment.rawToken = token` 直接抛 `Cannot add property rawToken, object is not extensible`，
整条收集失败。修法：`attachRawTokens` 改为**复制**出新数组（见 `src/rawtoken.js`）。

### 坑四：回扫拿不到会话

`tracker.sessions()` 是进程内内存记录（重启后为空），`sessions.list()` 只返回**活会话**
（QQ 会话重启后没有活跃 agent，不在里面）。真机实测 146 个会话里 QQChat 的 14 个
`agentAvailable` 全是 false。

**正确来源**：`sessionPersistence.list()` —— 它列所有**已存储**的会话（含历史）。

### 排查工具

插件现在通过 `/state` 暴露两个诊断字段，遇到「发了图但库里没有」先看它们：

| 字段 | 看什么 |
|---|---|
| `ingestDiag` | 事件数 / 带图消息数 / 入队数 / `lastRawTokens` / 按原因分类的跳过计数 |
| `visionDiag` | 静态可用性 + **上一次真实调用**的 ok/reason/route |

`visionDiag.lastCall.ok === false` 时，UI 会显示「上次失败：具体原因」而不是「就绪」。

---

## 动图（GIF）为什么以前是静态的，现在怎么修好的

**症状**：群里收进来的 GIF 存到库里变成一张静图；发出去的 GIF 在 QQ 里也不会动。

**两个各自独立的根因**（都已修）：

1. **收进来的 GIF 丢帧** —— DSH 的附件服务 `@deepseek-ai/dsh-attachment-local` 会对每张图做
   "归一化"：`canPassThroughNormalization()` 见到 `mediaType==='image/gif'` 或 `animated`
   一律返回 false，然后 `encodingLadder()` 只产出 `image/webp`（有 alpha）或 `image/jpeg`。
   所以 `ctx.attachments.readImage(ref)` 拿回来的**永远是单帧**。
   修法：桥接进程本来就在下载原始 Buffer，它把原字节 POST 到插件的 `/dsh-qq-sticker/raw-image`
   （best-effort，失败不影响聊天），插件按 token 落进"原始图池"（`src/rawstore.js`，
   10 分钟 TTL）。ingest 优先用原始池的字节入库，GIF 的 28 帧就都留住了。

2. **发出去的 GIF 是静态大图** —— 全链路（`qq_send_image` → guard 队列 → 桥接 `_applyImageOp`
   → `onebot.sendImage`）以前**没有任何地方传 `sub_type`**，NapCat 就当普通图片发。
   修法：`qq_send_image` 加可选参数 `subType`（0/1），一路透传到 image 段的 `sub_type`；
   GIF + `subType:1` 时再补 `summary: '[动画表情]'`。

**同时放宽的收集门槛**（原来会误杀动图）：

| 项 | 原来 | 现在 |
|---|---|---|
| 表情最大边长 | 640px | **1920px** |
| 表情最大字节 | 1.5MB | **10MB** |
| GIF | 也受上面两条限制 | **完全不受限**（只受库的硬顶 12MB） |

改的都是 `src/config.js` 的默认值 + `src/ingest.js` / `src/library.js` / `src/proactive.js`
的判定。旧配置若显式写过 640/1572864，需要到设置页改一下（或留空用默认）。

**怎么确认它在工作**：设置页「发送设置」→ 图片位置选「文字之后」，「按小表情发送」打开；
概览页能看到库里有动图的张数。Console 里 `[qq-sticker] 收进表情 #xxxx` 会打出真实尺寸。

---

## 已知限制

| 限制 | 原因 | 出路 |
|---|---|---|
| ~~未识别的图被发出去~~ | ~~`visible()` 只挡 hidden，没看标签和物理目录~~ | ✅ 已修：`isSendable` 统一判定，只有 `已识别/<标签>/` 能发 |
| ~~发表情显示成大图~~ | ~~DSH 发送链不透传 `sub_type`~~ | ✅ 已修：`qq_send_image` 新增 `subType` 参数并透传到 NapCat |
| ~~动图只按首帧识别~~ | ~~Host 侧没有图像库~~ | ✅ 已修：桥接转交原始字节 → 原始图池（GIF 保真） |
| GIF 转码成别的格式 | Node 里没有图像库/ffmpeg | 只做「发送时标记」，不做真实转码 |
| 商城表情（mface）不入库 | 桥接把 `mface` 段转成文本 `[表情]`，没有图 | 需要改桥接保留原段 |
| 无法同步 QQ 收藏 | DSH 侧没有 `fetch_custom_face_detail` | 需要桥接/qq-guard 开只读通道 |

---

## 许可与来源

原插件是本地自建（`author: local` / `为 QQ Agent 定制` / `落叶` / `本地自建`），
无外部开源许可约束。本插件的算法数值（四档频率、五档活跃度缩放、评分权重、
单次删除上限、两道保险）全部沿用原实现，未改数值。
