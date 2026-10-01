import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FsVault } from '../src/main/fsvault.js'
import { installKind, isGameDirName, isInstallMarker } from '../src/main/installs.js'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-installs-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(rel: string, content = ''): Promise<string> {
  const full = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
  return full
}

describe('install folders', () => {
  it('knows game stores, engines and programs by what sits in them', () => {
    expect(installKind(['steamapps', 'libraryfolder.vdf'])).toBe('Steam library')
    expect(installKind(['Game.exe', 'steam_api64.dll', 'Data'])).toBe('Steam game')
    expect(installKind(['.egstore', 'Fortnite'])).toBe('Epic game')
    expect(installKind(['goggame-1207658924.info', 'Witcher.exe'])).toBe('GOG game')
    expect(installKind(['UnityPlayer.dll', 'Hollow.exe', 'Hollow_Data'])).toBe('Unity game')
    expect(installKind(['Engine', 'Portals', 'Portals.exe'])).toBe('Unreal game')
    expect(installKind(['MicrosoftGame.config', 'Content'])).toBe('Xbox game')
    expect(installKind(['unins000.exe', 'unins000.dat', 'Krita.exe'])).toBe('installed program')
    expect(installKind(['blender.exe', 'a.dll', 'b.dll', 'c.dll'])).toBe('installed program')
  })

  it('leaves folders of notes and art alone, an Unreal project or a lone tool included', () => {
    expect(installKind(['Gate.md', 'gate.png', 'Sketches'])).toBeNull()
    expect(installKind(['Portals.uproject', 'Content', 'Config', 'Source', 'Engine'])).toBeNull()
    expect(installKind(['upscaler.exe', 'notes.md'])).toBeNull()
    expect(installKind(['tool.exe', 'a.dll', 'b.dll'])).toBeNull()
    expect(installKind([])).toBeNull()
  })

  it('knows game library names whatever their case, with Windows trailing dots', () => {
    for (const n of ['SteamLibrary', 'Epic Games', 'XboxGames', 'GOG Games', 'Riot Games', 'windows.old', 'SteamLibrary.']) {
      expect(isGameDirName(n), n).toBe(true)
    }
    for (const n of ['Games', 'Art', 'Steampunk refs', 'Portals']) expect(isGameDirName(n), n).toBe(false)
    expect(['steam_api64.dll', 'Game.EXE', 'x.dll', 'goggame-1.info'].every(isInstallMarker)).toBe(true)
    expect(['gate.png', 'notes.md', 'readme.txt'].some(isInstallMarker)).toBe(false)
  })
})

describe('FsVault and installs', () => {
  async function drive(): Promise<void> {
    await put('ConceptForge/Ideas.md', 'ideas')
    await put('ConceptForge/gate.png')
    await put('SteamLibrary/steamapps/common/Doom/textures/sky.png')
    await put('Games/Notes on games.md', 'my notes')
    await put('Games/Hollow/UnityPlayer.dll')
    await put('Games/Hollow/Hollow_Data/icon.png')
    await put('Games/Hollow/README.md', 'game readme')
    await put('Tools/Krita/unins000.exe')
    await put('Tools/Krita/share/brushes/b.png')
    await put('Tools/notes.md', 'tool notes')
  }

  it('leaves installed games and programs out of the scan, and says which', async () => {
    await drive()
    const v = new FsVault([tmp])
    const res = await v.scan()
    expect(res.files.map((f) => f.path).sort()).toEqual(['ConceptForge/Ideas.md', 'Games/Notes on games.md', 'Tools/notes.md'])
    expect(res.assets.map((a) => a.path)).toEqual(['ConceptForge/gate.png'])
    expect([...res.folders].sort()).toEqual(['ConceptForge', 'Games', 'Tools'])
    expect(res.installs.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'Games/Hollow', kind: 'Unity game' },
      { path: 'SteamLibrary', kind: 'game library' },
      { path: 'Tools/Krita', kind: 'installed program' },
    ])
    expect(v.installs()).toHaveLength(3)
    // Nothing in them can be read or written either.
    expect(v.isIgnored('Games/Hollow/README.md')).toBe(true)
    expect(v.isIgnored('steamlibrary/x.md')).toBe(true)
    expect(await v.read('Games/Hollow/README.md')).toBeNull()
    await expect(v.create('Tools/Krita/mine.md', 'x')).rejects.toThrow(/excluded/)
    expect(v.isIgnored('Games/Notes on games.md')).toBe(false)
  })

  it('shows an install the user keeps, and leaves out a folder the user hid', async () => {
    await drive()
    const v = new FsVault([tmp], { keep: [path.join(tmp, 'Games', 'Hollow'), path.join(tmp, 'SteamLibrary')], hidden: [path.join(tmp, 'ConceptForge')] })
    const res = await v.scan()
    expect(res.files.map((f) => f.path).sort()).toEqual(['Games/Hollow/README.md', 'Games/Notes on games.md', 'Tools/notes.md'])
    expect(res.installs.map((i) => i.path)).toEqual(['Tools/Krita'])
    // steamapps stays out by name, kept library or not.
    expect(res.assets.map((a) => a.path).sort()).toEqual(['Games/Hollow/Hollow_Data/icon.png'])
    expect(v.isIgnored('ConceptForge/Ideas.md')).toBe(true)
    expect(v.isIgnored('conceptforge')).toBe(true)
    await expect(v.write('ConceptForge/New.md', 'x')).rejects.toThrow(/excluded/)
    // Rules change in place: the hidden folder is back, the kept game goes again (next scan).
    v.hidden = []
    v.keep = []
    expect(v.isIgnored('ConceptForge/Ideas.md')).toBe(false)
    expect(v.isIgnored('SteamLibrary/a.md')).toBe(true)
    const again = await v.scan()
    expect(again.files.map((f) => f.path).sort()).toEqual(['ConceptForge/Ideas.md', 'Games/Notes on games.md', 'Tools/notes.md'])
  })

  it('applies the rules inside the right root of a multi-root vault, and never hides a root itself', async () => {
    await put('D/Art/a.md', 'a')
    await put('F/Art/b.md', 'b')
    await put('F/Epic Games/Fortnite/x.md', 'x')
    const v = new FsVault([path.join(tmp, 'D'), path.join(tmp, 'F')], { hidden: [path.join(tmp, 'D', 'Art'), path.join(tmp, 'F')] })
    const res = await v.scan()
    expect(res.files.map((f) => f.path).sort()).toEqual(['F/Art/b.md'])
    expect(res.installs).toEqual([{ path: 'F/Epic Games', kind: 'game library' }])
    expect(v.isIgnored('D/Art/a.md')).toBe(true)
    expect(v.isIgnored('F/Art/b.md')).toBe(false)
  })

  it('refuses a path that reaches a hidden folder through a link', async () => {
    await put('Private/secret.md', 'shh')
    await put('Notes/a.md', 'a')
    try {
      await fs.symlink(path.join(tmp, 'Private'), path.join(tmp, 'Notes', 'link'), 'junction')
    } catch {
      return // no symlinks here
    }
    const v = new FsVault([tmp], { hidden: [path.join(tmp, 'Private')] })
    await expect(v.write('Notes/link/new.md', 'x')).rejects.toThrow(/excluded/)
    expect(await v.read('Notes/link/secret.md')).toBeNull()
  })
})
