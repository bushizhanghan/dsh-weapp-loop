// dsh-weapp-loop: agent tools over the WeChat DevTools CLI, plus an HTTP
// config route that feeds the right-sidebar panel. The CLI is a remote
// control for a running, logged-in IDE, so every call reports the IDE state
// honestly instead of pretending a preview happened.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ideRunning,
  knownProjects,
  parseErrors,
  projectSummary,
  readQrDataUrl,
  resolveCli,
  runCli,
  tempPaths,
} from './engine.js'

export const name = 'weapp-loop'
export const inject = ['tools', 'webServer']

const CONFIG_PATH = '/dsh-weapp-loop/config'
const HEALTH_PATH = '/dsh-weapp-loop/health'

const Config = {
  // Default project used when a tool is called without a path.
  projectPath: '',
  // CLI calls are bounded: the real CLI hangs when no IDE is logged in.
  cliTimeoutMs: 20_000,
  // How long weapp_open waits for the IDE to become ready.
  openWaitMs: 60_000,
}

export function apply(ctx, config = {}) {
  const cfg = { ...Config, ...config }
  const stateFile = join(homedir(), '.dsh', 'dsh-weapp-loop', 'state.json')
  // A read-only profile or a full disk must not take the whole plugin down at
  // load time, which is what an unguarded mkdirSync in apply() did.
  try {
    mkdirSync(join(homedir(), '.dsh', 'dsh-weapp-loop'), { recursive: true })
  } catch {}

  const readState = () => {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8'))
    } catch {
      return { lastQr: null, lastPreviewAt: null, lastErrors: [], readySince: null, readyUntil: null }
    }
  }
  const writeState = (patch) => {
    const next = { ...readState(), ...patch }
    // Write-then-rename: a crash mid-write used to leave truncated JSON, which
    // readState silently turned into defaults, losing the last QR and errors.
    try {
      writeFileSync(`${stateFile}.tmp`, JSON.stringify(next, null, 2), 'utf8')
      renameSync(`${stateFile}.tmp`, stateFile)
    } catch {}
    return next
  }

  // Readiness means a CLI call actually worked, not merely that a process
  // exists: DevTools sitting at the login screen has a process and no working
  // CLI, and that used to report ready for the rest of the session.
  const READY_TTL_MS = 5 * 60_000
  const markReady = (path) =>
    writeState({
      readySince: new Date().toISOString(),
      readyUntil: new Date(Date.now() + READY_TTL_MS).toISOString(),
      projectPath: path,
    })

  const ide = () => resolveCli()

  /** Full IDE state, the single source the tools and the panel share. */
  async function ideState() {
    const resolved = ide()
    if (!resolved) {
      return { installed: false, running: false, ready: false, cli: null, root: null, hint: '未检测到微信开发者工具。安装后可在 config.projectPath 旁配置 WECHAT_DEVTOOLS_PATH 指向安装目录。' }
    }
    const running = ideRunning(processList())
    const state = readState()
    const ready = running && Boolean(state.readyUntil) && Date.parse(state.readyUntil) > Date.now()
    return {
      installed: true,
      running,
      ready,
      cli: resolved.cli,
      root: resolved.root,
      hint: ready
        ? null
        : running
          ? '开发者工具在运行，但还没有一次成功的 CLI 调用——可能停在登录界面。请在 IDE 里扫码登录并打开项目，然后调用 weapp_open。'
          : '开发者工具未运行。调用 weapp_open 启动并打开项目。',
    }
  }

  /** Process names, cached 3s: tasklist is a real spawn. */
  let processCache = { at: 0, names: [] }
  function processList() {
    const now = Date.now()
    if (now - processCache.at < 3000) return processCache.names
    processCache = { at: now, names: [] }
    try {
      const out = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 5000, windowsHide: true })
      processCache.names = out
        .split('\n')
        .map((l) => l.split(',')[0].replace(/"/g, '').trim())
        .filter(Boolean)
    } catch {}
    return processCache.names
  }

  async function resolveProject(args) {
    const path = args.projectPath || cfg.projectPath
    if (!path) {
      const known = knownProjects()
      if (known.length === 1) return { path: known[0] }
      throw new Error(`未提供项目路径。开发者工具记录的项目：${known.join(' / ') || '（无）'}。请在参数或 config.projectPath 中指定。`)
    }
    return { path }
  }

  // ---------------- tools ----------------
  const tools = [
    {
      name: 'weapp_status',
      description:
        '检测微信开发者工具与本机小程序项目状态：是否安装、IDE 是否在运行、是否已就绪（已登录并打开项目），以及开发者工具记录的项目列表。任何其他 weapp_* 工具之前先调它。Returns {installed, running, ready, cli, projects:[{path,appid,name,libVersion}]}。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const s = await ideState()
        const projects = knownProjects().map(projectSummary).filter(Boolean)
        return { ok: true, ...s, projects }
      },
    },
    {
      name: 'weapp_projects',
      description: '列出开发者工具记录过的所有小程序项目（从 User Data 的 last_all_projects 读取，只读不猜）。Returns {ok, projects:[{path,appid,name,description,libVersion,exists}]}。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const projects = knownProjects().map(projectSummary).filter(Boolean)
        return { ok: true, projects }
      },
    },
    {
      name: 'weapp_open',
      description:
        '启动微信开发者工具并打开指定小程序项目，然后轮询等待 IDE 就绪（登录后才会就绪）。首次使用需要你在 IDE 里扫码登录——插件不能代登录。就绪前其他工具会返回未就绪。Returns {ok, started, ready, waitedMs, hint}。',
      parameters: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: '小程序项目目录（含 project.config.json）。缺省用 config.projectPath。' },
          waitMs: { type: 'integer', description: '等待就绪的毫秒数，默认 60000。' },
        },
      },
      async execute(args, exec) {
        const { path } = await resolveProject(args)
        const resolved = ide()
        if (!resolved) throw new Error('未检测到微信开发者工具，无法启动。')
        const summary = projectSummary(path)
        if (!summary) throw new Error(`${path} 不是小程序项目（缺 project.config.json）`)
        // Stay under the tool's own timeoutMs so the host never kills the poll
        // before readiness has a chance to be recorded.
        const waitMs = Math.min(Number(args.waitMs) || cfg.openWaitMs, 100_000)
        const launched = await runCli(resolved.cli, ['open', '--project', path, '--lang', 'zh'], {
          timeoutMs: 15_000,
          signal: exec?.signal,
        })
        // A launched process is not a working CLI: poll only when the open call
        // itself returned 0, otherwise the login screen would look ready.
        // Readiness is never marked here — a running process is exactly what the
        // login screen is too. Only a CLI call that actually succeeded
        // (preview/upload) earns it.
        let running = false
        const pollStart = Date.now()
        if (launched.ok) {
          while (Date.now() - pollStart < waitMs) {
            if (exec?.signal?.aborted) break
            if (ideRunning(processList())) {
              running = true
              break
            }
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
        const ready = ideState().ready
        return {
          ok: launched.ok,
          started: launched.ok,
          running,
          ready,
          waitedMs: Date.now() - pollStart,
          cli: launched.timedOut ? 'timeout' : launched.code,
          project: summary,
          stderr: launched.ok ? undefined : launched.stderr.slice(0, 500),
          hint: ready
            ? 'IDE 已就绪，可调用 weapp_preview 生成预览二维码。'
            : launched.ok
              ? 'IDE 进程已拉起，但进程在跑不等于登录好了。请在开发者工具里扫码登录并打开项目，然后调用 weapp_preview——成功一次就会标记为已就绪。'
              : 'open 命令没有成功返回，IDE 很可能没被拉起。检查开发者工具安装是否完整，或手动打开一次。',
        }
      },
    },
    {
      name: 'weapp_preview',
      description:
        '对指定小程序项目触发预览，返回 base64 二维码数据 URL（可直接贴进对话让手机扫）与编译结果。需要 IDE 已登录并打开项目；未就绪时返回明确的未就绪原因而不是假成功。Returns {ok, qrDataUrl, compileOk, info, errors}。',
      parameters: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: '小程序项目目录。缺省用 config.projectPath。' },
        },
      },
      async execute(args, exec) {
        const { path } = await resolveProject(args)
        const s = await ideState()
        if (!s.installed) throw new Error('未检测到微信开发者工具。')
        if (!s.ready) {
          return {
            ok: false,
            reason: 'ide-not-ready',
            hint: s.hint || 'IDE 未就绪，先调用 weapp_open 并完成扫码登录。',
            state: s,
          }
        }
        const paths = tempPaths()
        try {
          const run = await runCli(s.cli, ['preview', '--project', path, '-f', 'base64', '-o', paths.qr, '-i', paths.info, '--lang', 'zh'], {
            timeoutMs: cfg.cliTimeoutMs,
            signal: exec?.signal,
          })
          if (run.timedOut || run.aborted) {
            return {
              ok: false,
              reason: run.aborted ? 'cancelled' : 'cli-timeout',
              hint: 'CLI 超过 20s 未返回——通常是 IDE 未登录或未打开项目。打开开发者工具扫码登录后重试。',
              stdout: run.stdout.slice(0, 500),
            }
          }
          const qr = readQrDataUrl(paths.qr)
          let info = null
          try {
            if (existsSync(paths.info)) info = JSON.parse(readFileSync(paths.info, 'utf8'))
          } catch {}
          const parsed = parseErrors(`${run.stdout}\n${run.stderr}`)
          if (!qr) {
            writeState({ lastErrors: parsed.errors })
            return {
              ok: false,
              reason: 'no-qr',
              hint: '未拿到二维码数据。若 IDE 刚登录，稍等几秒重试；或检查 IDE 是否已打开该项目。',
              errors: parsed.errors,
              stdout: run.stdout.slice(0, 500),
              stderr: run.stderr.slice(0, 500),
            }
          }
          if (run.ok) markReady(path)
          writeState({ lastQr: qr, lastPreviewAt: new Date().toISOString(), lastErrors: parsed.errors })
          // 'info' lines are benign console output, so only real errors fail the
          // compile verdict — otherwise `console ready` reported compileOk:false.
          return { ok: true, qrDataUrl: qr, compileOk: !parsed.errors.some((e) => e.kind === 'error'), info, errors: parsed.errors }
        } finally {
          try {
            rmSync(paths.dir, { recursive: true, force: true })
          } catch {}
        }
      },
    },
    {
      name: 'weapp_errors',
      description:
        '解析小程序编译/运行报错文本，返回结构化错误清单（file/line/column/kind/message）。可直接把 IDE 控制台日志或 CLI 输出贴给它。Returns {ok, errors:[...], raw:[未识别行]}。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要解析的报错文本（IDE 控制台输出或 CLI stdout）。' },
          useLast: { type: 'boolean', description: '为 true 时解析最近一次 weapp_preview 记录的错误。' },
        },
      },
      async execute(args) {
        // Re-parsing the stored array as JSON text produced one bogus error
        // whose message was the whole stringified array.
        if (args.useLast) return { ok: true, errors: readState().lastErrors || [], raw: [] }
        const parsed = parseErrors(String(args.text || ''))
        return { ok: true, errors: parsed.errors, raw: parsed.raw }
      },
    },
    {
      name: 'weapp_upload',
      description:
        '把小程序上传为开发版本（需要 IDE 已登录，且需要你在微信公众平台确认）。上传是生产动作，务必先向用户确认版本号与描述。Returns {ok, info} 或 {ok:false, reason}。',
      parameters: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: '小程序项目目录。缺省用 config.projectPath。' },
          version: { type: 'string', description: '版本号，如 1.2.0。' },
          desc: { type: 'string', description: '版本描述。' },
          confirmed: { type: 'boolean', description: '用户已明确确认上传。为 false 时只返回预览不执行。' },
        },
      },
      async execute(args, exec) {
        const { path } = await resolveProject(args)
        if (!args.version || !args.desc) throw new Error('上传需要 version 与 desc。')
        if (args.confirmed !== true) {
          return { ok: false, reason: 'not-confirmed', hint: `将上传 ${path} 为版本 ${args.version}（${args.desc}）。确认后带 confirmed=true 重试。` }
        }
        const s = await ideState()
        if (!s.ready) return { ok: false, reason: 'ide-not-ready', hint: s.hint || 'IDE 未就绪。' }
        const paths = tempPaths()
        try {
          const run = await runCli(
            s.cli,
            ['upload', '--project', path, '-v', String(args.version), '-d', String(args.desc), '-i', paths.info, '--lang', 'zh'],
            { timeoutMs: 60_000, signal: exec?.signal },
          )
          // A timed-out upload must not be reported with the previous call's
          // info file, which used to look like this upload's success.
          if (run.timedOut || run.aborted) {
            return {
              ok: false,
              reason: run.aborted ? 'cancelled' : 'cli-timeout',
              hint: 'CLI 超过 60s 未返回。上传可能仍在 IDE 里进行，请到开发者工具确认后再重试。',
              stdout: run.stdout.slice(0, 500),
            }
          }
          let info = null
          try {
            if (existsSync(paths.info)) info = JSON.parse(readFileSync(paths.info, 'utf8'))
          } catch {}
          const parsed = parseErrors(`${run.stdout}\n${run.stderr}`)
          if (run.ok) markReady(path)
          return { ok: run.ok, info, errors: parsed.errors, stdout: run.stdout.slice(0, 500), stderr: run.stderr.slice(0, 500) }
        } finally {
          try {
            rmSync(paths.dir, { recursive: true, force: true })
          } catch {}
        }
      },
    },
  ]

  const OUTPUT_SCHEMA = { type: 'json' }
  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  for (const t of tools) {
    try {
      ctx.tools.register({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        output: { schema: OUTPUT_SCHEMA, render },
        // weapp_open may legitimately poll for up to 100s, so the host budget
        // must stay above it or the poll is killed before readiness is written.
        timeoutMs: 200_000,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({ card: 'generic', title: t.name, kind: 'read', rawInput: args }),
        execute: t.execute,
      })
    } catch (error) {
      console.error(`[weapp-loop] ${t.name} registration skipped: ${error}`)
    }
  }

  // ---------------- HTTP routes for the sidebar panel ----------------
  const writeJson = (response, statusCode, value) => {
    const text = JSON.stringify(value)
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(text)
  }

  const configPayload = () => {
    const state = readState()
    const running = ideRunning(processList())
    return {
      plugin: name,
      projectPath: cfg.projectPath || null,
      ide: { installed: !!ide(), running, cli: ide()?.cli || null },
      lastPreviewAt: state.lastPreviewAt || null,
      lastQr: state.lastQr || null,
      lastErrors: state.lastErrors || [],
      readySince: state.readySince || null,
      // The panel needs `running` too: driving 已就绪 off readySince alone left
      // it green forever after the IDE quit.
      ready: running && Boolean(state.readyUntil) && Date.parse(state.readyUntil) > Date.now(),
    }
  }

  const routes = []
  const registerRoutes = () => {
    if (typeof ctx.webServer?.register !== 'function') return () => {}
    const configRoute = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (_request, response) => writeJson(response, 200, configPayload()),
    })
    const healthRoute = ctx.webServer.register({
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (_request, response) => writeJson(response, 200, { ok: true, ...configPayload() }),
    })
    routes.push(configRoute, healthRoute)
    return () => {
      for (const r of routes.splice(0)) if (typeof r === 'function') r()
    }
  }
  const unregister = registerRoutes()
  ctx.on?.('dispose', () => unregister?.())
}
