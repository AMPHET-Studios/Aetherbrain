import { describe, expect, it } from 'vitest'
import { boardFolderName, boardPictureName, isDeviceName } from '../src/board/format'
import { safeEmbedPath } from '../src/board/format'

/**
 * Round-2 review fix diff-core-m4: Windows reserves every name whose part before the FIRST dot is CON, PRN, AUX, NUL, COM1-9 or LPT1-9
 * (`nul.txt` and `NUL.tar.gz` are the device too, and a space before the dot does not free it). The guard of round 1 tested the whole
 * name and put its suffix at the END, after the dot, which left `con.- Library` / `nul-.lpt9temp-.webp` reserved (626 of 30,000 random
 * names). The suffix now goes right after the device word.
 */

const NOW = new Date(2026, 9, 10, 9, 30, 15)

/** What Windows looks at: the part before the first dot, trailing spaces dropped, any letter case. */
function reservedOnWindows(name: string): boolean {
  const first = name.split('.')[0]!.replace(/ +$/, '')
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i.test(first)
}

function rand(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('isDeviceName', () => {
  it('knows a device by the part before its first dot, in any case, with or without an extension', () => {
    for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'COM0', 'LPT0', 'com¹', 'LPT³']) expect(isDeviceName(name), name).toBe(true)
    for (const name of ['nul.txt', 'NUL.tar.gz', 'con.', 'con..', 'com1.a.b.c', 'LPT9.png', 'con .x', 'CON  ', 'aux .', 'con.- Library~- pictures', 'nul.lpt9temp.webp']) expect(isDeviceName(name), name).toBe(true)
    for (const name of ['console', 'con-', 'conx.png', 'aux1', 'comm', 'com10', 'com1a', 'lpt', 'lpt10', 'nu', 'nul-.png', 'a.con', 'x.nul.png', '.con', ' con', 'xcon', 'c o n', '', 'Library']) expect(isDeviceName(name), JSON.stringify(name)).toBe(false)
  })
})

describe('boardFolderName and the device names', () => {
  it('puts the suffix right after the device word, whatever follows (a dot, spaces, an extension), and keeps the old answer where the name is no device\'s', () => {
    expect(boardFolderName('CON')).toBe('CON pictures')
    expect(boardFolderName('lpt1')).toBe('lpt1 pictures')
    expect(boardFolderName('nul.txt')).toBe('nul pictures.txt')
    expect(boardFolderName('COM1.tar.gz')).toBe('COM1 pictures.tar.gz')
    expect(boardFolderName('con .x')).toBe('con pictures .x')
    // The reviewer's case: a device word before a dot, the rest rewritten by the cleaning (`#`, tab and `|` become `-`).
    expect(boardFolderName('con.#\tLibrary~|')).toBe('con pictures.- Library~-')
    // Both: a device name that also ends in the vault's temp suffix.
    expect(boardFolderName('con.aether-tmp')).toBe('con pictures.aether-tmp pictures')
    for (const name of ['console', 'con-', 'conx.png', 'aux1', 'comm', 'com10', 'lpt', 'a.con', 'Gate reference']) expect(boardFolderName(name), name).toBe(name)
    // The names the vault ignores still get theirs at the end.
    expect(boardFolderName('Library')).toBe('Library pictures')
    expect(boardFolderName('Steam. ')).toBe('Steam pictures')
  })
})

describe('boardPictureName and the device names', () => {
  const name = (original: string, mime = 'image/png') => boardPictureName(original, mime, NOW)

  it('puts the dash right after the device word, before any dot', () => {
    expect(name('con.png')).toBe('con-.png')
    expect(name('NUL.jpg')).toBe('NUL-.jpg')
    expect(name('CON.png.png')).toBe('CON-.png.png')
    expect(name('nul.lpt9temp.webp')).toBe('nul-.lpt9temp.webp')
    expect(name('con .x.png')).toBe('con- .x.png')
    expect(name('Lpt3.final.v2.bmp')).toBe('Lpt3-.final.v2.bmp')
    // A name that is no device's is left alone.
    for (const original of ['console.png', 'con-.png', 'aux1.png', 'x.con.png', 'comm.jpg', 'com10.gif']) expect(name(original), original).toBe(original)
  })

  it('its result is a name safe to embed, device word or not', () => {
    for (const original of ['con.png', 'CON.png.png', 'nul.lpt9temp.webp', 'com1.x_y.png', 'aux.#a.png']) {
      expect(safeEmbedPath(`Boards/Gate/${name(original)}`), original).toBe(true)
    }
  })
})

describe('no board folder or picture name is a Windows device, 30,000 random names', () => {
  const BITS = ['con', 'CON', 'Nul', 'prn', 'AUX', 'com1', 'COM9', 'lpt1', 'Lpt9', 'com0', 'com²', 'console', 'com10', 'nu', 'l', '.', '..', '. ', ' ', '  ', '\t', '-', '_', '#', '|', '~', ':', '/', '\\', '[', ']', '"', '*', '?', '$', '.x', '.png', 'png', 'Library', 'temp', '.aether-tmp', 'Steam', 'a', 'b', 'ü', '日本', '😀', '1', '(1)', 'x.y']

  it('boardFolderName: the first dot-separated part is never a device word, and nothing else about the name changed', () => {
    const r = rand(20261010)
    let devices = 0
    for (let i = 0; i < 15000; i++) {
      let title = ''
      for (let n = 1 + Math.floor(r() * 5); n > 0; n--) title += BITS[Math.floor(r() * BITS.length)]
      const folder = boardFolderName(title)
      if (isDeviceName(folder.replace(/ pictures(?=\.|$)/, ''))) devices++
      expect(reservedOnWindows(folder), JSON.stringify([title, folder])).toBe(false)
      expect(folder).not.toMatch(/[\\/:*?"<>|#[\]]/)
      expect(folder.length).toBeLessThanOrEqual(130)
    }
    // The fuzz really met device names (many hundreds of them), or it would prove nothing.
    expect(devices).toBeGreaterThan(300)
  })

  it('boardPictureName: the first dot-separated part of the file name is never a device word', () => {
    const r = rand(77)
    const EXTS = ['.png', '.PNG', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.txt', '', '.']
    let devices = 0
    for (let i = 0; i < 15000; i++) {
      let stem = ''
      for (let n = 1 + Math.floor(r() * 5); n > 0; n--) stem += BITS[Math.floor(r() * BITS.length)]
      const original = stem + EXTS[Math.floor(r() * EXTS.length)]
      const file = boardPictureName(original, 'image/png', NOW)
      if (/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?= *\.|$)/i.test(original.replace(/^.*[\\/]/, '').replace(/^[-.$ ]+/, ''))) devices++
      expect(reservedOnWindows(file), JSON.stringify([original, file])).toBe(false)
      expect(/\.(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(file), file).toBe(true)
    }
    expect(devices).toBeGreaterThan(300)
  })
})
