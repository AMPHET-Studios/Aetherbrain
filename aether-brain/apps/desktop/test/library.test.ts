import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { dateFromName, exifDay, readMeta } from '../src/main/library/meta'
import { GENRES, LABEL_SETS, VISION_TYPES, safeName, tasteTags, typeByRules } from '../src/main/library/classify'
import { LIBRARY_END, LIBRARY_START, assignDests, freeName, libraryNotes, mergeNote, newNote, picksOf, place, type Picture, type PlanItem, type Seen } from '../src/main/library/plan'
import { LookCache, MANIFEST, analyze, copyPlan, inside, labelsKey, type Eyes } from '../src/main/library/library'
import { vi } from 'vitest'
import { visionAnswerOf, type VisionJob } from '../src/main/library/vision'
import { VisionModel, VISION_MODEL_FILES } from '../src/main/library/vision-model'

/* ------------------------------------------------------------------ */
/* Picture bytes                                                        */
/* ------------------------------------------------------------------ */

const CRC = (() => {
  const t: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (b: Buffer) => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, c])
}

/** A real PNG of noise (seeded: the same seed gives the same bytes), w × h, with optional text chunks. */
function png(w: number, h: number, seed: number, text: Record<string, string> = {}): Buffer {
  let s = seed >>> 0 || 1
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) >>> 24) & 255
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = i % (w * 3 + 1) === 0 ? 0 : rnd()
  const texts = Object.entries(text).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...texts, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A big-endian TIFF with ASCII tags in IFD0 and in the Exif IFD. */
function tiff(ifd0: [number, string][], exif: [number, string][]): Buffer {
  const n0 = ifd0.length + (exif.length ? 1 : 0)
  const ifd0At = 8
  const exifAt = ifd0At + 2 + 12 * n0 + 4
  let dataAt = exifAt + (exif.length ? 2 + 12 * exif.length + 4 : 0)
  const out = Buffer.alloc(dataAt + [...ifd0, ...exif].reduce((a, [, s]) => a + s.length + 1, 0))
  out.write('MM', 0, 'latin1')
  out.writeUInt16BE(42, 2)
  out.writeUInt32BE(ifd0At, 4)
  const writeIfd = (at: number, tags: [number, string][], pointer?: number) => {
    const all = [...tags.map(([t, s]) => ({ t, s })), ...(pointer ? [{ t: 0x8769, s: null as string | null }] : [])].sort((a, b) => a.t - b.t)
    out.writeUInt16BE(all.length, at)
    all.forEach((e, k) => {
      const p = at + 2 + k * 12
      out.writeUInt16BE(e.t, p)
      if (e.s === null) {
        out.writeUInt16BE(4, p + 2)
        out.writeUInt32BE(1, p + 4)
        out.writeUInt32BE(pointer!, p + 8)
      } else {
        out.writeUInt16BE(2, p + 2)
        out.writeUInt32BE(e.s.length + 1, p + 4)
        out.writeUInt32BE(dataAt, p + 8)
        out.write(e.s, dataAt, 'latin1')
        dataAt += e.s.length + 1
      }
    })
    out.writeUInt32BE(0, at + 2 + all.length * 12)
  }
  writeIfd(ifd0At, ifd0, exif.length ? exifAt : undefined)
  if (exif.length) writeIfd(exifAt, exif)
  return out
}

/** A JPEG header with EXIF (camera, date) and a frame size, padded to `pad` bytes. */
function jpeg(w: number, h: number, exif: { make?: string; model?: string; taken?: string }, pad = 20_000, seed = 1): Buffer {
  const ifd0: [number, string][] = []
  if (exif.make) ifd0.push([0x010f, exif.make])
  if (exif.model) ifd0.push([0x0110, exif.model])
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(ifd0, exif.taken ? [[0x9003, exif.taken]] : [])])
  const seg = (m: number, body: Buffer) => {
    const head = Buffer.alloc(4)
    head[0] = 0xff
    head[1] = m
    head.writeUInt16BE(body.length + 2, 2)
    return Buffer.concat([head, body])
  }
  const sof = Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  const filler = Buffer.alloc(pad, seed & 255)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, app1Body), seg(0xc0, sof), filler, Buffer.from([0xff, 0xd9])])
}

const meta0 = { kind: 'png' as const, width: 800, height: 600, turned: false, taken: null, make: null, model: null, software: null, ai: null }
const pic = (rel: string, over: Partial<Picture> = {}): Picture => ({ abs: `/src/${rel}`, rel, size: 50_000, mtime: Date.UTC(2024, 2, 1), meta: { ...meta0 }, ...over })
/** Picks saying `label` of `set` with probability `p`. */
const sees = (picks: Record<string, [number, number][]>, colours: Seen['colours'] = null): Seen => ({ colours, picks })
const typeIndex = (t: string) => VISION_TYPES.indexOf(t as (typeof VISION_TYPES)[number])
const genreIndex = (fam: keyof typeof GENRES, name: string) => GENRES[fam].findIndex((g) => g.name === name)

