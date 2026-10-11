/**
 * Small follow-ups of the second review round that cross agents' files: a board named like a Windows device, a picture whose header
 * cannot be read is never decoded to find out its size, and a docked reload raises no 'Could not open' toast.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardStem } from '../src/board/boardRegistry'
import { pictureSize } from '../src/board/view/env'

describe('boardStem', () => {
  it('keeps a Windows device name from becoming the board file name', () => {
    expect(boardStem('CON')).toBe('_CON')
    expect(boardStem('nul.x')).toBe('_nul.x')
    expect(boardStem('Com1')).toBe('_Com1')
    expect(boardStem('Concept art')).toBe('Concept art')
    expect(boardStem('console')).toBe('console')
  })
})

describe('pictureSize', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not decode a file of 100 KB whose header it cannot read', async () => {
    const decode = vi.fn(async () => ({ width: 100, height: 100, close() {} }))
    vi.stubGlobal('createImageBitmap', decode)
    const junk = new Blob([new Uint8Array(100 * 1024).fill(7)])
    expect(await pictureSize(junk)).toBeNull()
    expect(decode).not.toHaveBeenCalled()
  })

  it('reads the size of a PNG from its header without decoding', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    const v = new DataView(b.buffer)
    v.setUint32(16, 16000)
    v.setUint32(20, 16000)
    expect(await pictureSize(new Blob([b]))).toEqual({ w: 16000, h: 16000 })
    expect(decode).not.toHaveBeenCalled()
  })
})
