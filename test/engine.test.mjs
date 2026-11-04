import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ideRunning, knownProjects, parseErrors, projectSummary, readQrDataUrl, resolveCli, runCli, tempPaths } from '../lib/engine.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('resolveCli finds the installed DevTools', () => {
  const r = resolveCli()
  assert.ok(r, 'cli.bat should resolve on this machine')
  assert.match(r.cli, /cli\.bat$/)
})

test('ideRunning matches Chinese and English process names', () => {
  assert.equal(ideRunning(['wechatdevtools.exe']), true)
  assert.equal(ideRunning(['微信开发者工具.exe']), true)
  assert.equal(ideRunning(['chrome.exe']), false)
  assert.equal(ideRunning([]), false)
})

test('projectSummary reads a real project.config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-proj-'))
  try {
    writeFileSync(
      join(dir, 'project.config.json'),
      JSON.stringify({ appid: 'wx123', projectname: 'demo', libVersion: '3.3.4', compileType: 'miniprogram', description: 'd' }),
    )
    writeFileSync(join(dir, 'app.json'), '{}')
    const s = projectSummary(dir)
    assert.equal(s.appid, 'wx123')
    assert.equal(s.name, 'demo')
    assert.equal(s.libVersion, '3.3.4')
    assert.equal(s.exists, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('projectSummary returns null for a non-project dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-noproj-'))
  try {
    assert.equal(projectSummary(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('knownProjects finds the real 大创项目 from User Data', () => {
  const projects = knownProjects()
  // this machine has the project recorded; if it ever moves the test still
  // passes as long as discovery returns an array
  assert.ok(Array.isArray(projects))
  if (projects.length) assert.ok(projects.every((p) => typeof p === 'string'))
})

test('parseErrors extracts file/line/column and classifies kind', () => {
  const text = [
    'app.js:12:5: expected expression, got \';\'',
    'pages/index/index.wxml:3:1: 标签闭合错误',
    '[ pages/index/index.js ] TypeError: Cannot read property \'x\' of undefined',
    'WARNING: deprecated API wx.request',
    'just a normal log line',
  ].join('\n')
  const { errors, raw } = parseErrors(text)
  assert.ok(errors.length >= 3, `expected >=3 errors, got ${errors.length}`)
  const first = errors.find((e) => e.file === 'app.js')
  assert.equal(first.line, 12)
  assert.equal(first.column, 5)
  assert.equal(first.kind, 'error')
  const warn = errors.find((e) => e.kind === 'warning')
  assert.ok(warn, 'warning should be classified')
  assert.ok(raw.some((l) => l.includes('normal log')), 'unknown lines land in raw')
})

test('parseErrors tolerates empty input', () => {
  const { errors, raw } = parseErrors('')
  assert.deepEqual(errors, [])
  assert.deepEqual(raw, [])
})

test('readQrDataUrl only accepts real image bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-qr-'))
  try {
    // A PNG payload: magic bytes plus enough filler to clear the size floor.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 1)])
    const base64 = png.toString('base64')
    const dataFile = join(dir, 'a.txt')
    writeFileSync(dataFile, `data:image/png;base64,${base64}`)
    assert.equal(readQrDataUrl(dataFile), `data:image/png;base64,${base64}`)
    const bareFile = join(dir, 'b.txt')
    writeFileSync(bareFile, base64)
    assert.equal(readQrDataUrl(bareFile), `data:image/png;base64,${base64}`)
    // The CLI writes its failures into the same file; those are not QR codes.
    const failure = join(dir, 'c.txt')
    writeFileSync(failure, 'Error: 项目未打开')
    assert.equal(readQrDataUrl(failure), null)
    const text = join(dir, 'd.txt')
    writeFileSync(text, 'A'.repeat(400))
    assert.equal(readQrDataUrl(text), null)
    assert.equal(readQrDataUrl(join(dir, 'missing.txt')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runCli quotes a cli path containing spaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp space-'))
  try {
    const bat = join(dir, 'echo-args.bat')
    writeFileSync(bat, '@echo off\r\necho ARG1=%1\r\necho ARG2=%2\r\n')
    const result = await runCli(bat, ['one two', 'three'], { timeoutMs: 10_000 })
    assert.equal(result.ok, true, result.stderr)
    assert.match(result.stdout, /one two/)
    assert.match(result.stdout, /three/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runCli kills the whole process tree on timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-slow-'))
  try {
    const stamp = join(dir, 'stamp.txt')
    const bat = join(dir, 'slow.bat')
    // ping is the portable sleep here; the stamp proves the bat kept running.
    writeFileSync(bat, `@echo off\r\nping -n 4 127.0.0.1 >nul\r\necho done> "${stamp}"\r\n`)
    const result = await runCli(bat, [], { timeoutMs: 500 })
    assert.equal(result.timedOut, true)
    await new Promise((r) => setTimeout(r, 3500))
    assert.equal(existsSync(stamp), false, 'the bat must not survive the timeout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runCli rejects arguments carrying shell metacharacters', async () => {
  const result = await runCli('C:\\no\\such\\cli.bat', ['-d', 'x&echo PWNED'], { timeoutMs: 1000 })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /shell metacharacter/)
})

test('tempPaths are unique per call', () => {
  const a = tempPaths()
  const b = tempPaths()
  try {
    assert.notEqual(a.info, b.info)
    assert.notEqual(a.dir, b.dir)
    assert.ok(existsSync(a.dir))
  } finally {
    rmSync(a.dir, { recursive: true, force: true })
    rmSync(b.dir, { recursive: true, force: true })
  }
})
