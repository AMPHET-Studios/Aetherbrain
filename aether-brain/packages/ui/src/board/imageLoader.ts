/**
 * The picture cache's loader (imageCache.ts asks it for a picture at a tier): turns the host's bytes into decoded bitmaps.
 * The two small tiers are previews the host makes (`preview`); the full tier is the file itself (`original`), scaled while decoding
 * when it is bigger than the tier allows. Design: docs/design/reference-board.md ("Decisions" 4).
 *
 * A picture is never decoded to find out how big it is: its size is read from the first bytes of the file (core's `readImageHeader`;
 * a few KB of PNG can claim 30,000 x 30,000 pixels, and a decode of that is 3.6 GB), and
 * - above MAX_LOAD_PIXELS (150 million) it is refused, never decoded: the answer is `{ failure: 'too-large' }`;
 * - from 64 million (MAX_DECODE_PIXELS, the host's thumbnail cap) up to that, decodes run ONE AT A TIME for the whole page, whichever
 *   loader asks (a decode is width x height x 4 bytes, and `createImageBitmap` with a resize decodes the whole raster first);
 * - a picture is decoded once, straight to the size it is wanted at.
 * A picture the host has no preview of (it is over the host's own thumbnail cap, say) is made into the preview here, from the original,
 * so that it shows at every zoom and not only past 1024 px. A file whose header cannot be read (after looking further into a JPEG or an
 * AVIF) is decoded as the engine sees fit only when it is tiny (core's IMAGE_BLIND_DECODE_MAX_BYTES; one at a time), else it cannot be
 * read (null, which the cache calls 'unreadable'): a flat raster compresses to a few hundred KB, so the size of a file says nothing of
 * what it takes to decode.
 *
 * Nothing here throws: a failure is a null, or `{ failure }` when the reason is known and permanent; a bitmap made along the way is
 * closed unless it is handed over.
 */
import { IMAGE_BLIND_DECODE_MAX_BYTES, MAX_DECODE_PIXELS, isModelPath, readBlobHeader } from '@aether/core'
import { IMAGE_TIERS, type BoardPictureHost, type ImageFailure, type ImageTier } from './api'
import { FULL_MAX_PIXELS, type BitmapLike, type LoadFailure, type LoadedImage } from './imageCache'

/** `createImageBitmap` as the loader uses it (a Blob in, a bitmap out), so that tests can pass a fake. */
export type CreateBitmap = (source: Blob, options?: ImageBitmapOptions) => Promise<BitmapLike>

/** The longer side of the full tier. */
const FULL_PX = IMAGE_TIERS[2]
/**
 * A 3D model is its picture at most this many px on a side, at every tier: the helper draws it (the board turns it from its proxy, never
 * from this), and there is no "file itself" to decode: a model is never read whole by a board.
 */
export const MODEL_PREVIEW_PX = 512
/** A picture with more pixels than this is not decoded at all (150 megapixels: 600 MB as RGBA). */
export const MAX_LOAD_PIXELS = 150e6
/** Pictures over this many pixels decode one at a time (the host does not make thumbnails of them either). */
const SOLO_PIXELS = MAX_DECODE_PIXELS

/**
 * Both decodes turn a picture the way its EXIF says, as the host's previews do, so the tiers of one picture have the same shape
 * whatever the engine's default.
 */
const UPRIGHT: ImageBitmapOptions = { imageOrientation: 'from-image' }

function closeQuietly(b: BitmapLike | null | undefined): void {
  try {
    b?.close()
  } catch {
    /* nothing left to give back */
  }
}

/** The longest a decode may hold the line: after this the next one goes (the cache gave up on that load long before). */
const SOLO_GIVE_UP_MS = 45_000

/** Decodes that must not overlap, one after another, for the whole page: every loader made by createImageLoader shares the line. */
let solo: Promise<void> = Promise.resolve()
function alone<T>(job: () => Promise<T>): Promise<T> {
  let release: () => void = () => {}
  const mine = new Promise<void>((resolve) => {
    release = resolve
  })
  const turn = solo
  solo = mine
  return turn.then(async () => {
    // A decode that never ends must not hold every big picture of the page back for good.
    const timer = setTimeout(release, SOLO_GIVE_UP_MS)
    try {
      return await job()
    } finally {
      clearTimeout(timer)
      release()
    }
  })
}

/**
 * The picture's size as it is shown (upright), from the first bytes of the file (a JPEG's frame header behind long COM or APP segments is
 * looked for in the first 2 MiB); null when the header is not there or not understood.
 */
async function headerSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  const header = await readBlobHeader(blob)
  return header ? { w: header.shownWidth, h: header.shownHeight } : null
}

/** The reason a host gave for a refusal (a rejection carrying `reason`), when it is one we know. */
function reasonOf(err: unknown): ImageFailure | null {
  const reason = typeof err === 'object' && err !== null ? (err as { reason?: unknown }).reason : null
  return reason === 'missing' || reason === 'too-large' || reason === 'unreadable' ? reason : null
}

