// dsh-weapp-loop engine: DevTools CLI wrapper + compile-error parsing +
// IDE state detection. Pure functions + one spawn boundary, so it is testable
// without a running IDE.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------
// IDE discovery: the CLI is a remote control for an already-running,
// already-logged-in IDE. Without one it hangs, so we probe first.
// ---------------------------------------------------------------------
export const IDE_PROCESS_NAMES = ['wechatdevtools', '微信开发者工具']

/** Candidate install roots, most-specific first. */
export function ideCandidates() {
  return [
    process.env.WECHAT_DEVTOOLS_PATH,
    'D:\\微信web开发者工具',
    'C:\\Program Files (x86)\\Tencent\\微信web开发者工具',
    join(homedir(), 'AppData', 'Local', '微信web开发者工具'),
  ].filter(Boolean)
}

/** Resolve the cli.bat path, or null when DevTools is not installed. */
export function resolveCli() {
  for (const root of ideCandidates()) {
    const cli = join(root, 'cli.bat')
    if (existsSync(cli)) return { cli, root }
  }
  return null
}

/** Is a DevTools process alive right now? */
export function ideRunning(processList) {
  const names = processList || []
  return names.some((n) => IDE_PROCESS_NAMES.some((want) => n.toLowerCase().includes(want.toLowerCase())))
}

// ---------------------------------------------------------------------
// Project discovery: read project.config.json, never guess.
// ---------------------------------------------------------------------
export function readProjectConfig(projectPath) {
  const file = join(projectPath, 'project.config.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function projectSummary(projectPath) {
  const cfg = readProjectConfig(projectPath)
  if (!cfg) return null
  return {
    path: projectPath,
    appid: cfg.appid || null,
    name: cfg.projectname || null,
    description: cfg.description || null,
    libVersion: cfg.libVersion || null,
    compileType: cfg.compileType || null,
    exists: existsSync(join(projectPath, 'app.json')),
  }
}

/**
 * Projects DevTools itself remembers, from its User Data
 * WeappLocalData/localstorage_* key `last_all_projects`.
 * shortcut: reads the first file that parses; IDE stores one record per
 * profile dir, so a multi-profile machine may hide others.
 */
export function knownProjects() {
  const roots = [
    process.env.WECHAT_DEVTOOLS_USERDATA,
    'E:\\WeChatDevToolsData\\微信开发者工具\\User Data',
    join(homedir(), 'AppData', 'Roaming', '微信开发者工具', 'User Data'),
  ].filter(Boolean)
  const out = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const dir of safeReaddir(root)) {
      const weapp = join(root, dir, 'WeappLocalData')
      if (!existsSync(weapp)) continue
      for (const file of safeReaddir(weapp)) {
        if (!file.startsWith('localstorage_')) continue
        try {
          const json = JSON.parse(readFileSync(join(weapp, file), 'utf8'))
          if (Array.isArray(json)) {
            for (const item of json) {
              if (item && typeof item.projectid === 'string' && existsSync(item.projectid)) {
                out.push(item.projectid)
              }
            }
          }
        } catch {
          /* not every localstorage file is JSON */
        }
      }
    }
  }
  return [...new Set(out)]
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------
// CLI invocation with a hard timeout: the real CLI hangs when no IDE is
// logged in, so every call is bounded and reports that state instead.
//
// Everything is handed to cmd.exe as ONE quoted string. Passing argv through
// spawn() unquoted splits a `cli.bat` path at its first space (DevTools
// installs under "C:\Program Files (x86)\…"), and libuv only adds quotes when
// an argument already contains one, so a `&` in an upload description would be
// re-parsed by cmd as a command separator.
// ---------------------------------------------------------------------
// `%` is deliberately absent: a bare `50%` or `C:\a%b\proj` reaches cmd.exe
// intact, only `%NAME%` expands, and upload descriptions like "修复50%闪退"
// are legitimate. `^` really does eat the next character, so it stays.
const SHELL_META = /["&|<>^\r\n]/

export async function runCli(cli, args, { timeoutMs = 20_000, signal } = {}) {
  const bad = args.find((a) => SHELL_META.test(String(a)))
  if (bad !== undefined) {
    return {
      ok: false,
      timedOut: false,
      code: null,
      stdout: '',
      stderr: `argument rejected: ${JSON.stringify(String(bad).slice(0, 80))} contains a shell metacharacter ("&|<>^%)`,
    }
  }
  const command = `"${cli}" ${args.map((a) => `"${a}"`).join(' ')}`
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    let timer = null
    // windowsVerbatimArguments: libuv would otherwise escape the quotes we just
    // added, and cmd would see a literal `"C:\path\cli.bat"` as the command.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsHide: true, windowsVerbatimArguments: true })

    // cli.bat launches node.exe, so killing cmd.exe alone leaves the real CLI
    // running for another minute; /T walks the whole tree.
    const killTree = () => {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {}
      try {
        child.kill()
      } catch {}
    }
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      killTree()
      finish({ ok: false, timedOut: false, aborted: true, code: null, stdout: out, stderr: `${err}\n[cancelled]` })
    }

    timer = setTimeout(() => {
      killTree()
      finish({ ok: false, timedOut: true, code: null, stdout: out, stderr: err })
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', (error) => {
      finish({ ok: false, timedOut: false, code: null, stdout: out, stderr: String(error.message || error) })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, timedOut: false, code, stdout: out, stderr: err })
    })
  })
}

