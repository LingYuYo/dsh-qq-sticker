/**
 * test-gif.mjs —— GIF / 动图链路的专项回归（离线、不碰真 DSH）。
 *
 * 覆盖这次修复的三个要点：
 *  ① **收集**：GIF 无视尺寸与字节限制，强制入表情包库；
 *     普通图的上限从 640px/1.5MB 放宽到 1920px/10MB（误杀修复）。
 *  ② **原始图池**：桥接转交的未转码字节能被收下、取出、按 token 对上 image 块，
 *     并且有 TTL 与路径穿越防护。这是 GIF 动画能留住的唯一通道 ——
 *     DSH 附件服务会把 GIF 重编码成单帧 webp/jpeg。
 *  ③ **发送**：qq_send_image 调用带 subType（1 = 表情），配置关掉时带 0。
 *
 * 跑法：`node test-gif.mjs`
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { DEFAULTS, readConfig } from './src/config.js'
import { isLikelySticker } from './src/ingest.js'
import { looksLikeSticker } from './src/proactive.js'
import { Library } from './src/library.js'
import { RawImageStore } from './src/rawstore.js'

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qq-sticker-gif-'))
  tempDirs.push(dir)
  return await fn(dir)
}

/** 最小合法 GIF89a（含 1 帧 GCE + 循环块；足够 sniff 认成 image/gif）。 */
function makeGif(width = 86, height = 86, padBytes = 0) {
  const header = Buffer.from('GIF89a', 'ascii')
  const body = Buffer.alloc(32 + padBytes)
  body.writeUInt16LE(width, 0)
  body.writeUInt16LE(height, 2)
  // Graphic Control Extension
  Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00]).copy(body, 4)
  // NETSCAPE2.0 循环块
  Buffer.from([0x21, 0xff, 0x0b]).copy(body, 11)
  Buffer.from('NETSCAPE2.0', 'ascii').copy(body, 14)
  Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]).copy(body, 25)
  // trailer
  body[32 + padBytes - 1] = 0x3b
  return Buffer.concat([header, body])
}

/** 最小合法 PNG（尺寸可控）。 */
function makePng(width = 32, height = 32, pad = 0) {
  const buf = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8
  buf[25] = 6
  return buf
}

/* ════════════════════════════════════════════════════════════
   ① 收集期过滤：GIF 永不拒绝，普通图放宽到 1920px / 10MB
   ════════════════════════════════════════════════════════════ */
console.log('\n① 收集期过滤')

await check('GIF 即便超大也算表情（不受尺寸/字节限制）', () => {
  const cfg = readConfig(DEFAULTS)
  const huge = isLikelySticker({ mediaType: 'image/gif', width: 4096, height: 4096, bytes: 30 * 1024 * 1024 }, cfg)
  assert.equal(huge, true, 'GIF 应该无视尺寸与字节限制')
})

await check('默认限制已放宽：1920px / 10MB 以内算表情', () => {
  const cfg = readConfig(DEFAULTS)
  assert.equal(cfg.collect.stickerMaxDim, 1920, '默认最大边长应为 1920')
  assert.equal(cfg.collect.stickerMaxBytes, 10485760, '默认最大字节应为 10MB')
  // 以前 640px / 1.5MB 会把这种图误杀掉
  assert.equal(isLikelySticker({ mediaType: 'image/png', width: 1800, height: 1700, bytes: 5 * 1024 * 1024 }, cfg), true)
  // 真照片（超 1920）仍然排除
  assert.equal(isLikelySticker({ mediaType: 'image/png', width: 4000, height: 3000, bytes: 8 * 1024 * 1024 }, cfg), false)
})

await check('发送期过滤也认 GIF（looksLikeSticker）', () => {
  const cfg = readConfig(DEFAULTS)
  assert.equal(looksLikeSticker({ ext: 'gif', width: 4096, height: 4096, bytes: 40 * 1024 * 1024 }, cfg), true)
  assert.equal(looksLikeSticker({ ext: 'png', width: 1800, height: 1800, bytes: 8 * 1024 * 1024 }, cfg), true)
})

/* ════════════════════════════════════════════════════════════
   ② 入库：GIF 的字节/尺寸限制
   ════════════════════════════════════════════════════════════ */
console.log('\n② 入库')