/* ------------------------------------------------------------------ */

describe('picture metadata', () => {
  it('reads a camera, its model and the day a JPEG was taken from EXIF', () => {
    const m = readMeta(jpeg(4000, 3000, { make: 'Canon', model: 'EOS R6', taken: '2023:05:12 10:10:10' }))
    expect(m).toMatchObject({ kind: 'jpeg', width: 4000, height: 3000, make: 'Canon', model: 'EOS R6', taken: '2023-05-12', ai: null })
  })

  it('tells Stable Diffusion and ComfyUI pictures by their settings', () => {
    expect(readMeta(png(64, 64, 3, { parameters: 'a castle\nSteps: 30, Sampler: Euler a, Seed: 42' })).ai).toBe('Stable Diffusion')
    expect(readMeta(png(64, 64, 3, { prompt: '{"3": {"class_type": "KSampler", "inputs": {}}}' })).ai).toBe('ComfyUI')
    expect(readMeta(png(64, 64, 3, { Comment: 'drawn by hand' })).ai).toBeNull()
  })

  it('finds dates in file names and refuses impossible ones', () => {
    expect(dateFromName('IMG_20240612_142233.jpg')).toBe('2024-06-12')
    expect(dateFromName('Screenshot 2022-01-02 at 10.00.00.png')).toBe('2022-01-02')
    expect(dateFromName('PXL_20231225_090000123.jpg')).toBe('2023-12-25')
    expect(dateFromName('1700000000000.png')).toBe('2023-11-14')
    expect(dateFromName('gate_v2.png')).toBeNull()
    expect(dateFromName('IMG_20241345.jpg')).toBeNull()
    expect(exifDay('0000:00:00 00:00:00')).toBeNull()
  })
})

describe('types by rules', () => {
  it('trusts generator metadata, screenshot names, texture maps and cameras', () => {
    expect(typeByRules({ ...meta0, ai: 'Midjourney' }, 'x.png', 'x.png')).toMatchObject({ type: 'AI Generated', sure: true })
    expect(typeByRules(meta0, 'Screenshot 2024-01-01.png', 'Screenshot 2024-01-01.png')).toMatchObject({ type: 'Screenshots', sure: true })
    expect(typeByRules(meta0, 'rock_normal.png', 'Mats/rock_normal.png')).toMatchObject({ type: 'Textures', sure: true })
    expect(typeByRules({ ...meta0, make: 'SONY' }, 'a.jpg', 'a.jpg')).toMatchObject({ type: 'Photos', sure: true })
    expect(typeByRules(meta0, 'IMG_1234.jpg', 'IMG_1234.jpg')).toMatchObject({ type: 'Photos', sure: true })
  })

  it('takes folder names and software as a guess only', () => {
    expect(typeByRules(meta0, 'a.png', 'Concept Art/a.png')).toMatchObject({ type: 'Concept Art', sure: false })
    expect(typeByRules({ ...meta0, software: 'Blender 4.1' }, 'a.png', 'a.png')).toMatchObject({ type: 'Renders', sure: false })
    expect(typeByRules(meta0, 'a.png', 'stuff/a.png')).toMatchObject({ type: null, sure: false })
  })

  it('reads folder names as whole words, the nearest folder first', () => {
    const t = (rel: string) => typeByRules(meta0, rel.slice(rel.lastIndexOf('/') + 1), rel).type
    expect(t('Documents/My Art/Concept/x.png')).toBe('Concept Art')
    expect(t('Pictures/Concept Art/x.png')).toBe('Concept Art')
    expect(t('Party/x.png')).toBeNull()
    expect(t('Martin/x.png')).toBeNull()
    expect(t('Firefox Downloads/x.png')).toBeNull()
    expect(t('Games/3DS/x.png')).toBeNull()
    expect(t('Documents/x.png')).toBeNull()
    expect(t('Art/3D/x.png')).toBe('Renders')
    expect(t('concept_art/x.png')).toBe('Concept Art')
    expect(t('Old Scans/x.png')).toBe('Documents')
  })

  it('reads genre words at the start of words only', () => {
    const g = (rel: string, fam: 'art' | 'photo' = 'art') => place(pic(rel), sees({ type: [[typeIndex(fam === 'art' ? 'Concept Art' : 'Photos'), 0.9]] })).genre
    expect(g('Art/Workspace/x.png')).toBe('Unsorted')
    expect(g('Art/Space Battles/x.png')).toBe('Sci-Fi')
    expect(g('Art/futuristic city/x.png')).toBe('Sci-Fi')
    expect(g('Photos/Scary/x.jpg', 'photo')).toBe('Unsorted')
    expect(g('Photos/cars/x.jpg', 'photo')).toBe('Vehicles')
  })

  it('names colour moods', () => {
    expect(tasteTags({ lum: 0.15, sat: 0.6, warm: -0.2, contrast: 0.3 })).toEqual(['dark-moody', 'vibrant', 'cool', 'high-contrast'])
    expect(tasteTags({ lum: 0.8, sat: 0.05, warm: 0.3, contrast: 0.1 })).toEqual(['bright', 'monochrome'])
  })

  it('makes names safe for every file system and for embeds', () => {
    expect(safeName('a:b|c[1]#x^.png')).toBe('a_b_c_1__x_.png')
    expect(safeName('CON')).toBe('_CON')
    expect(safeName('trailing. ')).toBe('trailing')
  })
})

