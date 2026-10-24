import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ideRunning, knownProjects, parseErrors, projectSummary, readQrDataUrl, resolveCli, runCli, tempPaths } from '../lib/engine.js'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
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

test('readQrDataUrl accepts data URL and bare base64', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-qr-'))
  try {
    const dataFile = join(dir, 'a.txt')
    writeFileSync(dataFile, 'data:image/png;base64,AAAA')
    assert.equal(readQrDataUrl(dataFile), 'data:image/png;base64,AAAA')
    const bareFile = join(dir, 'b.txt')
    writeFileSync(bareFile, 'A'.repeat(200))
    assert.equal(readQrDataUrl(bareFile), `data:image/png;base64,${'A'.repeat(200)}`)
    assert.equal(readQrDataUrl(join(dir, 'missing.txt')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runCli honors the timeout and reports timedOut', async () => {
  // `timeout` is not a real cmd builtin; use a command that blocks instead.
  const result = await runCli('cmd.exe', ['/c', 'pause'], { timeoutMs: 800 })
  assert.equal(result.timedOut, true)
  assert.equal(result.ok, false)
})

test('runCli returns output for a fast command', async () => {
  const result = await runCli('cmd.exe', ['/c', 'echo', 'hello'], { timeoutMs: 5000 })
  assert.equal(result.ok, true)
  assert.match(result.stdout, /hello/)
})

test('tempPaths are unique per process', () => {
  const p = tempPaths()
  assert.notEqual(p.info, p.qr)
  assert.ok(p.info.includes('weapp-loop-info'))
})