await withTempDir(async (root) => {
  const log = () => {}
  const library = new Library({ dataDir: root, config: readConfig(DEFAULTS), log })

  await check('GIF 能入库，且 animated 标记为 true', async () => {
    const gif = makeGif(86, 86)
    const result = await library.ingest({ bytes: gif, source: 'observed' })
    assert.equal(result.ok, true, `入库失败：${result.reason}`)
    assert.equal(result.item.ext, 'gif')
    assert.equal(result.item.animated, true, 'GIF 应标记为动图')
    assert.equal(result.item.width, 86)
    assert.equal(result.item.height, 86)
    // 落盘文件头确实是 GIF
    const onDisk = await readFile(result.item.path)
    assert.equal(onDisk.subarray(0, 6).toString('ascii'), 'GIF89a')
  })

  await check('GIF 超过 maxItemMB 也照样入库（放宽到硬顶 12MB）', async () => {
    const cfg = readConfig({ ...DEFAULTS, library: { ...DEFAULTS.library, maxItemMB: 2 } })
    const small = new Library({ dataDir: path.join(root, 'lib2'), config: cfg, log })
    // 3MB 的 GIF：maxItemMB=2 时普通图会被拒，GIF 应该放行
    const big = makeGif(86, 86, 3 * 1024 * 1024)
    const result = await small.ingest({ bytes: big, source: 'observed' })
    assert.equal(result.ok, true, `GIF 应绕过 maxItemMB：${result.reason}`)
  })

  await check('普通图仍然受 maxItemMB 限制', async () => {
    const cfg = readConfig({ ...DEFAULTS, library: { ...DEFAULTS.library, maxItemMB: 1 } })
    const small = new Library({ dataDir: path.join(root, 'lib3'), config: cfg, log })
    const big = makePng(64, 64, 2 * 1024 * 1024)
    const result = await small.ingest({ bytes: big, source: 'observed' })
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /单张太大/)
  })
})

/* ════════════════════════════════════════════════════════════
   ③ 原始图池
   ════════════════════════════════════════════════════════════ */
console.log('\n③ 原始图池（GIF 动画保真的唯一通道）')

await withTempDir(async (root) => {
  const store = new RawImageStore({ dir: path.join(root, 'raw') })
  await store.load()

  await check('put / take 往返：字节与媒体类型一致', async () => {
    const gif = makeGif(86, 86)
    const put = await store.put({
      token: 'abcdefgh12345678',
      mediaType: 'image/gif',
      dataB64: gif.toString('base64'),
    })
    assert.equal(put.ok, true, `put 失败：${put.reason}`)
    assert.equal(put.bytes, gif.length)
    const got = await store.take('abcdefgh12345678')
    assert.ok(got, 'take 应取回条目')
    assert.equal(got.mediaType, 'image/gif')
    assert.equal(Buffer.from(got.data).subarray(0, 6).toString('ascii'), 'GIF89a', '取回的后缀/内容应仍是 GIF')
  })

  await check('token 不合规一律拒绝（防路径穿越）', async () => {
    for (const bad of ['../../etc/passwd', 'abc', 'a'.repeat(70), 'abc/defghijk', 'abc def ghijk']) {
      const result = await store.put({ token: bad, mediaType: 'image/gif', dataB64: 'R0lGODlh' })
      assert.equal(result.ok, false, `token "${bad}" 不该被接受`)
    }
  })

  await check('不支持的媒体类型被拒（只收 gif/png/jpeg/webp）', async () => {
    const result = await store.put({ token: 'abcdefgh12345678', mediaType: 'image/tiff', dataB64: 'AAAA' })
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /不支持/)
  })

  await check('文本里的 [[qqimg:token]] 能按顺序解析与剥离', () => {
    const text = '看这张 [[qqimg:token0001abcd]] 还有 [[qqimg:token0002efgh]] 完毕'
    const tokens = RawImageStore.tokensInText(text)
    assert.deepEqual(tokens, ['token0001abcd', 'token0002efgh'])
    assert.equal(RawImageStore.stripTokens(text).includes('[[qqimg:'), false, '剥离后不该残留标记')
    assert.equal(RawImageStore.stripTokens(text), '看这张 还有 完毕')
  })

  await check('过期的条目取不出来（TTL）', async () => {
    const shortLived = new RawImageStore({ dir: path.join(root, 'raw2'), ttlMs: 60_000 })
    await shortLived.load()
    await shortLived.put({ token: 'expire0000001', mediaType: 'image/gif', dataB64: makeGif().toString('base64') })
    assert.ok(await shortLived.take('expire0000001'), '刚写入应可取')
    // 手动把时间戳推到过去（等价于等 10 分钟）
    const entry = shortLived._index.get('expire0000001')
    entry.at = Date.now() - 61_000
    assert.equal(await shortLived.take('expire0000001'), null, '过期后不该再取出来')
  })

  await check('stats 报出张数与字节', async () => {
    const stats = store.stats()
    assert.ok(stats.count >= 1)
    assert.ok(stats.bytes > 0)
  })
})

/* ════════════════════════════════════════════════════════════
   ④ 配置：发送位置与 subType
   ════════════════════════════════════════════════════════════ */
console.log('\n④ 配置（发送位置 / sub_type）')

await check('默认 imagePosition=after、subType=1', () => {
  const cfg = readConfig(DEFAULTS)
  assert.equal(cfg.send.imagePosition, 'after')
  assert.equal(cfg.send.subType, 1)
})

await check('imagePosition 非法值回落为 after', () => {
  const cfg = readConfig({ ...DEFAULTS, send: { ...DEFAULTS.send, imagePosition: 'whatever' } })
  assert.equal(cfg.send.imagePosition, 'after')
})

await check('sendAsSticker=false 时 subType 强制为 0（普通大图）', () => {
  const cfg = readConfig({ ...DEFAULTS, send: { ...DEFAULTS.send, sendAsSticker: false, subType: 1 } })
  assert.equal(cfg.send.subType, 0)
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