describe('placing a picture', () => {
  it('keeps a sure rule over the vision model', () => {
    const p = place(pic('Screenshot 2022-01-02 at 10.00.00.png'), sees({ type: [[typeIndex('Concept Art'), 0.99]] }))
    expect(p).toMatchObject({ type: 'Screenshots', year: '2022', dateFrom: 'name' })
  })

  it('lets a confident vision model overrule a folder name, and not an unsure one', () => {
    expect(place(pic('Art/x.png'), sees({ type: [[typeIndex('Photos'), 0.7]] })).type).toBe('Photos')
    expect(place(pic('Art/x.png'), sees({ type: [[typeIndex('Photos'), 0.5]] })).type).toBe('Concept Art')
    expect(place(pic('stuff/x.png'), sees({ type: [[typeIndex('Renders'), 0.45]] })).type).toBe('Renders')
    expect(place(pic('stuff/x.png'), sees({ type: [[typeIndex('Renders'), 0.3]] })).type).toBe('Other')
  })

  it('takes the genre from folder words first, then the model, else Unsorted', () => {
    const art = sees({ type: [[typeIndex('Concept Art'), 0.9]], 'genre:art': [[genreIndex('art', 'Horror'), 0.8]] })
    expect(place(pic('Art/Portals/gate.png'), art).genre).toBe('Ancient High-Tech')
    expect(place(pic('Art/x.png'), art).genre).toBe('Horror')
    expect(place(pic('Art/x.png'), sees({ 'genre:art': [[0, 0.2]] })).genre).toBe('Unsorted')
    expect(place(pic('scans/x.png'), null)).toMatchObject({ type: 'Documents', genre: null })
  })

  it('dates by EXIF, then the name, then the file', () => {
    expect(place(pic('a.jpg', { meta: { ...meta0, taken: '2019-07-01' } }), null)).toMatchObject({ year: '2019', dateFrom: 'photo' })
    expect(place(pic('IMG_20200101_000000.jpg'), null)).toMatchObject({ year: '2020', dateFrom: 'name' })
    expect(place(pic('a.png', { mtime: Date.UTC(2021, 5, 1) }), null)).toMatchObject({ year: '2021', dateFrom: 'file' })
    expect(place(pic('a.png', { mtime: 0 }), null)).toMatchObject({ year: 'Undated', dateFrom: null })
  })

  it('tags taste from colours and subjects for art and photos only', () => {
    const s = sees({ type: [[typeIndex('Concept Art'), 0.9]], subject: [[0, 0.6], [1, 0.31], [2, 0.2]] }, { lum: 0.1, sat: 0.6, warm: 0.2, contrast: 0.1 })
    expect(place(pic('Art/x.png'), s).tags).toEqual(['dark-moody', 'vibrant', 'warm', 'characters', 'creatures'])
    expect(place(pic('Screenshot 1.png'), s).tags).toEqual(['dark-moody', 'vibrant', 'warm'])
  })

  it('keeps the best few descriptions of each set', () => {
    expect(picksOf({ type: [0.01, 0.7, 0.2, 0.09], x: [1] })).toEqual({ type: [[1, 0.7], [2, 0.2], [3, 0.09]], x: [[0, 1]] })
  })
})

describe('names in the library', () => {
  it('adds (2), (3) … to a taken name, ignoring letter case', () => {
    expect(freeName('gate.png', new Set(['gate.png']))).toBe('gate (2).png')
    expect(freeName('Gate.PNG', new Set(['gate.png', 'gate (2).png']))).toBe('Gate (3).PNG')
    expect(freeName('a:b.png', new Set())).toBe('a_b.png')
  })

  it('names ten thousand pictures of one name in one folder in linear time', () => {
    const items: PlanItem[] = Array.from({ length: 10_000 }, (_, id) => ({ id, pic: pic(`d${id}/image.png`), placement: { type: 'Other', genre: null, year: '2024', dateFrom: 'file', tags: [], why: '' }, dest: '', status: 'new' }))
    const t0 = performance.now()
    assignDests(items, [])
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(new Set(items.map((i) => i.dest)).size).toBe(10_000)
    expect(items[9_999]!.dest).toBe('Other/2024/image (10000).png')
  })

  it('gives every new picture a free path in its folder', () => {
    const item = (id: number, rel: string, status: PlanItem['status'] = 'new'): PlanItem => ({ id, pic: pic(rel), placement: { type: 'Concept Art', genre: 'Sci-Fi', year: '2024', dateFrom: 'file', tags: [], why: '' }, dest: '', status })
    const items = [item(0, 'a/gate.png'), item(1, 'b/gate.png'), item(2, 'c/GATE.png'), item(3, 'd/other.png', 'duplicate')]
    assignDests(items, ['Concept Art/Sci-Fi/2024/gate.png'])
    expect(items.map((i) => i.dest)).toEqual(['Concept Art/Sci-Fi/2024/gate (2).png', 'Concept Art/Sci-Fi/2024/gate (3).png', 'Concept Art/Sci-Fi/2024/GATE (4).png', ''])
  })
})

