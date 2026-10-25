/**
 * test-load.mjs —— 在纯 Node 里模拟 DSH 装载插件，把真实 Error + 堆栈打到终端。
 *
 * 为什么需要它：DSH 的「异常」卡片只显示数字，点不开详情、日志里也没有记录。
 * 这个脚本做的事和 DSH Loader 装载时一样：import 模块 → 读 Config → 调 apply(ctx, config)，
 * 任何一步抛错都原样打印（包括 cause 链和完整的 stack）。
 *
 * ★ 两种 ctx 都要过：
 *   · `--real-cordis`：用真的 Cordis Context 装插件（最接近 DSH，能复现
 *     `cannot get property "x" without inject` 这类 proxy 陷阱错误）；
 *   · 默认：轻量假 ctx（不需要 DSH 依赖，快速回归）。
 * 只要你机器上装了 DSH 的 node_modules，就优先跑 `--real-cordis`。
 *
 * 跑法（在插件根目录）：
 *   node test-load.mjs                 # 假 ctx 快速自检
 *   node test-load.mjs --real-cordis   # 真 Cordis（推荐，能复现真机报错）
 *   node test-load.mjs --verbose       # 额外打印 ctx 被调用的顺序
 *   node test-load.mjs --no-effects    # 不执行 ctx.effect 里的回调（只看注册阶段）
 *
 * 退出码：0 = 装载成功；1 = 失败（失败原因见终端输出）。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = new Set(process.argv.slice(2))
const VERBOSE = argv.has('--verbose')
const RUN_EFFECTS = !argv.has('--no-effects')
const REAL_CORDIS = argv.has('--real-cordis')

// ────────────────────────────────────────────────────────────── 输出工具

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
}

function banner(text) {
  console.log(`\n${C.bold}${'='.repeat(70)}${C.reset}`)
  console.log(`${C.bold}${text}${C.reset}`)
  console.log(`${C.bold}${'='.repeat(70)}${C.reset}`)
}

function step(text) {
  console.log(`${C.cyan}→${C.reset} ${text}`)
}

function ok(text) {
  console.log(`${C.green}✓${C.reset} ${text}`)
}

function warn(text) {
  console.log(`${C.yellow}!${C.reset} ${text}`)
}

/** 打印一个错误的全部信息：message / name / code / 完整 stack / cause 链 / 附加字段。 */
function dumpError(error, depth = 0) {
  const pad = '  '.repeat(depth + 1)
  const indent = '  '.repeat(depth)
  console.log(`\n${indent}${C.red}${C.bold}✗ ERROR${C.reset}`)
  console.log(`${pad}${C.bold}name:${C.reset}    ${error?.name ?? '(no name)'}`)
  console.log(`${pad}${C.bold}message:${C.reset} ${error?.message ?? String(error)}`)
  if (error?.code !== undefined) console.log(`${pad}${C.bold}code:${C.reset}    ${JSON.stringify(error.code)}`)
  if (error?.errno !== undefined) console.log(`${pad}${C.bold}errno:${C.reset}   ${error.errno}`)
  if (error?.syscall !== undefined) console.log(`${pad}${C.bold}syscall:${C.reset} ${error.syscall}`)
  if (error?.path !== undefined) console.log(`${pad}${C.bold}path:${C.reset}    ${error.path}`)

  // 附加的枚举字段（DSH 的 config/schema 错误常把细节挂在自定义字段上）
  const skip = new Set(['name', 'message', 'stack', 'cause', 'code', 'errno', 'syscall', 'path'])
  for (const key of Object.getOwnPropertyNames(error ?? {})) {
    if (skip.has(key)) continue
    let value
    try { value = error[key] } catch { continue }
    if (value === undefined || typeof value === 'function') continue
    let text
    try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
    if (text !== undefined && text.length > 400) text = `${text.slice(0, 400)}…`
    console.log(`${pad}${C.bold}${key}:${C.reset} ${text}`)
  }

  console.log(`\n${pad}${C.bold}stack:${C.reset}`)
  const stack = String(error?.stack ?? '(no stack)')
  for (const line of stack.split('\n')) console.log(`${pad}  ${line}`)

  if (error?.cause) {
    console.log(`${pad}${C.bold}── cause ──${C.reset}`)
    dumpError(error.cause, depth + 1)
  }
}

// ────────────────────────────────────────────────────────────── 假 ctx