// ---------------------------------------------------------------------
// Compile-error parsing.
// DevTools writes plain-text errors like
//   app.js:12:5: expected expression, got ';'
//   [ pages/index/index ] TypeError: Cannot read property 'x' of undefined
// We normalize them into {file, line, column, kind, message}.
// shortcut: the IDE's console has no stable machine format; unrecognized
// lines are returned verbatim under `raw` so nothing is silently lost.
// ---------------------------------------------------------------------
// Two shapes: a bare `file:line:col: message`, or a bracketed
// `[ path/to/file ] message`. Paths may contain spaces and CJK, so the file
// group is greedy — it takes the last `.<ext>:` in the line — and ANSI colour
// codes are stripped first or they land in the message.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g
const ERROR_PREFIX = /^(?:error|warn|warning|错误|警告)\s*[:：]\s*/i
const FILE_LOC = /^(.*\.(?:js|json|wxml|wxss|wxs)):(\d+):(\d+):\s*(.*)$/
const FILE_ONLY = /^(.*\.(?:js|json|wxml|wxss|wxs)):\s*(.*)$/
const BRACKET = /^\[\s*(.+?)\s*\]\s*(.*)$/
const BRACKET_LOC = /^(.*\.(?:js|json|wxml|wxss|wxs)):(\d+):(\d+)$/
const ERROR_WORDS = /error|错误|fail|失败|expected|unexpected|cannot|undefined|未定义|语法|非法|TypeError|ReferenceError|SyntaxError/i
const WARN_WORDS = /warn|警告|deprecat/i

function kindOf(text) {
  if (WARN_WORDS.test(text)) return 'warning'
  if (ERROR_WORDS.test(text)) return 'error'
  return 'info'
}

export function parseErrors(text) {
  const errors = []
  const raw = []
  for (const line of String(text || '').replace(ANSI, '').split(/\r?\n/)) {
    let t = line.trim()
    if (!t) continue
    if (/^at\s/.test(t)) {
      raw.push(t)
      continue
    }
    // Classify before the prefix is stripped: `错误：编译异常` carries its only
    // error word in the prefix, so testing the stripped body drops it entirely.
    const kind = kindOf(t)
    const body0 = t.replace(ERROR_PREFIX, '')

    let file = null
    let lineNo = null
    let column = null
    let message = ''
    let m = FILE_LOC.exec(body0)
    if (m) {
      file = m[1]
      lineNo = Number(m[2])
      column = Number(m[3])
      message = m[4].trim()
    } else if ((m = BRACKET.exec(body0))) {
      // `[ info ] 编译完成` is a log level, not a file — only treat the bracket
      // body as a path when it looks like one.
      const inner = BRACKET_LOC.exec(m[1])
      const looksLikePath = Boolean(inner) || /[\\/]/.test(m[1]) || /\.[a-z0-9]+$/i.test(m[1])
      if (looksLikePath) {
        file = inner ? inner[1] : m[1]
        if (inner) {
          lineNo = Number(inner[2])
          column = Number(inner[3])
        }
        message = m[2].trim()
      }
    } else if ((m = FILE_ONLY.exec(body0))) {
      file = m[1]
      message = m[2].trim()
    }

    // A line that names a source file is a diagnostic even when its wording is
    // not in the keyword list; a keyword-only line still counts with no file.
    if (file || kind !== 'info') {
      errors.push({ file, line: lineNo, column, kind, message: message || body0 || t })
    } else {
      raw.push(body0)
    }
  }
  return { errors, raw }
}

// ---------------------------------------------------------------------
// QR payload: `preview -f base64` writes the data URL to a file.
// The CLI writes its failures into the same file, and an <img> fed that text
// renders a broken image instead of reporting the failure, so only bytes that
// actually start a PNG/JPEG count as a QR.
// ---------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

export function readQrDataUrl(file) {
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8').trim()
    // The CLI wraps its base64 output, so whitespace inside the payload is
    // normal and must not be read as "this is not a QR".
    const dataUrl = /^data:image\/(?:png|jpeg);base64,([\s\S]+)$/.exec(text)
    const bare = dataUrl ? dataUrl[1] : text
    const base64 = bare.replace(/\s+/g, '')
    if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64)) return null
    const bytes = Buffer.from(base64, 'base64')
    const png = bytes.length > 100 && bytes.subarray(0, 4).equals(PNG_MAGIC)
    const jpeg = bytes.length > 100 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (!png && !jpeg) return null
    return `data:image/${png ? 'png' : 'jpeg'};base64,${base64}`
  } catch {
    return null
  }
}

// A fresh directory per call: preview and upload run concurrently and used to
// share pid-only paths, so one call's leftover file was returned as the other's
// fresh result.
export const tempPaths = () => {
  const dir = mkdtempSync(join(tmpdir(), 'weapp-loop-'))
  return { dir, info: join(dir, 'info.json'), qr: join(dir, 'qr.txt') }
}

/** Best-effort file size helper for status reporting. */
export function dirSizeBytes(dir) {
  let total = 0
  const walk = (current) => {
    for (const entry of safeReaddir(current)) {
      const full = join(current, entry)
      try {
        const st = statSync(full)
        if (st.isDirectory()) walk(full)
        else total += st.size
      } catch {}
    }
  }
  walk(dir)
  return total
}
