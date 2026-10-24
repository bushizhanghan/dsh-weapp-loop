// dsh-weapp-loop engine: DevTools CLI wrapper + compile-error parsing +
// IDE state detection. Pure functions + one spawn boundary, so it is testable
// without a running IDE.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
// ---------------------------------------------------------------------
export async function runCli(cli, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const child = spawn('cmd.exe', ['/c', cli, ...args], { windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, timedOut: true, code: null, stdout: out, stderr: err })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, timedOut: false, code: null, stdout: out, stderr: String(error.message || error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, timedOut: false, code, stdout: out, stderr: err })
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
// `[ path/to/file.js ] message`. The bracket form has no line/column.
const ERROR_LINE =
  /^\s*(?:\[\s*([\w./\\-]+\.(?:js|json|wxml|wxss|wxs))\s*\]\s*(.+)|([\w./\\-]+\.(?:js|json|wxml|wxss|wxs))\s*[::]\s*(\d+)?\s*[::]?\s*(\d+)?\s*[::]?\s*(.+))$/

export function parseErrors(text) {
  const errors = []
  const raw = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    const m = ERROR_LINE.exec(t)
    const file = m ? m[1] || m[3] : null
    const message = m ? (m[2] || m[6] || '').trim() : ''
    const lineNo = m && m[4] ? Number(m[4]) : null
    const column = m && m[5] ? Number(m[5]) : null
    if (file || message) {
      const kind = /warn|警告|deprecat/i.test(message)
        ? 'warning'
        : /error|错误|fail|失败|expected|unexpected|cannot|未定义|语法|非法|TypeError|ReferenceError|SyntaxError/i.test(message)
          ? 'error'
          : 'info'
      errors.push({ file, line: lineNo, column, kind, message })
    } else if (/error|错误|fail|失败|warning|警告|deprecat/i.test(t)) {
      const kind = /warn|警告|deprecat/i.test(t) ? 'warning' : 'error'
      errors.push({ file: null, line: null, column: null, kind, message: t })
      raw.push(t)
    } else {
      raw.push(t)
    }
  }
  return { errors, raw }
}

// ---------------------------------------------------------------------
// QR payload: `preview -f base64` writes the data URL to a file.
// ---------------------------------------------------------------------
export function readQrDataUrl(file) {
  if (!existsSync(file)) return null
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text.startsWith('data:image')) return text
    // some builds write bare base64
    if (/^[A-Za-z0-9+/=\s]+$/.test(text) && text.length > 100) return `data:image/png;base64,${text.replace(/\s+/g, '')}`
    return text || null
  } catch {
    return null
  }
}

export const tempPaths = () => ({
  info: join(tmpdir(), `weapp-loop-info-${process.pid}.json`),
  qr: join(tmpdir(), `weapp-loop-qr-${process.pid}.txt`),
})

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
