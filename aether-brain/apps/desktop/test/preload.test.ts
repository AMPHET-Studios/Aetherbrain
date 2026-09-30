import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { IPC, type AetherBridge, type ForgeRequest } from '../src/shared/ipc.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** A stand-in for Electron's preload API: what the preload exposes, listens to and invokes. */
const electron = (() => {
  const listeners = new Map<string, ((e: unknown, ...args: unknown[]) => void)[]>()
  const exposed: Record<string, unknown> = {}
  const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
  return {
    listeners,
    exposed,
    invoke,
    module: {
      contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void (exposed[key] = api) },
      ipcRenderer: {
        invoke,
        on: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => {
          listeners.set(channel, [...(listeners.get(channel) ?? []), fn])
        },
        off: (channel: string, fn: (e: unknown, ...args: unknown[]) => void) => {
          listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== fn))
        },
      },
    },
  }
})()

let bridge: AetherBridge

beforeAll(async () => {
  // The preload is CommonJS TypeScript (.cts) that Electron runs in a sandbox: compile it and run it
  // the same way, with this stand-in as `electron`.
  const src = await fs.readFile(path.join(here, '..', 'src', 'preload', 'preload.cts'), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const require = (id: string): unknown => {
    if (id === 'electron') return electron.module
    throw new Error(`the sandboxed preload cannot require ${id}`)
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'process', js)(require, module, module.exports, process)
  bridge = electron.exposed['aether'] as AetherBridge
})

beforeEach(() => {
  electron.invoke.mockReset()
  electron.invoke.mockResolvedValue(undefined)
})

/** Main relays a Forge window request to the brain window; resolves once the preload answered. */
async function relay(req: ForgeRequest): Promise<unknown[]> {
  const answered = new Promise<unknown[]>((resolve) => {
    electron.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === IPC.forgeReply) resolve(args.slice(1))
      return undefined
    })
  })
  for (const fn of electron.listeners.get(IPC.forgeRequest) ?? []) fn({}, req)
  return answered
}

const save = { projectId: 'Projects/PORTALz', title: 'Gesture', png: new Uint8Array([0x89, 0x50]) }

describe('preload: pictures', () => {
  it('invokes the picture channels with their arguments', async () => {
    const data = new Uint8Array([1, 2, 3])
    await bridge.listAssets()
    await bridge.thumbnail('Art/gate.png', 128)
    await bridge.createAsset('Art/new.png', data)
    await bridge.openAsset('Art/gate.png')
    await bridge.forgeOpen({ pick: true })
    await bridge.forgeStatus()
    expect(electron.invoke.mock.calls).toEqual([
      [IPC.assets],
      [IPC.thumb, 'Art/gate.png', 128],
      [IPC.createAsset, 'Art/new.png', data],
      [IPC.openAsset, 'Art/gate.png'],
      [IPC.forgeOpen, { pick: true }],
      [IPC.forgeStatus],
    ])
  })
})

describe('preload: Forge requests', () => {
  it('answers a request with what the handler resolves to', async () => {
    const off = bridge.onForgeRequest(async (req) => (req.kind === 'projects' ? [{ id: 'Projects/PORTALz' }] : null))
    expect(await relay({ id: 7, kind: 'projects' })).toEqual([7, true, [{ id: 'Projects/PORTALz' }]])
    off()
  })

  it("answers with the handler's error message when it rejects", async () => {
    const off = bridge.onForgeRequest(async () => {
      throw new Error('Open a vault first')
    })
    expect(await relay({ id: 8, kind: 'save', save })).toEqual([8, false, 'Open a vault first'])
    off()
  })

  it('serves with the latest handler only, and says the brain is still starting without one', async () => {
    const first = vi.fn(async () => 'first')
    const offFirst = bridge.onForgeRequest(first)
    const offSecond = bridge.onForgeRequest(async () => 'second')
    expect(await relay({ id: 9, kind: 'projects' })).toEqual([9, true, 'second'])
    expect(first).not.toHaveBeenCalled()
    // Unsubscribing a replaced handler leaves the current one alone.
    offFirst()
    expect(await relay({ id: 10, kind: 'projects' })).toEqual([10, true, 'second'])
    offSecond()
    const [id, ok, message] = await relay({ id: 11, kind: 'projects' })
    expect([id, ok]).toEqual([11, false])
    expect(message).toMatch(/still starting/)
  })

  it('still answers when the result cannot cross IPC', async () => {
    const off = bridge.onForgeRequest(async () => ({ fn: () => 1 }))
    const replies: unknown[][] = []
    const done = new Promise<void>((resolve) => {
      electron.invoke.mockImplementation(async (...args: unknown[]) => {
        if (args[0] !== IPC.forgeReply) return undefined
        replies.push(args.slice(1))
        if (args[2] === true) throw new Error('An object could not be cloned.')
        resolve()
        return undefined
      })
    })
    for (const fn of electron.listeners.get(IPC.forgeRequest) ?? []) fn({}, { id: 12, kind: 'projects' })
    await done
    expect(replies.at(-1)).toEqual([12, false, 'Could not send the answer: An object could not be cloned.'])
    off()
  })

  it('ignores a request without an id', async () => {
    const handler = vi.fn(async () => 'x')
    const off = bridge.onForgeRequest(handler)
    for (const fn of electron.listeners.get(IPC.forgeRequest) ?? []) fn({}, { kind: 'projects' })
    await new Promise((r) => setTimeout(r, 10))
    expect(handler).not.toHaveBeenCalled()
    expect(electron.invoke).not.toHaveBeenCalled()
    off()
  })
})