describe('index notes', () => {
  const shelved = [
    { dest: 'Concept Art/Sci-Fi/2024/gate.png', type: 'Concept Art' as const, genre: 'Sci-Fi', year: '2024', tags: ['dark-moody', 'characters'], size: 2e6, mtime: 3 },
    { dest: 'Concept Art/Sci-Fi/2023/ship.png', type: 'Concept Art' as const, genre: 'Sci-Fi', year: '2023', tags: ['vibrant'], size: 1e6, mtime: 2 },
    { dest: 'Documents/2020/scan.jpg', type: 'Documents' as const, genre: null, year: '2020', tags: [], size: 5e5, mtime: 1 },
  ]
  const notes = libraryNotes('MASTERIMAGES', shelved, { source: 'D:\\', day: '2026-10-01' })
  const byPath = (p: string) => notes.find((n) => n.path === p)!

  it('makes the hub a project with a note per type, genre and taste', () => {
    expect(notes.map((n) => n.path)).toEqual([
      'MASTERIMAGES.md',
      'Concept Art/Concept Art.md',
      'Concept Art/Sci-Fi/Sci-Fi.md',
      'Documents/Documents.md',
      'Taste/Dark & moody.md',
      'Taste/Vibrant.md',
    ])
    const hub = newNote(byPath('MASTERIMAGES.md'), '2026-10-01')
    expect(hub).toMatch(/^---\ntitle: MASTERIMAGES\ntags: \[library, pictures\]\ntype: project\ncreated: 2026-10-01\nupdated: 2026-10-01\n---/)
    expect(hub).toContain('[[MASTERIMAGES · Concept Art|Concept Art]]: 2 pictures (Sci-Fi 2)')
    expect(hub).toContain('| 2024 | 1 |')
    expect(newNote(byPath('Concept Art/Concept Art.md'), '2026-10-01')).not.toContain('type: project')
  })

  it('embeds the newest pictures relative to each note and links up', () => {
    const genre = byPath('Concept Art/Sci-Fi/Sci-Fi.md')
    expect(genre.title).toBe('MASTERIMAGES · Concept Art · Sci-Fi')
    expect(genre.tags).toEqual(['library', 'concept-art', 'sci-fi', 'dark-moody', 'vibrant'])
    expect(genre.section).toContain('![[2024/gate.png]]\n![[2023/ship.png]]')
    expect(genre.section).toContain('part of [[MASTERIMAGES · Concept Art|Concept Art]]')
    expect(genre.section).toContain('Subjects: #characters 1')
    expect(byPath('Taste/Dark & moody.md').section).toContain('![[../Concept Art/Sci-Fi/2024/gate.png]]')
    expect(byPath('Documents/Documents.md').section).toContain('![[2020/scan.jpg]]')
  })

  it('rewrites only the librarian\'s block and the updated date, whatever the user wrote around it', () => {
    const first = newNote(byPath('Concept Art/Sci-Fi/Sci-Fi.md'), '2026-09-01')
    expect(first).toContain(`${LIBRARY_START}\n## Library`)
    expect(first.trimEnd().endsWith(LIBRARY_END)).toBe(true)
    const edited = first.replace('# MASTERIMAGES · Concept Art · Sci-Fi', '# My sci-fi refs\n\nMy own words.') + '\nA paragraph at the bottom.\n\n# My notes\n\nKeep these.\n\n\n\nSpaced.\n'
    const merged = mergeNote(edited, '## Library\n\nNew numbers\n', '2026-10-01')
    expect(merged).toContain('updated: 2026-10-01')
    expect(merged).toContain('created: 2026-09-01')
    expect(merged).toContain('My own words.')
    expect(merged).toContain(`${LIBRARY_START}\n## Library\n\nNew numbers\n${LIBRARY_END}\n\nA paragraph at the bottom.\n\n# My notes\n\nKeep these.\n\n\n\nSpaced.\n`)
    expect(merged).not.toContain('![[2024/gate.png]]')
    // A note with no block (or a broken one) gets one at the end; nothing of it goes.
    expect(mergeNote('# Mine\n\n## Library\n\nmy own list\n', '## Library\n\nX\n', '2026-10-01')).toBe(`# Mine\n\n## Library\n\nmy own list\n\n${LIBRARY_START}\n## Library\n\nX\n${LIBRARY_END}\n`)
    // An unclosed code fence of the user's does not hide the block (it is found by its marker).
    const fenced = mergeNote(`${first}\n\`\`\`\nunclosed`, '## Library\n\nY\n', '2026-10-01')
    expect(fenced.split(LIBRARY_START)).toHaveLength(2)
    expect(mergeNote(fenced, '## Library\n\nZ\n', '2026-10-01').split(LIBRARY_START)).toHaveLength(2)
    // Windows line endings stay.
    const crlf = mergeNote(first.replace(/\n/g, '\r\n'), '## Library\n\nW\n', '2026-10-01')
    expect(crlf).toContain('\r\n## Library\r\n\r\nW\r\n')
    expect(crlf.replace(/\r\n/g, '')).not.toContain('\n')
  })
})

