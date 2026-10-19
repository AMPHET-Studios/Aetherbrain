import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { TunnelStatusDto } from '../src/shared/ipc.js'
import { CLOUDFLARED_VERSION, TunnelHost, cloudflaredAsset, findOnPath, tunnelCommand, tunnelEnv, tunnelUrlIn, type CloudflaredAsset, type TunnelHostOptions } from '../src/main/tunnel.js'
import { lf } from './lf'

/**
 * The tunnel button: cloudflared found or downloaded (a pinned file, a pinned SHA-256), started on the link's port on this computer
 * only, its address read from what it prints, and stopped when asked, when the link goes, when the app quits, and when a crashed
 * app left one behind. A fake process and a fake network test the logic; small real programs test the parts a fake cannot (a
 * process that dies, hangs, or must be told to end).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
const ADDRESS = 'https://quiet-river-test.trycloudflare.com'

let tmp: string
let bin: string
let data: string
const cleanups: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-tunnel-'))
  bin = path.join(tmp, 'bin')
  data = path.join(tmp, 'data')
  await fs.mkdir(bin)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0)) await c()
  await fs.rm(tmp, { recursive: true, force: true })
})

/** A cloudflared on the PATH (any file will do: what runs is the test's own stand-in). */
async function putOnPath(): Promise<void> {
  await fs.writeFile(path.join(bin, EXE), 'not really a program')
}

/** A process that is not one: what the host spawns, with the parts the host listens to. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  constructor(readonly pid: number | undefined = undefined) {
    super()
  }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }
  say(text: string, to: 'stdout' | 'stderr' = 'stderr'): void {
    this[to].write(text)
  }
}

function fakeHost(over: Partial<TunnelHostOptions> = {}) {
  const child = new FakeChild(undefined)
  const spawned: { file: string; args: string[]; opts: any }[] = []
  const states: TunnelStatusDto[] = []
  const host = new TunnelHost({
    dir: data,
    fetch: async () => {
      throw new Error('no network in this test')
    },
    emit: (s) => states.push(s),
    env: { PATH: bin },
    spawn: ((file: string, args: string[], opts: unknown) => {
      spawned.push({ file, args, opts })
      return child
    }) as unknown as TunnelHostOptions['spawn'],
    ...over,
  })
  return { host, child, spawned, states }
}

const BOX = ['2026-10-18T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...', '+--------------------------------------------------------------------------------------------+', `|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |`, `|  ${ADDRESS}                                                                                |`, '+--------------------------------------------------------------------------------------------+']

/* ----------------------------------------------------------------------- */
/* The small pure parts                                                     */
/* ----------------------------------------------------------------------- */

describe('reading the address', () => {
  it('finds the quick tunnel’s address in the lines cloudflared prints, in any case', () => {
    expect(tunnelUrlIn(BOX[3]!)).toBe(ADDRESS)
    expect(tunnelUrlIn('visit HTTPS://Quiet-River-Test.TryCloudflare.com now')).toBe(ADDRESS)
    expect(tunnelUrlIn('INF nothing here')).toBeNull()
    expect(tunnelUrlIn('')).toBeNull()
  })

  it('never takes cloudflare’s own API host for a tunnel, nor any other site', () => {
    expect(tunnelUrlIn('ERR Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com failed')).toBeNull()
    expect(tunnelUrlIn('https://api.trycloudflare.com then https://real-one.trycloudflare.com')).toBe('https://real-one.trycloudflare.com')
    expect(tunnelUrlIn('https://example.com/x.trycloudflare.com')).toBeNull()
    expect(tunnelUrlIn('http://plain-http.trycloudflare.com')).toBeNull()
    expect(tunnelUrlIn('https://evil.com/https://x.trycloudflare.com.evil.com')).toBe('https://x.trycloudflare.com')
  })
})

