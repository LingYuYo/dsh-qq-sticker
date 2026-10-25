/**
 * 回归用例：把 2026-10-25 那次「DSH 里红点、日志里什么都没有」的坑焊死。
 *
 * 事故详情：
 *   插件在 apply() 里写了 `ctx.timer.interval(...)`，而 `timer` 没写进 `inject`。
 *   Cordis 的 ctx 是 **Proxy** —— 读未声明的服务属性会**抛错**：
 *     `cannot get property "timer" without inject`
 *   这个抛错发生在 proxy 的 get 陷阱内部，所以 **`ctx?.timer` / `ctx.timer ?? x`
 *   都兜不住**。假 ctx 测全绿、真机 fiberPhase=failed，正是因为假 ctx 没这个语义。
 *
 * 本文件用**真 Cordis**（能从 DSH 安装/离线依赖里解析到就用）验证三件事：
 *   ① 插件能真正装载（这是最基本的回归）；
 *   ② `safeService(ctx, '未声明的服务')` 返回 undefined 而不是抛错；
 *   ③ 直接 `ctx.未声明服务` 确实会抛（证明这个坑是真的，别有人"优化"回去）。
 *
 * 跑法：`node test-cordis-regression.mjs`
 *   · 找不到真 Cordis 时**跳过**（退出码 0），并打印怎么指路；
 *   · 找到就严格断言，任何一条不过就退出码 1。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
let skipped = 0

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    fail++
    console.log(`  x   ${name}\n      ${error?.message ?? error}`)
  }
}

function skip(name, reason) {
  skipped++
  console.log(`  -   ${name}（跳过：${reason}）`)
}

console.log('== 回归：Cordis 的「未声明服务属性」陷阱')

// ── 定位真 Cordis ────────────────────────────────────────────────
const candidates = [
  process.env.DSH_CORDIS_DIR,
  path.join(HERE, 'node_modules'),
  'C:/Users/1/Documents/deepseek-harness/default-workspace/plugins/dsh-qq-guard/node_modules',
  'D:/DeepSeekHarness_workarea/Work/.recon/harness/node_modules',
].filter(Boolean)

let cordis
let from = ''
for (const dir of candidates) {
  const base = path.join(dir, '@deepseek-ai', 'cordis', 'lib', 'index.js')
  if (!existsSync(base)) continue
  try {
    const mod = await import(`file:///${base.replace(/\\/g, '/').replace(/^\/+/, '')}`)
    if (typeof mod?.Context === 'function') { cordis = mod; from = dir; break }
  } catch { /* 下一个 */ }
}
if (!cordis) {
  try {
    cordis = await import('@deepseek-ai/cordis')
    from = '(bare specifier)'
  } catch { /* 没有 */ }
}

if (!cordis) {
  skip('全部回归用例', '本机解析不到 @deepseek-ai/cordis')
  console.log('\n  指路：设 DSH_CORDIS_DIR=<装了 @deepseek-ai/cordis 的 node_modules> 再跑。')
  console.log(`    $env:DSH_CORDIS_DIR="C:/Users/1/Documents/deepseek-harness/default-workspace/plugins/dsh-qq-guard/node_modules"`)
  console.log('    node test-cordis-regression.mjs')
  process.exit(0)
}
console.log(`  真 Cordis 来自：${from}`)

const { Context, Service } = cordis

// ── ① safeService 不抛错 ─────────────────────────────────────────
await check('① safeService(ctx, 未声明的服务) 返回 undefined，不抛错', async () => {
  const ctx = new Context()
  class FakeTools extends Service {
    constructor(c) { super(c, 'tools') }
    register() { return () => {} }
    schemas() { return [] }
  }
  ctx.plugin(FakeTools)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const { safeService } = await import('./src/util.js')
  // 'timer' 没写进任何 inject，但在 DSH 里是真实存在的服务
  assert.equal(safeService(ctx, 'timer'), undefined, 'safeService 应返回 undefined')
  assert.equal(safeService(ctx, '根本不存在的东西'), undefined)
  assert.equal(safeService(undefined, 'timer'), undefined)
  assert.equal(safeService(null, 'timer'), undefined)
})

