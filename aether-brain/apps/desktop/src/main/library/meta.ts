/**
 * What a picture's first bytes say about it, for the librarian: when it was
 * taken (EXIF), which camera or program made it, and whether an image
 * generator did (Stable Diffusion and ComfyUI text chunks, C2PA "made by AI"
 * markers, Midjourney / DALL·E / Firefly traces). Pure: header bytes in,
 * facts out. Nothing here decodes a picture.
 */
import { fourcc, has, imageKindOf, imageSize, jpegSegments, u16be, u16le, u32be, u32le, type ImageKind } from '../assets.js'

export interface PictureMeta {
  kind: ImageKind | null
  width: number | null
  height: number | null
  /** EXIF DateTimeOriginal (else digitized, else DateTime) as `YYYY-MM-DD`, or null. */
  taken: string | null
  make: string | null
  model: string | null
  /** The program that wrote it (EXIF Software, a PNG Software chunk, XMP CreatorTool). */
  software: string | null
  /** Why it looks made by an image generator (`Stable Diffusion`, `C2PA: made by AI` …), or null. */
  ai: string | null
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
const EXIF = [...ascii('Exif'), 0, 0]
const TIFF_LE = ascii('II')
const TIFF_BE = ascii('MM')

/** Printable text from bytes (latin1), trailing NULs and spaces dropped, at most `max` characters. */
function text(b: Uint8Array, start: number, end: number, max = 200): string {
  let out = ''
  for (let i = start; i < Math.min(end, b.length) && out.length < max; i++) {
    const c = b[i] ?? 0
    if (c === 0) break
    out += String.fromCharCode(c)
  }
  return out.replace(/[\u0000-\u001f]/g, ' ').trim()
}

interface TiffFacts {
  make?: string
  model?: string
  software?: string
  dateTime?: string
  original?: string
  digitized?: string
}

/** EXIF facts from a TIFF stream at `start`..`end`: IFD0 (make, model, software, date) and the Exif IFD (original, digitized dates). */
function tiffFacts(b: Uint8Array, start: number, end: number): TiffFacts {
  const out: TiffFacts = {}
  const little = has(b, start, TIFF_LE)
  if (!little && !has(b, start, TIFF_BE)) return out
  const stop = Math.min(end, b.length)
  const u16 = (i: number): number => (little ? u16le(b, i) : u16be(b, i))
  const u32 = (i: number): number => (little ? u32le(b, i) : u32be(b, i))
  if (u16(start + 2) !== 42) return out
  const ascii = (e: number): string | undefined => {
    if (u16(e + 2) !== 2) return undefined
    const count = u32(e + 4)
    const at = count <= 4 ? e + 8 : start + u32(e + 8)
    if (at < start || at + Math.min(count, 1) > stop) return undefined
    const s = text(b, at, Math.min(stop, at + count))
    return s || undefined
  }
  const walk = (ifdAt: number, visit: (tag: number, e: number) => void): void => {
    if (ifdAt < start || ifdAt + 2 > stop) return
    const entries = Math.min(u16(ifdAt), 512)
    for (let k = 0; k < entries; k++) {
      const e = ifdAt + 2 + k * 12
      if (e + 12 > stop) return
      visit(u16(e), e)
    }
  }
  let exifIfd = 0
  walk(start + u32(start + 4), (tag, e) => {
    if (tag === 0x010f) out.make = ascii(e)
    else if (tag === 0x0110) out.model = ascii(e)
    else if (tag === 0x0131) out.software = ascii(e)
    else if (tag === 0x0132) out.dateTime = ascii(e)
    else if (tag === 0x8769) exifIfd = start + u32(e + 8)
  })
  if (exifIfd) {
    walk(exifIfd, (tag, e) => {
      if (tag === 0x9003) out.original = ascii(e)
      else if (tag === 0x9004) out.digitized = ascii(e)
    })
  }
  return out
}

/** `2024:06:12 14:03:22` (EXIF) → `2024-06-12`; null for a blank or impossible date. */
export function exifDay(s: string | undefined): string | null {
  const m = /^(\d{4})[:\-.](\d{2})[:\-.](\d{2})/.exec(s?.trim() ?? '')
  if (!m) return null
  return validDay(Number(m[1]), Number(m[2]), Number(m[3]))
}

function validDay(y: number, mo: number, d: number): string | null {
  const now = new Date().getFullYear()
  if (y < 1980 || y > now + 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** EXIF of a JPEG (the first APP1 with EXIF), a PNG (eXIf) or a WebP (EXIF chunk). */
function exifOf(b: Uint8Array, kind: ImageKind | null): TiffFacts {
  if (kind === 'jpeg') {
    let facts: TiffFacts = {}
    jpegSegments(b, (m, at, len) => {
      if (m !== 0xe1 || !has(b, at + 4, EXIF)) return false
      facts = tiffFacts(b, at + 4 + EXIF.length, at + 2 + len)
      return true
    })
    return facts
  }
  if (kind === 'png') {
    for (let i = 8; i + 8 <= b.length; ) {
      const len = u32be(b, i)
      if (fourcc(b, i + 4) === 'eXIf') return tiffFacts(b, i + 8, i + 8 + len)
      if (fourcc(b, i + 4) === 'IEND') break
      i += 12 + len
    }
  }
  if (kind === 'webp') {
    for (let i = 12; i + 8 <= b.length; ) {
      const len = u32le(b, i + 4)
      if (fourcc(b, i) === 'EXIF') {
        const body = i + 8
        // Some writers keep the JPEG "Exif\0\0" prefix.
        return tiffFacts(b, has(b, body, EXIF) ? body + EXIF.length : body, body + len)
      }
      i += 8 + len + (len % 2)
    }
  }
  return {}
}

/** A PNG's text chunks (tEXt, and iTXt when not compressed): keyword → text. */
export function pngText(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  if (imageKindOf(b) !== 'png') return out
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i)
    const type = fourcc(b, i + 4)
    const body = i + 8
    const end = Math.min(b.length, body + len)
    if (type === 'tEXt' || type === 'iTXt') {
      let k = body
      while (k < end && b[k] !== 0) k++
      const key = text(b, body, k, 80)
      if (type === 'tEXt') out[key] = latin1(b, k + 1, end, 4000)
      else if (b[k + 1] === 0) {
        // iTXt: keyword \0 flag method language \0 translated \0 text (UTF-8)
        let j = k + 3
        while (j < end && b[j] !== 0) j++
        j++
        while (j < end && b[j] !== 0) j++
        out[key] = new TextDecoder().decode(b.subarray(j + 1, end)).slice(0, 4000)
      }
    }
    if (type === 'IEND' || len > 0x7fffffff) break
    i += 12 + len
  }
  return out
}

function latin1(b: Uint8Array, start: number, end: number, max: number): string {
  let out = ''
  for (let i = start; i < Math.min(end, b.length) && out.length < max; i++) out += String.fromCharCode(b[i] ?? 0)
  return out
}

/** The bytes as latin1 text (for marker searches), at most the first 256 KB. */
function haystack(b: Uint8Array): string {
  return latin1(b, 0, Math.min(b.length, 256 * 1024), 256 * 1024)
}

const GENERATOR_RE: [RegExp, string][] = [
  [/trainedAlgorithmicMedia/, 'C2PA: made by AI'],
  [/Midjourney/i, 'Midjourney'],
  [/DALL[·.\-\s]?E|OpenAI/, 'DALL·E / ChatGPT'],
  [/Adobe Firefly/i, 'Adobe Firefly'],
  [/NovelAI/i, 'NovelAI'],
  [/Leonardo\.?Ai/i, 'Leonardo.Ai'],
  [/InvokeAI|invokeai_metadata|sd-metadata/i, 'InvokeAI'],
  [/ComfyUI/i, 'ComfyUI'],
  [/stable[-\s]?diffusion/i, 'Stable Diffusion'],
]

/** Everything readMeta can tell from the first bytes of a picture (64 KB is plenty). */
export function readMeta(head: Uint8Array): PictureMeta {
  const kind = imageKindOf(head)
  const size = kind ? imageSize(head) : null
  const exif = exifOf(head, kind)
  const chunks = kind === 'png' ? pngText(head) : {}
  const hay = haystack(head)
  const xmpTool = /CreatorTool(?:="|>)([^"<]{1,120})/.exec(hay)?.[1]
  let ai: string | null = null
  // Generator settings that only image generators write.
  if (chunks['parameters'] && /Steps:|Sampler:|Seed:/.test(chunks['parameters'])) ai = 'Stable Diffusion'
  else if (chunks['workflow'] || (chunks['prompt'] && /class_type|"inputs"/.test(chunks['prompt']))) ai = 'ComfyUI'
  else if (chunks['Dream'] || chunks['sd-metadata'] || chunks['invokeai_metadata']) ai = 'InvokeAI'
  else if (chunks['Software'] && /NovelAI/i.test(chunks['Software'])) ai = 'NovelAI'
  else {
    // A C2PA manifest (JUMBF) or XMP saying so, or a generator naming itself.
    const c2pa = /c2pa|jumb/i.test(hay)
    for (const [re, name] of GENERATOR_RE) {
      if (!re.test(hay)) continue
      // "OpenAI" / "DALL·E" alone could be text in an ordinary picture: only inside a C2PA manifest.
      if (name === 'DALL·E / ChatGPT' && !c2pa) continue
      ai = name
      break
    }
  }
  return {
    kind,
    width: size?.width ?? null,
    height: size?.height ?? null,
    taken: exifDay(exif.original) ?? exifDay(exif.digitized) ?? exifDay(exif.dateTime),
    make: exif.make ?? null,
    model: exif.model ?? null,
    software: exif.software ?? chunks['Software'] ?? xmpTool ?? null,
    ai,
  }
}

/**
 * A date in a file name: `IMG_20240612_142233`, `Screenshot 2024-06-12 at…`,
 * `PXL_20240612…`, `WhatsApp Image 2024-06-12…`, or a 13-digit Unix time in
 * milliseconds. `YYYY-MM-DD`, or null.
 */
export function dateFromName(name: string): string | null {
  const m = /(?:^|[^\d])((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/.exec(name)
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]))
  const ms = /(?:^|[^\d])(1[3-7]\d{11})(?:[^\d]|$)/.exec(name)
  if (ms) {
    const d = new Date(Number(ms[1]))
    return validDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }
  return null
}
