// Integration test: boot the plugin against a fake ctx (tools registry +
// webServer), then drive the tools. Uses the REAL engine (real CLI probe,
// real User Data) but a fake IDE state so it never depends on a login.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const registry = new Map()
const routes = []
const fakeCtx = {
  tools: { register: (t) => registry.set(t.name, t) },
  webServer: {
    register: (r) => {
      routes.push(r)
      return () => routes.splice(routes.indexOf(r), 1)
    },
  },
  on: () => {},
}

// redirect the plugin's state file into a temp home (os.homedir is read-only
// in ESM, but it honours USERPROFILE on Windows)
const tmpHome = mkdtempSync(join(tmpdir(), 'weapp-home-'))
const realUserProfile = process.env.USERPROFILE
process.env.USERPROFILE = tmpHome

let results = []
try {
  apply(fakeCtx, { projectPath: 'C:\\Users\\1\\Documents\\大创项目', cliTimeoutMs: 3000, openWaitMs: 0 })

  const call = async (name, args = {}) => registry.get(name).execute(args, { signal: undefined })

  // 1. all six tools registered
  const expected = ['weapp_status', 'weapp_projects', 'weapp_open', 'weapp_preview', 'weapp_errors', 'weapp_upload']
  results.push(['all tools registered', expected.every((n) => registry.has(n))])

  // 2. two HTTP routes registered
  results.push(['config+health routes', routes.length === 2 && routes.some((r) => r.path === '/dsh-weapp-loop/config') && routes.some((r) => r.path === '/dsh-weapp-loop/health')])

  // 3. status reports the real installation
  const status = await call('weapp_status')
  results.push(['status.installed=true', status.ok === true && status.installed === true])
  results.push(['status.projects has 大创', Array.isArray(status.projects) && status.projects.length >= 1])

  // 4. projects lists the real project
  const projects = await call('weapp_projects')
  results.push(['projects non-empty', projects.ok === true && projects.projects.length >= 1])

  // 5. errors parsing through the tool boundary
  const errs = await call('weapp_errors', { text: 'app.js:1:1: syntax error' })
  results.push(['errors parsed', errs.ok === true && errs.errors.length === 1 && errs.errors[0].file === 'app.js'])

  // 6. preview without a ready IDE must report not-ready, not a fake success
  const preview = await call('weapp_preview')
  results.push(['preview honest-not-ready', preview.ok === false && (preview.reason === 'ide-not-ready' || preview.reason === 'no-qr' || preview.reason === 'cli-timeout')])

  // 7. upload requires confirmation
  const upload = await call('weapp_upload', { version: '1.0.0', desc: 'test' })
  results.push(['upload needs confirm', upload.ok === false && upload.reason === 'not-confirmed'])

  // 8. config route handler returns the shared payload
  let payload = null
  routes.find((r) => r.path === '/dsh-weapp-loop/config').handler({}, {
    writeHead: () => {},
    end: (t) => {
      payload = JSON.parse(t)
    },
  })
  results.push(['config route payload', payload && payload.plugin === 'weapp-loop' && payload.projectPath === 'C:\\Users\\1\\Documents\\大创项目'])
} catch (error) {
  console.error('UNEXPECTED THROW:', error)
  results.push(['no-throw', false])
} finally {
  if (realUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = realUserProfile
  rmSync(tmpHome, { recursive: true, force: true })
}

let pass = 0
for (const [name, ok] of results) {
  console.log(`${ok ? '✔' : '✖'} ${name}`)
  if (ok) pass += 1
}
console.log(`\n${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