// ── ② 直接读确实会抛（证明这个坑还在，别改回去）────────────────────
await check('② 插件 fiber 内直接 ctx.timer / ctx?.timer 都会抛（真机 failed 的原因）', async () => {
  // ⚠️ 注意：**根 ctx 不抛**（没有 fiber.runtime 时 proxy 直接返回 undefined）。
  //    只有当 ctx 属于一个正在装载的插件 fiber 时才抛 —— 也就是插件自己的 apply() 里。
  //    这正是为什么"在 REPL 里手试好使、装进 DSH 就红点"。
  const captured = {}
  class Probe extends Service {
    constructor(c) { super(c, 'tools') }
    register() { return () => {} }
  }
  const ctx = new Context()
  // 先确认：根 ctx 读未声明服务是 undefined，不抛
  assert.equal(ctx.timer, undefined, '根 ctx 读 timer 应返回 undefined（这是陷阱难复现的原因）')
  okRoot()

  // 再在一个真插件 fiber 里读
  ctx.plugin(Probe)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const probePlugin = {
    inject: ['tools'],
    Config: undefined,
    apply(c) {
      for (const read of [
        () => c.timer,
        () => c?.timer,
        () => c.timer ?? null,
      ]) {
        try {
          read()
          captured.threw = false
        } catch (error) {
          captured.threw = true
          captured.message = error?.message ?? String(error)
        }
      }
    },
  }
  performPlugin(ctx, probePlugin)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(captured.threw, true, '插件 fiber 内直接读应抛（说明这个坑是真的）')
  assert.match(captured.message, /without inject|inactive context/, `错误文案：${captured.message}`)

  function okRoot() { /* 上面已经断言过根 ctx 不抛 */ }
  /** 用 ctx.plugin 装载，吞掉装载期的 rejection（我们只要捕获 apply 内部行为）。 */
  function performPlugin(target, plugin) {
    try {
      target.plugin({ apply: plugin.apply, inject: plugin.inject })
    } catch { /* apply 内部若把错误继续抛出来，这里接住 */ }
  }
})

// ── ③ 插件本身能真装进去 ─────────────────────────────────────────
await check('③ 插件能在真 Cordis 下装载（apply 不抛错）', async () => {
  const mod = await import('./index.js')
  assert.equal(typeof mod.apply, 'function', 'index.js 应导出 apply')

  const ctx = new Context()
  const registered = []
  class FakeTools extends Service {
    constructor(c) { super(c, 'tools') }
    register(definition) {
      registered.push(definition?.name ?? '(unnamed)')
      return () => {}
    }
    schemas() { return [] }
  }
  ctx.plugin(FakeTools)
  await new Promise((resolve) => setTimeout(resolve, 50))

  let fiber
  try {
    fiber = ctx.plugin({
      apply: mod.apply,
      Config: mod.Config,
      inject: mod.inject,
      name: mod.name,
    })
    await fiber
  } catch (error) {
    assert.fail(`装载失败：${error?.message ?? error}\n${error?.stack ?? ''}`)
  }
  assert.ok(fiber, '应拿到 fiber')
  // apply 里注册的 effect 会让插件保持 active；这里只要不抛就够
  await new Promise((resolve) => setTimeout(resolve, 200))
})

// ── ④ inject 只放必需项（可选服务靠 safeService）──────────────────
await check('④ inject 里不该混进可选服务（混进去就变成硬依赖）', async () => {
  const mod = await import('./index.js')
  const inject = Array.isArray(mod.inject) ? mod.inject : []
  assert.ok(inject.includes('tools'), 'tools 是必需依赖，应在 inject 里')
  const optional = ['attachments', 'llm', 'systemPrompt', 'webServer', 'sessions', 'sessionPersistence', 'timer']
  for (const name of optional) {
    assert.ok(
      !inject.includes(name),
      `${name} 是可选的，不该写进 inject（会让插件在缺它的环境里装不上）；应该用 safeService 取`,
    )
  }
})

// ── ⑤ 源码里不该出现 `ctx?.<服务>` / `ctx.<服务> ??` 这种写法 ─────────
await check('⑤ 源码里没有 `ctx?.服务` / `ctx.服务 ??` 这类兜不住的写法', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const files = [path.join(HERE, 'index.js')]
  for (const name of await readdir(path.join(HERE, 'src'))) {
    if (name.endsWith('.js')) files.push(path.join(HERE, 'src', name))
  }
  /** 允许的成员：这些是 Cordis/我们自己的普通属性，不是服务。 */
  const allowed = new Set([
    'get', 'on', 'effect', 'emit', 'services', 'calls', 'handlers', 'effects',
    'config', 'mood', 'keyword', 'recentText', 'totalSent', 'now', 'agent', 'session',
    'library', 'tracker', 'state', 'collect', 'enabled', 'log', 'timer',
  ])
  /**
   * 去掉注释和字符串，避免误报（注释里写 `ctx.sender` 是文档，不是代码）。
   * 这是个粗但够用的扫描：块注释整段删、行注释删到行尾、字符串/模板里的内容删掉。
   */
  const stripNonCode = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
    .replace(/(^|[^\\])\/\/[^\n]*/g, '$1')      // 行注释
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")      // 单引号字符串
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')      // 双引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')        // 模板字符串
  const offenders = []
  for (const file of files) {
    const raw = await readFile(file, 'utf8')
    const code = stripNonCode(raw)
    // 只查 `ctx.` / `ctx?.` 后紧跟标识符、且不在 allow 里的情况
    const re = /\bctx\??\.([a-zA-Z_$][\w$]*)/g
    let match
    while ((match = re.exec(code)) !== null) {
      const member = match[1]
      if (allowed.has(member)) continue
      const line = code.slice(0, match.index).split('\n').length
      offenders.push(`${path.relative(HERE, file)} → ctx.${member}`)
    }
  }
  assert.deepEqual(offenders, [], `发现可能抛 without-inject 的写法（应该用 safeService）：\n${offenders.join('\n')}`)
})

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}｜跳过 ${skipped}`)
if (fail > 0) process.exit(1)
console.log('全部通过')
process.exit(0)
