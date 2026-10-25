# qq-sticker 保存失败根因 + 验证记录

> 结论先行：**不是 client.js 的写回逻辑或 mutate 路径写错，是运行中的 DSH Host 还加载着旧版 `src/config.js`。**
> 新加的 v2 配置段（proactive / battle / backup / store / gif）在运行中 Host 的 Config Schema 里根本不存在，
> 所以 settings 服务在 `isVolatilePath` 处直接拒绝写入。源码侧 Schema 本身是对的（13 段 / 65 叶子全部 `.volatile()`）。
>
> **后续更新（同日晚些时候复核）**：再次检查时 live Host 已经加载了新 Schema（13 段齐全），
> 真机回环写入成功并落盘 —— 即这个原始报错在当前进程上已不复现。详见第 4 节「复核更新」。

## 1. 现场证据

### 1.1 运行中 Host 的 Schema 只有 8 个段

从 live DSH（`http://127.0.0.1:14297`）调 `settings/describe`，取 `ns="qq-sticker"` 行：

```
uid / refs 信封：{"uid":83204,"refs":{...}}
schema 顶层 dict keys（Live）：
  enabled, debug, library, collect, vision, send, prompt, maintenance
  ↑ 只有 8 个，没有 proactive / battle / backup / store / gif
```

`value` 里也确认没有这 5 段：

```
value.proactive: undefined
value.battle:    undefined
```

### 1.2 写 proactive.enabled 被服务端拒绝（原样记录）

```
POST /api/settings/mutate
{ "ns": "qq-sticker", "ops": [{"op":"set","path":["proactive","enabled"],"value":true}], "expectedRevision": 0 }

→ { "ok": false,
    "error": { "code": "settings/rejected",
               "message": "Config field \"proactive.enabled\" is not volatile",
               "details": { "ns": "qq-sticker" } } }
```

对照：写旧段 `debug` 是成功的（同一次会话里验证过，随后已把它恢复成原值 false）。

**这两个结果并列，正好把责任范围钉死**：`mutate` 通道、revision、点分 path 序列化、HTTP 往返全都正常；
唯一变量是「这个字段在 Host 的 Schema 里存不存在」。

### 1.3 时间线（为什么 Host 会是旧的）

| 事实 | 值 |
|---|---|
| 运行中的 DSH 主进程启动时间 | 2026-10-25 **17:53**（PID 54304 host / 46520 主窗口） |
| `src/config.js` 最后修改时间（含 v2 段） | 2026-10-25 **18:41** |
| `src/proactive.js` / `battle` / `backup` / `zip.js` 等 v2 文件 | 2026-10-25 **18:4x** |

Host 侧代码不做热替换（README 里已写明「改动 Host 侧代码必须重启 DSH 才生效」），
17:53 启动的进程加载的是那一刻的 `config.js` —— 那时 v2 段还没写进去。

## 2. 源码侧是合格的（逐条核过）

用插件自带真 schemastery 展开 `Config.toJSON()` 后逐叶子检查：

```
叶子总数: 65
未标 volatile 的: 无（全部可写）
顶层段（13）: enabled, debug, library, collect, vision, send, prompt, maintenance,
              store, proactive, battle, backup, gif
```

也就是说 v2 段的声明方式与旧段**完全一致**（都带 `.default(...).volatile()`），
不存在「少写一个 .volatile() 导致不可写」的代码 bug。

再把 `client.js` 的 `FIELDS`（65 条）与 Host `DEFAULTS` 的叶子（65 个）做交叉比对：

```
client 字段数: 65 | Host DEFAULTS 叶子数: 65
✓ 每个字段 Host 都认
✓ 无遗漏
```

## 3. 拒绝逻辑在 Host 侧的哪一行（解包的 dsh-settings 源码）

`D:\DeepSeekHarness_workarea\Work\.recon\asar\out\@deepseek-ai\dsh-settings\lib\index.js`

- `isVolatilePath(schema, path)`（约 L153-158）：沿 `schema.dict` 逐段往下找，
  一旦某个 `dict` 里没有这个 key 就返回 false —— **"字段不存在"和"字段没标 volatile" 在这里得到同一个结果**。
  这解释了为什么错误文案是 `is not volatile` 而不是 `unknown field`。
- `write()`（约 L501-537）里两道校验都用到它：
  - `for (const path of paths) if (path.length && !isVolatilePath(schema, path)) throw new Error(...is not volatile)`
  - `validatePaths(next, form)` 对整棵写入树再扫一遍；
