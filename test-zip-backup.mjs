/**
 * 模块四离线用例：zip + backup。不联网、不起 DSH。
 *
 * 跑：`node test-zip-backup.mjs`
 *
 * 覆盖（都走真 zlib / 真文件系统）：
 *  1. createZip → extractZip 往返（store / deflate、空文件、空归档、大文件）；
 *  2. ZIP 结构：listZip 的 name/size/crc、路径分隔符统一 `/`、中文名 UTF-8 标志位；
 *  3. **真实解压验证**：PowerShell `Expand-Archive` 与 `tar -xf` 各解一遍，逐字节比对；
 *  4. Backup：假库备份后 zip 里有 library.json + 全部 images；
 *  5. keep 保留份数、并发 busy、brief 下次时间、定时到点触发、单文件失败只 warn。
 *
 * 注意：真实解压不是为了「自证」，而是因为 extractZip 与 createZip 是同一套手写
 * 逻辑，自己解自己永远说明不了格式对不对 —— 必须有第三方解压器背书。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { createZip, extractZip, listZip, normalizeZipName } from './src/zip.js'
import { Backup, BACKUP_DEFAULTS, computeNextRunAt, parseAtMinute } from './src/backup.js'

const execFileAsync = promisify(execFile)

let pass = 0
let fail = 0
const failures = []
/** 真实解压验证的日志，最后整段打出来，方便贴报告。 */
const realLogs = []

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

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-qq-sticker-zip-'))
  try { return await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}

/** 可复现的伪随机字节（同 seed 同一份，比对时不用存原值）。 */
function pseudoBytes(size, seed = 1) {
  const buf = Buffer.alloc(size)
  let state = seed >>> 0
  for (let i = 0; i < size; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    buf[i] = (state >>> 16) & 0xff
  }
  return buf
}

/** 找可用的系统解压器：PowerShell Expand-Archive / Windows 自带 bsdtar。 */
async function detectExtractors() {
  const out = []
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Command Expand-Archive -ErrorAction Stop).Name'], { encoding: 'utf8' })
    if (stdout.includes('Expand-Archive')) out.push('powershell')
  } catch { /* 没有 PowerShell 就跳过 */ }
  try {
    // 必须用 Windows 自带的 bsdtar（libarchive）：它认 UTF-8 标志位。
    // Git/MSYS 里那个是 GNU tar，根本读不了 zip；Info-ZIP unzip 6.00 又忽略 0x0800。
    const { stdout } = await execFileAsync(BSD_TAR, ['--version'], { encoding: 'utf8' })
    if (/bsdtar|libarchive/i.test(stdout)) out.push('bsdtar')
  } catch { /* 没有 bsdtar 就跳过 */ }
  return out
}

/** Windows 自带的 bsdtar（libarchive）。 */
const BSD_TAR = 'C:\\Windows\\System32\\tar.exe'

/**
 * 用系统解压器解 zip 到 dir，返回解压目录。
 * PowerShell 走 `Expand-Archive -Force`，bsdtar 走 `tar -xf`。
 * bsdtar 用 `cwd` + 相对路径调用，避开 `C:` 被当成远程主机名（GNU tar 的老毛病）。
 */
