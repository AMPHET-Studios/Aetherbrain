import type { ComponentProps, ReactElement } from 'react'
import type { ExtraProps } from 'react-markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVaultAdapter, TODAY_ID, imageKey, todayIso, type VaultFile } from '@aether/core'

/** localStorage for the node test environment. */
class MemoryStorage {
  private map = new Map<string, string>()
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

/** Fresh store and commands modules (fresh settings and state). */
async function fresh() {
  vi.stubGlobal('localStorage', new MemoryStorage())
  vi.resetModules()
  const { useAether } = await import('../src/store')
  const { findCommands } = await import('../src/commands')
  const s = () => useAether.getState()
  const run = (id: string) => {
    const cmd = findCommands('', s()).find((c) => c.id === id)
    if (!cmd) throw new Error(`no command ${id}`)
    return cmd.run(s())
  }
  return { useAether, s, run }
}

/**
 * A component as markup, rendered from the store's live state (server
 * rendering reads the store's initial state object, so the live state is
 * copied onto it first; each test has a fresh store).
 */
async function renderer() {
  const env = await fresh()
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const html = async (file: string, name: string, props: Record<string, unknown> = {}) => {
    const mod = (await import(`../src/components/${file}.tsx`)) as Record<string, (p: Record<string, unknown>) => React.ReactNode>
    Object.assign(env.useAether.getInitialState(), env.useAether.getState())
    return renderToStaticMarkup(createElement(mod[name]!, props))
  }
  return { ...env, html }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const TODAY = todayIso()
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('pictures in the note preview', () => {
  const NOTE = [
    '# Gate',
    '',
    '![[ring.png]]',
    '',
    'See [[sky.png|the sky]], [[Nope]] and [[Quiet]].',
    '',
    '![[missing.png]]',
    '',
  ].join('\n')

  const vault = () =>
    new MemoryVaultAdapter(
      [
        { path: 'Projects/Gate.md', content: NOTE },
        { path: 'Resources/Quiet.md', content: '# Quiet\n' },
      ],
      {
        assets: [
          { path: 'Projects/Gate/Art/ring.png', data: PNG, mtime: 2000 },
          { path: 'Projects/Gate/Art/sky.png', data: PNG, mtime: 1000 },
          // Shorter path, same name: only the note's folder (Projects) makes the embed pick the Gate one.
          { path: 'Art/ring.png', data: PNG, mtime: 3000 },
        ],
      },
    )

  it('shows a picture embed as a picture button, a picture link as a link, a missing picture as marked text; only notes are ghosts', async () => {
    const { s, html } = await renderer()
    await s().openVault(vault())
    const out = await html('MarkdownPreview', 'MarkdownPreview', { source: NOTE, selfId: 'Projects/Gate' })

    // The embed: a real button for the picture nearest the note, a placeholder while its preview loads.
    expect(out).toContain('<button type="button" class="embed-picture" title="Projects/Gate/Art/ring.png"><span class="embed-picture-wait">🖼 ring.png …</span></button>')
    // The link: resolved to the picture, never a ghost.
    const sky = out.match(/<a [^>]*data-target="sky\.png"[^>]*>the sky<\/a>/)?.[0] ?? ''
    expect(sky).toContain('class="wikilink wikilink-picture"')
    expect(sky).toContain('data-id="image:Projects/Gate/Art/sky.png"')
    expect(sky).toContain('href="#"')
    // A picture that isn't there: plain text marked missing, nothing to click.
    expect(out).toContain('<span class="picture-missing" title="No picture “missing.png” in the vault">missing.png</span>')
    // Notes work as before: [[Quiet]] resolves, [[Nope]] is the one ghost.
    expect(out).toMatch(/data-target="Quiet"[^>]*data-id="Resources\/Quiet"/)
    expect(out.match(/wikilink-ghost/g)).toHaveLength(1)
    expect(out).toMatch(/data-target="Nope"[^>]*class="wikilink wikilink-ghost"/)
  })

  it('a click on a picture embed or link goes to the picture; a missing picture has no click and writes nothing', async () => {
    const { s, useAether } = await fresh()
    const adapter = vault()
    await s().openVault(adapter)
    const { previewLink } = await import('../src/components/MarkdownPreview')
    const openImage = vi.fn(async (_path: string) => {})
    useAether.setState({ openImage })
    const ctx = { notes: s().notes, assets: s().assets, selfId: 'Projects/Gate', depth: 0 }
    /** The `<a>` props remarkWikilink gives a wikilink (see the markup test for what it resolves). */
    const link = (target: string, id: string | null, embed: boolean) =>
      previewLink(
        {
          href: '#',
          className: `wikilink${embed ? ' wikilink-embed' : ''}${id ? '' : ' wikilink-ghost'}`,
          'data-target': target,
          'data-embed': embed ? 'true' : 'false',
          ...(id ? { 'data-id': id } : {}),
          children: target,
        } as ComponentProps<'a'> & ExtraProps,
        ctx,
      ) as ReactElement<{ onOpen?: () => void; onClick?: (e: { preventDefault(): void }) => void; className?: string }>

    const ring = imageKey('Projects/Gate/Art/ring.png')
    link('ring.png', ring, true).props.onOpen!()
    expect(s().selectedId).toBe(ring)
    // A click in the text shows the picture; it doesn't launch the image app.
    expect(openImage).not.toHaveBeenCalled()

    const sky = imageKey('Projects/Gate/Art/sky.png')
    const preventDefault = vi.fn()
    link('sky.png', sky, false).props.onClick!({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(s().selectedId).toBe(sky)
    expect(openImage).not.toHaveBeenCalled()

    // Missing, embedded or linked: plain text; no Inbox/missing.png.md is ever written.
    for (const embed of [true, false]) {
      const el = link('missing.png', null, embed)
      expect(el.type).toBe('span')
      expect(el.props.className).toBe('picture-missing')
      expect(el.props.onClick).toBeUndefined()
    }
    const notes = s().notes.size
    expect([...s().notes.keys()].some((id) => /missing/i.test(id))).toBe(false)
    expect(await adapter.read('Inbox/missing.png.md')).toBeNull()

    // A missing note is still a ghost link that creates it.
    link('Nope', null, false).props.onClick!({ preventDefault })
    await vi.waitFor(() => expect(s().notes.size).toBe(notes + 1))
    expect(s().notes.has('Inbox/Nope')).toBe(true)
  })
})

describe('ticking a brief task, then Undo', () => {
  const GATE = `---\ntitle: Gate\ntype: project\nstatus: active\n---\n# Gate\n\n## To do\n\n- [x] Sketch ✅ 2026-09-01\n- [ ] Ink the gate 📅 ${TODAY}\n`

  it('reopens the task it ticked when a pending draft moved it to another line', async () => {
    const { s } = await fresh()
    await s().openVault(new MemoryVaultAdapter([{ path: 'Projects/Gate.md', content: GATE }]))
    const { tickBriefTask } = await import('../src/components/Inspector')
    const id = 'Projects/Gate'
    s().select(TODAY_ID)
    const row = s().brief!.today.find((t) => t.label === 'Ink the gate')!
    expect(s().notes.get(id)!.raw.split('\n')[row.line]).toContain('Ink the gate')

    // The note is open with unsaved edits that push every task one line down.
    s().openNote(id)
    s().setDraft(s().draft!.replace('# Gate\n', '# Gate\nIntro line.\n'))
    expect(s().dirty).toBe(true)

    await tickBriefTask(row)
    const ticked = s().notes.get(id)!.raw
    expect(ticked).toContain('Intro line.')
    expect(ticked).toMatch(/- \[x\] Ink the gate 📅 \S+ ✅/)
    expect(ticked.split('\n')[row.line]).toContain('Sketch')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'success', text: 'Ticked “Ink the gate”' })

    // Undo reopens Ink the gate (now a line further down), not the Sketch that took its old line.
    expect(s().toastAction()).toBe(true)
    await vi.waitFor(() => expect(s().notes.get(id)!.raw).toContain(`- [ ] Ink the gate 📅 ${TODAY}\n`))
    expect(s().notes.get(id)!.raw).toContain('- [x] Sketch ✅ 2026-09-01\n')
  })

  it('toggleTask says which line it wrote and the text after; a tick that wrote nothing shows no Undo', async () => {
    const { s } = await fresh()
    await s().openVault(new MemoryVaultAdapter([{ path: 'Projects/Gate.md', content: GATE }]))
    const { tickBriefTask } = await import('../src/components/Inspector')
    const id = 'Projects/Gate'
    const row = s().brief!.today.find((t) => t.label === 'Ink the gate')!
    const shown = s().notes.get(id)!.raw
    s().openNote(id)
    s().setDraft(s().draft!.replace('## To do\n', '## To do\n\n- [ ] Zeroth\n'))
    const res = await s().toggleTask(id, row.line, true, shown)
    expect(res).toEqual({ line: row.line + 2, after: s().notes.get(id)!.raw })
    expect(res!.after.split('\n')[res!.line]).toMatch(/- \[x\] Ink the gate/)

    // Ticking it again from the stale row: already done, nothing written, no "Ticked" toast.
    const toasts = s().toasts.length
    expect(await s().toggleTask(id, res!.line, true, res!.after)).toBeNull()
    await tickBriefTask(row)
    expect(s().toasts.slice(toasts).some((t) => t.text.startsWith('Ticked'))).toBe(false)
  })
})

describe('Copy embed', () => {
  const files = (): VaultFile[] => [{ path: 'Resources/Quiet.md', content: '# Quiet\n' }]

  it('refuses names a wikilink can’t hold (# [ ] |) and says what to rename', async () => {
    await fresh()
    const { embedOf } = await import('../src/components/pictures')
    const assets = new Map(
      ['Refs/Character #2.png', 'Refs/ref[1].jpg', 'Refs/a|b.png', 'Refs #1/sky.png', 'Art/sky.png', 'Art/gate.png'].map((p) => [p, { path: p }]),
    )
    expect(embedOf('Refs/Character #2.png', assets)).toEqual({ error: 'Rename “Character #2.png” to embed it: # [ ] | can’t be in a wikilink' })
    expect(embedOf('Refs/ref[1].jpg', assets)).toEqual({ error: expect.stringContaining('“ref[1].jpg”') })
    expect(embedOf('Refs/a|b.png', assets)).toEqual({ error: expect.stringContaining('“a|b.png”') })
    // Two sky.png: the path is written out, so its folder is what has to change.
    expect(embedOf('Refs #1/sky.png', assets)).toEqual({ error: expect.stringContaining('Rename “Refs #1” to embed it') })
    expect(embedOf('Art/sky.png', assets)).toEqual({ embed: '![[Art/sky.png]]' })
    expect(embedOf('Art/gate.png', assets)).toEqual({ embed: '![[gate.png]]' })
  })

  it('the palette command copies nothing for such a picture and shows the error instead of “Copied”', async () => {
    const { s, run } = await fresh()
    const writeText = vi.fn(async (_t: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await s().openVault(
      new MemoryVaultAdapter(files(), {
        assets: [
          { path: 'Resources/Refs/Character #2.png', data: PNG },
          { path: 'Resources/Refs/gate.png', data: PNG },
        ],
      }),
    )
    s().select(imageKey('Resources/Refs/Character #2.png'))
    await run('picture-embed')
    expect(writeText).not.toHaveBeenCalled()
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Rename “Character #2.png” to embed it: # [ ] | can’t be in a wikilink' })

    s().select(imageKey('Resources/Refs/gate.png'))
    await run('picture-embed')
    expect(writeText).toHaveBeenCalledWith('![[gate.png]]')
    expect(s().toasts.at(-1)).toMatchObject({ kind: 'success' })
  })
})

describe('a load that fell behind', () => {
  it('offers a rescan when the adapter could not keep every change that arrived while the vault loaded', async () => {
    const { s } = await fresh()
    class Behind extends MemoryVaultAdapter {
      readonly overflowed = true
    }
    await s().openVault(new Behind([{ path: 'Inbox/a.md', content: '# a' }]))
    const t = s().toasts.at(-1)
    expect(t?.text).toMatch(/rescan/i)
    expect(t?.action?.label).toBe('Rescan')
    await s().openVault(new MemoryVaultAdapter([{ path: 'Inbox/a.md', content: '# a' }]))
    expect(s().toasts.some((x) => x.text.includes('changed while the vault loaded') && x !== t)).toBe(false)
  })
})