/**
 * 假 Cordis ctx。
 *
 * 只实现插件真正会碰到的那几个方法，但每个都**记录调用**：
 * 这样如果插件用到了某个我们以为存在的服务，能立刻看出来。
 *
 * 关键取舍：`effect()` 默认**会执行**回调（与 DSH 一致 —— 装载时就跑），
 * 所以初始化、定时器、路由注册这些真实路径都会被走一遍。
 */
function makeCtx({ services = {}, onMissingService = 'warn' } = {}) {
  const calls = []
  const handlers = new Map()
  const effects = []

  const record = (kind, detail) => {
    calls.push({ kind, detail })
    if (VERBOSE) console.log(`   ${C.dim}[ctx.${kind}] ${detail}${C.reset}`)
  }

  const ctx = {
    calls,
    handlers,
    effects,
    /** 插件可能会直接读 ctx.tools / ctx.llm 这类属性 */
    get(name) {
      const hit = services[name]
      if (hit === undefined) {
        record('get', `'${name}' → undefined`)
        if (onMissingService === 'throw') throw new Error(`假 ctx 里没有服务 '${name}'`)
      } else {
        record('get', `'${name}' → ${hit?.__label ?? typeof hit}`)
      }
      return hit
    },
    on(event, handler, options) {
      record('on', `'${event}'${options?.prepend ? ' (prepend)' : ''}`)
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      const dispose = () => {
        const current = handlers.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
      return dispose
    },
    effect(fn, label) {
      record('effect', label ?? '(no label)')
      let dispose = () => {}
      if (RUN_EFFECTS) {
        const result = typeof fn === 'function' ? fn() : undefined
        if (typeof result === 'function') dispose = result
      }
      effects.push({ label, dispose })
      return dispose
    },
    timer: {
      interval(callback, delay) {
        record('timer.interval', `${delay}ms`)
        if (!RUN_EFFECTS) return () => {}
        const id = setInterval(callback, delay)
        id.unref?.()
        return () => clearInterval(id)
      },
    },
    /** 触发事件（用来走一遍 agent/created、session/event）。 */
    emit(event, ...args) {
      const list = handlers.get(event) ?? []
      record('emit', `'${event}' (${list.length} 个监听器)`)
      for (const handler of list) handler(...args)
    },
  }
  return ctx
}

/** 最小假 agent（带自己的 ctx：tools.register + systemPrompt.context）。 */
function makeAgent({ id = 'session-load-test', preset = 'qq-chat' } = {}) {
  const registered = []
  const contexts = []
  const agentCtx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            registered.push(definition?.name ?? '(unnamed)')
            return () => {
              const index = registered.indexOf(definition?.name)
              if (index >= 0) registered.splice(index, 1)
            }
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          context(spec) {
            contexts.push(spec?.name ?? '(unnamed)')
            return () => {
              const index = contexts.indexOf(spec?.name)
              if (index >= 0) contexts.splice(index, 1)
            }
          },
        }
      }
      if (name === 'agentPresets') {
        return { composedPreset: (scope) => (scope === agentCtx ? preset : undefined) }
      }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id,
    session: { header: { id, agentPreset: preset, cwd: HERE } },
    ctx: agentCtx,
  }
  return { agent, registered, contexts }
}

// ────────────────────────────────────────────────────────────── 主流程

