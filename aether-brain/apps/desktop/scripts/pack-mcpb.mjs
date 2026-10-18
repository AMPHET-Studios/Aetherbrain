// Packs the Claude Desktop extension: release/aether-brain-<version>.mcpb.
//
// An .mcpb is a plain ZIP: manifest.json + the bundled server + an icon.
// Claude Desktop installs it with a double-click (or Settings → Extensions →
// Advanced settings → Install Extension), asks for the vault folders (and
// folders to skip), and runs the server with its own Node. Needs
// `pnpm build:mcp` first.
//
// A tiny built-in zip writer (deflate from node:zlib + CRC-32) keeps this
// dependency-free. The archive has no directory entries.
//
//   node scripts/pack-mcpb.mjs [--out <folder>]
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '..')
const REPO = 'https://github.com/YEASTINFECTIONCHEESE/desktop-tutorial'

const outArg = process.argv.indexOf('--out')
const outDir = outArg > 0 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(app, 'release')

const pkg = JSON.parse(await fs.readFile(path.join(app, 'package.json'), 'utf8'))
const bundlePath = path.join(app, 'dist', 'mcp', 'aether-mcp.mjs')
const iconPath = path.join(app, 'build', 'icon.png')

const bundle = await fs.readFile(bundlePath).catch(() => {
  console.error(`[pack-mcpb] ${bundlePath} is missing: run "pnpm build:mcp" first.`)
  process.exit(1)
})
const icon = await fs.readFile(iconPath)

// Tool names and descriptions come from the server itself, so the manifest never drifts.
const { TOOLS, HOST_TOOLS } = await import(pathToFileURL(bundlePath).href)
if (!TOOLS || typeof TOOLS !== 'object' || !Array.isArray(HOST_TOOLS)) {
  console.error('[pack-mcpb] the bundle does not export TOOLS and HOST_TOOLS')
  process.exit(1)
}

/** Manifest v0.3 (strict schema: no unknown keys). */
const manifest = {
  manifest_version: '0.3',
  name: 'aether-brain',
  display_name: 'Aether Brain',
  version: pkg.version,
  description: 'Let Claude work in your second brain: search, read and write the markdown notes, projects, tasks and folders on your own drives.',
  long_description: [
    'Aether Brain turns folders of plain markdown notes into a 3D second brain. This extension gives Claude a direct line to it.',
    '',
    'Claude can search and read your notes (with their [[wikilinks]] and backlinks), browse your folders, see every project with its tasks and progress, capture ideas to the Inbox, create notes and folders (new planets inside a project), add and complete tasks (done tasks get a ✅ date), and update projects.',
    '',
    'Pick one or more folders, or whole drives such as D:\\ and F:\\. Everything stays on your computer: the files are the only source of truth, nothing is uploaded anywhere by the extension, and nothing outside the folders you picked can be read or written, with one exception: when you ask Claude to save a picture, it may copy a picture file you name from anywhere on this computer into your Inbox (a file that really is a picture, never a network path). Hidden and system folders are always skipped; list any other folder names Claude should never open in Skip these folders (the exclusions you set in the Aether Brain app do not reach the extension). No tool deletes a note, only .md notes, folders and pictures are ever created, and a name that is taken is never overwritten. Switch on Read only to let Claude look without changing anything.',
  ].join('\n'),
  author: { name: 'Aether Brain contributors' },
  repository: { type: 'git', url: REPO },
  homepage: REPO,
  documentation: `${REPO}/blob/main/aether-brain/docs/AI-LINK.md`,
  support: `${REPO}/issues`,
  icon: 'icon.png',
  server: {
    type: 'node',
    entry_point: 'server/aether-mcp.mjs',
    mcp_config: {
      command: 'node',
      // A `multiple` directory value expands to one argument per folder only when the argument is exactly the placeholder.
      // The server skips an empty value or an unexpanded `${…}` (an optional setting left unset).
      args: [
        '${__dirname}/server/aether-mcp.mjs',
        '--read-only=${user_config.read_only}',
        '--exclude-list=${user_config.exclude}',
        '${user_config.vaults}',
      ],
    },
  },
  // Not the tools only the running app offers (it has the pictures and the window; this stdio server has neither).
  tools: Object.entries(TOOLS)
    .filter(([name]) => !HOST_TOOLS.includes(name))
    .map(([name, t]) => ({ name, description: t.description })),
  tools_generated: false,
  keywords: ['notes', 'markdown', 'second brain', 'pkm', 'projects', 'tasks', 'obsidian', 'para'],
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=20.0.0' },
  },
  user_config: {
    vaults: {
      type: 'directory',
      title: 'Vault folders',
      description: 'The folders that hold your notes. Whole drives work too (for example D:\\ and F:\\); pick several to use them together.',
      multiple: true,
      required: true,
    },
    exclude: {
      type: 'string',
      title: 'Skip these folders',
      description:
        'Folder names Claude must never open, separated by commas (for example: Private, Taxes). Every folder with such a name is skipped, at any depth. Hidden and system folders are always skipped. Exclusions set in the Aether Brain app do not apply here.',
      default: '',
      required: false,
    },
    read_only: {
      type: 'boolean',
      title: 'Read only',
      description: 'Claude can search and read your notes but cannot change anything.',
      default: false,
      required: false,
    },
  },
}

/* ------------------------------------------------------------------ */
/* ZIP writer                                                         */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS time and date fields (local time, 2 s resolution, from 1980). */
function dosStamp(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/** A ZIP of files only (no directory entries), deflated unless storing is smaller. */
function zip(files, when = new Date()) {
  const { time, date } = dosStamp(when)
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const deflated = deflateRawSync(f.data, { level: 9 })
    const store = deflated.length >= f.data.length
    const body = store ? f.data : deflated
    const method = store ? 0 : 8
    const crc = crc32(f.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0) // central directory header
    entry.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix, 2.0 (so the mode below counts)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(time, 12)
    entry.writeUInt16LE(date, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(f.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(0, 30) // extra
    entry.writeUInt16LE(0, 32) // comment
    entry.writeUInt16LE(0, 34) // disk
    entry.writeUInt16LE(0, 36) // internal attributes
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38) // regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42)

    parts.push(local, name, body)
    central.push(entry, name)
    offset += local.length + name.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, dir, end])
}

const archive = zip([
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
  { name: 'server/aether-mcp.mjs', data: bundle },
  { name: 'icon.png', data: icon },
])

await fs.mkdir(outDir, { recursive: true })
const out = path.join(outDir, `aether-brain-${pkg.version}.mcpb`)
await fs.writeFile(out, archive)
console.log(`[pack-mcpb] ${path.relative(process.cwd(), out) || out} (${(archive.length / 1024).toFixed(0)} KB, ${manifest.tools.length} tools)`)
