import { describe, expect, it } from 'vitest'
import { ElectronVaultAdapter } from '../src/renderer/vault/electron'
import type { AetherBridge, VaultFileDto, VaultFilePage, VaultInfo } from '../src/shared/ipc'
import { FilePager, MAX_NOTE_BYTES, PAGE_BYTES, type PageFile } from '../src/main/pages'

const note = (i: number, chars: number): PageFile => ({ path: `N/${i}.md`, content: 'x'.repeat(chars), mtime: i })

function drain(pager: FilePager, files: PageFile[]): PageFile[][] {
  const pages: PageFile[][] = []
  let page = pager.start(files)
  pages.push(page.files)
  while (page.more) {
    page = pager.more(page.token)
    pages.push(page.files)
  }
  return pages
}

describe('the notes of a vault go over in pages', () => {
  it('a small vault is one page, in order', () => {
    const files = Array.from({ length: 50 }, (_, i) => note(i, 1000))
    const pages = drain(new FilePager(), files)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.map((f) => f.path)).toEqual(files.map((f) => f.path))
  })

  it('a vault of 300 MB comes in pages of a few MB each, every note once, in order', () => {
    const files = Array.from({ length: 300 }, (_, i) => note(i, 500_000)) // 300 x 0.5 M characters
    const pages = drain(new FilePager(), files)
    expect(pages.length).toBeGreaterThan(10)
    for (const page of pages) expect(page.reduce((n, f) => n + f.content.length * 2, 0)).toBeLessThanOrEqual(PAGE_BYTES + 1_000_100)
    expect(pages.flat().map((f) => f.path)).toEqual(files.map((f) => f.path))
  })

  it('one note larger than a page is a page of its own, never split and never alone with others', () => {
    const files = [note(0, 100), note(1, PAGE_BYTES), note(2, 100)]
    const pages = drain(new FilePager(), files)
    expect(pages.map((p) => p.map((f) => f.path))).toEqual([['N/0.md'], ['N/1.md'], ['N/2.md']])
  })

  it('an empty vault is one empty last page', () => {
    const page = new FilePager().start([])
    expect(page).toMatchObject({ files: [], more: false })
  })

  it('a new list drops what the old one had left: the old token answers an empty last page', () => {
    const pager = new FilePager(1000)
    const first = pager.start(Array.from({ length: 20 }, (_, i) => note(i, 300)))
    expect(first.more).toBe(true)
    const second = pager.start([note(99, 10)])
    expect(second.files.map((f) => f.path)).toEqual(['N/99.md'])
    expect(pager.more(first.token)).toMatchObject({ files: [], more: false })
  })

  it('lets go of the notes it has handed over (the last page empties it)', () => {
    const pager = new FilePager(1000)
    const page = pager.start([note(0, 100)])
    expect(page.more).toBe(false)
    expect(pager.more(page.token)).toMatchObject({ files: [], more: false })
  })

  it('leaves out note files over MAX_NOTE_BYTES (64 MB)', () => {
    expect(MAX_NOTE_BYTES).toBe(64 * 1024 * 1024)
  })
})

describe('the adapter reads the pages', () => {
  const INFO: VaultInfo = { root: '/v', name: 'v', roots: [{ path: '/v', mount: '', label: 'v' }], exclude: [], hidden: [], keep: [] }
  const file = (i: number): VaultFileDto => ({ path: `n${i}.md`, content: `# ${i}`, mtime: i })

  it('asks for page after page until the last, and returns every note in order', async () => {
    const asked: number[] = []
    const bridge = {
      listFiles: async (): Promise<VaultFilePage> => ({ files: [file(0), file(1)], token: 7, more: true }),
      listMoreFiles: async (token: number): Promise<VaultFilePage> => {
        asked.push(token)
        return asked.length < 3 ? { files: [file(1 + asked.length)], token, more: true } : { files: [file(9)], token, more: false }
      },
      onChanges: () => () => undefined,
    } as unknown as AetherBridge
    const files = await new ElectronVaultAdapter(bridge, INFO).list()
    expect(asked).toEqual([7, 7, 7])
    expect(files.map((f) => f.path)).toEqual(['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n9.md'])
  })

  it('still takes the array an older main sends', async () => {
    const bridge = { listFiles: async () => [file(0), file(1)], onChanges: () => () => undefined } as unknown as AetherBridge
    expect((await new ElectronVaultAdapter(bridge, INFO).list()).map((f) => f.path)).toEqual(['n0.md', 'n1.md'])
  })
})