async function main() {
  banner('dsh-qq-sticker · 装载自检（模拟 DSH Loader）')
  console.log(`${C.dim}插件目录：${HERE}${C.reset}`)
  console.log(`${C.dim}Node：${process.version}｜平台：${process.platform}${C.reset}`)
  console.log(`${C.dim}模式：${REAL_CORDIS ? '真 Cordis' : '假 ctx'}｜${RUN_EFFECTS ? '执行 ctx.effect 回调（与 DSH 一致）' : '只注册不执行'}${VERBOSE ? '｜verbose' : ''}${C.reset}`)

  if (REAL_CORDIS) return await runWithRealCordis()

  // ① 读 package.json / patch
  step('读 package.json 与 cordis.patch.yml')
  let manifest
  try {
    const { readFile } = await import('node:fs/promises')
    manifest = JSON.parse(await readFile(path.join(HERE, 'package.json'), 'utf8'))
    ok(`package.json：name=${manifest.name} version=${manifest.version} type=${manifest.type}`)
    const patchPath = manifest?.dsh?.bundle?.patch
    if (!patchPath) {
      warn('package.json 里没有 dsh.bundle.patch —— DSH 不会把它当 bundle 装')
    } else {
      const patch = await readFile(path.join(HERE, patchPath), 'utf8')
      ok(`${patchPath}：${patch.split('\n').length} 行`)
      if (!patch.includes(manifest.name)) {
        warn(`${patchPath} 里没有出现包名 ${manifest.name} —— patch 和目标包对不上`)
      }
    }
    if (manifest.dependencies) {
      ok(`dependencies：${Object.keys(manifest.dependencies).join(', ') || '(空)'}`)
    }
  } catch (error) {
    dumpError(error)
    return 1
  }

  // ② import（这一步等价于 DSH 的 `import(url?t=...)`）
  step("import('./index.js')")
  let mod
  try {
    mod = await import('./index.js')
    ok(`import 成功：导出 ${Object.keys(mod).join(', ')}`)
  } catch (error) {
    console.log('\n这通常意味着：缺依赖、语法错、或顶层 await 抛错。')
    dumpError(error)
    return 1
  }

  // ③ 检查导出契约
  step('检查入口导出')
  if (typeof mod.apply !== 'function') {
    console.log(`${C.red}✗ 没有导出 apply(ctx, config) —— DSH 无法装载${C.reset}`)
    return 1
  }
  ok(`apply：${typeof mod.apply}`)
  ok(`name：${mod.name ?? '(未声明)'}`)
  ok(`inject：${JSON.stringify(mod.inject ?? [])}`)
  if (typeof mod.Config === 'undefined') {
    warn('没导出 Config —— 设置页不会有表单')
  }

  // ④ 解析 Config（与 DSH 一致：Config 是可调用对象，传用户值得到解析结果）
  step('解析 Config（等价于 Loader 的 config 解析）')
  let config
  try {
    const rawConfig = { enabled: true, debug: true }
    if (typeof mod.Config === 'function') {
      config = mod.Config(rawConfig)
      ok('Config 是可调用 schema，已按用户值解析')
    } else if (mod.Config?._meta?.type === 'object') {
      warn('Config 用的是兜底垫片（不是真 schemastery）—— 设置页会失效')
      config = rawConfig
    } else {
      warn('Config 形态未知，直接传原始对象')
      config = rawConfig
    }
    ok(`config 已就绪（${Object.keys(config ?? {}).length} 个顶层键）`)
  } catch (error) {
    console.log('\n这说明 Config Schema 本身有问题（比如某个字段声明非法）。')
    dumpError(error)
    return 1
  }

  // ⑤ 构造假 ctx 并调 apply
  step('构造假 ctx → 调 apply(ctx, config)')
  const ctx = makeCtx({
    services: {
      // 这几个是插件会主动 get 的：给最小实现，拿不到也算失败路径
      agentDefaultModel: {
        __label: 'fake agentDefaultModel',
        currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }),
      },
      // attachments / llm / systemPrompt / sessions 故意不给：插件应优雅降级
    },
  })
  let returned
  try {
    returned = mod.apply(ctx, config)
    ok('apply() 没有抛错')
    if (returned !== undefined) ok(`apply() 返回：${typeof returned}`)
  } catch (error) {
    console.log('\n这是 DSH 里那个红点的直接原因：apply 抛错 → 插件装载失败。')
    dumpError(error)
    console.log(`\n${C.dim}已发生的 ctx 调用（定位到哪一步崩的）：${C.reset}`)
    for (const call of ctx.calls.slice(-20)) console.log(`  ${call.kind}: ${call.detail}`)
    return 1
  }

  // ⑥ 触发事件（这一步最容易暴露异步错误 —— 它们不会让 apply 抛，但会进 unhandled rejection）
  const unhandled = []
  process.on('unhandledRejection', (reason) => { unhandled.push(reason) })

  step('触发 agent/created（qq-chat）')
  try {
    const { agent, registered, contexts } = makeAgent({ preset: 'qq-chat' })
    ctx.emit('agent/created', { agent, source: 'user' })
    await sleep(300)
    ok(`注册了 ${registered.length} 个工具${registered.length ? `：${registered.join(', ')}` : ''}`)
    ok(`注册了 ${contexts.length} 个提示词 context${contexts.length ? `：${contexts.join(', ')}` : ''}`)
    if (registered.length === 0) warn('工具一个都没注册上 —— 检查 agent/created 里的 preset 判定')
  } catch (error) {
    console.log('\nagent/created 处理抛错（在 DSH 里这会表现为"插件能装但工具不出现"）。')
    dumpError(error)
    return 1
  }

  step('触发 agent/created（非 qq-chat，应当什么都不注册）')
  try {
    const other = makeAgent({ preset: 'minimal', id: 'session-other' })
    ctx.emit('agent/created', { agent: other.agent, source: 'user' })
    await sleep(100)
    if (other.registered.length > 0) warn(`非目标 preset 竟然注册了 ${other.registered.length} 个工具 —— 作用域判定有问题`)
    else ok('非目标 preset 未注册任何工具（作用域正确）')
  } catch (error) {
    dumpError(error)
    return 1
  }

  step('触发 session/event（无图消息，只走会话窗口）')
  try {
    ctx.emit('session/event', { id: 'session-load-test' }, {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text: '装载自检' }], source: { kind: 'user' } } },
    })
    await sleep(100)
    ok('session/event 未抛错')
  } catch (error) {
    dumpError(error)
    return 1
  }

  // ⑦ 等异步初始化落地（库/state 读盘是 fire-and-forget）
  step('等异步初始化（300ms）')
  await sleep(300)
  if (returned?.runtime) {
    const runtime = returned.runtime
    ok(`runtime 已就绪：库 ${runtime.library?.size ?? '?'} 张`)
    ok(`数据目录：${runtime.dataDir}`)
  }

  // ⑧ unhandled rejection
  if (unhandled.length > 0) {
    console.log(`\n${C.red}${C.bold}✗ 有 ${unhandled.length} 个未处理的 Promise rejection${C.reset}`)
    for (const reason of unhandled) dumpError(reason)
    console.log('\nDSH 里这类错误往往就是"红点但看不到详情"的来源。')
    return 1
  }
  ok('没有未处理的 Promise rejection')

  // ⑨ 清理
  step('清理（模拟插件卸载）')
  for (const item of [...ctx.effects].reverse()) {
    try { item.dispose?.() } catch (error) {
      warn(`effect 清理抛错（${item.label}）：${error?.message ?? error}`)
    }
  }
  await sleep(50)

  banner('装载成功：没有发现错误')
  console.log('如果 DSH 里仍然是红点，那问题在**插件之外**，按下面顺序查：')
  console.log(`  1. ${C.cyan}dsh plugin --profile desktop list${C.reset} 看这一行是否真的 enabled`)
  console.log(`  2. 确认 ${C.cyan}~/.dsh/profiles/desktop/package.json${C.reset} 的 dsh.profile.bundles 里有 @local/dsh-qq-sticker`)
  console.log(`  3. 确认 profile 的 ${C.cyan}node_modules/@local/dsh-qq-sticker${C.reset} 是 link 到这个目录`)
  console.log('  4. 彻底退出 DSH 再启动（Host 侧代码不会热替换）')
  return 0
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ────────────────────────────────────────────────────────────── 真 Cordis 模式

