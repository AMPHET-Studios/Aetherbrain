/**
 * The vision helper's page (a hidden, sandboxed window; see
 * src/main/library/vision.ts). For each picture main sends, it decodes the
 * bytes already scaled down (createImageBitmap), measures the colours, and
 * when asked compares the picture with the librarian's descriptions using
 * CLIP (transformers.js on the ONNX runtime's WebAssembly backend):
 * zero-shot, cosine similarity × 100 then a softmax per set of descriptions,
 * the way CLIP was trained to be used.
 *
 * Offline by construction: the model files, the runtime and this page all
 * come from the helper's own scheme (served by main from the app and its data
 * folder), remote models are switched off, and the helper's session refuses
 * every other request.
 */
import { AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, Tensor, env } from '@huggingface/transformers'
import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers'

interface VisionJobIn {
  bytes: Uint8Array
  type: string
  width: number | null
  height: number | null
  sets: Record<string, string[]> | null
}

interface VisionBridge {
  ready(): void
  onJob(cb: (id: number, job: VisionJobIn) => void): void
  done(id: number, answer: unknown): void
}

declare global {
  interface Window {
    aetherVision?: VisionBridge
  }
}

interface ColourStats {
  lum: number
  sat: number
  warm: number
  contrast: number
}

const MODEL = new URLSearchParams(location.search).get('model') ?? ''
/** CLIP ViT-B/32 looks at 224 × 224 pixels, normalized with these. */
const SIDE = 224
const MEAN = [0.48145466, 0.4578275, 0.40821073] as const
const STD = [0.26862954, 0.26130258, 0.27577711] as const
/** CLIP's learned temperature (exp(logit_scale) of the released model). */
const LOGIT_SCALE = 100
/** Colours are measured on a picture this small: plenty for averages. */
const COLOUR_SIDE = 48

env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = new URL('models/', location.href).href
env.useBrowserCache = false
env.useWasmCache = false
const wasm = env.backends.onnx.wasm
if (wasm) {
  // Shipped with the app (dist/vision/ort), never fetched from a CDN.
  wasm.wasmPaths = {
    mjs: new URL('ort/ort-wasm-simd-threaded.asyncify.mjs', location.href).href,
    wasm: new URL('ort/ort-wasm-simd-threaded.asyncify.wasm', location.href).href,
  }
  // Threads need cross-origin isolation (the helper's scheme sends COOP/COEP); one core is left to the app.
  wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1
  wasm.proxy = false
}

interface Clip {
  tokenizer: PreTrainedTokenizer
  text: PreTrainedModel
  vision: PreTrainedModel
}

let clip: Promise<Clip> | null = null

/** The model, loaded once (a failure is remembered: every later look says why). */
function loadClip(): Promise<Clip> {
  clip ??= (async () => {
    if (!MODEL) throw new Error('No model named')
    const opts = { dtype: 'q8', device: 'wasm' } as const
    const [tokenizer, text, vision] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL),
      CLIPTextModelWithProjection.from_pretrained(MODEL, opts),
      CLIPVisionModelWithProjection.from_pretrained(MODEL, opts),
    ])
    return { tokenizer, text, vision }
  })()
  return clip
}

/** Rows of a [n, d] tensor, each scaled to length 1. */
function unitRows(t: Tensor): Float32Array[] {
  const [n = 0, d = 0] = t.dims
  const data = t.data as Float32Array
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const row = Float32Array.from(data.subarray(i * d, (i + 1) * d))
    let norm = 0
    for (const x of row) norm += x * x
    norm = Math.sqrt(norm) || 1
    for (let k = 0; k < d; k++) row[k] = row[k]! / norm
    out.push(row)
  }
  return out
}

/** Text embeddings of each set of descriptions, made once per set. */
const textEmbeds = new Map<string, Promise<Float32Array[]>>()

function embedTexts(c: Clip, labels: string[]): Promise<Float32Array[]> {
  const key = JSON.stringify(labels)
  let hit = textEmbeds.get(key)
  if (!hit) {
    hit = (async () => {
      const inputs = c.tokenizer(labels, { padding: true, truncation: true })
      const out = (await c.text(inputs)) as { text_embeds: Tensor }
      return unitRows(out.text_embeds)
    })()
    textEmbeds.set(key, hit)
  }
  return hit
}

/**
 * The picture decoded, already scaled (high quality) so that its shorter side
 * is SIDE px; a smaller one as it is. `width` × `height` is the size it is
 * shown at, after its EXIF turn (main reads it from the header).
 */
