/**
 * The librarian's vision model on disk: CLIP ViT-B/32 (OpenAI's, quantized
 * for ONNX by Xenova), about 150 MB, downloaded once from Hugging Face when
 * the user asks for it and kept in the app's data folder. After that it runs
 * on this computer only: the vision helper loads these files from disk and
 * has no network at all (see vision.ts).
 *
 * A file is written to `<name>.part` and renamed once all of it arrived (its
 * length checked against Content-Length); `ready.json` is written last, so a
 * download that stopped halfway is never taken for a model. Electron-free:
 * main hands in a fetch (a session's, so the system proxy applies).
 */
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const VISION_MODEL_ID = 'Xenova/clip-vit-base-patch32'
export const VISION_MODEL_LABEL = 'CLIP ViT-B/32 (OpenAI, 8-bit)'
/** Where the files come from (`<base><file>`); AETHER_VISION_MODEL_URL replaces it (tests serve a tiny model). */
export const VISION_MODEL_BASE = `https://huggingface.co/${VISION_MODEL_ID}/resolve/main/`
/** Roughly what the download weighs, for the button. */
export const VISION_MODEL_MB = 150
/** The files the helper loads (transformers.js, dtype q8): config, tokenizer, both halves of CLIP. */
export const VISION_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/text_model_quantized.onnx',
  'onnx/vision_model_quantized.onnx',
] as const
/** No file of the model is bigger than this: a server sending more is not sending the model. */
const MAX_FILE_BYTES = 512 * 1024 * 1024
const READY = 'ready.json'

export type ModelFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>

export interface ModelProgress {
  file: string
  /** Bytes of every file so far (finished files and the one arriving). */
  done: number
  /** Bytes of all files when the server said, else null. */
  total: number | null
}

export interface ModelState {
  ready: boolean
  /** Bytes on disk when ready. */
  bytes: number
}

export class VisionModel {
  /** The model's folder: `<dir>/<model id>`. */
  readonly root: string
  private running: Promise<void> | null = null

  constructor(
    dir: string,
    private fetchFn: ModelFetch,
    private base: string = VISION_MODEL_BASE,
  ) {
    this.root = path.join(dir, ...VISION_MODEL_ID.split('/'))
  }

  /** True while a download runs. */
  get downloading(): boolean {
    return this.running !== null
  }

  /** Ready when `ready.json` says so and every file it lists is there at its size. */
  async state(): Promise<ModelState> {
    try {
      const sizes: unknown = JSON.parse(await fs.readFile(path.join(this.root, READY), 'utf8'))
      if (!sizes || typeof sizes !== 'object') return { ready: false, bytes: 0 }
      let bytes = 0
      for (const f of VISION_MODEL_FILES) {
        const want = (sizes as Record<string, unknown>)[f]
        const st = await fs.stat(path.join(this.root, f))
        if (typeof want !== 'number' || st.size !== want) return { ready: false, bytes: 0 }
        bytes += st.size
      }
      return { ready: true, bytes }
    } catch {
      return { ready: false, bytes: 0 }
    }
  }

  /** The absolute path of one model file (`onnx/x.onnx`), or null for anything that is not one. */
  fileOf(rel: string): string | null {
    return (VISION_MODEL_FILES as readonly string[]).includes(rel) ? path.join(this.root, ...rel.split('/')) : null
  }

  /** Download every file not on disk yet. One download at a time: a second call waits for the first. */
  download(onProgress: (p: ModelProgress) => void, signal: AbortSignal): Promise<void> {
    if (this.running) return this.running
    const run = this.fetchAll(onProgress, signal).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  /** Delete the model (the next librarian run sorts by rules and colours until it is downloaded again). */
  async remove(): Promise<void> {
    if (this.running) throw new Error('The vision model is downloading')
    await fs.rm(this.root, { recursive: true, force: true })
  }

  private async fetchAll(onProgress: (p: ModelProgress) => void, signal: AbortSignal): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    await fs.rm(path.join(this.root, READY), { force: true })
    const sizes: Record<string, number> = {}
    let done = 0
    let total: number | null = 0
    for (const f of VISION_MODEL_FILES) {
      const abs = path.join(this.root, ...f.split('/'))
      const have = await fs.stat(abs).catch(() => null)
      if (have?.isFile()) {
        // Renamed into place only once complete: kept from an earlier, interrupted download.
        sizes[f] = have.size
        done += have.size
        if (total !== null) total += have.size
        continue
      }
      signal.throwIfAborted()
      const res = await this.fetchFn(this.base + f, { signal })
      if (!res.ok || !res.body) throw new Error(`Could not download ${f} (HTTP ${res.status})`)
      // A compressed answer is unpacked by fetch: its Content-Length is the packed size, not the file's.
      const encoding = (res.headers.get('content-encoding') ?? 'identity').toLowerCase()
      const length = encoding === 'identity' ? Number(res.headers.get('content-length') ?? NaN) : NaN
      const known = Number.isFinite(length) && length >= 0
      if (known && length > MAX_FILE_BYTES) throw new Error(`${f} is too big to be the model`)
      // The total grows file by file: the server says each length only when asked for it.
      if (total !== null) total = known ? total + length : null
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const part = `${abs}.part`
      let got = 0
      const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
      counted.on('data', (chunk: Buffer) => {
        got += chunk.length
        if (got > MAX_FILE_BYTES) counted.destroy(new Error(`${f} is too big to be the model`))
        else onProgress({ file: f, done: done + got, total })
      })
      try {
        await pipeline(counted, createWriteStream(part), { signal })
        if (known && got !== length) throw new Error(`${f} arrived incomplete (${got} of ${length} bytes)`)
        await fs.rename(part, abs)
      } catch (err) {
        await fs.rm(part, { force: true })
        throw err
      }
      sizes[f] = got
      done += got
    }
    await fs.writeFile(path.join(this.root, READY), JSON.stringify(sizes, null, 2))
    onProgress({ file: '', done, total: done })
  }
}
