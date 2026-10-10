/**
 * The picture cache's loader (imageCache.ts asks it for a picture at a tier): turns the host's bytes into decoded bitmaps.
 * The two small tiers are previews the host makes (`preview`); the full tier is the file itself (`original`), scaled while decoding
 * when its longer side is over 8192. Nothing here throws: any failure is a null, and a bitmap made along the way is closed unless it is
 * handed over. Design: docs/design/reference-board.md ("Decisions" 4).
 */
import { IMAGE_TIERS, type BoardPictureHost, type ImageTier } from './api'
import type { BitmapLike, LoadedImage } from './imageCache'

/** `createImageBitmap` as the loader uses it (a Blob in, a bitmap out), so that tests can pass a fake. */
export type CreateBitmap = (source: Blob, options?: ImageBitmapOptions) => Promise<BitmapLike>

/** The longer side of the full tier. */
const FULL_PX = IMAGE_TIERS[2]

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

export function createImageLoader(
  pictures: Pick<BoardPictureHost, 'preview' | 'original'>,
  create: CreateBitmap = (source, options) => createImageBitmap(source, options),
): (path: string, tier: ImageTier) => Promise<LoadedImage | null> {
  /** A preview: the picture at most `tier` px on its longer side. A bitmap smaller than that is the picture itself. */
  async function preview(path: string, tier: ImageTier): Promise<LoadedImage | null> {
    const blob = await pictures.preview(path, tier)
    if (!blob) return null
    const bitmap = await create(blob, UPRIGHT)
    return Math.max(bitmap.width, bitmap.height) < tier ? { bitmap, natural: { w: bitmap.width, h: bitmap.height } } : { bitmap }
  }

  /** The picture itself, decoded once for its size and again, scaled while decoding, when it is bigger than the tier. */
  async function full(path: string): Promise<LoadedImage | null> {
    const blob = await pictures.original(path)
    if (!blob) return null
    const first = await create(blob, UPRIGHT)
    const w = first.width
    const h = first.height
    const longer = Math.max(w, h)
    if (!(longer > FULL_PX)) return { bitmap: first, natural: { w, h } }
    closeQuietly(first)
    const scale = FULL_PX / longer
    const bitmap = await create(blob, {
      ...UPRIGHT,
      resizeWidth: Math.max(1, Math.round(w * scale)),
      resizeHeight: Math.max(1, Math.round(h * scale)),
      resizeQuality: 'medium',
    })
    return { bitmap, natural: { w, h } }
  }

  return async (path, tier) => {
    try {
      return tier === FULL_PX ? await full(path) : await preview(path, tier)
    } catch {
      return null
    }
  }
}
