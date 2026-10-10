/**
 * shell-6 / format-m2: no name the board writes is one the vault refuses. The lists are the desktop's own, the vault's rule is
 * FsVault.isIgnored, and a fuzz of odd names goes through both.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GAME_FOLDERS, IGNORED_FOLDERS, boardFolderName, boardPictureName } from '../src/board/format'
import { FsVault, HEAVY_DIRS } from '../../../apps/desktop/src/main/fsvault'
import { GAME_DIRS } from '../../../apps/desktop/src/main/installs'

const NOW = new Date(2026, 9, 9, 14, 35, 12)
const dir = mkdtempSync(join(tmpdir(), 'aether-names-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const vault = new FsVault([dir])

describe('the lists copied from the desktop app are the desktop app\'s', () => {
  it('IGNORED_FOLDERS is HEAVY_DIRS and GAME_FOLDERS is GAME_DIRS, name for name', () => {
    expect([...IGNORED_FOLDERS].sort()).toEqual([...HEAVY_DIRS].sort())
    expect([...GAME_FOLDERS].sort()).toEqual([...GAME_DIRS].sort())
    expect(GAME_FOLDERS.size).toBeGreaterThanOrEqual(24)
  })

  it('a board named like any of them gets a folder the vault accepts', () => {
    for (const name of [...HEAVY_DIRS, ...GAME_DIRS]) {
      for (const spelled of [name, name.toUpperCase(), `${name}. `]) {
        const folder = boardFolderName(spelled)
        expect(vault.isIgnored(`Boards/${folder}`), spelled).toBe(false)
        expect(vault.isIgnored(`Boards/${folder}/photo.png`), spelled).toBe(false)
      }
    }
  })
})

describe('odd names never reach the vault\'s ignore rules', () => {
  const BITS = ['$', '$', '.', '..', '-', ' ', '  ', '#', ':', '\\', '/', '*', '?', '|', '"', '<', '>', '[', ']', '_', '~', '\u0000', '\u0007', '\t', '\n', '😀', 'ü', '日本', 'CON', 'NUL', 'aux', 'com1', 'LPT9', 'Library', 'Temp', 'out', 'build', 'Steam', 'Ubisoft', '.git', '$R', 'R1A2B3C', 'image', 'Screenshot', 'photo', 'a', 'b', '1', ' 2', '(1)', '.aether-tmp', 'node_modules', 'AppData', 'Windows', '..\\..\\', '../', 'C:\\Users\\me\\']
  const EXTS = ['.png', '.PNG', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.txt', '', '.']

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

  it('boardPictureName: 6,000 random names, none refused as a path in the board\'s folder', () => {
    const r = rand(2026)
    let dollars = 0
    for (let i = 0; i < 6000; i++) {
      let stem = ''
      for (let n = 1 + Math.floor(r() * 5); n > 0; n--) stem += BITS[Math.floor(r() * BITS.length)]
      const original = stem + EXTS[Math.floor(r() * EXTS.length)]
      if (original.replace(/^.*[\\/]/, '').startsWith('$')) dollars++
      const name = boardPictureName(original, 'image/png', NOW)
      const path = `Boards/Gate/${name}`
      expect(vault.isIgnored(path), JSON.stringify([original, name])).toBe(false)
      expect(name.startsWith('.') || name.startsWith('$'), JSON.stringify([original, name])).toBe(false)
      expect(name).not.toMatch(/[\\/:*?"<>|#[\]\u0000-\u001f]/)
      expect(/\.(png|jpg|jpeg|webp|gif|bmp|avif)$/.test(name)).toBe(true)
    }
    // The fuzz really hit the case: names that start with a $.
    expect(dollars).toBeGreaterThan(200)
  })

  it('boardFolderName: 6,000 random titles, none refused as a folder (or for a picture in it)', () => {
    const r = rand(77)
    for (let i = 0; i < 6000; i++) {
      let title = ''
      for (let n = 1 + Math.floor(r() * 4); n > 0; n--) title += BITS[Math.floor(r() * BITS.length)]
      const folder = boardFolderName(title)
      expect(vault.isIgnored(`Boards/${folder}`), JSON.stringify([title, folder])).toBe(false)
      expect(vault.isIgnored(`Boards/${folder}/${boardPictureName('x.png', 'image/png', NOW)}`), JSON.stringify([title, folder])).toBe(false)
      expect(folder).not.toMatch(/[\\/:*?"<>|#[\]]/)
      expect(folder.length).toBeLessThanOrEqual(90)
    }
  })

  it('the names of the recycle bin and a plain $ name', () => {
    for (const original of ['$R1A2B3C.png', '$I1A2B3C.jpg', '$100 bill.png', '$.png', '$$.png', '$ .png']) {
      const name = boardPictureName(original, 'image/png', NOW)
      expect(vault.isIgnored(`Boards/Gate/${name}`), original).toBe(false)
    }
  })
})