describe('the vision helper', () => {
  it('takes only well-formed answers', () => {
    const colours = { lum: 0.5, sat: 0.2, warm: -0.1, contrast: 0.1 }
    expect(visionAnswerOf({ colours, probs: { type: [0.9, 0.1] }, modelError: null })).toEqual({ colours, probs: { type: [0.9, 0.1] }, modelError: null })
    expect(visionAnswerOf({ colours: { ...colours, lum: 2 } })).toBeNull()
    expect(visionAnswerOf({ colours, probs: { type: [NaN] } })).toBeNull()
    expect(visionAnswerOf(null)).toBeNull()
    expect(visionAnswerOf({ colours, probs: null, modelError: 'x'.repeat(900) })?.modelError).toHaveLength(500)
  })

  it('compares with every set of descriptions once', () => {
    expect(Object.keys(LABEL_SETS)).toEqual(['type', 'genre:art', 'genre:photo', 'genre:screen', 'genre:texture', 'genre:web', 'subject'])
    expect(LABEL_SETS['type']).not.toContain('an AI generated image')
    expect(labelsKey()).toMatch(/^[0-9a-f]{16}$/)
  })
})

/* ------------------------------------------------------------------ */
/* On disk                                                              */
/* ------------------------------------------------------------------ */

let tmp: string
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aether-library-'))
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function put(rel: string, data: Buffer | string, mtime?: Date): Promise<string> {
  const abs = path.join(tmp, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, data)
  if (mtime) await fs.utimes(abs, mtime, mtime)
  return abs
}

/** Every file under `dir` (relative, `/`), with size and mtime. */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) await walk(abs)
      else {
        const st = await fs.stat(abs)
        out.push(`${path.relative(dir, abs).split(path.sep).join('/')}\t${st.size}\t${Math.round(st.mtimeMs)}`)
      }
    }
  }
  await walk(dir)
  return out.sort()
}

/** The library paths the manifest (JSON lines, later lines win) holds now, deleted ones left out. */
async function manifestDests(dest: string): Promise<string[]> {
  const last = new Map<string, { gone?: boolean }>()
  for (const line of (await fs.readFile(path.join(dest, MANIFEST), 'utf8')).split('\n').filter(Boolean)) {
    const e = JSON.parse(line) as { dest: string; gone?: boolean }
    last.set(e.dest, e)
  }
  return [...last].filter(([, e]) => !e.gone).map(([d]) => d).sort()
}

/** Eyes that see every picture as dark sci-fi concept art of a character (or nothing, for colours only). */
function fakeEyes(): Eyes & { jobs: VisionJob[] } {
  const jobs: VisionJob[] = []
  return {
    jobs,
    async look(job) {
      jobs.push(job)
      const probs = job.sets
        ? Object.fromEntries(
            Object.entries(job.sets).map(([k, labels]) => {
              const want = k === 'type' ? typeIndex('Concept Art') : k === 'genre:art' ? genreIndex('art', 'Sci-Fi') : 0
              return [k, labels.map((_, i) => (i === want ? 0.9 : 0.1 / Math.max(1, labels.length - 1)))]
            }),
          )
        : null
      return { colours: { lum: 0.12, sat: 0.3, warm: -0.1, contrast: 0.05 }, probs, modelError: null }
    },
  }
}

