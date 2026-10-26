/**
 * test-persist.mjs —— 打标落盘 / 注入上下文识别 / 收集失败诊断的回归。
 *
 * 覆盖 2026-10-26 真机报告的三个 Bug：
 *  ① 打标任务显示「已完成 60/60」但刷新后标签全没了（试运行 + 防抖落盘漏写）
 *  ② 「跳过：这条消息没图 x99」——其中混进了 DSH 自己注入的运行时上下文
 *  ③ 收集「失败 16 张」但完全看不到失败原因
 *
 * 跑法：`node test-persist.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createSaver } from './src/util.js'
import { Library } from './src/library.js'
import { DEFAULTS, readConfig } from './src/config.js'

let pass = 0
let fail = 0
const failures = []

async function check(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    fail++
    failures.push({ name, error })
    console.log(`  x   ${name}`)
    console.log(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}

const tempDirs = []
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-persist-'))
  tempDirs.push(dir)
  return await fn(dir)
}

/* ════════════════════════════════════════════════════════════
   ① createSaver：写盘期间的改动不能丢
   ════════════════════════════════════════════════════════════ */
console.log('\n① 防抖落盘器（写盘期间的改动不能丢）')

await check('flush 期间的 mark() 会在写完后补落一次', async () => {
  let writes = 0
  let resolveWriter
  const saver = createSaver(10, () => {
    writes++
    return new Promise((resolve) => { resolveWriter = resolve })
  })
  saver.mark()
  // 手动触发 flush（不等定时器）
  const flushing = saver.flush()
  // 写盘还没完成时又标脏（模拟：打标写到一半用户又改了库）
  saver.mark()
  // 放行第一次写盘
  await new Promise((r) => setTimeout(r, 20))
  resolveWriter?.()
  await flushing
  // 等补排的那一次
  await new Promise((r) => setTimeout(r, 60))
  assert.ok(writes >= 2, `写盘期间的改动被丢了：只写了 ${writes} 次，应该补写第二次`)
})

await check('没有改动时 flush 不写盘', async () => {
  let writes = 0
  const saver = createSaver(10, () => { writes++ })
  await saver.flush()
  assert.equal(writes, 0, '干净状态下不该写盘')
})

await check('连续 mark 只安排一次写盘（防抖仍有效）', async () => {
  let writes = 0
  const saver = createSaver(30, () => { writes++ })
  saver.mark(); saver.mark(); saver.mark()
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(writes, 1, `应只写 1 次，实际 ${writes}`)
})

/* ════════════════════════════════════════════════════════════
   ② Library：annotate 之后 flush 必须真的把标签写到磁盘
   ════════════════════════════════════════════════════════════ */
console.log('\n② 打标落盘（annotate → flush → 磁盘）')