/**
 * 找真 Cordis：插件自己的 node_modules 里通常没有它（DSH 从自己的模块图提供），
 * 所以按「显式指定 → 环境变量 → 常见位置」逐个试。
 *
 * @returns {Promise<{mod:object, from:string}|null>}
 */
async function importCordis() {
  const candidates = []
  const explicit = readArg('--cordis-dir') ?? process.env.DSH_CORDIS_DIR ?? process.env.QQG_DSH_MODULES
  if (explicit) candidates.push(explicit)
  // 本机常见位置：插件自己的 node_modules、DSH 安装、qq-guard 的离线测试依赖
  candidates.push(
    path.join(HERE, 'node_modules'),
    path.join(HERE, '..', 'node_modules'),
    path.join(HERE, '..', 'dsh-qq-bridge', 'node_modules'),
    'C:/Users/1/Documents/deepseek-harness/default-workspace/plugins/dsh-qq-guard/node_modules',
    'D:/DeepSeekHarness_workarea/Work/.recon/harness/node_modules',
  )
  for (const dir of candidates) {
    const base = path.join(dir, '@deepseek-ai', 'cordis', 'lib', 'index.js')
    try {
      const { existsSync } = await import('node:fs')
      if (!existsSync(base)) continue
      const mod = await import(pathToFileUrl(base))
      if (typeof mod?.Context === 'function') return { mod, from: dir }
    } catch { /* 继续试下一个 */ }
  }
  // 最后再试一次裸说明符（插件装在 profile 里时解得到）
  try {
    const mod = await import('@deepseek-ai/cordis')
    if (typeof mod?.Context === 'function') return { mod, from: '(bare specifier)' }
  } catch { /* 没有就算了 */ }
  return null
}

