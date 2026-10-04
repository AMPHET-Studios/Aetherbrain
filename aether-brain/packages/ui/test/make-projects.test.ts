import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, isProjectNote } from '@aether/core'

/** localStorage for the node test environment. */
class MemoryStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v))
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

async function freshStore() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const store = await import('../src/store')
  return () => store.useAether.getState()
}

afterEach(() => void vi.unstubAllGlobals())

const vault = (readOnly = false) =>
  new MemoryVaultAdapter(
    [
      { path: 'Work/Gate/Gate.md', content: '---\ntype: project\nstatus: active\n---\n# Gate\n' },
      { path: 'Work/Sculpts/Sculpts.md', content: '# Sculpts\n\nThe folder note.\n' },
    ],
    { readOnly, folders: ['Work/Portals', 'Work/Portals/SourceArt', 'Code/brain', 'Archive/Old'] },
  )

const starFolders = (s: ReturnType<Awaited<ReturnType<typeof freshStore>>>) =>
  [...s.notes.values()]
    .filter(isProjectNote)
    .map((n) => n.meta.path.slice(0, n.meta.path.lastIndexOf('/')))
    .sort()

describe('makeProjects: several folders become stars at once', () => {
  it('writes each project note, counts existing stars, rebuilds the graph once and toasts once', async () => {
    const s = await freshStore()
    await s().openVault(vault())
    const before = s().projectId
    let rebuilds = 0
    const graph = s().graph
    const toasts = s().toasts.length
    const unsub = (await import('../src/store')).useAether.subscribe((n, p) => {
      if (n.graph !== p.graph) rebuilds++
    })
    const res = await s().makeProjects(['Work/Portals', 'code/brain', 'Work/Sculpts', 'Work/Gate', 'Work/Portals'])
    unsub()
    expect(res).toEqual({ made: 4, failed: 0, error: null })
    expect(starFolders(s())).toEqual(['Code/brain', 'Work/Gate', 'Work/Portals', 'Work/Sculpts'])
    // The folder that already had its folder note keeps it (one line added), no second note.
    expect(s().notes.get('Work/Sculpts/Sculpts')?.raw).toMatch(/type: project/)
    expect(s().notes.get('Work/Sculpts/Sculpts')?.raw).toMatch(/The folder note\./)
    expect(s().graph).not.toBe(graph)
    expect(rebuilds).toBe(1)
    expect(s().toasts.length).toBe(toasts + 1)
    expect(s().toasts.at(-1)?.text).toBe('★ 4 folders are stars now')
    // The board's open project stays where it was.
    expect(s().projectId).toBe(before)
  })

  it('reports what could not become a star in one toast', async () => {
    const s = await freshStore()
    await s().openVault(vault())
    const res = await s().makeProjects(['Archive/Old', 'Code/brain'])
    expect(res.made).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.error).toMatch(/Archived folders are not projects/)
    expect(s().toasts.at(-1)?.text).toMatch(/1 folder is a star now; 1 could not be: Archived/)
  })

  it('writes nothing in a read-only vault', async () => {
    const s = await freshStore()
    await s().openVault(vault(true))
    const res = await s().makeProjects(['Work/Portals'])
    expect(res).toMatchObject({ made: 0, failed: 1 })
    expect(starFolders(s())).toEqual(['Work/Gate'])
  })

  it('still toasts and opens the board project when one folder is made by hand', async () => {
    const s = await freshStore()
    await s().openVault(vault())
    const id = await s().makeProject('Work/Portals')
    expect(id).toBe('Work/Portals/Portals')
    expect(s().projectId).toBe(id)
    expect(s().toasts.at(-1)?.text).toMatch(/Portals is a project now/)
  })
})
