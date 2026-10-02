/**
 * How the librarian sorts a picture: its Type (rules from its metadata, name
 * and folders; the vision model when they say nothing sure), its Genre (the
 * vision model, else words in its folders and name), its Year (EXIF, else
 * the name, else the file's dates), subject and taste tags. Pure.
 *
 * Folders: <library>/<Type>/<Genre>/<Year>/<file>.
 */
import type { PictureMeta } from './meta.js'

export const TYPES = ['Photos', 'Screenshots', 'Concept Art', 'Renders', 'Sketches', 'AI Generated', 'Textures', 'Memes & Web', 'Documents', 'Other'] as const
export type LibraryType = (typeof TYPES)[number]

export const UNSORTED = 'Unsorted'
export const UNDATED = 'Undated'

/** What the vision model is asked to tell types apart, one prompt per type. */
export const TYPE_PROMPTS: Record<Exclude<LibraryType, 'Other'>, string> = {
  Photos: 'a photograph taken with a camera or phone',
  Screenshots: 'a screenshot of a computer screen, app or video game',
  'Concept Art': 'a digital painting or concept art illustration',
  Renders: 'a 3D render made with 3D software',
  Sketches: 'a pencil sketch or line drawing on paper',
  'AI Generated': 'an AI generated image',
  Textures: 'a seamless texture of a material surface',
  'Memes & Web': 'an internet meme or web graphic with text',
  Documents: 'a scanned document or a page of text',
}

export type Family = 'art' | 'photo' | 'screen' | 'texture' | 'web' | 'doc'

export function familyOf(type: LibraryType): Family {
  switch (type) {
    case 'Photos':
      return 'photo'
    case 'Screenshots':
      return 'screen'
    case 'Textures':
      return 'texture'
    case 'Memes & Web':
      return 'web'
    case 'Documents':
      return 'doc'
    default:
      return 'art'
  }
}

interface Genre {
  name: string
  prompt: string
  /** Words in folder or file names that say this genre. */
  words: RegExp
}

/** `alts` as whole words of a folder or file name (`art` in `My Art`, never in `Martin` or `Party`). */
const word = (alts: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${alts})(?![a-z0-9])`, 'i')
/** `alts` at the start of a word (`futur` in `Futuristic`, never `space` in `Workspace`). */
const stem = (alts: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${alts})`, 'i')

