import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { FsVault, isAssetName, isAudioName } from '../src/main/fsvault.js'
import { MAX_AUDIO_BYTES } from '../src/main/assets.js'
import { THUMB_IPC, ThumbQueue, type ThumbHelper, type ThumbJob } from '../src/main/thumbnailer.js'
import { buildGraph, parseNote, previewKindOf } from '@aether/core'

/**
 * Songs (docs/COSMOLOGY.md, *Every file is a satellite*): an mp3, wav, flac, ogg, opus, m4a or aac file shows its waveform as a long
 * horizontal card. The helper decodes the song with Chromium's own decoder; the peaks and the picture are pure and are run here on
 * hand-made samples.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const PRELOAD = path.join(here, '..', 'src', 'preload', 'thumb-preload.cts')

interface Pre {
  WAVE_COLUMNS: number
  WAVE_ASPECT: number
  waveformLevels(channels: Float32Array[], columns: number): { peak: Float32Array; energy: Float32Array }
  waveformImage(levels: { peak: Float32Array; energy: Float32Array }, height: number): { width: number; height: number; data: Uint8ClampedArray }
}

async function loadPreload(globals: Record<string, unknown> = {}) {
  const src = await fs.readFile(PRELOAD, 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const sent: unknown[][] = []
  const on = new Map<string, (e: unknown, ...args: unknown[]) => void>()
  const electron = { ipcRenderer: { send: (...a: unknown[]) => void sent.push(a), on: (c: string, fn: (e: unknown, ...a: unknown[]) => void) => void on.set(c, fn) } }
  const module = { exports: {} as Record<string, unknown> }
  new Function('require', 'module', 'exports', ...Object.keys(globals), js)(() => electron, module, module.exports, ...Object.values(globals))
  return { pre: module.exports as unknown as Pre, sent, on }
}

describe('the loudness of a song', () => {
  it('takes the loudest sample of each slice over every channel for the peak, and scales the loudest slice to 1', async () => {
    const { pre } = await loadPreload()
    const left = new Float32Array([0, 0.1, 0, 0.5, 0, 0.2, 0, 0])
    const right = new Float32Array([0, 0, -0.4, 0, 0, 0, 0, 0])
    const { peak } = pre.waveformLevels([left, right], 4)
    expect(peak).toHaveLength(4)
    // Slices: [0 0.1] [0 0.5] [0 0.2] [0 0] on the left, [0 0] [-0.4 0] [0 0] [0 0] on the right: loudest 0.1, 0.5, 0.2, 0.
    expect(peak[1]).toBe(1)
    expect(peak[0]).toBeCloseTo(0.2, 6)
    expect(peak[2]).toBeCloseTo(0.4, 6)
    expect(peak[3]).toBe(0)
  })

  it('takes the root mean square for the energy, which moves where the peak is flat: a loud song still shows its shape', async () => {
    const { pre } = await loadPreload()
    // Every slice has one full-scale sample (peak 1 everywhere) but the first is mostly silence and the second is a loud tone.
    const quiet = new Float32Array(64).fill(0.02)
    quiet[0] = 1
    const loud = new Float32Array(64).fill(0.7)
    loud[0] = 1
    const { peak, energy } = pre.waveformLevels([Float32Array.from([...quiet, ...loud])], 2)
    expect(Array.from(peak)).toEqual([1, 1])
    expect(energy[1]).toBe(1)
    expect(energy[0]).toBeLessThan(0.5)
    expect(energy[0]).toBeGreaterThan(0)
  })

  it('is all zeros for silence and for nothing, and counts samples that are not numbers as silence', async () => {
    const { pre } = await loadPreload()
    expect(Array.from(pre.waveformLevels([new Float32Array(100)], 8).peak)).toEqual(new Array(8).fill(0))
    expect(Array.from(pre.waveformLevels([], 8).energy)).toEqual(new Array(8).fill(0))
    expect(Array.from(pre.waveformLevels([new Float32Array(0)], 4).peak)).toEqual([0, 0, 0, 0])
    const odd = pre.waveformLevels([new Float32Array([NaN, 0.5, Infinity, 0.25])], 2)
    for (const v of [...odd.peak, ...odd.energy]) expect(Number.isFinite(v) && v >= 0 && v <= 1).toBe(true)
  })

  it('gives a song shorter than the columns a value for each column anyway', async () => {
    const { pre } = await loadPreload()
    const { peak, energy } = pre.waveformLevels([new Float32Array([0.2, 0.4])], 8)
    expect(peak).toHaveLength(8)
    expect(energy).toHaveLength(8)
    expect(Math.max(...peak)).toBe(1)
  })
})

describe('the picture of a waveform', () => {
  const levels = (n: number, f: (i: number) => number) => ({ peak: new Float32Array(n).map((_, i) => f(i)), energy: new Float32Array(n).map((_, i) => f(i) * 0.5) })

  it('is three times as wide as it is tall, opaque, the same every time, and bars rise from the middle', async () => {
    const { pre } = await loadPreload()
    const l = levels(pre.WAVE_COLUMNS, (i) => (i % 2 === 0 ? 1 : 0.25))
    const a = pre.waveformImage(l, 256)
    expect([a.width, a.height]).toEqual([256 * pre.WAVE_ASPECT, 256])
    expect(pre.WAVE_ASPECT).toBe(3)
    expect(a.data).toHaveLength(a.width * a.height * 4)
    expect(Array.from(pre.waveformImage(l, 256).data)).toEqual(Array.from(a.data))
    for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255)
    const slot = a.width / pre.WAVE_COLUMNS
    // A bar takes the middle two thirds of its slot: the pixel just after it is the card behind.
    const gap = Math.floor((slot * 5) / 6)
    const bg = (y: number) => a.data[(y * a.width + gap) * 4]!
    const at = (x: number, y: number) => a.data[(y * a.width + x) * 4]!
    const x0 = Math.floor(slot / 6)
    const x1 = Math.floor(slot + slot / 6)
    // Column 0 (peak 1) reaches near the top; column 1 (peak 0.25) only near the middle.
    expect(at(x0, 20)).toBeGreaterThan(bg(20) + 20)
    expect(at(x1, 20)).toBe(bg(20))
    expect(at(x1, 128)).toBeGreaterThan(bg(128) + 20)
  })

  it('draws the energy brighter than the peak behind it', async () => {
    const { pre } = await loadPreload()
    const a = pre.waveformImage({ peak: new Float32Array(pre.WAVE_COLUMNS).fill(1), energy: new Float32Array(pre.WAVE_COLUMNS).fill(0.5) }, 256)
    const x = Math.floor(a.width / pre.WAVE_COLUMNS / 6)
    const red = (y: number) => a.data[(y * a.width + x) * 4]!
    // Inside the energy (near the middle) is brighter than the outline between it and the peak.
    expect(red(128)).toBeGreaterThan(red(40) + 30)
    expect(red(40)).toBeGreaterThan(red(0) + 20)
  })

  it('draws silence as a hairline of bars, not a blank card', async () => {
    const { pre } = await loadPreload()
    const flat = pre.waveformImage(levels(pre.WAVE_COLUMNS, () => 0), 32)
    const lit = Array.from({ length: flat.height }, (_, y) => flat.data[(y * flat.width + Math.floor(flat.width / pre.WAVE_COLUMNS / 6)) * 4]!)
    expect(Math.max(...lit)).toBeGreaterThan(Math.min(...lit) + 20)
  })
})

describe('the helper page for a song', () => {
  it('decodes the bytes with the browser, draws the waveform at its own shape and answers PNG bytes, or null for a song it cannot decode', async () => {
    const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const puts: { width: number; height: number }[] = []
    const decoded: ArrayBuffer[] = []
    const globals = {
      OfflineAudioContext: class {
        async decodeAudioData(buffer: ArrayBuffer) {
          decoded.push(buffer)
          if (buffer.byteLength < 4) throw new Error('EncodingError')
          return { numberOfChannels: 2, getChannelData: (c: number) => new Float32Array(1000).map((_, i) => (c === 0 ? Math.sin(i / 20) : 0.1)) }
        }
      },
      ImageData: class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number,
        ) {}
      },
      document: {
        createElement: () => ({
          width: 0,
          height: 0,
          getContext: () => ({ putImageData: (img: { width: number; height: number }) => void puts.push(img) }),
          toDataURL(type: string) {
            return 'data:' + type + ';base64,' + Buffer.from([...PNG, this.width / 3, this.height]).toString('base64')
          },
        }),
      },
    }
    const { sent, on } = await loadPreload(globals)
    const run = async (...args: unknown[]) => {
      const before = sent.length
      on.get(THUMB_IPC.audio)!({}, ...args)
      for (let i = 0; i < 200 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 5))
      return sent.at(-1)!
    }
    const song = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(await run(1, song, 512)).toEqual([THUMB_IPC.done, 1, new Uint8Array([...PNG, 256, 256])])
    // At most 256 tall however much is asked, and the song's own bytes were not handed over (a copy was).
    expect(puts[0]).toMatchObject({ width: 768, height: 256 })
    expect(decoded[0]).not.toBe(song.buffer)
    expect((await run(2, song, 64))[2]).toEqual(new Uint8Array([...PNG, 64, 64]))
    expect(puts[1]).toMatchObject({ width: 192, height: 64 })
    expect((await run(3, new Uint8Array([1]), 64))[2]).toBeNull()
    for (const [i, bad] of ([['not bytes', 64], [song, 0], [song, 5000], [song, '64']] as const).entries()) expect((await run(10 + i, ...bad))[2], String(i)).toBeNull()
  })
})

describe('telling and fetching a song', () => {
  it('names the songs a browser can decode, and nothing else', async () => {
    for (const n of ['a.mp3', 'A.WAV', 'a.flac', 'a.ogg', 'a.oga', 'a.m4a', 'a.aac', 'a.opus']) {
      expect(isAudioName(n), n).toBe(true)
      expect(previewKindOf(n), n).toBe('audio')
    }
    for (const n of ['a.mid', 'a.wma', 'a.aiff', 'a.mp3.txt', 'a.mp4', 'a']) {
      expect(isAudioName(n), n).toBe(false)
      expect(previewKindOf(n), n).not.toBe('audio')
    }
    expect(isAssetName('a.mp3')).toBe(false)
    expect(MAX_AUDIO_BYTES).toBe(48 * 1024 * 1024)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-audio-door-'))
    try {
      await fs.mkdir(path.join(dir, 'Music'))
      await fs.writeFile(path.join(dir, 'Music', 'a.mp3'), new Uint8Array([1]))
      const vault = new FsVault([dir])
      expect(await vault.previewAbs('Music/a.mp3')).not.toBeNull()
      expect(await vault.assetAbs('Music/a.mp3')).toBeNull()
      expect(await vault.modelAbs('Music/a.mp3')).toBeNull()
      expect(await vault.previewAbs('../a.mp3')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('hands the job to the helper on its own channel', async () => {
    const sent: { id: number; job: ThumbJob }[] = []
    const helper: ThumbHelper = { id: 1, send: (id, job) => void sent.push({ id, job }), destroy: () => undefined }
    const q = new ThumbQueue(() => helper, { timeoutMs: 1000 })
    const bytes = new Uint8Array([9, 9])
    const out = q.render({ audio: bytes, px: 256 })
    q.ready(1)
    expect(sent[0]!.job).toEqual({ audio: bytes, px: 256 })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5])
    q.done(1, sent[0]!.id, png)
    expect(await out).toEqual(png)
    expect(THUMB_IPC.audio).toBe('thumbs:audio')
  })
})

describe('a song in the graph', () => {
  it('is a file moon with a preview of its own kind, a long card for the scene', () => {
    const note = parseNote({ path: 'Home.md', content: '# Home\n' })
    const g = buildGraph(new Map([[note.meta.id, note]]), {
      images: { all: new Map(), moons: true, files: new Map([['Music/a.mp3', { path: 'Music/a.mp3', size: 4_000_000, mtime: 1 }]]) },
      folders: { all: new Set(['Music']), rootTitle: 'Vault', multiRoot: false, maxDepth: 4 },
    } as never)
    expect(g.nodes.find((n) => n.id === 'image:Music/a.mp3')?.image).toMatchObject({ file: 'audio', preview: 'audio' })
  })
})
