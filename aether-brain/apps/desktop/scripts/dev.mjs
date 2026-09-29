// Dev runner: Vite dev server for the renderer + tsc for main/preload + the AI link's
// MCP server bundle (built once) + Electron.
// No extra dependencies (concurrently, wait-on, ...) — a few lines of Node do it.
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..')
const PORT = 5174
const url = `http://localhost:${PORT}`

const run = (cmd, args, opts = {}) =>
  spawn(cmd, args, { cwd: app, stdio: 'inherit', shell: process.platform === 'win32', ...opts })

const waitForPort = (port, tries = 200) =>
  new Promise((resolve, reject) => {
    const attempt = (n) => {
      const s = createConnection({ port, host: '127.0.0.1' })
      s.once('connect', () => (s.end(), resolve()))
      s.once('error', () => (n <= 0 ? reject(new Error('vite did not start')) : setTimeout(() => attempt(n - 1), 150)))
    }
    attempt(tries)
  })

/** dist/mcp/aether-mcp.mjs, which main imports for the AI link. A failed build is not fatal: the link reports it. */
const buildMcp = () =>
  new Promise((resolve) => {
    const p = run('pnpm', ['build:mcp'])
    p.once('error', () => resolve())
    p.once('exit', (code) => {
      if (code) console.warn('[dev] pnpm build:mcp failed; the AI link will show the server as missing')
      resolve()
    })
  })

const mcp = buildMcp()
const vite = run('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'])
const tsc = run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput'])

await waitForPort(PORT)
// Give tsc a moment to emit dist/main on a cold start.
await new Promise((r) => setTimeout(r, 1500))
await mcp

const electron = run('pnpm', ['exec', 'electron', '.'], { env: { ...process.env, VITE_DEV_SERVER_URL: url } })
electron.on('exit', () => {
  vite.kill()
  tsc.kill()
  process.exit(0)
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    electron.kill()
    vite.kill()
    tsc.kill()
    process.exit(0)
  })
}