describe('what is downloaded', () => {
  it('is one pinned release for Windows x64, and nothing for the systems where the user installs cloudflared', () => {
    const a = cloudflaredAsset('win32', 'x64')!
    expect(a).toEqual({
      file: 'cloudflared-windows-amd64.exe',
      url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
      sha256: '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
      bytes: 55_325_120,
    })
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(new URL(a.url).protocol).toBe('https:')
    expect(new URL(a.url).host).toBe('github.com')
    for (const [platform, arch] of [['win32', 'arm64'], ['win32', 'ia32'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'], ['linux', 'arm64']] as const) {
      expect(cloudflaredAsset(platform, arch), `${platform} ${arch}`).toBeNull()
    }
  })
})

describe('what is run', () => {
  it('points cloudflared at the link’s port on this computer, nothing else, with no auto-update', () => {
    expect(tunnelCommand('/bin/cloudflared', 7461)).toEqual({ file: '/bin/cloudflared', args: ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7461'] })
  })

  it('gives it our environment without a TUNNEL_ setting, which would change what it runs', () => {
    const env = tunnelEnv({ PATH: '/bin', TUNNEL_TOKEN: 'secret', tunnel_origin_cert: 'x', Tunnel_Url: 'y', HOME: '/h', EMPTY: undefined })
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' })
  })
})

describe('looking for cloudflared on the PATH', () => {
  it('takes the first one in order, and only from a whole path', async () => {
    const a = path.join(tmp, 'a')
    const b = path.join(tmp, 'b')
    await fs.mkdir(a)
    await fs.mkdir(b)
    await fs.writeFile(path.join(b, EXE), 'b')
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(await findOnPath(EXE, `${a}${sep}${b}`)).toBe(path.join(b, EXE))
    await fs.writeFile(path.join(a, EXE), 'a')
    expect(await findOnPath(EXE, `${a}${sep}${b}`)).toBe(path.join(a, EXE))
    // An empty entry and a relative one (the current folder) are not looked in: a program in `.` is not on the PATH.
    expect(await findOnPath(EXE, `${sep}.${sep}bin`)).toBeNull()
    expect(await findOnPath(EXE, undefined)).toBeNull()
    expect(await findOnPath(EXE, '')).toBeNull()
  })

  it('does not look in a folder that is only a relative name: that is wherever the app happens to run from', async () => {
    await putOnPath()
    const rel = path.relative(process.cwd(), bin)
    // On another drive there is no relative way to name it (the test cannot make the case).
    if (path.isAbsolute(rel)) return
    expect(path.isAbsolute(rel)).toBe(false)
    expect(await findOnPath(EXE, rel)).toBeNull()
    expect(await findOnPath(EXE, bin)).toBe(path.join(bin, EXE))
  })

  it('does not take a folder for a program, and reads quoted entries on Windows', async () => {
    await fs.mkdir(path.join(bin, EXE))
    expect(await findOnPath(EXE, bin)).toBeNull()
    if (process.platform === 'win32') {
      await fs.rm(path.join(bin, EXE), { recursive: true })
      await fs.writeFile(path.join(bin, EXE), 'x')
      expect(await findOnPath(EXE, `"${bin}"`, 'win32')).toBe(path.join(bin, EXE))
    }
  })
})

/* ----------------------------------------------------------------------- */
/* Starting and stopping, with a fake process                               */
/* ----------------------------------------------------------------------- */

describe('starting the tunnel', () => {
  it('runs cloudflared on the link’s port, says it is starting, and says on when the address appears', async () => {
    await putOnPath()
    const { host, child, spawned, states } = fakeHost()
    const first = await host.start(7461)
    expect(first).toMatchObject({ state: 'starting', url: null, error: null, program: 'path' })
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.file).toBe(path.join(bin, EXE))
    expect(spawned[0]!.args).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7461'])
    expect(spawned[0]!.opts).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const line of BOX) child.say(`${line}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('on'))
    expect(states.map((s) => s.state)).toEqual(['starting', 'on'])
    expect(states.at(-1)).toMatchObject({ url: ADDRESS, error: null })
    expect((await host.status()).url).toBe(ADDRESS)
  })

  it('reads an address that arrives in pieces, and from stdout as well as stderr', async () => {
    await putOnPath()
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.say('|  https://quiet-riv', 'stdout')
    child.say('er-test.trycloudflare.com   |', 'stdout')
    expect(states.at(-1)?.state).toBe('starting')
    child.say('\n', 'stdout')
    await vi.waitFor(() => expect(states.at(-1)?.url).toBe(ADDRESS))
  })

  it('is not fooled by the API address in an error line', async () => {
    await putOnPath()
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.say('ERR Post "https://api.trycloudflare.com/tunnel": dial tcp: no such host\n')
    await new Promise((r) => setTimeout(r, 20))
    expect(states.at(-1)?.state).toBe('starting')
    child.say(`${BOX[3]}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.url).toBe(ADDRESS))
  })

  it('starts one process for two presses, even at once', async () => {
    await putOnPath()
    const { host, spawned } = fakeHost()
    await Promise.all([host.start(7461), host.start(7461)])
    await host.start(7461)
    expect(spawned).toHaveLength(1)
  })

  it('refuses a port that is no port, and says what is missing when there is no cloudflared', async () => {
    const { host, spawned } = fakeHost({ platform: 'win32', arch: 'x64' })
    await expect(host.start(80)).rejects.toThrow(/no usable port/)
    await expect(host.start(Number.NaN)).rejects.toThrow(/no usable port/)
    await expect(host.start(7461)).rejects.toThrow('cloudflared is not on this computer yet: download it first.')
    const other = fakeHost({ platform: 'linux', arch: 'x64' })
    await expect(other.host.start(7461)).rejects.toThrow(/Install it \(for example `brew install cloudflared`\)/)
    expect(spawned).toHaveLength(0)
    expect(other.spawned).toHaveLength(0)
  })

  it('says why when the program cannot start, and never lets the error go unheard', async () => {
    await putOnPath()
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))
    expect(states.at(-1)).toMatchObject({ state: 'off', url: null })
    expect(states.at(-1)?.error).toBe('cloudflared could not start: spawn cloudflared ENOENT')
  })

  it('says why when spawning itself throws', async () => {
    await putOnPath()
    const { host } = fakeHost({
      spawn: (() => {
        throw new Error('spawn UNKNOWN')
      }) as unknown as TunnelHostOptions['spawn'],
    })
    await expect(host.start(7461)).rejects.toThrow('cloudflared could not start: spawn UNKNOWN')
    expect(await host.status()).toMatchObject({ state: 'off', error: 'cloudflared could not start: spawn UNKNOWN' })
  })

  it('gives up when no address comes, and ends the process', async () => {
    await putOnPath()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.say('INF Requesting new quick Tunnel on trycloudflare.com...\n')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(states.at(-1)?.state).toBe('starting')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.killed).toBe(true)
    expect(states.at(-1)).toMatchObject({ state: 'off', url: null })
    expect(states.at(-1)?.error).toMatch(/^The tunnel did not come up in time\. Is this computer online\?/)
    expect(states.at(-1)?.error).toContain('Requesting new quick Tunnel')
  })

  it('does not start the process again for a start that already has one', async () => {
    await putOnPath()
    const { host, spawned, child } = fakeHost()
    await host.start(7461)
    child.say(`${BOX[3]}\n`)
    await vi.waitFor(async () => expect((await host.status()).state).toBe('on'))
    await host.start(7461)
    expect(spawned).toHaveLength(1)
  })
})