async function extractWithSystem(kind, zipPath, destDir) {
  await mkdir(destDir, { recursive: true })
  if (kind === 'powershell') {
    const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' `
      + `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    const { stdout, stderr } = await execFileAsync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8' })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }
  const cwd = path.dirname(zipPath)
  const { stdout, stderr } = await execFileAsync(BSD_TAR,
    ['-xf', path.basename(zipPath), '-C', destDir], { encoding: 'utf8', cwd })
  return { stdout: (stdout ?? '').trim(), stderr: (stderr ?? '').trim() }
}

/** 递归列出目录下所有文件（相对路径，`/` 分隔，排序）。 */
async function walkFiles(dir, base = dir) {
  const out = []
  let names = []
  try { names = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of names) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(full, base))
    else if (entry.isFile()) out.push(path.relative(base, full).replace(/\\/g, '/'))
  }
  return out.sort()
}

/**
 * 真实解压 + 逐字节比对。
 * @returns {{ kind:string, extracted:number, log:string }}
 */
async function verifyWithSystemExtractor(kind, buffer, expected, label) {
  return withTempDir(async (dir) => {
    const zipPath = path.join(dir, 'probe.zip')
    await writeFile(zipPath, buffer)
    const dest = path.join(dir, 'out')
    const run = await extractWithSystem(kind, zipPath, dest)
    const files = await walkFiles(dest)
    const want = expected.map((entry) => entry.name).sort()
    assert.deepEqual(files, want, `${kind} 解出的文件清单不一致`)
    for (const entry of expected) {
      const got = await readFile(path.join(dest, ...entry.name.split('/')))
      assert.equal(Buffer.compare(got, entry.data), 0, `${kind} 解出的 ${entry.name} 内容不一致`)
    }
    // 归档里声明的原大小 / CRC 也核一遍（tar 与 PS 都不显示这些，由 listZip 提供）
    const listed = listZip(buffer)
    const log = `[${kind}] ${label}：解出 ${files.length} 个文件，全部逐字节一致；`
      + ` zip=${buffer.length}B，条目=${listed.map((e) => `${e.name}(${e.method},${e.size}B,crc=${e.crc >>> 0})`).join(' ')}`
      + `；${kind === 'powershell' ? `stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}` : `bsdtar stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`}`
    realLogs.push(log)
    console.log(`  · ${log}`)
    return { kind, extracted: files.length, log }
  })
}

/** 造一个假库：library.json / state.json / schedule.json / images/*。 */
async function makeFakeLibrary(dir) {
  await mkdir(path.join(dir, 'images'), { recursive: true })
  await writeFile(path.join(dir, 'library.json'), `${JSON.stringify({ version: 1, items: [{ file: 'aaa.png' }] }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(dir, 'state.json'), `${JSON.stringify({ day: '2026-10-25', sent: 3 }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(dir, 'schedule.json'), `${JSON.stringify({ nextRunAt: 0 }, null, 2)}\n`, 'utf8')
  const images = [
    ['aaa.png', pseudoBytes(512, 1)],
    ['bbb.jpg', pseudoBytes(2048, 2)],
    ['ccc.gif', pseudoBytes(64, 3)],
  ]
  for (const [name, data] of images) await writeFile(path.join(dir, 'images', name), data)
  return images
}

/** 测试用配置（只关心 backup 段；默认 enabled=true，便于跑 runNow）。 */
function cfgOf(backup = {}) {
  return { enabled: true, backup: { ...BACKUP_DEFAULTS, enabled: true, ...backup } }
}

// ───────────────────────────────────────────────────────────── 1. ZIP 往返

await group('Zip / 往返', async () => {
  const samples = [
    { name: 'a.txt', data: Buffer.from('hello zip\n', 'utf8') },
    { name: 'images/pic.jpg', data: pseudoBytes(4096, 7) },
    { name: 'empty.bin', data: Buffer.alloc(0) },
  ]

  await check('store 模式：createZip → extractZip 逐条一致', async () => {
    const buffer = await createZip(samples)
    const out = await extractZip(buffer)
    assert.equal(out.length, 3)
    for (let i = 0; i < samples.length; i++) {
      assert.equal(out[i].name, samples[i].name)
      assert.equal(Buffer.compare(out[i].data, samples[i].data), 0)
    }
    // store 模式的 compression 必须是 0
    assert.deepEqual(listZip(buffer).map((e) => e.compression), [0, 0, 0])
  })

  await check('deflate 模式：大文件往返一致且比原文件小', async () => {
    const big = { name: 'images/big.bin', data: Buffer.alloc(256 * 1024, 0x41) }
    const buffer = await createZip([big], { deflate: true })
    const listed = listZip(buffer)
    assert.equal(listed[0].compression, 8)
    assert.ok(listed[0].compressedSize < big.data.length, '重复字节应被压小')
    const out = await extractZip(buffer)
    assert.equal(Buffer.compare(out[0].data, big.data), 0)
  })

  await check('deflate 模式对随机数据自动退回 store（压不动不硬压）', async () => {
    const random = { name: 'rand.bin', data: pseudoBytes(64 * 1024, 99) }
    const buffer = await createZip([random], { deflate: true })
    const listed = listZip(buffer)
    // 随机数据 deflate 后必然更大 → 本实现退回 store
    assert.equal(listed[0].compression, 0)
    assert.equal(listed[0].size, random.data.length)
    const out = await extractZip(buffer)
    assert.equal(Buffer.compare(out[0].data, random.data), 0)
  })

  await check('大文件（>1MB 随机）往返一致', async () => {
    const data = pseudoBytes(1024 * 1024 + 12345, 5)
    for (const deflate of [false, true]) {
      const out = await extractZip(await createZip([{ name: 'big.bin', data }], { deflate }))
      assert.equal(out[0].data.length, data.length)
      assert.equal(Buffer.compare(out[0].data, data), 0, `deflate=${deflate} 往返不一致`)
    }
  })

  await check('空 ZIP（0 个 entry）不崩：生成/列出/解压都是空', async () => {
    const buffer = await createZip([])
    assert.equal(buffer.length, 22, '只有 EOCD')
    assert.equal(buffer.readUInt32LE(0), 0x06054b50)
    assert.deepEqual(listZip(buffer), [])
    assert.deepEqual(await extractZip(buffer), [])
  })

  await check('空文件条目：CRC=0、长度=0，不崩', async () => {
    const buffer = await createZip([{ name: 'zero.dat', data: Buffer.alloc(0) }])
    const listed = listZip(buffer)
    assert.equal(listed[0].size, 0)
    assert.equal(listed[0].crc, 0)
    const out = await extractZip(buffer)
    assert.equal(out[0].data.length, 0)
  })

  await check('Uint8Array 与字符串都能打包', async () => {
    const out = await extractZip(await createZip([
      { name: 'u8.bin', data: new Uint8Array([1, 2, 3, 250]) },
      { name: 'txt.md', data: '中文内容\n' },
    ]))
    assert.deepEqual([...out[0].data], [1, 2, 3, 250])
    assert.equal(out[1].data.toString('utf8'), '中文内容\n')
  })

  await check('路径分隔符统一成 `/`，反斜杠与越界名被处理', async () => {
    const buffer = await createZip([{ name: 'images\\sub\\x.png', data: Buffer.from('x') }])
    assert.deepEqual(listZip(buffer).map((e) => e.name), ['images/sub/x.png'])
    assert.equal(normalizeZipName('./a//b\\c.txt'), 'a/b/c.txt')
    assert.throws(() => normalizeZipName('../evil.txt'), /越界/)
    assert.throws(() => normalizeZipName(''), /为空/)
  })

  await check('mtime 写进 DOS 日期，缺省不炸', async () => {
    const buffer = await createZip([
      { name: 'a.txt', data: Buffer.from('a'), mtime: new Date(2020, 5, 15, 13, 45, 30) },
      { name: 'b.txt', data: Buffer.from('b') },
      { name: 'c.txt', data: Buffer.from('c'), mtime: new Date(Number.NaN) },
    ])
    assert.equal(listZip(buffer).length, 3)
    // DOS 日期：年-1980 在 bit 9~15
    const localOffset = 0
    const dosDate = buffer.readUInt16LE(localOffset + 12)
    assert.equal(dosDate >> 9, 2020 - 1980)
    assert.equal((dosDate >> 5) & 0xf, 6)
    assert.equal(dosDate & 0x1f, 15)
    assert.equal(await extractZip(buffer).then((out) => out[0].data.toString()), 'a')
  })

  await check('CRC 校验：篡改数据字节必须抛错（不静默通过）', async () => {
    const buffer = await createZip([{ name: 'crc.txt', data: Buffer.from('trust-me') }])
    const copy = Buffer.from(buffer)
    // 数据区在 local header(30) + name 长度之后
    const nameLen = copy.readUInt16LE(26)
    copy[30 + nameLen] ^= 0xff
    await assert.rejects(() => extractZip(copy), /CRC 不符/)
  })

  await check('非 ZIP 输入明确抛错', async () => {
    await assert.rejects(() => extractZip(Buffer.from('definitely not a zip file at all')), /EOCD/)
    assert.throws(() => listZip(Buffer.alloc(4)), /太短/)
  })
})

// ───────────────────────────────────────────────────────────── 2. 真实解压

await group('Zip / 真实解压（第三方解压器背书）', async () => {
  const extractors = await detectExtractors()
  console.log(`  可用的系统解压器：${extractors.join(', ') || '（无）'}`)
  assert.ok(extractors.length > 0, '本机既没有 PowerShell 也没有 tar，无法做真实解压验证')

  const payload = [
    { name: 'library.json', data: Buffer.from('{"version":1}\n', 'utf8') },
    { name: 'images/abc.png', data: pseudoBytes(8192, 11) },
    { name: 'images/测试图片.jpg', data: pseudoBytes(4096, 12) },
    { name: 'state.json', data: Buffer.from('{"sent":0}\n', 'utf8') },
    // 可压缩的文本，用来确认 deflate 模式真的走了 method=8（随机字节压不动会退回 store）
    { name: 'report.txt', data: Buffer.from('备份测试文本，重复以可压缩。\n'.repeat(200), 'utf8') },
    { name: 'zero.bin', data: Buffer.alloc(0) },
  ]

  for (const kind of extractors) {
    await check(`${kind}：store 归档能被真实解压且逐字节一致（含中文文件名）`, async () => {
      const buffer = await createZip(payload)
      const result = await verifyWithSystemExtractor(kind, buffer, payload, 'store')
      assert.equal(result.extracted, payload.length)
    })

    await check(`${kind}：deflate 归档能被真实解压且逐字节一致`, async () => {
      const buffer = await createZip(payload, { deflate: true })
      const result = await verifyWithSystemExtractor(kind, buffer, payload, 'deflate')
      assert.equal(result.extracted, payload.length)
      // 确认真的用了 deflate（JSON 与中文名这种文本类会压小）
      const listed = listZip(buffer)
      assert.ok(listed.some((e) => e.compression === 8), '应当至少有一条是 deflate')
    })
  }

  await check('中文文件名在归档内部按 UTF-8 存、标志位 bit 11 置位', async () => {
    const buffer = await createZip([{ name: '测试图片.jpg', data: Buffer.from('x') }])
    const flags = buffer.readUInt16LE(6) // local header 的通用标志位
    assert.equal(flags & 0x0800, 0x0800, '缺 UTF-8 标志位时 Windows 资源管理器会乱码')
    const nameLen = buffer.readUInt16LE(26)
    const raw = buffer.subarray(30, 30 + nameLen).toString('utf8')
    assert.equal(raw, '测试图片.jpg')
    assert.equal(listZip(buffer)[0].name, '测试图片.jpg')
  })
})

// ───────────────────────────────────────────────────────────── 3. Backup

await group('Backup / 基本', async () => {
  await check('runNow：假库备份后 zip 里能找到 library.json 和全部 images', async () => {
    await withTempDir(async (dir) => {
      const images = await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({ keep: 7 }), dataDir: dir, log: () => { } })
      const result = await backup.runNow({ reason: 'test' })
      assert.equal(result.ok, true, result.reason)
      assert.ok(result.file.endsWith('.zip'))
      assert.ok(result.file.includes('qq-sticker-'))
      assert.equal(result.errors.length, 0)
      // 3 个元文件 + 3 张图
      assert.equal(result.entries, 6)

      const zipBuf = await readFile(result.file)
      const names = listZip(zipBuf).map((e) => e.name).sort()
      assert.deepEqual(names, ['images/aaa.png', 'images/bbb.jpg', 'images/ccc.gif',
        'library.json', 'schedule.json', 'state.json'])
      // 解出来内容也要对
      const out = await extractZip(zipBuf)
      const byName = new Map(out.map((e) => [e.name, e.data]))
      // 归档里的 library.json 应与源文件逐字节一致（write 时就是这份 JSON 文本）
      assert.equal(Buffer.compare(byName.get('library.json'), await readFile(path.join(dir, 'library.json'))), 0)
      assert.ok(byName.get('library.json').toString('utf8').includes('"items"'))
      for (const [name, data] of images) {
        assert.equal(Buffer.compare(byName.get(`images/${name}`), data), 0, `${name} 内容不一致`)
      }
      assert.equal(result.kept, 1)
      assert.deepEqual(result.removed, [])
    })
  })

  await check('runNow 的 zip 也能被系统解压器解开（备份文件本身可恢复）', async () => {
    await withTempDir(async (dir) => {
      const images = await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({ deflate: true }), dataDir: dir, log: () => { } })
      const result = await backup.runNow()
      assert.equal(result.ok, true)
      const zipBuf = await readFile(result.file)
      const extractors = await detectExtractors()
      assert.ok(extractors.length > 0)
      // 用 bsdtar 优先（输出干净），没有就用 PS
      const kind = extractors.includes('bsdtar') ? 'bsdtar' : 'powershell'
      const expected = []
      for (const name of ['library.json', 'state.json', 'schedule.json']) {
        expected.push({ name, data: await readFile(path.join(dir, name)) })
      }
      for (const [name, data] of images) expected.push({ name: `images/${name}`, data })
      const verified = await verifyWithSystemExtractor(kind, zipBuf, expected, 'backup(deflate)')
      assert.equal(verified.extracted, expected.length)
    })
  })

  await check('cfg 缺失 backup 段也不崩（默认值兜底）', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      // 完全空配置
      const backup = new Backup({ getConfig: () => ({}), dataDir: dir, log: () => { } })
      const brief = backup.brief()
      assert.equal(brief.enabled, false)
      assert.equal(brief.at, '06:00')
      assert.equal(brief.keep, 7)
      const result = await backup.runNow()
      assert.equal(result.ok, true, result.reason)
      const names = listZip(await readFile(result.file)).map((e) => e.name)
      assert.ok(names.includes('library.json'))
    })
  })

  await check('backup.dir 绝对路径生效；目录不存在自动创建', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(path.join(dir, 'data'))
      const outDir = path.join(dir, 'nested', 'backup-out')
      const dataDir = path.join(dir, 'data')
      const backup = new Backup({ getConfig: () => cfgOf({ dir: outDir }), dataDir, log: () => { } })
      const result = await backup.runNow()
      assert.equal(result.ok, true, result.reason)
      assert.ok(result.file.startsWith(outDir), `备份应落在 ${outDir}，实际 ${result.file}`)
      const files = await readdir(outDir)
      assert.equal(files.length, 1)
    })
  })

  await check('单个文件读失败只 warn 并跳过，不影响整次备份', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      // 造一个「读不了的图片」：用同名目录冒充文件（readFile 会 EISDIR）
      await rm(path.join(dir, 'images', 'bbb.jpg'))
      await mkdir(path.join(dir, 'images', 'bbb.jpg'), { recursive: true })
      const logs = []
      const backup = new Backup({ getConfig: () => cfgOf({}), dataDir: dir, log: (lvl, msg) => logs.push(`${lvl}:${msg}`) })
      const result = await backup.runNow()
      assert.equal(result.ok, true, result.reason)
      assert.equal(result.errors.length, 1)
      assert.equal(result.errors[0].name, 'bbb.jpg')
      const names = listZip(await readFile(result.file)).map((e) => e.name)
      assert.ok(!names.includes('images/bbb.jpg'))
      assert.ok(names.includes('images/aaa.png'))
      assert.ok(logs.some((line) => line.startsWith('warn:') && line.includes('bbb.jpg')))
    })
  })

  await check('整个 dataDir 缺 images/ 也能备份（不崩、只 warn）', async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, 'library.json'), '{}\n', 'utf8')
      const logs = []
      const backup = new Backup({ getConfig: () => cfgOf({}), dataDir: dir, log: (lvl, msg) => logs.push(`${lvl}:${msg}`) })
      const result = await backup.runNow()
      assert.equal(result.ok, true, result.reason)
      assert.equal(result.entries, 1)
      assert.ok(logs.some((line) => line.includes('图片目录不可读')))
    })
  })
})

await group('Backup / 保留份数与并发', async () => {
  await check('listBackups 新→旧：同一分钟内 -10 比 -2 新（不能按字符串排）', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({ keep: 50 }), dataDir: dir, log: () => { } })
      // 同一分钟内造 12 份，文件名后缀从无到 -12
      for (let i = 0; i < 12; i++) {
        const result = await backup.runNow()
        assert.equal(result.ok, true, result.reason)
      }
      const names = (await backup.listBackups()).map((entry) => entry.name)
      assert.equal(names.length, 12)
      const stamp = names[0].match(/^qq-sticker-(\d{8}-\d{4})/)[1]
      // 无后缀算第 1 份，第 12 份后缀 -12；最新的排最前
      assert.equal(names[0], `qq-sticker-${stamp}-12.zip`, `最新应是 -12，实际 ${names[0]}`)
      assert.equal(names.at(-1), `qq-sticker-${stamp}.zip`, `最旧应是无后缀，实际 ${names.at(-1)}`)
      // 严格递减
      const ranks = names.map((name) => {
        const m = name.match(/^qq-sticker-\d{8}-(\d{4})(?:-(\d+))?\.zip$/)
        return Number(m[2] ?? 1)
      })
      for (let i = 1; i < ranks.length; i++) assert.ok(ranks[i] < ranks[i - 1], `顺序应严格递减：${ranks.join(',')}`)
    })
  })

  await check('keep=3：备份 5 次只剩 3 份，且留下的是最新 3 份', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({ keep: 3 }), dataDir: dir, log: () => { } })
      const created = []
      for (let i = 0; i < 5; i++) {
        const result = await backup.runNow({ reason: `round-${i}` })
        assert.equal(result.ok, true, result.reason)
        created.push(path.basename(result.file))
        // 同一分钟内文件名会撞，实现会自动加 -2/-3 后缀
        assert.ok(!created.slice(0, -1).includes(path.basename(result.file)), '同分钟不能重名')
      }
      const list = await backup.listBackups()
      assert.equal(list.length, 3, `应只剩 3 份，实际 ${list.length}`)
      // 最新 3 份（created 后 3 个）应都在
      for (const name of created.slice(-3)) {
        assert.ok(list.some((entry) => entry.name === name), `最新一份 ${name} 不该被删`)
      }
      // 最早两份应被删
      for (const name of created.slice(0, 2)) {
        assert.ok(!list.some((entry) => entry.name === name), `最旧一份 ${name} 应被删`)
      }
      const brief = backup.brief()
      assert.equal(brief.backups.length, 3)
      assert.ok(brief.backups.every((b) => typeof b.name === 'string' && b.size > 0 && b.at > 0))
    })
  })

  await check('pruneKeep：低于 keep 时不动，超过时删到 keep', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({ keep: 2 }), dataDir: dir, log: () => { } })
      assert.deepEqual(await backup.pruneKeep(), [])
      for (let i = 0; i < 4; i++) await backup.runNow()
      assert.equal((await backup.listBackups()).length, 2)
      assert.deepEqual(await backup.pruneKeep(), [])
    })
  })

  await check('并发第二次 runNow 返回 busy（同一时刻只许一个）', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      const backup = new Backup({ getConfig: () => cfgOf({}), dataDir: dir, log: () => { } })
      const first = backup.runNow()
      const second = await backup.runNow()
      assert.equal(second.ok, false)
      assert.equal(second.reason, 'busy')
      const result = await first
      assert.equal(result.ok, true, result.reason)
      // 忙的时候没多写一份
      assert.equal((await backup.listBackups()).length, 1)
    })
  })
})

await group('Backup / 调度', async () => {
  await check('parseAtMinute：合法/非法输入', () => {
    assert.equal(parseAtMinute('06:00'), 360)
    assert.equal(parseAtMinute('6:5'), 365)
    assert.equal(parseAtMinute('23:59'), 1439)
    assert.equal(parseAtMinute('00:00'), 0)
    assert.equal(parseAtMinute('24:00'), null)
    assert.equal(parseAtMinute('06:60'), null)
    assert.equal(parseAtMinute('乱写'), null)
    assert.equal(parseAtMinute(''), null)
  })

  await check('computeNextRunAt：跨天正确（当天未到 → 今天；已过 → 明天）', () => {
    // 2026-10-25 05:00 本地，at=06:00 → 当天 06:00
    const early = new Date(2026, 9, 25, 5, 0, 0).getTime()
    const next = computeNextRunAt('06:00', early)
    const nextDate = new Date(next)
    assert.equal(nextDate.getDate(), 25)
    assert.equal(nextDate.getHours(), 6)
    assert.equal(nextDate.getMinutes(), 0)
    assert.equal((nextDate.getSeconds()), 0)

    // 2026-10-25 07:00，at=06:00 → 次日 06:00
    const late = new Date(2026, 9, 25, 7, 0, 0).getTime()
    const tomorrow = new Date(computeNextRunAt('06:00', late))
    assert.equal(tomorrow.getDate(), 26)
    assert.equal(tomorrow.getHours(), 6)

    // 月末跨月：2026-10-31 23:00，at=01:00 → 11-01
    const monthEnd = new Date(2026, 9, 31, 23, 0, 0).getTime()
    const nextMonth = new Date(computeNextRunAt('01:00', monthEnd))
    assert.equal(nextMonth.getMonth(), 10)
    assert.equal(nextMonth.getDate(), 1)

    // 非法 at → 0
    assert.equal(computeNextRunAt('乱写', early), 0)
  })

  await check('brief：nextRunInMin 是数字且 >= 0，字段齐全', async () => {
    await withTempDir(async (dir) => {
      const backup = new Backup({ getConfig: () => cfgOf({ at: '06:00', keep: 5 }), dataDir: dir, log: () => { } })
      const now = new Date(2026, 9, 25, 5, 30, 0).getTime()
      const brief = backup.brief(now)
      assert.equal(brief.enabled, true)
      assert.equal(brief.at, '06:00')
      assert.equal(brief.keep, 5)
      assert.equal(typeof brief.nextRunInMin, 'number')
      assert.ok(brief.nextRunInMin >= 0)
      assert.equal(brief.nextRunInMin, 30)
      assert.ok(brief.nextRunAt > now)
      assert.equal(brief.lastRunAt, 0)
      assert.equal(brief.lastBackupFile, '')
      assert.deepEqual(brief.backups, [])
      assert.equal(typeof brief.dir, 'string')
    })
  })

  await check('load/save：schedule 落盘后能读回', async () => {
    await withTempDir(async (dir) => {
      const cfg = cfgOf({})
      const first = new Backup({ getConfig: () => cfg, dataDir: dir })
      first.schedule.nextRunAt = 1234567890
      first.schedule.lastRunAt = 123
      first.schedule.lastFile = 'qq-sticker-20261025-0600.zip'
      await first.saveSchedule()
      const again = new Backup({ getConfig: () => cfg, dataDir: dir })
      await again.load()
      assert.equal(again.schedule.nextRunAt, 1234567890)
      assert.equal(again.schedule.lastRunAt, 123)
      assert.equal(again.schedule.lastFile, 'qq-sticker-20261025-0600.zip')
    })
  })

  await check('设置改了 backup.at 之后，nextRunAt 按新时刻重算（不然面板会显示旧时间）', async () => {
    await withTempDir(async (dir) => {
      let at = '06:00'
      const clock = new Date(2026, 9, 25, 12, 0, 0).getTime()
      const backup = new Backup({
        getConfig: () => cfgOf({ at }), dataDir: dir, log: () => { }, now: () => clock,
      })
      await backup.load()
      const before = backup.brief().nextRunAt
      assert.equal(new Date(before).getHours(), 6)
      at = '20:30'
      const after = backup.brief().nextRunAt
      assert.equal(new Date(after).getHours(), 20)
      assert.equal(new Date(after).getMinutes(), 30)
      assert.equal(new Date(after).getDate(), 25, '20:30 还没到，应是今天')
      // maybeRun 也按新时刻判断
      const state = await backup.maybeRun()
      assert.equal(state.ok, false)
      assert.equal(state.reason, 'not-yet')
      assert.equal(state.nextRunAt, after)
    })
  })

  await check('定时器：关掉时 tick 不动；到点触发一次并排好下一次', async () => {
    await withTempDir(async (dir) => {
      await makeFakeLibrary(dir)
      const realNow = new Date(2026, 9, 25, 6, 0, 30).getTime()
      let clock = realNow
      const backup = new Backup({
        getConfig: () => cfgOf({ enabled: true, at: '06:00' }),
        dataDir: dir,
        log: () => { },
        now: () => clock,
      })
      // 还没到点（下一次 = 次日 06:00），手动塞一个未来时间
      await backup.load()
      backup.schedule.nextRunAt = new Date(2026, 9, 25, 6, 1, 0).getTime()
      assert.deepEqual(await backup.maybeRun(), { ok: false, reason: 'not-yet', nextRunAt: backup.schedule.nextRunAt })
      assert.equal((await backup.listBackups()).length, 0)

      // 到点
      clock = backup.schedule.nextRunAt + 1000
      const result = await backup.maybeRun()
      assert.equal(result.ok, true, result.reason)
      assert.equal((await backup.listBackups()).length, 1)
      const nextRun = new Date(backup.schedule.nextRunAt)
      assert.equal(nextRun.getDate(), 26, '跑完应排到次日同时刻')
      assert.equal(nextRun.getHours(), 6)
      assert.equal(backup.schedule.lastRunAt, clock)
      assert.equal(backup.schedule.lastResult.ok, true)
      // 计划已落盘
      const saved = JSON.parse(await readFile(path.join(dir, 'backup-schedule.json'), 'utf8'))
      assert.equal(saved.nextRunAt, backup.schedule.nextRunAt)
      assert.equal(saved.lastFile, path.basename(result.file))
    })
  })

  await check('定时器：cfg.backup.enabled=false 时 maybeRun 返回 disabled', async () => {
    await withTempDir(async (dir) => {
      const backup = new Backup({ getConfig: () => cfgOf({ enabled: false }), dataDir: dir })
      assert.deepEqual(await backup.maybeRun(), { ok: false, reason: 'disabled' })
    })
  })

  await check('startTimer：无 timer 服务时退回 setInterval，stop 能停下且可重复调用', async () => {
    await withTempDir(async (dir) => {
      const backup = new Backup({ getConfig: () => cfgOf({ enabled: false }), dataDir: dir })
      const fakeCtx = { get: () => undefined }
      const stop = backup.startTimer(fakeCtx)
      assert.equal(typeof stop, 'function')
      stop()
      stop() // 幂等
      backup.dispose()
    })
  })

  await check('startTimer：有 timer 服务时走 timer.interval（不直接读 ctx.timer）', async () => {
    await withTempDir(async (dir) => {
      const backup = new Backup({ getConfig: () => cfgOf({ enabled: false }), dataDir: dir })
      let calls = 0
      let intervalMs = 0
      const fakeCtx = {
        get(name) {
          if (name !== 'timer') return undefined
          return { interval: (fn, ms) => { calls++; intervalMs = ms; return () => { calls += 100 } } }
        },
      }
      const stop = backup.startTimer(fakeCtx)
      assert.equal(calls, 1)
      assert.equal(intervalMs, 60_000)
      stop()
      assert.equal(calls, 101)
    })
  })

  await check('dispose：重复调用不抛', async () => {
    const backup = new Backup({ getConfig: () => cfgOf({}), dataDir: os.tmpdir() })
    backup.dispose()
    backup.dispose()
  })
})

// ───────────────────────────────────────────────────────────── 收尾

console.log(`\n${'='.repeat(60)}`)
if (realLogs.length > 0) {
  console.log('真实解压验证（系统解压器输出）：')
  for (const line of realLogs) console.log(`  ${line}`)
  console.log('')
}
console.log(`通过 ${pass}｜失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const item of failures) console.log(`- ${item.name}`)
  process.exit(1)
}
console.log('全部通过')
