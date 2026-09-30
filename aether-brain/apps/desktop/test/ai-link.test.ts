import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryVaultAdapter, type VaultChange } from '@aether/core'
import { IPC, type AetherBridge, type AiActivityDto, type VaultChangeDto, type VaultFileDto, type VaultInfo } from '../src/shared/ipc.js'
import { ElectronVaultAdapter } from '../src/renderer/vault/electron.js'
import { FsVault } from '../src/main/fsvault.js'
import {
  AI_DEFAULT_PORT,
  AI_HOST,
  AiLinkHost,
  aiSettings,
  claudeCodeCommand,
  claudeDesktopConfig,
  cleanPatch,
  describeStartError,
  isValidPort,
  linkUrl,
  newToken,
  quoteArg,
  serverArgs,
  type AiLinkHostOptions,
  type AiLinkSettings,
  type LinkVault,
  type McpModule,
} from '../src/main/ai-link.js'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('settings', () => {
  it('makes url-safe 32-character tokens', () => {
    const a = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(newToken()).not.toBe(a)
  })

  it('fills defaults: off, port 7457, read-write, a fresh token', () => {
    const s = aiSettings(undefined)
    expect(s).toMatchObject({ enabled: false, port: AI_DEFAULT_PORT, readOnly: false })
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('keeps valid stored values and repairs broken ones', () => {
    const token = newToken()
    expect(aiSettings({ enabled: true, port: 9000, token, readOnly: true })).toEqual({ enabled: true, port: 9000, token, readOnly: true })
    const bad = aiSettings({ enabled: 'yes', port: 80, token: 'short', readOnly: 1 })
    expect(bad.enabled).toBe(false)
    expect(bad.port).toBe(AI_DEFAULT_PORT)
    expect(bad.token).not.toBe('short')
    expect(bad.readOnly).toBe(false)
  })

  it('validates ports and cleans IPC patches', () => {
    expect(isValidPort(7457)).toBe(true)
    expect(isValidPort(80)).toBe(false)
    expect(isValidPort(70000)).toBe(false)
    expect(isValidPort(8000.5)).toBe(false)
    expect(cleanPatch({ enabled: true, port: '8123', readOnly: 'no', regenerateToken: true, extra: 1 })).toEqual({
      enabled: true,
      port: 8123,
      regenerateToken: true,
    })
    expect(cleanPatch(null)).toEqual({})
  })

  it('builds the local URL with the token path', () => {
    expect(linkUrl(AI_HOST, 7457, 'abc')).toBe('http://127.0.0.1:7457/mcp/abc')
  })
})

describe('client setups', () => {
  const win = {
    command: 'C:\\Users\\Dom\\AppData\\Local\\Programs\\Aether Brain\\Aether Brain.exe',
    serverScript: 'C:\\Users\\Dom\\AppData\\Local\\Programs\\Aether Brain\\resources\\app.asar.unpacked\\dist\\mcp\\aether-mcp.mjs',
    roots: ['D:\\', 'F:\\'],
    readOnly: false,
  }

  it('passes every root as --vault, then excludes and --read-only', () => {
    expect(serverArgs({ ...win, exclude: ['Backups'], readOnly: true })).toEqual([
      win.serverScript,
      '--vault',
      'D:\\',
      '--vault',
      'F:\\',
      '--exclude',
      'Backups',
      '--read-only',
    ])
  })

  it('writes a Claude Desktop mcpServers entry that runs this app as Node', () => {
    const cfg = JSON.parse(claudeDesktopConfig(win)) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
    }
    const entry = cfg.mcpServers['aether-brain']!
    expect(entry.command).toBe(win.command)
    expect(entry.args).toEqual([win.serverScript, '--vault', 'D:\\', '--vault', 'F:\\'])
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(JSON.parse(claudeDesktopConfig({ ...win, readOnly: true })).mcpServers['aether-brain'].args).toContain('--read-only')
  })

  it('quotes Windows arguments as PowerShell literals (a drive root keeps its backslash)', () => {
    expect(quoteArg('D:\\', 'win32')).toBe("'D:\\'")
    expect(quoteArg('C:\\Program Files\\x', 'win32')).toBe("'C:\\Program Files\\x'")
    expect(quoteArg("Dom's Notes", 'win32')).toBe("'Dom''s Notes'")
    // PowerShell also ends a single-quoted string at typographic quotes: doubled too.
    expect(quoteArg('Dom\u2019s \u2018x\u2019', 'win32')).toBe("'Dom\u2019\u2019s \u2018\u2018x\u2019\u2019'")
  })

  it('never lets PowerShell expand $, $(…), backticks or % inside a Windows argument', () => {
    // Double quotes would expand these: `$Notes` to '' (the root widened to D:\), `$(…)` runs code, `t is a tab.
    for (const root of ['D:\\$Notes', 'F:\\Art$(Write-Host INJECTED)', 'E:\\Work`tNotes', 'G:\\100%done%']) {
      expect(quoteArg(root, 'win32')).toBe(`'${root}'`)
    }
    const cmd = claudeCodeCommand({ ...win, roots: ['D:\\$Notes', 'F:\\Art$(Write-Host INJECTED)'] }, 'win32')
    expect(cmd).toContain("--vault 'D:\\$Notes' --vault 'F:\\Art$(Write-Host INJECTED)'")
    expect(cmd).not.toContain('"')
  })

  it('single-quotes arguments for POSIX shells so nothing expands', () => {
    expect(quoteArg('/home/me/My $notes', 'linux')).toBe("'/home/me/My $notes'")
    expect(quoteArg('/a/"b"/`c`/wow!', 'darwin')).toBe("'/a/\"b\"/`c`/wow!'")
    expect(quoteArg("/home/me/Dom's", 'linux')).toBe("'/home/me/Dom'\\''s'")
  })

  it.skipIf(process.platform === 'win32')('hands every argument to a real sh unchanged', () => {
    const args = ['/home/me/$HOME', '/a/$(echo INJECTED)', '/b/`id`', "/c/Dom's \"notes\"", '/d/wow!x', '/e/back\\slash', '/f/%x%']
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${args.map((a) => quoteArg(a, process.platform)).join(' ')}`], {
      encoding: 'utf8',
    })
    expect(out.split('\n').slice(0, -1)).toEqual(args)
  })

  it('builds a claude mcp add command with the env var before --', () => {
    const cmd = claudeCodeCommand({ ...win, readOnly: true }, 'win32')
    expect(cmd).toBe(
      'claude mcp add aether-brain --scope user -e ELECTRON_RUN_AS_NODE=1 -- ' +
        `'${win.command}' '${win.serverScript}' --vault 'D:\\' --vault 'F:\\' --read-only`,
    )
  })

  it('explains start failures in words', () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
    expect(describeStartError(inUse, 7457)).toMatch(/Port 7457 is already in use/)
    expect(describeStartError(new Error('boom'), 7457)).toMatch(/boom/)
  })
})

/* ------------------------------------------------------------------ */
/* Host lifecycle with a fake server module                           */
/* ------------------------------------------------------------------ */

type BrainOpts = Parameters<McpModule['Brain']['open']>[0]
type LinkOpts = Parameters<McpModule['startHttpLink']>[0]

function fakeServer() {
  const log = {
    opens: [] as BrainOpts[],
    links: [] as LinkOpts[],
    applied: [] as VaultChangeDto[][],
    closedLinks: 0,
    closedBrains: 0,
  }
  let busyPort: number | null = null
  let gate: Promise<void> | null = null
  const mod: McpModule = {
    Brain: {
      async open(opts) {
        log.opens.push(opts)
        if (gate) await gate
        return {
          applyExternal: (c) => void log.applied.push(c),
          close: () => void log.closedBrains++,
        }
      },
    },
    async startHttpLink(opts) {
      if (opts.port === busyPort) throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
      log.links.push(opts)
      return {
        url: `http://${opts.host}:${opts.port}/mcp`,
        port: opts.port,
        close: async () => void log.closedLinks++,
      }
    },
  }
  return {
    mod,
    log,
    busy: (p: number | null) => (busyPort = p),
    /** Hold Brain.open until the returned function is called. */
    hold: () => {
      let release!: () => void
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
  }
}

const VAULT: LinkVault = { roots: ['/v/notes'], exclude: [] }
const PRELOAD = { files: [{ path: 'a.md', content: '# A', mtime: 1 }], folders: [] }

function makeHost(settings: Partial<AiLinkSettings> = {}, over: Partial<AiLinkHostOptions> = {}) {
  const server = fakeServer()
  const saved: AiLinkSettings[] = []
  const activity: AiActivityDto[] = []
  let current: LinkVault | null = VAULT
  const host = new AiLinkHost({
    settings: { ...aiSettings(undefined), ...settings },
    save: (s) => void saved.push(s),
    onActivity: (a) => void activity.push(a),
    currentVault: () => current,
    bundlePath: '/nowhere/aether-mcp.mjs',
    serverScript: '/app/resources/app.asar.unpacked/dist/mcp/aether-mcp.mjs',
    execPath: '/app/aether-brain',
    portable: false,
    platform: 'linux',
    load: async () => server.mod,
    ...over,
  })
  return { host, server, saved, activity, setCurrent: (v: LinkVault | null) => (current = v) }
}

describe('AiLinkHost', () => {
  it('stays off until enabled, then opens the brain from the preload and listens on 127.0.0.1', async () => {
    const { host, server, saved } = makeHost()
    let st = await host.setVault(VAULT, PRELOAD)
    expect(st.running).toBe(false)
    expect(server.log.opens).toHaveLength(0)

    st = await host.configure({ enabled: true })
    expect(saved.at(-1)?.enabled).toBe(true)
    expect(st.running).toBe(true)
    // The preload was dropped while the link was off, so the brain scans for itself.
    expect(server.log.opens[0]).toEqual({ roots: ['/v/notes'], exclude: [], watch: false })
    expect(server.log.links[0]).toMatchObject({ host: '127.0.0.1', port: AI_DEFAULT_PORT, token: st.token, readOnly: false })
    expect(st.url).toBe(`http://127.0.0.1:${AI_DEFAULT_PORT}/mcp/${st.token}`)
    expect(JSON.parse(st.claudeDesktopConfig).mcpServers['aether-brain'].args).toEqual([
      '/app/resources/app.asar.unpacked/dist/mcp/aether-mcp.mjs',
      '--vault',
      '/v/notes',
    ])
    expect(st.serverScript).toBe('/app/resources/app.asar.unpacked/dist/mcp/aether-mcp.mjs')
  })

  it('hands the preload to the brain when enabled at read time', async () => {
    const { host, server } = makeHost({ enabled: true })
    const st = await host.setVault(VAULT, PRELOAD)
    expect(st.running).toBe(true)
    expect(server.log.opens[0]).toEqual({ roots: ['/v/notes'], exclude: [], watch: false, preload: PRELOAD })
  })

  it('replays watcher batches that arrive while the brain opens, then feeds it directly', async () => {
    const { host, server } = makeHost({ enabled: true })
    const release = server.hold()
    const started = host.setVault(VAULT, PRELOAD)
    await new Promise((r) => setTimeout(r, 0))
    const early: VaultChangeDto[] = [{ kind: 'change', path: 'a.md', content: '# A2', mtime: 2 }]
    host.applyExternal(early)
    expect(server.log.applied).toHaveLength(0)
    release()
    await started
    expect(server.log.applied).toEqual([early])
    const late: VaultChangeDto[] = [{ kind: 'addDir', path: 'Planet' }]
    host.applyExternal(late)
    expect(server.log.applied).toEqual([early, late])
  })

  it('restarts only the HTTP link for link settings, and the brain for a new vault', async () => {
    const { host, server } = makeHost({ enabled: true })
    await host.setVault(VAULT, PRELOAD)
    let st = await host.configure({ readOnly: true })
    expect(server.log.opens).toHaveLength(1)
    expect(server.log.closedLinks).toBe(1)
    expect(server.log.links.at(-1)?.readOnly).toBe(true)
    expect(st.readOnly).toBe(true)

    const oldToken = st.token
    st = await host.configure({ regenerateToken: true })
    expect(st.token).not.toBe(oldToken)
    expect(server.log.links.at(-1)?.token).toBe(st.token)

    const other: LinkVault = { roots: ['D:\\', 'F:\\'], exclude: ['Backups'] }
    await host.setVault(null)
    expect(server.log.closedBrains).toBe(1)
    st = await host.setVault(other, PRELOAD)
    expect(st.running).toBe(true)
    expect(server.log.opens.at(-1)).toMatchObject({ roots: ['D:\\', 'F:\\'], exclude: ['Backups'], preload: PRELOAD })
  })

  it('reports a taken port as an error instead of throwing, and recovers on another port', async () => {
    const { host, server } = makeHost({ enabled: true })
    server.busy(AI_DEFAULT_PORT)
    let st = await host.setVault(VAULT, PRELOAD)
    expect(st.running).toBe(false)
    expect(st.error).toMatch(/Port 7457 is already in use/)
    st = await host.configure({ port: 7460 })
    expect(st.running).toBe(true)
    expect(st.error).toBeNull()
    expect(st.port).toBe(7460)
    // The brain opened once and was kept across the retry.
    expect(server.log.opens).toHaveLength(1)
  })

  it('rejects invalid ports without changing anything', async () => {
    const { host, saved } = makeHost()
    await expect(host.configure({ port: 80 })).rejects.toThrow(/1024 to 65535/)
    expect(saved).toHaveLength(0)
    expect(host.status().port).toBe(AI_DEFAULT_PORT)
  })

  it('says so when the server bundle is missing', async () => {
    const { host } = makeHost({ enabled: true }, { load: undefined, bundlePath: path.join(here, 'no-such-bundle.mjs') })
    const st = await host.setVault(VAULT, PRELOAD)
    expect(st.running).toBe(false)
    expect(st.error).toMatch(/AI link server is missing/)
  })

  it('closes a brain that finished opening after the vault changed', async () => {
    const { host, server } = makeHost({ enabled: true })
    const release = server.hold()
    const first = host.setVault(VAULT, PRELOAD)
    await new Promise((r) => setTimeout(r, 0))
    const second = host.setVault({ roots: ['/v/other'], exclude: [] }, PRELOAD)
    release()
    await first
    const st = await second
    expect(server.log.closedBrains).toBe(1)
    expect(server.log.opens.map((o) => o.roots[0])).toEqual(['/v/notes', '/v/other'])
    expect(st.running).toBe(true)
  })

  it('forwards activity and stops everything on quit', async () => {
    const { host, server, activity } = makeHost({ enabled: true })
    await host.setVault(VAULT, PRELOAD)
    server.log.links[0]!.onActivity?.({ client: 'Claude', tool: 'create_note', summary: 'created "Portal ideas"', path: 'Inbox/Portal ideas.md', write: true })
    expect(activity).toEqual([{ client: 'Claude', tool: 'create_note', summary: 'created "Portal ideas"', path: 'Inbox/Portal ideas.md', write: true }])
    await host.stop()
    expect(server.log.closedLinks).toBe(1)
    expect(server.log.closedBrains).toBe(1)
    expect(host.status().running).toBe(false)
  })
})

describe('preload', () => {
  it('keeps its local IPC channel map in sync with shared/ipc.ts', async () => {
    const src = await fs.readFile(path.join(here, '..', 'src', 'preload', 'preload.cts'), 'utf8')
    const block = /const IPC = \{([\s\S]*?)\} as const/.exec(src)?.[1] ?? ''
    const local = Object.fromEntries([...block.matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]))
    expect(local).toEqual({ ...IPC })
  })
})

/* ------------------------------------------------------------------ */
/* Renderer: the Electron vault adapter and the panels' helpers       */
/* ------------------------------------------------------------------ */

const INFO: VaultInfo = { root: '/v/notes', name: 'notes', roots: [{ path: '/v/notes', mount: '', label: 'notes' }], exclude: [] }

/** The bridge calls the adapter uses, with change events the test fires. */
function fakeBridge(files: VaultFileDto[]) {
  const subs = new Set<(c: VaultChangeDto[]) => void>()
  let whileListing: (() => void) | null = null
  let listError: Error | null = null
  const bridge = {
    listFiles: async () => {
      whileListing?.()
      if (listError) throw listError
      return files
    },
    listFolders: async () => ({ folders: [], truncated: false }),
    onChanges: (cb: (c: VaultChangeDto[]) => void) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
  } as unknown as AetherBridge
  return {
    bridge,
    subs,
    emit: (c: VaultChangeDto[]) => {
      for (const cb of [...subs]) cb(c)
    },
    onList: (fn: () => void) => (whileListing = fn),
    failList: (err: Error) => (listError = err),
  }
}

/** localStorage for the store in the node test environment. */
function stubStorage(): void {
  const map = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  })
}