describe('analyze and copy', () => {
  const day2024 = new Date(Date.UTC(2024, 2, 1, 12))
  const day2023 = new Date(Date.UTC(2023, 6, 1, 12))

  async function source(): Promise<string> {
    await put('D/Camera/IMG_20230512_101010.jpg', jpeg(4000, 3000, { make: 'Canon', taken: '2023:05:12 10:10:10' }))
    await put('D/Art/Portals/gate.png', png(400, 300, 1), day2024)
    await put('D/Art/Portals/gate copy.png', png(400, 300, 1), day2024)
    await put('D/misc/random.png', png(300, 200, 2), day2023)
    await put('D/misc2/random.png', png(300, 200, 3), day2023)
    await put('D/Screens/Screenshot 2022-01-02 at 10.00.00.png', png(320, 200, 4))
    await put('D/ai/00012-123456789.png', png(256, 256, 5, { parameters: 'a gate\nSteps: 20, Sampler: Euler, Seed: 1' }), day2024)
    await put('D/icons/icon.png', png(16, 16, 6))
    await put('D/notapic.png', 'not a picture at all')
    await put('D/SomeGame/steam_api64.dll', 'x')
    await put('D/SomeGame/art.png', png(400, 300, 7))
    return path.join(tmp, 'D')
  }

  it('plans, copies create-only with dates kept, writes the notes, and leaves the source alone', async () => {
    const src = await source()
    const dest = path.join(tmp, 'F', 'MASTERIMAGES')
    const before = await listing(src)
    const eyes = fakeEyes()
    const a = await analyze({ source: src, dest, eyes, model: true, cache: LookCache.memory() })
    expect(a).toMatchObject({ found: 9, tiny: 1, unreadable: 1, installs: 1, truncated: false, vision: { colours: true, model: true, error: null } })
    const by = (rel: string) => a.items.find((i) => i.pic.rel === rel)!
    expect(by('Camera/IMG_20230512_101010.jpg')).toMatchObject({ status: 'new', dest: 'Photos/Family & Friends/2023/IMG_20230512_101010.jpg' })
    expect(by('Art/Portals/gate.png').dest).toBe('Concept Art/Ancient High-Tech/2024/gate.png')
    expect(by('Art/Portals/gate copy.png')).toMatchObject({ status: 'duplicate', duplicateOf: `#${by('Art/Portals/gate.png').id}` })
    expect(by('misc/random.png').dest).toBe('Concept Art/Sci-Fi/2023/random.png')
    expect(by('misc2/random.png').dest).toBe('Concept Art/Sci-Fi/2023/random (2).png')
    expect(by('Screens/Screenshot 2022-01-02 at 10.00.00.png').dest).toBe('Screenshots/Games/2022/Screenshot 2022-01-02 at 10.00.00.png')
    expect(by('ai/00012-123456789.png').dest).toBe('AI Generated/Sci-Fi/2024/00012-123456789.png')
    // Every new picture was looked at once, with every set of descriptions.
    expect(eyes.jobs).toHaveLength(7)
    expect(Object.keys(eyes.jobs[0]!.sets!)).toEqual(Object.keys(LABEL_SETS))
    // Nothing is written by analyze.
    expect(await fs.stat(dest).catch(() => null)).toBeNull()

    const r = await copyPlan(a)
    expect(r).toMatchObject({ copied: 6, alreadyThere: 0, failed: [], stopped: false })
    expect(await listing(src)).toEqual(before)
    const gate = await fs.stat(path.join(dest, 'Concept Art', 'Ancient High-Tech', '2024', 'gate.png'))
    expect(Math.round(gate.mtimeMs)).toBe(day2024.getTime())
    expect(await fs.readFile(path.join(dest, 'Concept Art', 'Sci-Fi', '2023', 'random (2).png'))).toEqual(png(300, 200, 3))
    const files = (await listing(dest)).map((l) => l.split('\t')[0])
    expect(files.filter((f) => !f!.endsWith('.md'))).toEqual([
      '.aether-library.jsonl',
      'AI Generated/Sci-Fi/2024/00012-123456789.png',
      'Concept Art/Ancient High-Tech/2024/gate.png',
      'Concept Art/Sci-Fi/2023/random (2).png',
      'Concept Art/Sci-Fi/2023/random.png',
      'Photos/Family & Friends/2023/IMG_20230512_101010.jpg',
      'Screenshots/Games/2022/Screenshot 2022-01-02 at 10.00.00.png',
    ])
    expect(files).toContain('MASTERIMAGES.md')
    expect(files).toContain('Concept Art/Sci-Fi/Sci-Fi.md')
    expect(files).toContain('Taste/Dark & moody.md')
    expect(files.some((f) => f!.includes('aether-tmp'))).toBe(false)
    const hub = await fs.readFile(path.join(dest, 'MASTERIMAGES.md'), 'utf8')
    expect(hub).toContain('type: project')
    expect(hub).toContain('6 pictures')
    const sci = await fs.readFile(path.join(dest, 'Concept Art', 'Sci-Fi', 'Sci-Fi.md'), 'utf8')
    expect(sci).toContain('![[2023/random.png]]')
    expect(sci).toContain('#characters')

    // A second run copies nothing new; a picture the user deleted from the library stays out.
    await fs.rm(path.join(dest, 'Concept Art', 'Sci-Fi', '2023', 'random.png'))
    await fs.writeFile(path.join(dest, 'Concept Art', 'Sci-Fi', 'Sci-Fi.md'), sci.replace(LIBRARY_START, `My notes.\n\n${LIBRARY_START}`))
    const again = await analyze({ source: src, dest, eyes: fakeEyes(), model: true, cache: LookCache.memory() })
    expect(again.items.filter((i) => i.status === 'new')).toEqual([])
    expect(again.items.find((i) => i.pic.rel === 'misc/random.png')!.status).toBe('removed')
    expect(again.items.find((i) => i.pic.rel === 'Art/Portals/gate copy.png')!.status).toBe('duplicate')
    expect(again.shelved).toHaveLength(5)
    const r2 = await copyPlan(again)
    expect(r2.copied).toBe(0)
    const sci2 = await fs.readFile(path.join(dest, 'Concept Art', 'Sci-Fi', 'Sci-Fi.md'), 'utf8')
    expect(sci2).toContain('My notes.')
    expect(sci2).not.toContain('![[2023/random.png]]')
    expect(sci2).toContain('![[2023/random (2).png]]')
  })

  it('sorts by rules alone without eyes, and never copies over a file that took the name', async () => {
    const src = await source()
    const dest = path.join(tmp, 'F', 'LIB')
    const a = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    expect(a.vision).toEqual({ colours: false, model: false, error: null })
    expect(a.items.find((i) => i.pic.rel === 'misc/random.png')!.dest).toBe('Other/2023/random.png')
    // Something else appears at a planned name before the copy.
    await put('F/LIB/Other/2023/random.png', 'mine')
    const r = await copyPlan(a)
    expect(r.failed).toEqual([])
    expect(await fs.readFile(path.join(dest, 'Other', '2023', 'random.png'), 'utf8')).toBe('mine')
    expect((await manifestDests(dest)).filter((k) => k.startsWith('Other/2023/'))).toEqual(['Other/2023/random (2).png', 'Other/2023/random (3).png'])
  })

  it('keeps the library out of the source it is sorted from', async () => {
    const src = await source()
    const dest = path.join(src, 'Library2')
    await put('D/Library2/Photos/x/2020/old.png', png(400, 300, 9))
    const a = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    expect(a.items.some((i) => i.pic.rel.startsWith('Library2/'))).toBe(false)
    await expect(analyze({ source: src, dest: src, eyes: null, model: false, cache: LookCache.memory() })).rejects.toThrow(/cannot be the folder/)
    expect(inside(src, dest)).toBe('Library2')
    expect(inside(dest, src)).toBeNull()
  })

  it('remembers what it saw, and asks the model again only for pictures it saw without it', async () => {
    const src = await source()
    const file = path.join(tmp, 'cache.json')
    const cache = await LookCache.load(file)
    const eyes = fakeEyes()
    await analyze({ source: src, dest: path.join(tmp, 'L'), eyes, model: false, cache })
    expect(eyes.jobs.every((j) => j.sets === null)).toBe(true)
    const reloaded = await LookCache.load(file)
    expect(reloaded.size).toBe(7)
    const eyes2 = fakeEyes()
    await analyze({ source: src, dest: path.join(tmp, 'L'), eyes: eyes2, model: false, cache: reloaded })
    expect(eyes2.jobs).toHaveLength(0)
    await analyze({ source: src, dest: path.join(tmp, 'L'), eyes: eyes2, model: true, cache: reloaded })
    expect(eyes2.jobs).toHaveLength(7)
    // Descriptions changed: the picks no longer count.
    const other = await LookCache.load(file, 'another')
    const st = await fs.stat(path.join(src, 'misc', 'random.png'))
    expect(other.get(path.join(src, 'misc', 'random.png'), st.size, st.mtimeMs)?.picks).toBeNull()
  })

  it('keeps a picture the user deleted out, even when it comes back under another name', async () => {
    const src = await source()
    const dest = path.join(tmp, 'F', 'DEL')
    await copyPlan(await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() }))
    const kept = (await manifestDests(dest)).find((d) => d.endsWith('/gate.png'))!
    await fs.rm(path.join(dest, ...kept.split('/')))
    // The same bytes again, as a renamed copy in the source.
    await put('D/elsewhere/gate-final.png', png(400, 300, 1), day2024)
    const again = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    const by = (rel: string) => again.items.find((i) => i.pic.rel === rel)!
    expect(by('Art/Portals/gate.png').status).toBe('removed')
    expect(by('Art/Portals/gate copy.png').status).toBe('removed')
    expect(by('elsewhere/gate-final.png')).toMatchObject({ status: 'removed', duplicateOf: kept })
    expect((await copyPlan(again)).copied).toBe(0)
    // Back in the library (restored by the user): no longer deleted.
    await fs.writeFile(path.join(dest, ...kept.split('/')), png(400, 300, 1))
    const third = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    expect(third.items.find((i) => i.pic.rel === 'Art/Portals/gate.png')!.status).toBe('copied')
  })

  it('never copies over anything on a drive without hard links, with both workers racing for names', async () => {
    const src = path.join(tmp, 'S')
    await put('S/a/gate.png', png(300, 200, 21), day2023)
    await put('S/b/gate.png', png(300, 200, 22), day2023)
    await put('S/c/gate.png', png(300, 200, 23), day2023)
    const dest = path.join(tmp, 'F', 'EXFAT')
    const a = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    expect(a.items.map((i) => i.dest).sort()).toEqual(['Other/2023/gate (2).png', 'Other/2023/gate (3).png', 'Other/2023/gate.png'])
    // A file nobody planned sits at the first name (a crash orphan, or the user's own).
    await put('F/EXFAT/Other/2023/gate.png', 'not mine to replace')
    const link = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('EPERM: links unsupported'), { code: 'EPERM' }))
    try {
      const r = await copyPlan(a)
      expect(r).toMatchObject({ copied: 3, failed: [] })
    } finally {
      link.mockRestore()
    }
    expect(await fs.readFile(path.join(dest, 'Other', '2023', 'gate.png'), 'utf8')).toBe('not mine to replace')
    const names = (await fs.readdir(path.join(dest, 'Other', '2023'))).sort()
    expect(names).toEqual(['gate (2).png', 'gate (3).png', 'gate (4).png', 'gate.png'])
    const bodies = await Promise.all(names.filter((n) => n !== 'gate.png').map((n) => fs.readFile(path.join(dest, 'Other', '2023', n))))
    const want = [png(300, 200, 21), png(300, 200, 22), png(300, 200, 23)]
    expect(want.every((w) => bodies.some((b) => b.equals(w)))).toBe(true)
    expect((await manifestDests(dest)).filter((d) => d.startsWith('Other/'))).toEqual(['Other/2023/gate (2).png', 'Other/2023/gate (3).png', 'Other/2023/gate (4).png'])
  })

  it('cleans temp files a crash left, and keeps the manifest small across runs', async () => {
    const src = await source()
    const dest = path.join(tmp, 'F', 'CRASH')
    await put('F/CRASH/Other/2023/random.png.deadbeef.aether-tmp', 'half a copy')
    await copyPlan(await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() }))
    expect((await listing(dest)).some((l) => l.includes('aether-tmp'))).toBe(false)
    for (let i = 0; i < 3; i++) await copyPlan(await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() }))
    const lines = (await fs.readFile(path.join(dest, MANIFEST), 'utf8')).split('\n').filter(Boolean)
    expect(lines.length).toBeLessThan(20)
  })

  it('stops between pictures when asked, keeping what it copied', async () => {
    const src = await source()
    const dest = path.join(tmp, 'F', 'STOP')
    const a = await analyze({ source: src, dest, eyes: null, model: false, cache: LookCache.memory() })
    const ac = new AbortController()
    const r = await copyPlan(a, { signal: ac.signal, onProgress: (p) => p.phase === 'copying' && p.done >= 1 && ac.abort() })
    expect(r.stopped).toBe(true)
    expect(r.copied).toBeGreaterThanOrEqual(1)
    expect(r.copied).toBeLessThan(6)
    expect(await manifestDests(dest)).toHaveLength(r.copied)
  })
})

