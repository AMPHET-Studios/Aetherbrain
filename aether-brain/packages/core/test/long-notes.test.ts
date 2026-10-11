/**
 * A note too long to read as markdown whole (PARSE_MAX_CHARS) is read up to there: micromark takes ~1.2 s and ~300 MB for every MB, and a
 * 12 MB chat ran the 4 GB window out of memory while the vault was loading. What is past the limit is counted and searchable, not linked.
 */
import { describe, expect, it } from 'vitest'
import { MemoryVaultAdapter, PARSE_MAX_CHARS, PARSE_MAX_CHARS_CHAT, PLAIN_MAX_CHARS, SearchIndex, loadVault, parseNote } from '../src'

const block = (k: number): string =>
  `> **Me:** How do I make the portal glow? (message ${k})\n>\n> **Claude:** Use volumetrics, see [[Portal ${k % 7}]] and #concept-art.\n>\n> - first point\n> - second point with \`code\`\n\n`

function chat(chars: number, head = '---\ntitle: Big chat\ntags: [ai-chat]\n---\n# Big chat\n\n## Transcript\n\n'): string {
  let s = head
  let k = 0
  while (s.length < chars) s += block(k++)
  return s
}

describe('long notes', () => {
  it('reads only the first PARSE_MAX_CHARS of a 4 MB chat, in well under a second of parsing', () => {
    const raw = chat(4 * 1024 * 1024)
    const t = performance.now()
    const note = parseNote({ path: 'Chats/big.md', content: raw, mtime: 1 })
    const ms = performance.now() - t
    expect(ms).toBeLessThan(4000) // 4 MB used to take about 24 s here
    // A chat (tagged ai-chat) is read less far than other notes: its text is inert, what is read is its header and start.
    expect(note.partial).toBeGreaterThan(PARSE_MAX_CHARS_CHAT * 0.7)
    expect(note.partial).toBeLessThanOrEqual(PARSE_MAX_CHARS_CHAT)
    expect(note.links.length).toBeGreaterThan(20)
    expect(note.links.length).toBeLessThan(2000)
    expect(note.raw).toBe(raw)
    expect(note.plain.length).toBeLessThanOrEqual(PLAIN_MAX_CHARS + 2)
    expect(note.meta.title).toBe('Big chat')
  })

  it('cuts at a blank line, so a block is not read in halves', () => {
    const raw = chat(PARSE_MAX_CHARS_CHAT * 3)
    const note = parseNote({ path: 'a.md', content: raw })
    const body = raw.slice(raw.indexOf('## Transcript'))
    expect(note.partial).toBeDefined()
    // The part read ends where a block ended.
    const read = note.body.slice(0, note.partial)
    expect(read.endsWith('\n\n')).toBe(true)
    expect(body.length).toBeGreaterThan(note.partial!)
  })

  it('a note under the limit is read whole, as before', () => {
    const note = parseNote({ path: 'a.md', content: chat(PARSE_MAX_CHARS - 5000, '---\ntitle: Plain\n---\n# Plain\n\n') })
    expect(note.partial).toBeUndefined()
    expect(note.links.length).toBeGreaterThan(100)
    expect(parseNote({ path: 'c.md', content: chat(PARSE_MAX_CHARS_CHAT - 3000) }).partial).toBeUndefined()
  })

  it('what is past the limit is searchable (up to PLAIN_MAX_CHARS) and counted, but gives no links or tags', () => {
    const head = 'Intro line.\n\n'
    let s = head
    while (s.length < PARSE_MAX_CHARS + 20_000) s += 'filler words here and there. '
    s += '\n\nSee [[Late Link]] and #latetag and zebrafish.\n\n'
    const note = parseNote({ path: 'a.md', content: s })
    expect(note.partial).toBeDefined()
    expect(note.links.map((l) => l.to)).not.toContain('Late Link')
    expect(note.inlineTags).not.toContain('latetag')
    expect(note.plain).toContain('zebrafish')
    expect(note.plain).toContain('Late Link')
  })

  it('the search text stops at PLAIN_MAX_CHARS, the word count does not', () => {
    const words = 400_000
    const note = parseNote({ path: 'a.md', content: `Intro.\n\n${'alpha '.repeat(words)}\n` })
    expect(note.plain.length).toBeLessThanOrEqual(PLAIN_MAX_CHARS + 2)
    expect(note.meta.wordCount).toBe(words + 1)
  })

  it('one huge list, which micromark takes minutes over (2 MB: 74 s), parses in a moment', () => {
    let s = '# List\n\n'
    let k = 0
    while (s.length < 2 * 1024 * 1024) s += `- item ${k++} about things\n`
    const t = performance.now()
    const note = parseNote({ path: 'a.md', content: s })
    expect(performance.now() - t).toBeLessThan(4000)
    expect(note.partial).toBeDefined()
  })

  it('a 40 MB note is no problem for memory or time', () => {
    const raw = chat(40 * 1024 * 1024)
    const t = performance.now()
    const note = parseNote({ path: 'a.md', content: raw })
    expect(performance.now() - t).toBeLessThan(15000)
    expect(note.meta.wordCount).toBeGreaterThan(1_000_000)
  }, 60_000)

  it('loading a vault of long notes yields to the event loop while it parses', async () => {
    const adapter = new MemoryVaultAdapter([
      ...Array.from({ length: 8 }, (_, i) => ({ path: `Chats/c${i}.md`, content: chat(PARSE_MAX_CHARS * 2) })),
    ])
    const seen: number[] = []
    await loadVault(adapter, undefined, (p) => {
      if (p.phase === 'parsing') seen.push(p.done)
    })
    expect(seen.length).toBeGreaterThan(1)
  }, 60_000)

  it('a chat is read less far than another long note, and a note that is not a chat keeps the general limit', () => {
    const asChat = parseNote({ path: 'a.md', content: chat(PARSE_MAX_CHARS * 2) })
    const other = parseNote({ path: 'b.md', content: chat(PARSE_MAX_CHARS * 2, '---\ntitle: Notes\n---\n# Notes\n\n') })
    expect(asChat.partial!).toBeLessThanOrEqual(PARSE_MAX_CHARS_CHAT)
    expect(other.partial!).toBeGreaterThan(PARSE_MAX_CHARS_CHAT)
    expect(other.partial!).toBeLessThanOrEqual(PARSE_MAX_CHARS)
  })

  it('the search index is built in slices and finds a word deep in a long chat', async () => {
    const deep = chat(PARSE_MAX_CHARS_CHAT * 2) + '\n\nlate zebrafish remark\n'
    const note = parseNote({ path: 'Chats/deep.md', content: deep })
    const other = parseNote({ path: 'a.md', content: 'Some other note about apples.' })
    const index = new SearchIndex()
    await index.rebuildAsync([note, other], 0) // a slice of 0 ms yields after every note
    expect(index.size).toBe(2)
    expect(index.search('zebrafish').map((h) => h.id)).toEqual([note.meta.id])
    expect(index.search('apples').map((h) => h.id)).toEqual([other.meta.id])
  })
})
