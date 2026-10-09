import { buildGraph, parseNote, type GraphData, type NoteId, type ParsedNote } from '@aether/core'

export interface Shape {
  /** Top-level areas, subfolders per area, topic folders per subfolder, notes per topic folder. */
  areas: number
  subs: number
  topics: number
  notes: number
  /** One in this many notes links to a note that does not exist yet (a ghost). */
  ghostEvery?: number
  projects?: number
}

/** A vault of `areas × subs × topics × notes` notes, each linking to the next, some to a ghost; and some project stars. */
export function vaultOf(s: Shape, more?: { extra?: (add: (path: string, content: string) => void) => void }): { graph: GraphData; folders: string[] } {
  const notes = new Map<NoteId, ParsedNote>()
  const folders = new Set<string>()
  let k = 0
  const add = (path: string, content: string): void => {
    const n = parseNote({ path, content, mtime: 1_700_000_000_000 + k })
    notes.set(n.meta.id, n)
  }
  for (let a = 0; a < s.areas; a++) {
    for (let b = 0; b < s.subs; b++) {
      for (let c = 0; c < s.topics; c++) {
        const dir = `Area${a}/Sub${b}/Topic${c}`
        folders.add(`Area${a}`).add(`Area${a}/Sub${b}`).add(dir)
        for (let i = 0; i < s.notes; i++, k++) {
          const next = `Note ${k + 1}`
          const ghost = s.ghostEvery && k % s.ghostEvery === 0 ? `\n[[Todo ${k}]]` : ''
          add(`${dir}/Note ${k}.md`, `# Note ${k}\n\n[[${next}]]${ghost}\n`)
        }
      }
    }
  }
  for (let p = 0; p < (s.projects ?? 0); p++) {
    folders.add('Projects').add(`Projects/P${p}`)
    add(`Projects/P${p}.md`, `---\nstatus: active\n---\n# P${p}\n\n[[Note ${p}]]\n`)
    for (let t = 0; t < 5; t++) add(`Projects/P${p}/Task ${t}.md`, `# Task ${p}-${t}\n\n[[P${p}]]\n`)
  }
  more?.extra?.(add)
  const graph = buildGraph(notes, { folders: { multiRoot: false, all: [...folders], rootTitle: 'Vault', maxDepth: 3, maxFolders: 0 } })
  return { graph, folders: [...folders] }
}