function decode(job: VisionJobIn): Promise<ImageBitmap> {
  const blob = new Blob([job.bytes as Uint8Array<ArrayBuffer>], { type: job.type })
  const { width: w, height: h } = job
  if (w && h) {
    const scale = SIDE / Math.min(w, h)
    if (scale < 1) {
      return createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)), resizeQuality: 'high' })
    }
  }
  return createImageBitmap(blob)
}

function context(w: number, h: number): OffscreenCanvasRenderingContext2D {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No 2D canvas')
  return ctx
}

/** Mean luminance, saturation and warmth, and the spread of luminance, of the whole picture (see-through pixels left out). */
function colours(bmp: ImageBitmap): ColourStats {
  const scale = Math.min(1, COLOUR_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const ctx = context(w, h)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, w, h)
  const px = ctx.getImageData(0, 0, w, h).data
  let n = 0
  let lum = 0
  let lum2 = 0
  let sat = 0
  let warm = 0
  for (let i = 0; i < px.length; i += 4) {
    if ((px[i + 3] ?? 0) < 16) continue
    const r = (px[i] ?? 0) / 255
    const g = (px[i + 1] ?? 0) / 255
    const b = (px[i + 2] ?? 0) / 255
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    n++
    lum += l
    lum2 += l * l
    sat += max > 0 ? (max - min) / max : 0
    warm += r - b
  }
  if (!n) return { lum: 0.5, sat: 0, warm: 0, contrast: 0 }
  const mean = lum / n
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return {
    lum: clamp(mean, 0, 1),
    sat: clamp(sat / n, 0, 1),
    warm: clamp(warm / n, -1, 1),
    contrast: clamp(Math.sqrt(Math.max(0, lum2 / n - mean * mean)), 0, 1),
  }
}

/** CLIP's input: the middle square of the picture at SIDE × SIDE (on white, for see-through pictures), normalized, channels first. */
function pixelValues(bmp: ImageBitmap): Tensor {
  const ctx = context(SIDE, SIDE)
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, SIDE, SIDE)
  const side = Math.min(bmp.width, bmp.height)
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIDE, SIDE)
  const px = ctx.getImageData(0, 0, SIDE, SIDE).data
  const plane = SIDE * SIDE
  const data = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) data[c * plane + i] = ((px[i * 4 + c] ?? 0) / 255 - MEAN[c]!) / STD[c]!
  }
  return new Tensor('float32', data, [1, 3, SIDE, SIDE])
}

function softmax(xs: number[]): number[] {
  const max = Math.max(...xs)
  const e = xs.map((x) => Math.exp(x - max))
  const sum = e.reduce((a, b) => a + b, 0) || 1
  return e.map((x) => x / sum)
}

/** Probabilities of each description of each set, for the picture `bmp`. */
async function compare(bmp: ImageBitmap, sets: Record<string, string[]>): Promise<Record<string, number[]>> {
  const c = await loadClip()
  const out = (await c.vision({ pixel_values: pixelValues(bmp) })) as { image_embeds: Tensor }
  const image = unitRows(out.image_embeds)[0]
  if (!image) throw new Error('The model gave no picture embedding')
  const probs: Record<string, number[]> = {}
  for (const [key, labels] of Object.entries(sets)) {
    if (!labels.length) continue
    const texts = await embedTexts(c, labels)
    probs[key] = softmax(
      texts.map((t) => {
        let dot = 0
        for (let k = 0; k < t.length; k++) dot += t[k]! * (image[k] ?? 0)
        return dot * LOGIT_SCALE
      }),
    )
  }
  return probs
}

/** The answer for one job, or null when the picture cannot be decoded. */
async function look(job: VisionJobIn): Promise<unknown> {
  let bmp: ImageBitmap
  try {
    bmp = await decode(job)
  } catch {
    return null
  }
  try {
    const answer = { colours: colours(bmp), probs: null as Record<string, number[]> | null, modelError: null as string | null }
    if (job.sets) {
      try {
        answer.probs = await compare(bmp, job.sets)
      } catch (err) {
        answer.modelError = err instanceof Error ? err.message : String(err)
      }
    }
    return answer
  } finally {
    bmp.close()
  }
}

const bridge = typeof window === 'undefined' ? undefined : window.aetherVision
if (bridge) {
  bridge.onJob((id, job) => {
    look(job).then(
      (answer) => bridge.done(id, answer),
      () => bridge.done(id, null),
    )
  })
  bridge.ready()
}