describe('the vision model download', () => {
  const body = (s: string) => new Response(s, { headers: { 'content-length': String(Buffer.byteLength(s)) } })

  it('downloads each file once, checks lengths, and is ready only when all arrived', async () => {
    const asked: string[] = []
    let fail = 'onnx/vision_model_quantized.onnx'
    const model = new VisionModel(tmp, async (url) => {
      asked.push(url)
      const f = url.slice('https://example.test/'.length)
      if (f === fail) return new Response('short', { headers: { 'content-length': '999' } })
      return body(`data of ${f}`)
    }, 'https://example.test/')
    const seen: number[] = []
    await expect(model.download((p) => seen.push(p.done), new AbortController().signal)).rejects.toThrow(/incomplete/)
    expect(await model.state()).toEqual({ ready: false, bytes: 0 })
    expect(await fs.stat(path.join(model.root, 'onnx', 'vision_model_quantized.onnx.part')).catch(() => null)).toBeNull()
    fail = ''
    asked.length = 0
    await model.download(() => undefined, new AbortController().signal)
    // Files that arrived before are kept.
    expect(asked).toEqual(['https://example.test/onnx/vision_model_quantized.onnx'])
    const state = await model.state()
    expect(state.ready).toBe(true)
    expect(state.bytes).toBe(VISION_MODEL_FILES.reduce((a, f) => a + `data of ${f}`.length, 0))
    expect(model.fileOf('config.json')).toBe(path.join(model.root, 'config.json'))
    expect(model.fileOf('../secret')).toBeNull()
    await fs.appendFile(path.join(model.root, 'config.json'), 'x')
    expect((await model.state()).ready).toBe(false)
    await model.remove()
    expect(await fs.stat(model.root).catch(() => null)).toBeNull()
  })

  it('refuses an answer that is not the file', async () => {
    const model = new VisionModel(tmp, async () => new Response('nope', { status: 404 }), 'https://example.test/')
    await expect(model.download(() => undefined, new AbortController().signal)).rejects.toThrow(/HTTP 404/)
  })
})
