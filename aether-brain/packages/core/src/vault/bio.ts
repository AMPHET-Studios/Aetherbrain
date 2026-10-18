import { joinFrontmatter } from '../markdown/frontmatter'
import type { NoteId } from '../types'
import { idFromPath, normalizeFolderPath, slugifyTitle, todayIso } from './paths'

/**
 * The Bio star (docs/COSMOLOGY.md): the one blue star of the sky. It is the folder `Bio` at the vault's home (`Bio`, or
 * `<first drive>/Bio` in a vault of several roots) and holds the user's own notes about their body and mind: sleep, food,
 * meds, exercise, drugs and mental health.
 *
 * What this file writes are starting pages: the user's own headings with empty lists to fill in. Never a diagnosis, never
 * advice, never a phone number, never a word about changing a medicine (the companion keeps to the same rules,
 * `src/mcp/companion.ts`); a test reads every page for them. Nothing here is ever written over: a page that is there is left
 * as it is (`planBio`).
 */
export const BIO_FOLDER = 'Bio'

/** A list of lines under a heading: `lines` are the prompts to fill in; without any, one empty bullet. */
interface BioSection {
  heading: string
  lines?: string[]
}

export interface BioNoteDef {
  /** The page's title; its file name is the same (`Bio/Sleep schedule.md`). */
  title: string
  /** The topic tag next to `bio`. */
  tag: string
  /** One line in the user's own voice above the sections, or ''. */
  intro: string
  sections: BioSection[]
}

/** The six pages of the Bio star, in the order the user named them. */
export const BIO_NOTES: readonly BioNoteDef[] = [
  {
    title: 'Sleep schedule',
    tag: 'sleep',
    intro: 'Write what is true, not what should be.',
    sections: [
      { heading: 'A usual night', lines: ['Lights out:', 'Fall asleep:', 'Wake up:', 'Naps:'] },
      { heading: 'What helps' },
      { heading: 'What gets in the way' },
    ],
  },
  {
    title: 'Food',
    tag: 'food',
    intro: 'What I eat and when, as it really is.',
    sections: [
      { heading: 'A usual day', lines: ['Breakfast:', 'Lunch:', 'Dinner:', 'Snacks and drinks:'] },
      { heading: 'What I avoid (allergies, things that go badly)' },
      { heading: 'Easy meals for low-energy days' },
    ],
  },
  {
    title: 'Meds',
    tag: 'meds',
    intro: 'Only what I take, in my own words. Changes go through my doctor or pharmacist.',
    sections: [
      { heading: 'What I take', lines: ['Name, dose, when, what it is for:'] },
      { heading: 'Who prescribes it' },
      { heading: 'What I notice (good and bad)' },
      { heading: 'Questions for my doctor or pharmacist' },
    ],
  },
  {
    title: 'Exercise',
    tag: 'exercise',
    intro: 'What my body does in a week, and what I would like it to do.',
    sections: [{ heading: 'What I do' }, { heading: 'A usual week' }, { heading: 'What I like and what I skip' }],
  },
  {
    title: 'Drugs',
    tag: 'drugs',
    intro: 'Anything I use besides food and prescribed meds: alcohol, nicotine, caffeine, cannabis, anything else. Written for me, no judgment.',
    sections: [
      { heading: 'What I use', lines: ['What, how much, how often:'] },
      { heading: 'What it does for me, and what it costs me' },
      { heading: 'When I want it most' },
    ],
  },
  {
    title: 'Mental health',
    tag: 'mental-health',
    intro: 'In my own words.',
    sections: [
      { heading: 'What I live with' },
      { heading: 'What it looks like when I am doing well' },
      { heading: 'Early signs that I am not' },
      { heading: 'What helps' },
      { heading: 'My people (who I can reach)' },
    ],
  },
]

/** The document of one page for `day` (YYYY-MM-DD): frontmatter, the title, the intro and the sections, then a Log to write in. */
export function bioNoteText(def: BioNoteDef, day: string = todayIso()): string {
  const list = (lines: string[] | undefined): string => (lines && lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- ')
  const parts = [`# ${def.title}`]
  if (def.intro) parts.push(def.intro)
  for (const s of def.sections) parts.push(`## ${s.heading}\n\n${list(s.lines)}`)
  parts.push(`## Log\n\n${list(undefined)}`)
  return joinFrontmatter({ title: def.title, type: 'note', tags: ['bio', def.tag], created: day, updated: day }, `${parts.join('\n\n')}\n`)
}

export interface BioPlan {
  /** The Bio folder (vault path). */
  folder: string
  /** The pages to write: only the ones the folder does not have yet. */
  create: { path: string; title: string; content: string }[]
  /** Titles of the pages already there (a note of that name in the folder, in any letter case). */
  present: string[]
}

/** The vault path of a page of the Bio star (`Bio/Sleep schedule.md`). */
export function bioNotePath(folder: string, def: BioNoteDef): string {
  const dir = normalizeFolderPath(folder)
  return `${dir ? `${dir}/` : ''}${slugifyTitle(def.title)}.md`
}

/**
 * Which pages of the Bio star the vault has and which it lacks. `existing` is every note id of the vault (or just the ones in
 * the folder); a page counts as there under any letter case, since Windows and macOS keep one file for `Food` and `food`.
 */
export function bioStatus(folder: string, existing: Iterable<NoteId>): { present: BioNoteDef[]; missing: BioNoteDef[] } {
  const dir = normalizeFolderPath(folder).toLowerCase()
  const prefix = dir ? `${dir}/` : ''
  const have = new Set<string>()
  for (const id of existing) {
    const lower = id.toLowerCase()
    if (lower.startsWith(prefix)) have.add(lower)
  }
  const present: BioNoteDef[] = []
  const missing: BioNoteDef[] = []
  for (const def of BIO_NOTES) (have.has(idFromPath(bioNotePath(folder, def)).toLowerCase()) ? present : missing).push(def)
  return { present, missing }
}

/** What making the Bio star writes: the missing pages, in order, dated `now`. Pages that are there are never in `create`. */
export function planBio(folder: string, existing: Iterable<NoteId>, now: Date = new Date()): BioPlan {
  const dir = normalizeFolderPath(folder)
  const { present, missing } = bioStatus(dir, existing)
  const day = todayIso(now)
  return {
    folder: dir,
    create: missing.map((def) => ({ path: bioNotePath(dir, def), title: def.title, content: bioNoteText(def, day) })),
    present: present.map((def) => def.title),
  }
}