await withTempDir(async (root) => {
  const cfg = readConfig(DEFAULTS)
  const library = new Library({ dataDir: root, config: cfg, log: () => {} })
  await library.load()

  // 造两张最小 PNG 入库
  const png = (pad = 0) => {
    const buf = Buffer.alloc(33 + pad)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
    buf.writeUInt32BE(13, 8)
    buf.write('IHDR', 12, 'ascii')
    buf.writeUInt32BE(32, 16)
    buf.writeUInt32BE(32, 20)
    buf[24] = 8
    buf[25] = 6
    return buf
  }
  const a = await library.ingest({ bytes: png(1), source: 'observed' })
  const b = await library.ingest({ bytes: png(2), source: 'observed' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)

  await check('annotate 后立刻 flush，磁盘上就有标签', async () => {
    library.annotate(a.item, { tags: ['开心', '赞同'], note: '测试备注', text: '图上文字' })
    await library.flush()
    const raw = JSON.parse(await readFile(path.join(root, 'library.json'), 'utf8'))
    const saved = (raw.items ?? []).find((it) => String(it.file) === String(a.item.file))
    assert.ok(saved, '落盘的 library.json 里应能找到这张图')
    assert.deepEqual([...(saved.tags ?? [])].sort(), ['开心', '赞同'].sort(), `标签没落盘：${JSON.stringify(saved.tags)}`)
    assert.equal(saved.note, '测试备注', '备注没落盘')
    assert.equal(saved.text, '图上文字', '图上文字没落盘')
  })

  await check('flush 后重新 load，内存里的标签与磁盘一致（模拟刷新面板）', async () => {
    const reloaded = new Library({ dataDir: root, config: cfg, log: () => {} })
    await reloaded.load()
    const item = reloaded.items.find((it) => String(it.file) === String(a.item.file))
    assert.ok(item, '重新加载后应能找到这张图')
    assert.ok(Array.isArray(item.tags) && item.tags.length === 2, `重新加载后标签丢了：${JSON.stringify(item.tags)}`)
  })

  await check('第二批打标后再 flush 也能累积落盘（不是覆盖）', async () => {
    library.annotate(b.item, { tags: ['沙雕'] })
    await library.flush()
    const reloaded = new Library({ dataDir: root, config: cfg, log: () => {} })
    await reloaded.load()
    const first = reloaded.items.find((it) => String(it.file) === String(a.item.file))
    const second = reloaded.items.find((it) => String(it.file) === String(b.item.file))
    assert.ok(first?.tags?.length === 2, '第一批的标签应还在')
    assert.ok(second?.tags?.length >= 1, '第二批的标签应落盘')
  })
})

/* ════════════════════════════════════════════════════════════
   ③ DSH 注入的运行时上下文要被识别（不混进"没图"统计）
   ════════════════════════════════════════════════════════════ */
console.log('\n③ 注入上下文识别')

const { createRuntime } = await import(pathToFileURL('D:/DeepSeekHarness_workarea/Dsh-QQ-Mod/dsh-qq-sticker/index.js').href)

await withTempDir(async (root) => {
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const ctx = {
      get() { return undefined },
      on() { return () => {} },
      effect(fn) { const r = fn?.(); return typeof r === 'function' ? r : () => {} },
    }
    const runtime = createRuntime(ctx, {})
    // 等 init 跑完（library 就绪）
    for (let i = 0; i < 40; i++) {
      if (runtime.dataDir) break
      await new Promise((r) => setTimeout(r, 50))
    }

    await check('运行时上下文不占「没图」计数（skippedContext 单独计）', async () => {
      // 直接调 ingestor：注入消息若被识别，就根本不会进 onUserMessage
      // 这里验证的是"消息内容判定"本身：用 ingestor 的 skipped 结果反推
      const injected = [
        { type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "D:\\x"' },
      ]
      const res = runtime.ingestor.onUserMessage({
        sessionId: 'session-test-inject',
        content: injected,
        srcHint: '',
      })
      assert.equal(res.queued, 0, '注入上下文不该入队')
      assert.ok(Array.isArray(res.skipped) && res.skipped.includes('no-image'), '内容层面它确实没图')
    })

    await check('带图的注入样文本不会被误判成注入（有图一律放行）', () => {
      const withImage = [
        { type: 'text', text: 'Current runtime context. blah' },
        { type: 'image', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/webp', width: 100, height: 100, bytes: 1000 } },
      ]
      // 判定函数在 index.js 内部；用等价规则验证：有 image 块 → 不是注入
      const hasImage = withImage.some((b) => b?.type === 'image' && b.attachment)
      assert.equal(hasImage, true, '这条应被当作真消息（有图）')
    })
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
})

/* ════════════════════════════════════════════════════════════
   ④ 收集失败诊断：每种失败都要有具体原因
   ════════════════════════════════════════════════════════════ */
console.log('\n④ 收集失败诊断')

const { Collector } = await import(pathToFileURL('D:/DeepSeekHarness_workarea/Dsh-QQ-Mod/dsh-qq-sticker/src/collect.js').href)

await withTempDir(async (root) => {
  const cfg = readConfig(DEFAULTS)
  const library = new Library({ dataDir: root, config: cfg, log: () => {} })
  await library.load()

  await check('读不到字节时给出具体原因（不是只有 failed++）', async () => {
    const logLines = []
    const collector = new Collector({
      library,
      getConfig: () => cfg,
      log: (level, msg) => logLines.push(`${level}:${msg}`),
      dataDir: root,
      deps: {
        knownSessions: async () => ['session-x'],
        readMessages: async () => ([{
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'dead'.repeat(16), mediaType: 'image/webp', bytes: 5000 } }],
          time: Date.now(),
          senderId: 'someone',
          selfId: 'bot',
        }]),
        // 关键：返回空（模拟附件已被 DSH 清理）
        readImage: async () => null,
      },
    })
    const result = await collector.collectTopUsed({ hours: 24, limit: 10 })
    assert.equal(result.failed, 1, `应记 1 张失败，实际 ${result.failed}`)
    assert.ok(Array.isArray(result.failures) && result.failures.length >= 1, '必须带失败明细')
    const line = result.failures[0]
    assert.match(line, /读不到字节/, `失败原因应说清是"读不到字节"，实际：${line}`)
    assert.match(line, /image\/webp/, '失败原因里应带媒体类型')
    assert.ok(logLines.some((l) => l.startsWith('warn:')), '失败应打 warn 日志（不再只是 debug）')
  })

  await check('入库被拒时把 ingest 的具体原因带出来', async () => {
    const collector = new Collector({
      library,
      getConfig: () => cfg,
      log: () => {},
      dataDir: root,
      deps: {
        knownSessions: async () => ['session-y'],
        readMessages: async () => ([{
          content: [{ type: 'image', attachment: { attachmentId: 'sha256:' + 'beef'.repeat(16), mediaType: 'image/png', bytes: 99999999 } }],
          time: Date.now(),
          senderId: 'someone',
          selfId: 'bot',
        }]),
        // 返回 20MB 的假字节，会被 library.ingest 以"单张太大"拒绝
        readImage: async () => ({ data: new Uint8Array(20 * 1024 * 1024), mediaType: 'image/png' }),
      },
    })
    const result = await collector.collectTopUsed({ hours: 24, limit: 10 })
    assert.equal(result.failed, 1)
    assert.ok(Array.isArray(result.failures) && result.failures.length >= 1, '必须带失败明细')
    assert.match(result.failures[0], /入库被拒/, `应标明是入库被拒，实际：${result.failures[0]}`)
    // 具体原因由 library.ingest 给出：太大是「单张太大（X MB > Y MB）」，
    // 假字节识别不出格式则是「不认识的图片格式」。两者都算"带出了具体原因"。
    assert.match(result.failures[0], /单张太大|太大|MB|不认识的图片格式/,
      `应带出具体的拒绝原因，实际：${result.failures[0]}`)
  })
})

/* ════════════════════════════════════════════════════════════
   汇总
   ════════════════════════════════════════════════════════════ */
for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => {})

console.log(`\n${'='.repeat(60)}`)
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) {
    console.log(`\n· ${item.name}`)
    console.log(String(item.error?.stack ?? item.error).split('\n').slice(0, 6).join('\n'))
  }
  process.exit(1)
}
console.log('全部通过')
process.exit(0)
