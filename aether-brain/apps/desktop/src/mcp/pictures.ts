/**
 * Pictures an AI sends to the brain (the AI link's save_image): where the bytes may come from, and what is checked before any
 * of them is written. Pure Node, tested without Electron or a network.
 *
 * Three sources, each with the rules its trust deserves:
 *  - `data`: the picture itself as base64 text. Small only (the HTTP link refuses a request over 1 MiB), and the model has to
 *    type every character of it, so it is for icons and sketches, not photographs.
 *  - `path`: a file on this computer. Only for a client that runs the server here (Claude Desktop, Claude Code: stdio), never
 *    for the HTTP link a tunnel reaches. A network or device path (`\\server\share`, `\\?\`) is refused outright (Windows would
 *    send the user's credentials to it), the file must be a real picture of a name Aether Brain shows, and a symlink is followed
 *    to where it really points before that is judged.
 *  - `file`: what ChatGPT hands a tool for a picture the user attached or it made (`openai/fileParams`): a temporary https
 *    address. Only ChatGPT's own file hosts are downloaded from (a model can write any address into an argument, and a fetch
 *    of a page an attacker named could carry the user's notes out in its query string), over https, on the standard port, with
 *    no credentials, redirects only to those hosts again, a size cap and a time limit.
 * Whatever the source, the bytes must then pass `assetBytes` (a real PNG, JPEG, GIF, WebP, BMP or AVIF, at most 40 MB).
 */
import { promises as fs } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { slugifyTitle, todayIso } from '@aether/core'
import { MAX_ASSET_BYTES, type ImageKind } from '../main/assets.js'
import { isImageName } from '../main/fsvault.js'

/** Most base64 characters a `data` argument may carry: the HTTP link refuses a request over 1 MiB, and this leaves room for the rest of it. */
export const MAX_PICTURE_DATA_CHARS = 850_000
/** Where a picture goes when no folder is given, under the vault's home. */
export const PICTURES_FOLDER = 'Inbox/Pictures'
/**
 * Hosts a ChatGPT file may be downloaded from: each name and every subdomain of it. ChatGPT's own file hosts as far as OpenAI's
 * documentation and files in the wild show; `AETHER_FILE_HOSTS` adds more (see `fileHostsFromEnv`).
 */
export const OPENAI_FILE_HOSTS: readonly string[] = ['oaiusercontent.com', 'openai.com', 'chatgpt.com']
/** Redirects a download may follow (each one to an allowed host again). */
export const MAX_REDIRECTS = 3
/** How long a download may take altogether. */
export const DOWNLOAD_TIMEOUT_MS = 60_000

/** The file extension each picture kind is written with (a JPEG is `.jpg`, whatever the name it came with). */
export const PICTURE_EXT: Record<ImageKind, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp', avif: 'avif' }

/** The bytes of a picture and the name it came with ('' when it had none). */
export interface PictureSource {
  bytes: Uint8Array
  name: string
}

/** What ChatGPT passes for a file parameter (`openai/fileParams`). */
export interface PictureFile {
  download_url: string
  file_id?: string | undefined
  mime_type?: string | undefined
  file_name?: string | undefined
}

/* ------------------------------ names ------------------------------ */

/**
 * The name a picture is saved under, without its extension: the file name it came with (any folders and a picture extension
 * taken off, characters Windows refuses turned into spaces, at most 80 characters), or `Picture <today>` when it had none.
 */
export function pictureStem(raw: string | undefined, now: Date = new Date()): string {
  const base = (raw ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = slugifyTitle(base.replace(/\.(png|jpe?g|gif|webp|bmp|avif)$/i, ''))
    // Windows drops trailing dots and spaces from a name: say so here, not when the file comes out under another name.
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  return stem || `Picture ${todayIso(now)}`
}

/** The picture's name as an Inbox note would call it: its file name with the separators a file name uses turned into spaces. */
export function pictureTitle(stem: string): string {
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || stem
}

/* ------------------------------ data ------------------------------- */

/** The bytes of a `data` argument: bare base64 or a `data:image/png;base64,` URL, whitespace allowed. */
export function decodePictureData(raw: string): Uint8Array {
  let s = raw.trim()
  const url = /^data:([^;,]*)((?:;[^,;]*)*),/i.exec(s)
  if (url) {
    if (!/;base64$/i.test(url[2] ?? '')) throw new Error('data must be base64: bare base64 text, or a data:image/png;base64,… address')
    s = s.slice(url[0].length)
  }
  s = s.replace(/\s+/g, '')
  if (!s) throw new Error('data is empty')
  if (s.length > MAX_PICTURE_DATA_CHARS) {
    throw new Error(`data is too long: ${s.length.toLocaleString('en-US')} characters (at most ${MAX_PICTURE_DATA_CHARS.toLocaleString('en-US')}, a picture of about 600 KB). Use file or path for a bigger picture.`)
  }
  // URL-safe base64 (`-` `_`) is read too.
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error('data is not base64 text')
  return new Uint8Array(Buffer.from(s, 'base64'))
}

/* ------------------------------ path ------------------------------- */

/** A path that leaves this computer or names a device: `\\server\share`, `//server/share`, `\\?\C:\…`, `\\.\pipe\…`. */
function isNetworkOrDevicePath(p: string): boolean {
  return /^(\\\\|\/\/)/.test(p)
}

/**
 * A picture file on this computer. Only for a client running the server here. Refuses a relative path, a network or device
 * path (also when a symlink leads there), anything that is not a plain file, a name that is not a picture's, a file over the
 * size cap, and (after reading) anything whose bytes are not a picture, which the caller checks with `assetBytes`.
 */
export async function readLocalPicture(raw: string, maxBytes: number = MAX_ASSET_BYTES): Promise<PictureSource> {
  const p = raw.trim()
  if (!p) throw new Error('path is empty')
  if (isNetworkOrDevicePath(p)) throw new Error('A network or device path (\\\\server\\share, \\\\?\\ …) is not allowed: use a picture file on this computer')
  if (!path.isAbsolute(p)) throw new Error('path must be the whole path of the file, e.g. C:\\Users\\me\\Downloads\\gate.png')
  const name = path.basename(p)
  if (!isImageName(name)) throw new Error(`Only pictures (png, jpg, jpeg, webp, gif, bmp, avif) can be saved: ${name}`)
  let real: string
  try {
    real = await fs.realpath(p)
  } catch {
    throw new Error(`No such file: ${name}`)
  }
  // Followed to where it really is: a link may lead off the computer, or to something that is no picture.
  if (isNetworkOrDevicePath(real)) throw new Error('That file is on the network (it is a link to a network path): copy it to this computer first')
  if (!isImageName(path.basename(real))) throw new Error(`${name} is a link to something that is not a picture`)
  const st = await fs.stat(real)
  if (!st.isFile()) throw new Error(`${name} is not a file`)
  if (st.size > maxBytes) throw new Error(`The picture is too big: ${(st.size / 1024 / 1024).toFixed(1)} MB (at most ${Math.floor(maxBytes / 1024 / 1024)} MB)`)
  const handle = await fs.open(real, 'r')
  try {
    // One byte more than the cap: a file that grew since the stat is still refused.
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    if (bytesRead > maxBytes) throw new Error(`The picture is too big (at most ${Math.floor(maxBytes / 1024 / 1024)} MB)`)
    return { bytes: new Uint8Array(buf.subarray(0, bytesRead)), name }
  } finally {
    await handle.close()
  }
}

/* ------------------------------ file ------------------------------- */

/** The extra hosts the user allowed (`AETHER_FILE_HOSTS`, comma or space separated: `files.example.com, cdn.example.org`). */
export function fileHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  for (const part of (env['AETHER_FILE_HOSTS'] ?? '').split(/[,\s]+/)) {
    const host = part.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
    // A name only: no scheme, path, port, wildcard or address.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && isIP(host) === 0 && !out.includes(host)) out.push(host)
    if (out.length >= 20) break
  }
  return out
}

