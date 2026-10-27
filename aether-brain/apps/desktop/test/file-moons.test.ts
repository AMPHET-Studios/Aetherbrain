import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FILE_JUNK_DIR, FILE_JUNK_EXT, FILE_JUNK_NAME, FILE_SCAN_MAX, FsVault, OPENABLE_FILE_EXT, isFileCandidate, isOpenableFileName } from '../src/main/fsvault.js'
import { FILE_JUNK_DIR as CORE_DIR, FILE_JUNK_EXT as CORE_EXT, FILE_JUNK_NAME as CORE_NAME, FILE_OPENABLE_KINDS, FILE_SCAN_MAX as CORE_SCAN_MAX, fileExtensionsOf, isFileMoonPath, isOpenableFile } from '@aether/core'

/**
 * Every file is a moon (docs/COSMOLOGY.md): main lists the other files a scan finds, by name, bounded, and may open only the safe kinds.
 * Main cannot import @aether/core at runtime, so it keeps copies of the lists: these tests keep the copies equal.
 */

describe('the copies of the lists in main', () => {
  it('are the same as core’s: the clutter, the scan cap and the kinds the OS may open', () => {
    expect([...FILE_JUNK_EXT].sort()).toEqual([...CORE_EXT].sort())
    expect([...FILE_JUNK_NAME].sort()).toEqual([...CORE_NAME].sort())
    expect([...FILE_JUNK_DIR].sort()).toEqual([...CORE_DIR].sort())
    expect(FILE_SCAN_MAX).toBe(CORE_SCAN_MAX)
    const openable = FILE_OPENABLE_KINDS.flatMap((k) => fileExtensionsOf(k)).sort()
    expect([...OPENABLE_FILE_EXT].sort()).toEqual(openable)
  })

  it('judge the same paths the same way', () => {
    for (const p of ['Music/theme.mp3', 'Docs/plan.pdf', 'a/x.zzz', 'A/Makefile', 'A/.hidden.txt', 'p/dist/a.zip', 'A/app.js.map', 'A/Thumbs.db', 'A/x.lua']) {
      expect(isFileCandidate(p, 'linux'), p).toBe(isFileMoonPath(p))
    }
  })
})

describe('what the OS may open', () => {
  it('opens a song, a document, an archive, a data file and a design file; never code or a kind nobody named', () => {
    for (const n of ['a.mp3', 'a.PDF', 'a.zip', 'a.csv', 'a.psd']) expect(isOpenableFileName(n), n).toBe(true)
    for (const n of ['a.ps1', 'a.bat', 'a.cmd', 'a.sh', 'a.py', 'a.lua', 'a.exe', 'a.msi', 'a.jar', 'a.svg', 'a.hta', 'a.scr', 'a.zzz', 'noext']) expect(isOpenableFileName(n), n).toBe(false)
    expect(isOpenableFile('x/a.exe')).toBe(false)
    expect(isOpenableFile('x/a.mp3')).toBe(true)
  })
})

describe('the scan lists the other files', () => {
  let tmp: string
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-files-'))
  })
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })
  const put = async (rel: string, data = 'x') => {
    const full = path.join(tmp, ...rel.split('/'))
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, data)
  }

  it('finds an mp3, a pdf and a script by name, and leaves out notes, pictures and clutter', async () => {
    await put('Music/theme.mp3')
    await put('Docs/plan.pdf')
    await put('Mod/weapon.lua')
    await put('Music/Music.md', '# Music')
    await put('Music/cover.png')
    await put('Music/.hidden.mp3')
    await put('dist/bundle.zip')
    await put('Music/app.js.map')
    await put('Music/Makefile')
    const res = await new FsVault([tmp]).scan()
    const found = (res.otherFiles ?? []).map((f) => f.path).sort()
    expect(found).toEqual(['Docs/plan.pdf', 'Mod/weapon.lua', 'Music/theme.mp3'])
    expect(res.assets.map((a) => a.path)).toEqual(['Music/cover.png'])
  })

  it('opens nothing it has not scanned, and never a note or a picture through the file door', async () => {
    await put('Music/theme.mp3')
    await put('Music/Music.md', '# Music')
    await put('Music/cover.png')
    const v = new FsVault([tmp])
    await v.scan()
    expect(await v.fileAbs('Music/theme.mp3')).toBe(path.join(tmp, 'Music', 'theme.mp3'))
    expect(await v.fileAbs('Music/Music.md')).toBeNull()
    expect(await v.fileAbs('Music/cover.png')).toBeNull()
    expect(await v.fileAbs('Music/missing.mp3')).toBeNull()
    expect(await v.fileAbs('../outside.mp3')).toBeNull()
    expect(await v.fileAbs('Music')).toBeNull()
  })
})
