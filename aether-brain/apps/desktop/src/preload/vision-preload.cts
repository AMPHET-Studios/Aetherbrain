/**
 * Preload of the hidden vision helper (sandboxed, context-isolated; see
 * src/main/library/vision.ts). It hands the helper page the jobs main sends
 * (a picture's bytes and the descriptions to compare it with) and sends its
 * answers back, nothing more: the page reads nothing itself, and its session
 * refuses every request but its own scheme.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Same channels as VISION_IPC in src/main/library/vision.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  ready: 'vision:ready',
  job: 'vision:job',
  done: 'vision:done',
} as const

interface VisionJobIn {
  bytes: Uint8Array
  type: string
  width: number | null
  height: number | null
  sets: Record<string, string[]> | null
}

const side = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null)

function setsOf(v: unknown): Record<string, string[]> | null {
  if (!v || typeof v !== 'object') return null
  const out: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list) && list.every((x) => typeof x === 'string')) out[k] = list as string[]
  }
  return out
}

let listening = false

contextBridge.exposeInMainWorld('aetherVision', {
  /** Call once the page can take jobs. */
  ready: () => ipcRenderer.send(IPC.ready),
  /** `cb` gets every job main sends; the first call wins. */
  onJob: (cb: (id: number, job: VisionJobIn) => void) => {
    if (listening) return
    listening = true
    ipcRenderer.on(IPC.job, (_e, id: unknown, bytes: unknown, type: unknown, width: unknown, height: unknown, sets: unknown) => {
      if (typeof id !== 'number' || !(bytes instanceof Uint8Array) || typeof type !== 'string') return
      cb(id, { bytes, type, width: side(width), height: side(height), sets: setsOf(sets) })
    })
  },
  done: (id: number, answer: unknown) => ipcRenderer.send(IPC.done, id, answer),
})