- 外层 `dsh-api-settings-controller` 的 `write()` 把任何 provider 抛错统一转成 `settings/rejected`。

所以这条报错是**宿主按设计拒绝**，不是异常路径。

## 4. 复核更新：原始报错在当前进程上已不复现（2026-10-25 21:00 之后）

写这份文档的过程中再查了一次 live 状态，情况变了 —— **Host 已经加载了新 Schema**。
宿主进程 PID 没变（仍是 17:53:29 启动的那批），说明是插件自身被 reload / HMR 重建，
而不是整个 DSH 重启。这条不改变上面的根因判断，只说明「重启/重载之后就好了」这个结论。

复核证据：

| 检查 | 结果 |
|---|---|
| live `settings/describe` 的 qq-sticker 段数 | **13 段**（旧 8 + store/proactive/battle/backup/gif），与源码一致 |
| 真机写 `proactive.enabled = true` | `{ok:true, revision:5}`，并**真的落盘**：`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `qq-sticker.config.proactive.enabled: true`（已恢复原值 false） |
| v2 字段逐个写入再恢复 | **20/20 合法值全部可写可恢复**；故意用越界值（probability 1.25 > max 1、burstProbability 1.2）被正确拒绝，证明范围校验也在工作 |
| `cordis_inspect_query` → `Config.listConfigs`（entry `include:qq-sticker`） | `status: "schema"`，JSON Schema 里 13 段齐全，每个叶子都带 `x-cordis.volatile: true` |
| `cordis_inspect_query` → `Slots.listSubTree`（`sidebar.panellist`） | `qq-sticker` 占据 `order: 27`，`active: true` |
| `verify-sticker-config.mjs` | 通过 8｜失败 0 |

所以：**代码侧（Host Schema / client 字段映射 / mutate 通道）全部合格；当初的红条是旧进程的 Schema 陈旧所致。**
翎羽重启 DSH 验收时如果还看到红条，那是验收时又改了 Host 代码没重启 —— 界面现在会直接标「需重启」提示。

---

## 5. 处理与已加的防御

**当初要做的**：完全退出 DSH 再启动（只刷新页面不够）。重启后 Host 会重新 import
`src/config.js`，13 个段全部出现在 describe 结果里，保存就正常了。

**已加进界面的防御**（这次一起改了）：

1. **写前预判**：`createRemoteForm` 现在把 describe 返回的 `schema` 信封（`{uid, refs}`）存进快照，
   用 `topKeysOf()` 取出 Host 真正认的顶层段集合。设置页拿它跟 `FIELDS` 的段比对：
   - 有缺 → 顶部出黄色提示条，列出缺哪几段；
   - 对应行标「需重启」徽标、控件换成禁用占位文字（`重启 DSH 后可改`），点了不会写、也就不会报错。
2. **失败原因透传**：`mutate` 失败时不再只显示一句「保存失败」，而是把宿主返回的
   `code` + `message` 经 `describeMutateError()` 翻译后显示。针对这条具体错误有专门文案：

   > Host 的 Config Schema 里没有「proactive.enabled」这个字段 —— 运行中的 DSH 还是旧代码，
   > 重启 DSH 后这一项才可写。

   `SETTINGS_CONFLICT`（revision 过期）则提示「已重新读取，再点一次即可」。

## 6. 可重复验证

```bash
# 1) 源码侧：13 段 / 65 叶子是否全部 volatile
cd /d/DeepSeekHarness_workarea/Dsh-QQ-Mod/dsh-qq-sticker
node -e "import('./src/config.js').then(({Config})=>{const j=Config.toJSON(),r=j.refs[j.uid];
const flat=(n,p,o)=>{if(!n)return o;if(n.type==='object'&&n.dict){for(const[k,c]of Object.entries(n.dict))flat(j.refs[c],p?p+'.'+k:k,o)}else o.push({p,v:n.meta?.volatile===true});return o};
const l=flat(r,'',[]);console.log('叶子',l.length,'非volatile',l.filter(x=>!x.v).length)})"

# 2) 运行时：live DSH 的 qq-sticker 段数（重启前后对比）
curl -s http://127.0.0.1:14297/dsh-qq-sticker/config | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);
console.log('v2 段是否在 live config 里:', ['store','proactive','battle','backup','gif'].filter(k=>k in j.config))})"
```

> 注：`GET /dsh-qq-sticker/config` 走的是插件自己 `readConfig()` 归一化后的结果，
> 重启前它也不含 v2 段 —— 这说明旧 Host 读的确实是旧 Schema。