/** The genres of each family: what they are called, how the vision model is asked, which names say them. */
export const GENRES: Record<Family, Genre[]> = {
  art: [
    { name: 'Ancient High-Tech', prompt: 'ancient stone ruins with glowing high-tech portals and monoliths', words: stem('portal|monolith|ruin|ancient[\\s_-]?tech|relic') },
    { name: 'Sci-Fi', prompt: 'science fiction art with spaceships, robots and futuristic technology', words: stem('sci[\\s_-]?fi|spaces?(?![a-z])|spaceship|spacecraft|robot|mech(?:a|s)?(?![a-z])|futur|alien|starship') },
    { name: 'Cyberpunk', prompt: 'a cyberpunk city at night with neon lights', words: stem('cyber|neon') },
    { name: 'Fantasy', prompt: 'fantasy art with castles, magic and dragons', words: stem('fantasy|dragon|elf(?![a-z])|elves|wizard|magic|castle') },
    { name: 'Dark Fantasy', prompt: 'dark gothic fantasy art, grim and shadowy', words: stem('dark[\\s_-]?fantasy|gothic|grimdark') },
    { name: 'Horror', prompt: 'horror art, creepy and frightening', words: stem('horror|creepy|zombie|monster|demon') },
    { name: 'Post-Apocalyptic', prompt: 'a post-apocalyptic wasteland with abandoned ruins', words: stem('post[\\s_-]?apoc|apocalyp|wasteland') },
    { name: 'Steampunk', prompt: 'steampunk machines with brass, gears and steam', words: stem('steampunk|clockwork') },
    { name: 'Nature', prompt: 'a nature landscape painting with forests, mountains and water', words: stem('nature|forest|landscape|mountain|jungle|rainforest|ocean') },
    { name: 'Urban', prompt: 'a modern city street with buildings', words: stem('urban|city|cities|street|towns?(?![a-z])') },
    { name: 'Historical', prompt: 'a historical scene from medieval or ancient times', words: stem('histor|medieval|viking|samurai|romans?(?![a-z])|egypt') },
    { name: 'Stylized & Anime', prompt: 'an anime or cartoon style illustration', words: stem('anime|manga|cartoon|toons?(?![a-z])|styli[sz]ed|chibi') },
    { name: 'Abstract', prompt: 'abstract art with shapes, patterns and colours', words: stem('abstract|pattern') },
  ],
  photo: [
    { name: 'Family & Friends', prompt: 'a photo of family and friends together', words: word('family|friends?|kids?|baby|babies|mom|mum|dad|wedding') },
    { name: 'Portraits', prompt: 'a portrait photo of one person', words: stem('portrait|selfie|headshot') },
    { name: 'Pets & Animals', prompt: 'a photo of a pet or an animal', words: word('pets?|dogs?|cats?|puppy|puppies|kittens?|animals?|birds?|zoo') },
    { name: 'Nature & Landscapes', prompt: 'a landscape photo of nature, mountains, forest or the sea', words: stem('nature|landscape|forest|beach|mountain|hike|hiking|lakes?(?![a-z])|parks?(?![a-z])') },
    { name: 'City & Architecture', prompt: 'a photo of buildings, streets and architecture', words: stem('city|cities|architect|building|street|downtown') },
    { name: 'Travel', prompt: 'a travel photo of a famous place or a trip', words: stem('travel|trips?(?![a-z])|vacation|holiday|tours?(?![a-z])') },
    { name: 'Food', prompt: 'a photo of food or a meal', words: stem('food|meal|dinner|lunch|breakfast|recipe|cake') },
    { name: 'Events & Parties', prompt: 'a photo of a party, concert or celebration', words: stem('party|parties|birthday|christmas|concert|event|graduation|halloween') },
    { name: 'Vehicles', prompt: 'a photo of a car, motorcycle or other vehicle', words: word('cars?|trucks?|bikes?|motorcycles?|vehicles?') },
    { name: 'Art & Museums', prompt: 'a photo of artwork, sculptures or a museum', words: stem('museum|gallery|galleries|exhibit|sculpture') },
    { name: 'Everyday', prompt: 'an everyday snapshot of things at home', words: word('home|house|room|desk') },
  ],
  screen: [
    { name: 'Games', prompt: 'a screenshot of a video game', words: stem('game|steam(?![a-z])|unreal|unity|minecraft|fortnite') },
    { name: 'Art Software', prompt: 'a screenshot of art or 3D software like Photoshop or Blender', words: stem('photoshop|blender|krita|zbrush|substance|maya(?![a-z])') },
    { name: 'Web & Apps', prompt: 'a screenshot of a website or app', words: word('web|websites?|sites?|browsers?|apps?') },
    { name: 'Chats & Social', prompt: 'a screenshot of a chat or social media post', words: stem('chat|discord|twitter|instagram|whatsapp|message|tweet') },
    { name: 'Video & Movies', prompt: 'a screenshot from a movie or video', words: stem('movie|film|video|youtube|netflix|frame') },
    { name: 'Documents & Text', prompt: 'a screenshot of a document or text', words: word('docs?|documents?|text|pdfs?|code') },
  ],
  texture: [
    { name: 'Stone & Rock', prompt: 'a texture of stone or rock', words: stem('stone|rock|cliff|marble|granite|concrete') },
    { name: 'Wood', prompt: 'a texture of wood', words: stem('wood|bark|plank|timber') },
    { name: 'Metal', prompt: 'a texture of metal', words: stem('metal|steel|iron|rust|copper|brass') },
    { name: 'Ground & Dirt', prompt: 'a texture of ground, soil, mud or sand', words: stem('ground|dirt|soil|mud(?![a-z])|sand(?![a-z])|gravel') },
    { name: 'Foliage', prompt: 'a texture of leaves, grass or moss', words: stem('foliage|leaf|leaves|grass|moss|plant') },
    { name: 'Fabric & Leather', prompt: 'a texture of fabric, cloth or leather', words: stem('fabric|cloth|leather|textile|cotton|wool') },
    { name: 'Sci-Fi Panels', prompt: 'a sci-fi metal panel texture', words: stem('sci[\\s_-]?fi|panel|hull|tech(?![a-z])') },
    { name: 'Tiles & Bricks', prompt: 'a texture of tiles or bricks', words: stem('tile|brick|cobble|pavement') },
    { name: 'Organic', prompt: 'an organic texture of skin, flesh or scales', words: stem('skin|flesh|scale|organic|creature') },
    { name: 'Water & Ice', prompt: 'a texture of water, ice or snow', words: stem('water|ice(?![a-z])|snow|frost') },
  ],
  web: [
    { name: 'Memes', prompt: 'a funny internet meme', words: stem('meme|funny|lol(?![a-z])') },
    { name: 'Quotes & Text', prompt: 'an image of a quote or text', words: stem('quote|text') },
    { name: 'Logos & Icons', prompt: 'a logo or icon', words: stem('logo|icon|badge|emblem') },
    { name: 'Infographics', prompt: 'an infographic or chart', words: stem('infographic|chart|diagram') },
  ],
  doc: [{ name: 'Documents', prompt: 'a scanned document', words: /./ }],
}