describe('ElectronVaultAdapter', () => {
  it('keeps changes main reports during a load and hands them to the first watcher, in order', async () => {
    const f = fakeBridge([{ path: 'a.md', content: '# A', mtime: 1 }])
    const a = new ElectronVaultAdapter(f.bridge, INFO)
    // Main starts watching while it reads: one batch arrives before listFiles resolves, one after.
    f.onList(() => f.emit([{ kind: 'change', path: 'a.md', content: '# A2', mtime: 2 }]))
    await a.list()
    f.emit([{ kind: 'add', path: 'b.md', content: '# B', mtime: 3 }])
    const got: VaultChange[][] = []
    a.watch((c) => void got.push(c))
    expect(got).toEqual([
      [
        { kind: 'change', path: 'a.md', content: '# A2', mtime: 2 },
        { kind: 'add', path: 'b.md', content: '# B', mtime: 3 },
      ],
    ])
    // Live from here on, and the holding subscription is gone.
    expect(f.subs.size).toBe(1)
    f.emit([{ kind: 'unlink', path: 'b.md' }])
    expect(got.at(-1)).toEqual([{ kind: 'unlink', path: 'b.md' }])
  })

  it('stops holding when the listing fails, and holds once per load', async () => {
    const f = fakeBridge([])
    const a = new ElectronVaultAdapter(f.bridge, INFO)
    await a.list()
    await a.list()
    expect(f.subs.size).toBe(1)
    f.failList(new Error('No vault open'))
    await expect(a.list()).rejects.toThrow(/No vault open/)
    expect(f.subs.size).toBe(0)
  })

  it('passes picture changes through untouched, while a load holds them and live', async () => {
    const f = fakeBridge([])
    const a = new ElectronVaultAdapter(f.bridge, INFO)
    f.onList(() => f.emit([{ kind: 'add', path: 'Art/gate.png', mtime: 5, size: 1234 }]))
    await a.list()
    const got: VaultChange[][] = []
    a.watch((c) => void got.push(c))
    f.emit([{ kind: 'change', path: 'Art/gate.png', mtime: 6, size: 2048 }, { kind: 'unlink', path: 'Art/old.webp' }])
    expect(got).toEqual([
      [{ kind: 'add', path: 'Art/gate.png', mtime: 5, size: 1234 }],
      [
        { kind: 'change', path: 'Art/gate.png', mtime: 6, size: 2048 },
        { kind: 'unlink', path: 'Art/old.webp' },
      ],
    ])
  })

  it('lists pictures, turns thumbnail bytes into PNG blobs, creates and opens pictures through main', async () => {
    const f = fakeBridge([])
    const calls: unknown[][] = []
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    Object.assign(f.bridge, {
      listAssets: async () => ({ assets: [{ path: 'Art/gate.png', mtime: 1, size: 7 }, { path: 'b.jpg' }], truncated: true }),
      thumbnail: async (p: string, size: number) => {
        calls.push(['thumbnail', p, size])
        return p === 'Art/gate.png' ? png : p === 'empty.png' ? new Uint8Array(0) : null
      },
      createAsset: async (p: string, data: Uint8Array) => {
        calls.push(['createAsset', p, data.length])
        if (p === 'Art/taken.png') throw new Error('EEXIST: something already exists at Art/taken.png')
      },
      openAsset: async (p: string) => void calls.push(['openAsset', p]),
    })
    const a = new ElectronVaultAdapter(f.bridge, INFO)
    expect(await a.listAssets()).toEqual([{ path: 'Art/gate.png', mtime: 1, size: 7 }, { path: 'b.jpg' }])
    expect(a.assetsTruncated).toBe(true)
    const blob = await a.thumbnail('Art/gate.png', 128)
    expect(blob?.type).toBe('image/png')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(png)
    expect(await a.thumbnail('missing.png', 128)).toBeNull()
    expect(await a.thumbnail('empty.png', 128)).toBeNull()
    // A new picture is reported to the app's watchers right away (main's watcher confirms it later).
    const got: VaultChange[][] = []
    a.watch((c) => void got.push(c))
    await a.createAsset('Art/new.png', png)
    expect(got).toEqual([[{ kind: 'add', path: 'Art/new.png', mtime: expect.any(Number), size: png.length }]])
    await expect(a.createAsset('Art/taken.png', png)).rejects.toThrow(/EEXIST/)
    expect(got).toHaveLength(1)
    await a.openAsset('Art/gate.png')
    expect(calls).toEqual([
      ['thumbnail', 'Art/gate.png', 128],
      ['thumbnail', 'missing.png', 128],
      ['thumbnail', 'empty.png', 128],
      ['createAsset', 'Art/new.png', png.length],
      ['createAsset', 'Art/taken.png', png.length],
      ['openAsset', 'Art/gate.png'],
    ])
  })

  it("creates new notes through main's create-only path and never replaces a file the store has not loaded", async () => {
    stubStorage()
    const { useAether } = await import('@aether/ui')
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-create-'))
    const at = (rel: string) => path.join(tmp, ...rel.split('/'))
    const history = '# Changelog\n\n## 1.0\n- important history\n'
    try {
      await fs.mkdir(at('Code/Game'), { recursive: true })
      await fs.mkdir(at('Inbox'))
      await fs.writeFile(at('Code/Game/CHANGELOG.md'), history)
      await fs.writeFile(at('Code/Game/Design.md'), '# Design\n')
      await fs.writeFile(at('Inbox/Other.md'), '# Other\n')
      const v = new FsVault([tmp])
      const calls: string[] = []
      // Main's handlers as the preload reaches them: a rejection crosses IPC with its message only.
      const ipc = <T>(channel: string, run: () => Promise<T>): Promise<T> =>
        run().catch((err: unknown) => {
          throw new Error(`Error invoking remote method '${channel}': ${String(err)}`)
        })
      const bridge = {
        listFiles: async () => v.readAll((await v.scan()).files),
        listFolders: async () => ({ folders: v.lastScan?.folders ?? [], truncated: false }),
        readFile: (p: string) => ipc(IPC.read, () => v.read(p)),
        writeFile: (p: string, c: string) => {
          calls.push(`write ${p}`)
          return ipc(IPC.write, () => v.write(p, c))
        },
        createFile: (p: string, c: string) => {
          calls.push(`create ${p}`)
          return ipc(IPC.create, () => v.create(p, c))
        },
        onChanges: () => () => undefined,
      } as unknown as AetherBridge
      const info: VaultInfo = { root: tmp, name: 'vault', roots: [{ path: tmp, mount: '', label: 'vault' }], exclude: [] }
      const s = () => useAether.getState()
      await s().openVault(new ElectronVaultAdapter(bridge, info))
      // Written by another app after the load, not reported yet.
      await fs.writeFile(at('Inbox/Buy milk.md'), 'AI wrote this')
      // Repo boilerplate the brain skips, the unreported note, and the unreported note in another letter case.
      const made = [await s().createNote('Code/Game', 'CHANGELOG'), await s().capture('Buy milk'), await s().capture('buy MILK')]
      expect(await fs.readFile(at('Code/Game/CHANGELOG.md'), 'utf8')).toBe(history)
      expect(await fs.readFile(at('Inbox/Buy milk.md'), 'utf8')).toBe('AI wrote this')
      expect(made.every((id) => id && s().notes.has(id))).toBe(true)
      expect(made.map((id) => id?.toLowerCase())).not.toContain('inbox/buy milk')
      expect(made[0]).not.toBe('Code/Game/CHANGELOG')
      // Every new note went through create, none through write.
      expect(calls.filter((c) => c.startsWith('write '))).toEqual([])
      expect(calls.filter((c) => c.startsWith('create ')).length).toBeGreaterThanOrEqual(4)
      expect((await fs.readdir(at('Inbox'))).length).toBe(4)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it('lets the store see a note written while the vault was loading', async () => {
    stubStorage()
    const { useAether } = await import('@aether/ui')
    const f = fakeBridge([{ path: 'a.md', content: '# A', mtime: 1 }])
    f.onList(() => f.emit([{ kind: 'add', path: 'Inbox/From Claude.md', content: '# From Claude', mtime: 2 }]))
    await useAether.getState().openVault(new ElectronVaultAdapter(f.bridge, INFO))
    expect(useAether.getState().status).toBe('ready')
    expect([...useAether.getState().notes.keys()].sort()).toEqual(['Inbox/From Claude', 'a'])
  })
})

describe('panels helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tells a failed tool call from a successful one', async () => {
    stubStorage()
    const { activityFailed } = await import('../src/renderer/panels.js')
    expect(activityFailed({ tool: 'create_note', summary: 'create_note failed: "Portal ideas" already exists' })).toBe(true)
    expect(activityFailed({ tool: 'create_note', summary: 'created "Portal ideas"' })).toBe(false)
    expect(activityFailed({ tool: '', summary: ' failed: x' })).toBe(false)
  })

  it('saves the open note before a reopen, and says so when it cannot', async () => {
    stubStorage()
    const { useAether } = await import('@aether/ui')
    const { saveOpenNote } = await import('../src/renderer/panels.js')
    class Flaky extends MemoryVaultAdapter {
      broken = false
      override async write(p: string, content: string): Promise<void> {
        if (this.broken) throw new Error('disk is locked')
        return super.write(p, content)
      }
    }
    const vault = new Flaky([{ path: 'x.md', content: '# X\n', mtime: 1 }])
    const s = () => useAether.getState()
    await s().openVault(vault)
    s().openNote('x', { fly: false })
    s().setDraft('# X\n\nedited\n')
    expect(s().dirty).toBe(true)
    expect(await saveOpenNote()).toBe(true)
    expect(await vault.read('x.md')).toContain('edited')

    vault.broken = true
    s().setDraft('# X\n\nedited again\n')
    expect(await saveOpenNote()).toBe(false)
    expect(s().dirty).toBe(true)
  })
})