describe('stopping and ending', () => {
  it('stops on request: the process is told to go before stop returns, and that is not an error', async () => {
    await putOnPath()
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.say(`${BOX[3]}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('on'))
    const stopped = host.stop()
    // Told synchronously: a quitting app does not get to wait.
    expect(child.killed).toBe(true)
    expect(await stopped).toMatchObject({ state: 'off', url: null, error: null })
    expect(states.at(-1)).toMatchObject({ state: 'off', url: null, error: null })
  })

  it('stopping with nothing running is quiet, and forgets an old error', async () => {
    await putOnPath()
    const { host, child } = fakeHost()
    await host.start(7461)
    child.emit('exit', 1, null)
    expect((await host.status()).error).toMatch(/exit code 1/)
    expect(await host.stop()).toMatchObject({ state: 'off', error: null })
  })

  it('says it ended by itself, with the last thing cloudflared said', async () => {
    await putOnPath()
    const { host, child, states } = fakeHost()
    await host.start(7461)
    child.say(`${BOX[3]}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('on'))
    child.say('ERR Unable to reach the origin service\nERR connection reset by peer\n')
    await new Promise((r) => setTimeout(r, 20))
    child.emit('exit', 1, null)
    expect(states.at(-1)).toMatchObject({ state: 'off', url: null })
    expect(states.at(-1)?.error).toBe('cloudflared stopped (exit code 1): ERR Unable to reach the origin service / ERR connection reset by peer')
  })

  it('can be started again after it stopped, with a fresh address', async () => {
    await putOnPath()
    const first = new FakeChild()
    const second = new FakeChild()
    const kids = [first, second]
    const { host, states } = fakeHost({ spawn: (() => kids.shift()!) as unknown as TunnelHostOptions['spawn'] })
    await host.start(7461)
    first.say(`${BOX[3]}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.url).toBe(ADDRESS))
    await host.stop()
    expect(states.at(-1)).toMatchObject({ state: 'off', url: null })
    await host.start(7462)
    second.say('|  https://another-name-test.trycloudflare.com  |\n')
    await vi.waitFor(() => expect(states.at(-1)?.url).toBe('https://another-name-test.trycloudflare.com'))
  })

  it('does not take an old process’s last words for the new one’s', async () => {
    await putOnPath()
    const first = new FakeChild()
    const second = new FakeChild()
    const kids = [first, second]
    const { host, states } = fakeHost({ spawn: (() => kids.shift()!) as unknown as TunnelHostOptions['spawn'] })
    await host.start(7461)
    await host.stop()
    await host.start(7461)
    first.say(`${BOX[3]}\n`)
    first.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 20))
    expect(states.at(-1)).toMatchObject({ state: 'starting', url: null })
    second.say(`${BOX[3]}\n`)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('on'))
  })
})

describe('which cloudflared runs', () => {
  const tiny = Buffer.from('a stand-in for the release, small enough to test')
  const TINY: CloudflaredAsset = { file: 'cloudflared-test', url: 'https://downloads.test/cloudflared-test', sha256: createHash('sha256').update(tiny).digest('hex'), bytes: tiny.length }
  const ownFile = () => path.join(data, EXE)

  async function putOwn(content: Buffer = tiny): Promise<void> {
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(ownFile(), content)
  }

  it('prefers one on the PATH to the app’s own copy', async () => {
    await putOnPath()
    await putOwn()
    const { host, spawned } = fakeHost({ assetFor: () => TINY })
    expect((await host.status()).program).toBe('path')
    await host.start(7461)
    expect(spawned[0]!.file).toBe(path.join(bin, EXE))
  })

  it('uses the app’s own copy when there is none on the PATH, after checking it is still the file that was downloaded', async () => {
    await putOwn()
    const { host, spawned } = fakeHost({ assetFor: () => TINY })
    expect((await host.status()).program).toBe('app')
    await host.start(7461)
    expect(spawned[0]!.file).toBe(ownFile())
  })

  it('throws away an own copy that changed since it was downloaded, and says to download it again', async () => {
    await putOwn()
    // Same size, other bytes: another program wrote into the folder.
    await fs.writeFile(ownFile(), Buffer.alloc(tiny.length, 0x41))
    const { host, spawned } = fakeHost({ assetFor: () => TINY })
    await expect(host.start(7461)).rejects.toThrow(/not the release any more.*Download it again/)
    expect(existsSync(ownFile())).toBe(false)
    expect(spawned).toHaveLength(0)
    expect((await host.status()).program).toBeNull()
  })

  it('does not count a file of the wrong size as the release', async () => {
    await putOwn(Buffer.from('short'))
    const { host } = fakeHost({ assetFor: () => TINY })
    expect((await host.status()).program).toBeNull()
  })
})

/* ----------------------------------------------------------------------- */
/* The download                                                             */
/* ----------------------------------------------------------------------- */

describe('downloading cloudflared', () => {
  const body = Buffer.from('this stands in for the cloudflared release: pinned by its size and its SHA-256 '.repeat(40))
  const ASSET: CloudflaredAsset = { file: 'cloudflared-test', url: 'https://downloads.test/cloudflared-test', sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length }
  const ownFile = () => path.join(data, EXE)
  const ok = (bytes: Buffer | Uint8Array, headers: Record<string, string> = {}) => new Response(bytes as BodyInit, { status: 200, headers: { 'content-length': String(bytes.length), ...headers } })

  function downloader(answer: (url: string) => Response | Promise<Response>) {
    const calls: string[] = []
    const made = fakeHost({
      assetFor: () => ASSET,
      env: { PATH: path.join(tmp, 'empty') },
      fetch: async (url) => {
        calls.push(url)
        return answer(url)
      },
    })
    return { ...made, calls }
  }

  it('says what it would download before it does, and where from', async () => {
    const { host } = downloader(() => ok(body))
    expect((await host.status()).download).toEqual({ file: 'cloudflared-test', mb: 0, from: `Cloudflare's release ${CLOUDFLARED_VERSION} on GitHub` })
    const real = fakeHost({ platform: 'win32', arch: 'x64' }).host
    expect((await real.status()).download).toEqual({ file: 'cloudflared-windows-amd64.exe', mb: 52.8, from: `Cloudflare's release ${CLOUDFLARED_VERSION} on GitHub` })
    expect((await fakeHost({ platform: 'linux', arch: 'x64' }).host.status()).download).toBeNull()
  })

  it('downloads the pinned address, keeps the file once its SHA-256 matches, and leaves no half file', async () => {
    const { host, states, calls } = downloader(() => ok(body))
    const done = await host.download()
    expect(calls).toEqual([ASSET.url])
    expect(done).toMatchObject({ program: 'app', downloading: null, error: null })
    expect(await fs.readFile(ownFile())).toEqual(body)
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
    // Progress was told, and ended.
    expect(states.some((s) => s.downloading !== null)).toBe(true)
    expect(states.at(-1)?.downloading).toBeNull()
    expect(states.filter((s) => s.downloading).every((s) => s.downloading!.total === body.length)).toBe(true)
  })

  it('throws away a file whose SHA-256 is not the pinned one, and says so', async () => {
    const { host } = downloader(() => ok(Buffer.alloc(body.length, 0x42)))
    await expect(host.download()).rejects.toThrow(/not the cloudflared release \(its SHA-256 differs\), so it was thrown away/)
    expect(existsSync(ownFile())).toBe(false)
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
    expect(await host.status()).toMatchObject({ program: null, downloading: null })
    expect((await host.status()).error).toMatch(/SHA-256 differs/)
  })

  it('stops a download that grows past the release, and one that stops short', async () => {
    const big = downloader(() => ok(Buffer.concat([body, Buffer.from('more')]), { 'content-length': String(body.length) }))
    await expect(big.host.download()).rejects.toThrow(/bigger than the cloudflared release/)
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
    expect(existsSync(ownFile())).toBe(false)
    const short = downloader(() => ok(body.subarray(0, 100), { 'content-length': String(body.length) }))
    await expect(short.host.download()).rejects.toThrow(/stopped early \(100 of \d+ bytes\)/)
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
  })

  it('refuses a server that announces another size', async () => {
    const { host } = downloader(() => new Response(body, { status: 200, headers: { 'content-length': '123' } }))
    await expect(host.download()).rejects.toThrow(/not the size of the cloudflared release/)
    expect(existsSync(ownFile())).toBe(false)
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
  })

  it('says when the server refuses, or cannot be reached', async () => {
    const refused = downloader(() => new Response('nope', { status: 404 }))
    await expect(refused.host.download()).rejects.toThrow('Could not download cloudflared (HTTP 404).')
    const offline = downloader(() => {
      throw new TypeError('fetch failed')
    })
    await expect(offline.host.download()).rejects.toThrow('fetch failed')
    expect((await offline.host.status()).downloading).toBeNull()
    expect(existsSync(`${ownFile()}.part`)).toBe(false)
  })

  it('downloads nothing when cloudflared is already there, on the PATH or the app’s own', async () => {
    await putOnPath()
    const calls: string[] = []
    const withPath = new TunnelHost({ dir: data, fetch: async (url) => (calls.push(url), ok(body)), emit: () => undefined, env: { PATH: bin }, assetFor: () => ASSET })
    expect(await withPath.download()).toMatchObject({ program: 'path', downloading: null })
    expect(calls).toEqual([])
    expect(existsSync(ownFile())).toBe(false)
    await fs.rm(path.join(bin, EXE))
    const first = downloader(() => ok(body))
    await first.host.download()
    await first.host.download()
    expect(first.calls).toHaveLength(1)
  })

  it('is not started while it downloads, and one download at a time', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { host, calls } = downloader(async () => {
      await gate
      return ok(body)
    })
    const first = host.download()
    await vi.waitFor(async () => expect((await host.status()).downloading).not.toBeNull())
    await expect(host.start(7461)).rejects.toThrow('cloudflared is still downloading.')
    expect(await host.download()).toMatchObject({ downloading: { total: body.length } })
    release()
    await first
    expect(calls).toHaveLength(1)
  })

  it('does not download where the app has no file for the system, and says what to do', async () => {
    const { host } = fakeHost({ platform: 'darwin', arch: 'arm64' })
    await expect(host.download()).rejects.toThrow(/does not download cloudflared for this system.*brew install cloudflared/)
  })
})