/** Subject tags the vision model adds to art and photos (never folders). */
export const SUBJECTS: { tag: string; prompt: string }[] = [
  { tag: 'characters', prompt: 'a character design of a person' },
  { tag: 'creatures', prompt: 'a creature or monster design' },
  { tag: 'environments', prompt: 'an environment or landscape scene' },
  { tag: 'architecture', prompt: 'buildings and architecture' },
  { tag: 'vehicles', prompt: 'a vehicle, spaceship or mech design' },
  { tag: 'props', prompt: 'a prop, weapon or object design' },
  { tag: 'portraits', prompt: 'a close-up portrait of a face' },
  { tag: 'animals', prompt: 'an animal' },
  { tag: 'interiors', prompt: 'an interior of a room' },
]

/**
 * The types the vision model is asked about. Not "AI Generated": a picture
 * does not show reliably whether a generator made it, its metadata does
 * (typeByRules).
 */
export const VISION_TYPES = TYPES.filter((t): t is Exclude<LibraryType, 'Other' | 'AI Generated'> => t !== 'Other' && t !== 'AI Generated')

/** Families whose genres the vision model is asked about (documents have one genre). */
export const VISION_FAMILIES = ['art', 'photo', 'screen', 'texture', 'web'] as const

/** Every set of descriptions one picture is compared with, by set key. */
export const LABEL_SETS: Record<string, readonly string[]> = {
  type: VISION_TYPES.map((t) => TYPE_PROMPTS[t]),
  ...Object.fromEntries(VISION_FAMILIES.map((f) => [`genre:${f}`, GENRES[f].map((g) => g.prompt)])),
  subject: SUBJECTS.map((s) => s.prompt),
}

/** A Type from the rules, and whether it is sure enough to skip the vision model's opinion. */
export interface RuleType {
  type: LibraryType | null
  sure: boolean
  why: string
}

const SCREEN_SIZES = new Set([
  '1920x1080', '2560x1440', '3840x2160', '1366x768', '1280x720', '1600x900', '1440x900', '1680x1050', '2560x1080', '3440x1440',
  '1280x800', '2880x1800', '1080x1920', '1080x2400', '1170x2532', '1284x2778', '1179x2556', '1290x2796', '750x1334', '1242x2688',
])
/**
 * Folder names that say a type, as whole words. Windows' own library folders
 * (Pictures, Documents, Downloads, Desktop) say nothing: anything lands there.
 */
const FOLDER_TYPES: [RegExp, LibraryType][] = [
  [word('screen ?shots?|screencaps?|screen ?captures?|snips?'), 'Screenshots'],
  [word('renders?|rendering|blender|3d|cgi'), 'Renders'],
  [word('sketch(?:es|book|books)?|drawings?|doodles?|line ?art'), 'Sketches'],
  [word('memes?|reactions?'), 'Memes & Web'],
  [word('scans?|scanned|receipts?|invoices?|paperwork'), 'Documents'],
  [word('photos?|photography|camera(?: ?roll| ?uploads)?|dcim|iphone|android|phone|selfies?'), 'Photos'],
  [word('concepts?|concept ?art|art(?:work)?s?|digital ?art|paintings?|illustrations?|artstation|refs?|references?|portfolio|speed ?paints?|studies'), 'Concept Art'],
]

const RENDER_TOOLS = /blender|substance|marmoset|keyshot|octane|cinema ?4d|maya|3ds ?max|houdini|unreal|unity|redshift|v-?ray|arnold|zbrush|eevee|cycles/i
const PAINT_TOOLS = /photoshop|krita|clip ?studio|celsys|procreate|paint ?tool ?sai|affinity|rebelle|painter|artrage|medibang|ibis/i

