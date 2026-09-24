import type { VaultFile } from '../types'

/** Deterministic PRNG (mulberry32) so stress vaults are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS =
  'neuron synapse orbit cluster filament bloom graph vault note idea perspective value gesture shader portal monolith ruin rainforest lantern cache habit review inbox project area resource archive memory light color silhouette rhythm texture worker layout camera focus retrieve capture connect organize'.split(
    ' ',
  )
const FOLDERS = ['Inbox', 'Projects', 'Areas', 'Resources/Drawing', 'Resources/Graphics', 'Resources/Knowledge', 'Archive', 'Daily']
const TAGS = ['drawing', 'graphics', 'gamedev', 'knowledge-work', 'idea', 'health', 'career', 'shaders', 'color', 'tools']

/**
 * Generate a synthetic vault with roughly `nodes` notes and `edges` wikilinks,
 * clustered by folder so the constellation layout has structure. Used by the
 * `?stress=1000` mode and perf tests.
 */
export function generateSyntheticVault(nodes = 1000, edges = 2500, seed = 42): VaultFile[] {
  const rnd = seededRandom(seed)
  const titles: string[] = []
  const folders: string[] = []
  for (let i = 0; i < nodes; i++) {
    const w1 = WORDS[Math.floor(rnd() * WORDS.length)]
    const w2 = WORDS[Math.floor(rnd() * WORDS.length)]
    titles.push(`${cap(w1 ?? 'note')} ${cap(w2 ?? 'idea')} ${i}`)
    folders.push(FOLDERS[Math.floor(rnd() * FOLDERS.length)] ?? 'Inbox')
  }
  const links: number[][] = Array.from({ length: nodes }, () => [])
  let made = 0
  let guard = 0
  while (made < edges && guard++ < edges * 20) {
    const a = Math.floor(rnd() * nodes)
    // 70% of links stay inside the same folder cluster; hubs get extra in-links.
    let b: number
    if (rnd() < 0.7) {
      b = Math.floor(rnd() * nodes)
      let tries = 0
      while (folders[b] !== folders[a] && tries++ < 8) b = Math.floor(rnd() * nodes)
    } else {
      b = rnd() < 0.3 ? Math.floor(rnd() * Math.min(20, nodes)) : Math.floor(rnd() * nodes)
    }
    if (a === b) continue
    const arr = links[a]!
    if (arr.includes(b)) continue
    arr.push(b)
    made++
  }
  const start = Date.UTC(2024, 0, 1)
  const span = Date.UTC(2026, 8, 20) - start
  const files: VaultFile[] = []
  for (let i = 0; i < nodes; i++) {
    const created = new Date(start + rnd() * span).toISOString().slice(0, 10)
    const tags = [TAGS[Math.floor(rnd() * TAGS.length)], rnd() < 0.4 ? TAGS[Math.floor(rnd() * TAGS.length)] : null]
      .filter((t): t is string => !!t)
    const body = links[i]!.map((j) => `- [[${titles[j]}]] — ${sentence(rnd)}`).join('\n')
    files.push({
      path: `${folders[i]}/${titles[i]}.md`,
      content: `---\ntitle: ${titles[i]}\ntags: [${[...new Set(tags)].join(', ')}]\ncreated: ${created}\nupdated: ${created}\n---\n\n# ${titles[i]}\n\n${sentence(rnd)} ${sentence(rnd)}\n\n## Links\n\n${body}\n`,
    })
  }
  return files
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1)
}

function sentence(rnd: () => number): string {
  const n = 6 + Math.floor(rnd() * 10)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rnd() * WORDS.length)] ?? 'note')
  return cap(out.join(' ')) + '.'
}