/* ----------------------------------------------------------------------- */
/* A tunnel an earlier run left behind                                      */
/* ----------------------------------------------------------------------- */

describe('finding a tunnel a crashed app left running', () => {
  async function pidFile(contents: string): Promise<void> {
    await fs.mkdir(data, { recursive: true })
    await fs.writeFile(path.join(data, 'tunnel.pid'), contents)
  }

  it('stops the process the pid file names when it is a cloudflared, and forgets the file', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    await pidFile('4242')
    const { host } = fakeHost({ processName: async (pid) => (pid === 4242 ? 'cloudflared.exe' : null) })
    await host.reap()
    expect(kill).toHaveBeenCalledWith(4242)
    expect(existsSync(path.join(data, 'tunnel.pid'))).toBe(false)
  })

  it('never stops a process that is not a cloudflared (the number may belong to something else by now)', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    for (const name of ['node.exe', 'cloudflared-helper.exe', 'notcloudflared', 'Cloudflared.exe.exe', null]) {
      await pidFile('4242')
      await fakeHost({ processName: async () => name }).host.reap()
    }
    expect(kill).not.toHaveBeenCalled()
  })

  it('does nothing for a file that is no pid, a pid that cannot be one, or no file', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const named = vi.fn(async () => 'cloudflared.exe')
    for (const text of ['', 'abc', '0', '1', '-5', '1.5', '12 34']) {
      await pidFile(text)
      await fakeHost({ processName: named }).host.reap()
      expect(existsSync(path.join(data, 'tunnel.pid')), text).toBe(false)
    }
    await fakeHost({ processName: named }).host.reap()
    expect(kill).not.toHaveBeenCalled()
    expect(named).not.toHaveBeenCalled()
  })

  it('is a quiet no-op when the process is already gone', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    await pidFile('4242')
    await expect(fakeHost({ processName: async () => 'cloudflared.exe' }).host.reap()).resolves.toBeUndefined()
  })
})