/** The Type the metadata, name and folders say, before any vision. `rel`: the path inside the source, `/`-separated. */
export function typeByRules(meta: PictureMeta, name: string, rel: string): RuleType {
  const folders = rel.split('/').slice(0, -1).join('/')
  if (meta.ai) return { type: 'AI Generated', sure: true, why: meta.ai }
  if (/^dall[·.\s-]?e|chatgpt image|^midjourney|^(comfyui|leonardo|firefly)[_\s-]|_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$|^\d{5}-\d{6,12}\.png$/i.test(name)) {
    return { type: 'AI Generated', sure: true, why: 'generator file name' }
  }
  if (/screen ?shot|screencap|capture d.écran|bildschirmfoto|^snip|^scr[_-]\d/i.test(name)) return { type: 'Screenshots', sure: true, why: 'screenshot file name' }
  if (/[_\s-](albedo|base_?colou?r|diffuse|diff|normal|nrm|nor|rough(ness)?|metal(lic|ness)?|ao|ambient_?occlusion|height|disp(lacement)?|bump|spec(ular)?|gloss(iness)?|emissive|opacity|orm|arm)\.[a-z]+$/i.test(name) || /(^|\/)(textures?|materials?|pbr)(\/|$)/i.test(folders)) {
    return { type: 'Textures', sure: true, why: 'texture map' }
  }
  if (meta.make || meta.model) return { type: 'Photos', sure: true, why: `camera ${[meta.make, meta.model].filter(Boolean).join(' ')}`.trim() }
  if (/^(img|dsc|dscn|dscf|pxl|mvimg|pano|gopr|dji|p\d{7}|photo)[_-]?\d/i.test(name) || /(^|\/)dcim(\/|$)/i.test(folders)) return { type: 'Photos', sure: true, why: 'camera file name' }
  if (meta.software && RENDER_TOOLS.test(meta.software)) return { type: 'Renders', sure: false, why: meta.software }
  // The nearest folder that says what it holds (`Documents/My Art/Concepts/x.png` is concept art).
  const segs = folders ? folders.split('/') : []
  for (let i = segs.length - 1; i >= 0; i--) {
    const hit = FOLDER_TYPES.find(([re]) => re.test(segs[i] ?? ''))
    if (hit) return { type: hit[1], sure: false, why: `folder ${segs[i]}` }
  }
  if (meta.software && PAINT_TOOLS.test(meta.software)) return { type: 'Concept Art', sure: false, why: meta.software }
  if (meta.kind === 'png' && meta.width && meta.height && SCREEN_SIZES.has(`${meta.width}x${meta.height}`)) return { type: 'Screenshots', sure: false, why: 'screen-sized PNG' }
  return { type: null, sure: false, why: '' }
}

/** The genre the folder and file names say for `family`, or null. */
export function genreByWords(family: Family, rel: string): string | null {
  // The deepest folder that names a genre wins, then the file name.
  const parts = rel.split('/')
  for (let i = parts.length - 1; i >= 0; i--) {
    const hit = GENRES[family].find((g) => g.words.test(parts[i] ?? ''))
    if (hit && family !== 'doc') return hit.name
  }
  return family === 'doc' ? 'Documents' : null
}

/** Colour statistics of a picture (0–1, warmth −1–1), as the vision helper measures them. */
export interface ColourStats {
  /** Mean luminance. */
  lum: number
  /** Mean saturation. */
  sat: number
  /** Mean of red minus blue. */
  warm: number
  /** Standard deviation of luminance. */
  contrast: number
}

/** Taste tags of a picture from its colours: dark-moody, bright, monochrome, muted, vibrant, warm, cool, high-contrast. */
export function tasteTags(c: ColourStats): string[] {
  const out: string[] = []
  if (c.lum < 0.28) out.push('dark-moody')
  else if (c.lum > 0.68) out.push('bright')
  if (c.sat < 0.1) out.push('monochrome')
  else if (c.sat < 0.25) out.push('muted')
  else if (c.sat > 0.5) out.push('vibrant')
  if (c.sat >= 0.1) {
    if (c.warm > 0.08) out.push('warm')
    else if (c.warm < -0.06) out.push('cool')
  }
  if (c.contrast > 0.28) out.push('high-contrast')
  return out
}

/** The best label of a softmax over `labels`, when it is clear enough (≥ `min`), else null. */
export function pick<T extends string>(labels: readonly T[], probs: readonly number[], min: number): { label: T; p: number } | null {
  let best = -1
  for (let i = 0; i < probs.length; i++) if (best < 0 || (probs[i] ?? 0) > (probs[best] ?? 0)) best = i
  if (best < 0) return null
  const p = probs[best] ?? 0
  return p >= min ? { label: labels[best]!, p } : null
}

/**
 * A file or folder name safe on Windows, macOS and Linux (no reserved
 * characters, no trailing dot or space) and inside a `![[…]]` embed (no
 * brackets, `|`, `#` or `^`).
 */
export function safeName(name: string): string {
  const clean = name
    .replace(/[<>:"/\\|?*\u0000-\u001f[\]#^]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  const base = clean || 'picture'
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base) ? `_${base}` : base
}