/** True when `hostname` is one of `hosts` or a subdomain of one. An address (IPv4, IPv6) never is. */
export function isAllowedFileHost(hostname: string, hosts: readonly string[]): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (!h || h.includes(':') || h.startsWith('[') || isIP(h) !== 0) return false
  return hosts.some((d) => h === d || h.endsWith(`.${d}`))
}

/** `raw` as a URL a picture may be downloaded from (https, a standard port, no credentials, an allowed host), or an error that says why not. */
function checkedUrl(raw: string, hosts: readonly string[]): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('The picture link is not a web address')
  }
  if (u.protocol !== 'https:') throw new Error('Only https links can be downloaded')
  if (u.username || u.password) throw new Error('A link with a user name or password in it is not downloaded')
  if (u.port !== '') throw new Error('Only links on the standard https port are downloaded')
  if (!isAllowedFileHost(u.hostname, hosts)) {
    throw new Error(
      `The picture is on ${u.hostname}, which this link does not download from (it takes ChatGPT's file hosts: ${OPENAI_FILE_HOSTS.join(', ')}). ` +
        'Save the picture to a file and use path, or send it as data. The person running Aether Brain can allow another host with AETHER_FILE_HOSTS.',
    )
  }
  return u
}

/** The file name a download address ends in, when it is a picture's ('' otherwise). */
function nameFromUrl(u: URL): string {
  let last = ''
  try {
    last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    last = ''
  }
  return isImageName(last) ? last : ''
}

/** A response body read up to `max` bytes; one more and the download is stopped and refused. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!body) throw new Error('The download had no content')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`The picture is too big (at most ${Math.floor(max / 1024 / 1024)} MB)`)
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

export interface DownloadOptions {
  /** `fetch` (tests pass their own). */
  fetch?: typeof fetch
  /** Hosts allowed besides `OPENAI_FILE_HOSTS`. */
  hosts?: readonly string[]
  maxBytes?: number
  timeoutMs?: number
}

/** A ChatGPT file as bytes: downloaded from its temporary address, under every rule in this file's header. */
export async function fetchPictureFile(file: PictureFile, opts: DownloadOptions = {}): Promise<PictureSource> {
  const doFetch = opts.fetch ?? globalThis.fetch
  const hosts = [...OPENAI_FILE_HOSTS, ...(opts.hosts ?? [])]
  const max = opts.maxBytes ?? MAX_ASSET_BYTES
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS)
  let url = checkedUrl(file.download_url, hosts)
  for (let hop = 0; ; hop++) {
    let res: Response
    try {
      // Redirects are followed here, one at a time, so each one can be judged like the first.
      res = await doFetch(url, { redirect: 'manual', signal, headers: { Accept: 'image/*' } })
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      throw new Error(timedOut ? 'The download took too long' : `The download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (!to || hop >= MAX_REDIRECTS) throw new Error('The download was sent on too many times')
      url = checkedUrl(new URL(to, url).toString(), hosts)
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`The download answered ${res.status} (a ChatGPT file link expires: ask for the picture again)`)
    }
    const length = Number(res.headers.get('content-length'))
    if (Number.isFinite(length) && length > max) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`The picture is too big: ${(length / 1024 / 1024).toFixed(1)} MB (at most ${Math.floor(max / 1024 / 1024)} MB)`)
    }
    const bytes = await readCapped(res.body, max)
    return { bytes, name: file.file_name?.trim() || nameFromUrl(url) }
  }
}