/* ----------------------------------------------------------------------- */
/* Real processes                                                           */
/* ----------------------------------------------------------------------- */

describe('with real processes', () => {
  /** A stand-in for cloudflared: records how it was run, prints what the real one prints, then does `then`. */
  async function stand(then: string): Promise<{ command: TunnelHostOptions['command']; ran: string }> {
    const script = path.join(tmp, 'stand-in.cjs')
    const ran = path.join(tmp, 'ran.json')
    await fs.writeFile(
      script,
      `const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(ran)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.TUNNEL_TOKEN ?? null, path: !!process.env.PATH }))
process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n')
${then}`,
    )
    return {
      ran,
      command: (program, port) => {
        const c = tunnelCommand(program, port)
        return { file: process.execPath, args: [script, ...c.args] }
      },
    }
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const ADDRESS_LINES = `process.stderr.write('+----+\\n|  ${ADDRESS}  |\\n+----+\\n')`

  function realHost(command: TunnelHostOptions['command'], over: Partial<TunnelHostOptions> = {}) {
    const states: TunnelStatusDto[] = []
    const host = new TunnelHost({
      dir: data,
      fetch: async () => {
        throw new Error('no network in this test')
      },
      emit: (s) => states.push(s),
      env: { ...process.env, PATH: bin, TUNNEL_TOKEN: 'must-not-reach-it' },
      command,
      ...over,
    })
    cleanups.push(() => host.stop().then(() => undefined))
    return { host, states }
  }

  it('runs, shows its address, is killed on stop, and leaves no pid file', async () => {
    await putOnPath()
    const s = await stand(`${ADDRESS_LINES}\nsetInterval(() => {}, 1000)`)
    const { host, states } = realHost(s.command)
    await host.start(7461)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('on'), { timeout: 10_000 })
    expect(states.at(-1)?.url).toBe(ADDRESS)
    // How it was run: the link's port on this computer, no TUNNEL_ setting.
    const ran = JSON.parse(await fs.readFile(s.ran, 'utf8'))
    expect(ran.args).toEqual(['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7461'])
    expect(ran.token).toBeNull()
    expect(ran.path).toBe(true)
    const pid = Number(await fs.readFile(path.join(data, 'tunnel.pid'), 'utf8'))
    expect(alive(pid)).toBe(true)
    expect(await host.stop()).toMatchObject({ state: 'off', url: null, error: null })
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
    await vi.waitFor(() => expect(existsSync(path.join(data, 'tunnel.pid'))).toBe(false))
  })

  it('says it ended by itself when the process dies', async () => {
    await putOnPath()
    const s = await stand(`process.stderr.write('ERR failed to request quick Tunnel\\n')\nprocess.exit(3)`)
    const { host, states } = realHost(s.command)
    await host.start(7461)
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('off'), { timeout: 10_000 })
    expect(states.at(-1)?.error).toBe('cloudflared stopped (exit code 3): INF Requesting new quick Tunnel on trycloudflare.com... / ERR failed to request quick Tunnel')
    expect(existsSync(path.join(data, 'tunnel.pid'))).toBe(false)
  })

  it('gives up on a process that never says an address, and ends it', async () => {
    await putOnPath()
    const s = await stand('setInterval(() => {}, 1000)')
    const { host, states } = realHost(s.command, { startTimeoutMs: 600 })
    await host.start(7461)
    const pid = Number(await vi.waitFor(async () => (await fs.readFile(path.join(data, 'tunnel.pid'), 'utf8')) || Promise.reject(new Error('no pid yet')), { timeout: 5000 }))
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe('off'), { timeout: 10_000 })
    expect(states.at(-1)?.error).toMatch(/did not come up in time/)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
  })

  it('reaps a real process a crashed app left running, by its pid file, only when it is named cloudflared', async () => {
    const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    cleanups.push(() => void idle.kill())
    await new Promise((r) => idle.once('spawn', r))
    const pid = idle.pid!
    await fs.mkdir(data, { recursive: true })
    // Named something else: left alone.
    await fs.writeFile(path.join(data, 'tunnel.pid'), String(pid))
    await new TunnelHost({ dir: data, fetch: async () => new Response(null), emit: () => undefined, processName: async () => 'node.exe' }).reap()
    expect(alive(pid)).toBe(true)
    // Named cloudflared: stopped.
    await fs.writeFile(path.join(data, 'tunnel.pid'), String(pid))
    await new TunnelHost({ dir: data, fetch: async () => new Response(null), emit: () => undefined, processName: async () => EXE }).reap()
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
  })
})