function pathToFileUrl(p) {
  return new URL(`file:///${String(p).replace(/\\/g, '/').replace(/^\/+/, '')}`).href
}

/** 读 `--key=value` 形式的参数。 */
function readArg(key) {
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(`${key}=`)) {
      const value = raw.slice(key.length + 1).trim()
      if (value) return value.replace(/^["']|["']$/g, '')
    }
  }
  return undefined
}

/**
 * 用真正的 Cordis 起一个最小运行时，把插件装进去。
 *
 * 为什么这条最值钱：真 Cordis 的 ctx 是 **Proxy**，读一个没写进 `inject`
 * 的服务属性会抛 `cannot get property "x" without inject` —— 而假 ctx 不会。
 * 2026-10-25 插件在 DSH 里 fiberPhase=failed 就是被 `ctx.timer` 这条绊倒的，
 * 假 ctx 测全绿、真机红点，差别就在这里。
 */
async function runWithRealCordis() {
  step('定位真 Cordis 与 schemastery')
  const cordis = await importCordis()
  if (!cordis) {
    warn('本机解析不到 @deepseek-ai/cordis')
    console.log('  → 插件目录里跑一次 `pnpm install`（它会把 schemastery 装上，但不装 cordis）')
    console.log('  → cordis 只在 DSH 自己的模块图里，所以要么：')
    console.log(`     ${C.cyan}node test-load.mjs --real-cordis --cordis-dir="<某个装了 @deepseek-ai/cordis 的 node_modules>"${C.reset}`)
    console.log(`     ${C.cyan}$env:DSH_CORDIS_DIR="<同上>" ; node test-load.mjs --real-cordis${C.reset}`)
    console.log('  → 或者先跑默认假 ctx 模式：node test-load.mjs')
    return 2
  }
  const { Context, Service } = cordis.mod
  ok(`@deepseek-ai/cordis 已加载（来自 ${cordis.from}）`)

  let Schema
  try {
    Schema = (await import('@deepseek-ai/schemastery')).default
    ok('@deepseek-ai/schemastery 已加载')
  } catch {
    warn('没有 schemastery，Config 解析会跳过（仍然能测 apply 阶段的 proxy 陷阱）')
  }

  step("import('./index.js')")
  let mod
  try {
    mod = await import('./index.js')
    ok(`import 成功：导出 ${Object.keys(mod).join(', ')}`)
  } catch (error) {
    dumpError(error)
    return 1
  }

  step('构造真 Cordis Context 并挂最小 tools 服务')
  const ctx = new Context()
  const registered = []
  try {
    // 用 Service 基类挂一个 tools 实现（与 DSH 同名同形）
    class FakeTools extends Service {
      constructor(c) { super(c, 'tools') }
      register(definition) {
        registered.push(definition?.name ?? '(unnamed)')
        return () => {
          const index = registered.indexOf(definition?.name)
          if (index >= 0) registered.splice(index, 1)
        }
      }
      schemas() { return [] }
      get(name) { return undefined }
      execute() { throw new Error('fake tools.execute') }
    }
    ctx.plugin(FakeTools)
    ok('tools 服务已注册')
  } catch (error) {
    dumpError(error)
    return 1
  }

  step('用真 Cordis 装载插件（ctx.plugin({ apply, Config, inject })）')
  try {
    const fiber = ctx.plugin({
      apply: mod.apply,
      Config: mod.Config,
      inject: mod.inject,
      name: mod.name,
    })
    await fiber
    ok('插件 fiber 已 active（装载成功）')
  } catch (error) {
    console.log('\n★ 这就是 DSH 里那个红点的真实原因（真 Cordis 复现）。')
    dumpError(error)
    return 1
  }

  await sleep(300)
  ok(`工具已注册 ${registered.length} 个${registered.length ? `：${registered.join(', ')}` : ''}`)
  if (registered.length === 0) {
    warn('工具一个都没注册 —— apply 成功但 agent/created 没触发（正常：要等 QQ 会话）')
  }
  if (!Schema) warn('跳过 Config 解析（没 schemastery）')

  step('卸载（dispose fiber）')
  try {
    await ctx.registry.delete(mod.apply)
  } catch { /* ignore */ }

  banner('真 Cordis 装载成功：没有发现错误')
  return 0
}

// 顶层兜底：任何没被捕获的异常也要打出来
process.on('uncaughtException', (error) => {
  console.log('\n未捕获异常（uncaughtException）：')
  dumpError(error)
  process.exit(1)
})

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    dumpError(error)
    process.exit(1)
  })
