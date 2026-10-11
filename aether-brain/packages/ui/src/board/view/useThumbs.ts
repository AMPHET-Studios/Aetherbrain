/**
 * The picker's thumbnails as a hook: a ThumbCache that lives while the picker is open, told which rows are in view. Previews are
 * the host's (256 px), turned into object URLs held at most THUMB_MAX at a time and revoked when they fall out.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { BoardPictureHost } from '../api'
import { ThumbCache } from './thumbs'

export const THUMB_PX = 256

/** `urlOf(path)`: the thumbnail's URL, null when there is none, undefined while it loads. `visible` are the paths of the rows in view. */
export function useThumbs(pictures: Pick<BoardPictureHost, 'preview'>, visible: readonly string[]): (path: string) => string | null | undefined {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const cache = useRef<ThumbCache | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  // The cache is made in an effect (and given back in its cleanup): a strict-mode remount gets a live one.
  useEffect(() => {
    const c = new ThumbCache({
      load: (path) => pictures.preview(path, THUMB_PX),
      createUrl: (blob) => URL.createObjectURL(blob),
      revokeUrl: (url) => URL.revokeObjectURL(url),
      onChange: () => redraw(),
    })
    cache.current = c
    c.want(visibleRef.current)
    return () => {
      c.dispose()
      cache.current = null
    }
  }, [pictures])
  const key = visible.join('\n')
  useEffect(() => {
    cache.current?.want(visibleRef.current)
  }, [key])
  return useCallback((path: string) => cache.current?.urlOf(path), [])
}