/* ----------------------------------------------------------------------- */
/* main.ts wires it                                                         */
/* ----------------------------------------------------------------------- */

describe('main.ts wiring', () => {
  const src = lf(readMain())
  function readMain(): string {
    return readFileSync(path.join(here, '..', 'src', 'main', 'main.ts'), 'utf8')
  }
  const slice = (from: string, to: string): string => {
    const a = src.indexOf(from)
    return src.slice(a, src.indexOf(to, a))
  }

  it('downloads through a session of its own, into its own folder, and tells the window every change', () => {
    const create = slice('function createTunnel()', '\n}\n')
    expect(create).toContain("path.join(app.getPath('userData'), 'tunnel')")
    expect(create).toContain('session.fromPartition(TUNNEL_DOWNLOAD_PARTITION).fetch(url, init)')
    expect(create).toContain('toRenderer(IPC.tunnelState, s)')
    expect(src).toContain("const TUNNEL_DOWNLOAD_PARTITION = 'aether-tunnel-download'")
    // An in-memory session (no persist: prefix): nothing of it is kept.
    expect(src).not.toMatch(/persist:aether-tunnel/)
  })

  it('answers the four calls, and a start switches the link on first and carries the link’s own port', () => {
    for (const call of ['tunnelStatus', 'tunnelDownload', 'tunnelStart', 'tunnelStop']) expect(src, call).toContain(`ipc.handle(IPC.${call},`)
    const start = slice('async function startTunnel()', '\n}\n')
    expect(start).toContain('await link.configure({ enabled: true })')
    expect(start).toContain('requireTunnel().start(st.port)')
    expect(start).toContain('if (!st.running) throw')
  })

  it('stops the tunnel when the link goes off or moves, when the app quits, and finds a stray one at start', () => {
    const configure = slice('ipc.handle(IPC.aiConfigure,', '\n  })\n')
    expect(configure).toContain('if (clean.enabled === false || clean.port !== undefined) void tunnel?.stop()')
    const quit = slice("app.on('before-quit'", '\n})\n')
    expect(quit).toContain('void tunnel?.stop()')
    expect(src.indexOf('void tunnel?.stop()', src.indexOf("app.on('before-quit'"))).toBeLessThan(src.indexOf('void ai?.stop()', src.indexOf("app.on('before-quit'")))
    const ready = slice('void app.whenReady()', '\n})\n')
    expect(ready).toContain('tunnel = createTunnel()')
    expect(ready).toContain('void tunnel.reap()')
    expect(ready.indexOf('void tunnel.reap()')).toBeLessThan(ready.indexOf('registerIpc()'))
  })
})