export function createImageLoader(
  pictures: Pick<BoardPictureHost, 'preview' | 'original'> & Partial<Pick<BoardPictureHost, 'exists'>>,
  create: CreateBitmap = (source, options) => createImageBitmap(source, options),
): (path: string, tier: ImageTier) => Promise<LoadedImage | LoadFailure | null> {
  /**
   * The picture of `blob` (`size`: its upright size from the header) at most `limit` px on its longer side and `area` pixels, decoded
   * once, scaled while decoding when it is bigger; closed and refused when the engine gives more than the header said.
   */
  async function decodeTo(blob: Blob, size: { w: number; h: number }, limit: number, area: number): Promise<LoadedImage | LoadFailure> {
    let scale = Math.min(1, limit / Math.max(size.w, size.h))
    if (area < Infinity) scale = Math.min(scale, Math.sqrt(area / (size.w * size.h)))
    const bitmap =
      scale < 1
        ? await create(blob, {
            ...UPRIGHT,
            resizeWidth: Math.max(1, Math.round(size.w * scale)),
            resizeHeight: Math.max(1, Math.round(size.h * scale)),
            resizeQuality: 'medium',
          })
        : await create(blob, UPRIGHT)
    // A header that understated the picture: whatever the engine made is not kept.
    if (bitmap.width * bitmap.height > MAX_LOAD_PIXELS) {
      closeQuietly(bitmap)
      return { failure: 'too-large', natural: size }
    }
    return { bitmap, natural: size }
  }

  /** The old way, for a header that cannot be read: decoded once for its size, again (scaled) when it is bigger than allowed. */
  async function decodeBlind(blob: Blob, limit: number, area: number): Promise<LoadedImage | LoadFailure | null> {
    const first = await create(blob, UPRIGHT)
    const w = first.width
    const h = first.height
    let scale = Math.min(1, limit / Math.max(w, h))
    if (area < Infinity) scale = Math.min(scale, Math.sqrt(area / (w * h)))
    if (!(scale < 1)) return { bitmap: first, natural: { w, h } }
    closeQuietly(first)
    const bitmap = await create(blob, {
      ...UPRIGHT,
      resizeWidth: Math.max(1, Math.round(w * scale)),
      resizeHeight: Math.max(1, Math.round(h * scale)),
      resizeQuality: 'medium',
    })
    return { bitmap, natural: { w, h } }
  }

  /** The picture made from the file itself: at most `limit` px on its longer side and `area` pixels. */
  async function fromOriginal(path: string, limit: number, area: number): Promise<LoadedImage | LoadFailure | null> {
    if (pictures.exists && !pictures.exists(path)) return { failure: 'missing' }
    let got: Blob | null = null
    try {
      got = await pictures.original(path)
    } catch (err) {
      const reason = reasonOf(err)
      return reason ? { failure: reason } : null
    }
    if (!got) return null
    const blob: Blob = got
    const size = await headerSize(blob)
    if (!size) {
      // No header to judge by: what a decode would take is not known (a flat JPEG of 156 megapixels is 0.6 MB), so only a tiny file is
      // decoded to see; a bigger one is a file the board cannot use (cut short, or not made the way its kind says).
      if (blob.size > IMAGE_BLIND_DECODE_MAX_BYTES) return null
      return alone(() => decodeBlind(blob, limit, area))
    }
    if (size.w * size.h > MAX_LOAD_PIXELS) return { failure: 'too-large', natural: size }
    return size.w * size.h > SOLO_PIXELS ? alone(() => decodeTo(blob, size, limit, area)) : decodeTo(blob, size, limit, area)
  }

  /** A preview: the picture at most `tier` px on its longer side. A bitmap smaller than that is the picture itself. */
  async function preview(path: string, tier: number): Promise<LoadedImage | LoadFailure | null> {
    let got: Blob | null = null
    try {
      got = await pictures.preview(path, tier)
    } catch (err) {
      const reason = reasonOf(err)
      return reason ? { failure: reason } : null
    }
    // No preview: the host will not make one (over its thumbnail cap) or cannot. The original is made into one here.
    if (!got) return fromOriginal(path, tier, Infinity)
    const bitmap = await create(got, UPRIGHT)
    return Math.max(bitmap.width, bitmap.height) < tier ? { bitmap, natural: { w: bitmap.width, h: bitmap.height } } : { bitmap }
  }

  return async (path, tier) => {
    try {
      if (isModelPath(path)) {
        const got = await preview(path, Math.min(tier, MODEL_PREVIEW_PX))
        // A model has no pixels of its own: the size of its picture is the size it is shown at on a board, whatever tier this is.
        return got?.bitmap ? { ...got, natural: { w: MODEL_PREVIEW_PX, h: MODEL_PREVIEW_PX } } : got
      }
      return tier === FULL_PX ? await fromOriginal(path, FULL_PX, FULL_MAX_PIXELS) : await preview(path, tier)
    } catch {
      return null
    }
  }
}