/* ----------------------------------------------------------------------- */
/* The words around the button                                              */
/* ----------------------------------------------------------------------- */

describe('the words around the button', () => {
  const asset = cloudflaredAsset('win32', 'x64')!
  const guide = lf(readFileSync(path.join(here, '..', '..', '..', 'docs', 'AI-LINK.md'), 'utf8'))
  const readme = lf(readFileSync(path.join(here, '..', '..', '..', 'README.md'), 'utf8'))
  const panel = lf(readFileSync(path.join(here, '..', 'src', 'renderer', 'components', 'AiLinkPanel.tsx'), 'utf8'))
  const mb = `${Math.round((asset.bytes / 1_048_576) * 10) / 10} MB`

  it('the guide and the README name the file, its size and its release exactly as the app will download them', () => {
    expect(guide).toContain(asset.file)
    expect(guide).toContain(mb)
    expect(guide).toContain(`release ${CLOUDFLARED_VERSION} on GitHub`)
    expect(readme).toContain(mb)
  })

  it('the guide and the panel call the buttons the same things', () => {
    for (const label of ['Start tunnel', 'Stop tunnel', 'Download cloudflared', 'Check again']) {
      expect(panel, label).toContain(label)
      expect(guide, label).toContain(label)
    }
  })

  it('the panel asks before it downloads: the only call to download is inside the confirm step, which says what and from where', () => {
    const confirm = panel.slice(panel.indexOf('asking ? ('), panel.indexOf('onClick={() => setAsking(true)}'))
    expect(confirm.length).toBeGreaterThan(200)
    expect(confirm).toContain('bridge.tunnelDownload()')
    expect(confirm).toContain('t.download.file')
    expect(confirm).toContain('t.download.from')
    expect(confirm).toContain('Not now')
    expect(panel.match(/bridge.tunnelDownload()/g)).toHaveLength(1)
  })
})
