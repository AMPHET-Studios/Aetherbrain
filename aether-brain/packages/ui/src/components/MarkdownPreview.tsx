import { useMemo, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AssetResolver,
  LinkResolver,
  extractTasks,
  folderOf,
  imageFileName,
  imageKey,
  imagePathOf,
  isMediaPath,
  isVideoPath,
  remarkNoLateAutolinks,
  remarkWikilink,
  splitFrontmatter,
  tameDelimiters,
  type NoteId,
  type ParsedNote,
  type VaultAsset,
} from '@aether/core'
import { useAether } from '../store'
import { cx } from '../util'
import { EMBED_MAX, PREVIEW_FIRST, PREVIEW_MAX, PREVIEW_STEP, groups, previewCut } from '../preview'
import { usePreview } from './pictures'

interface Props {
  /** Full raw markdown (frontmatter is stripped for display). */
  source: string
  /** Note id being rendered — embeds of itself are skipped. */
  selfId?: NoteId | null
  depth?: number
  className?: string
}

/**
 * Markdown preview with [[wikilinks]], ![[embeds]] (rendered inline, one
 * level deep) and #tags. Clicking a wikilink opens the note; clicking a ghost
 * link creates it. Picture targets (`![[gate.png]]`) resolve to the vault's
 * pictures like the graph does: an embed shows the picture, a click goes to
 * it, and a missing one is never a note to create.
 *
 * Only the first part of a long note is drawn (`PREVIEW_FIRST` characters, a part more per *Show more*, never
 * more than `PREVIEW_MAX`; an embedded note `EMBED_MAX`): laying text out costs memory in proportion to its
 * length, and a 16 MB imported chat took 10 GB. See `preview.ts`.
 */
export function MarkdownPreview({ source, selfId = null, depth = 0, className }: Props) {
  const notes = useAether((s) => s.notes)
  const assets = useAether((s) => s.assets)
  const revision = useAether((s) => s.revision)
  const toggleTag = useAether((s) => s.toggleTag)
  const toggleTask = useAether((s) => s.toggleTask)

  const resolver = useMemo(() => sharedResolver(notes, revision), [notes, revision])
  // How much of the note is drawn: the first part, and one more per *Show more*; another note starts again.
  const max = depth > 0 ? EMBED_MAX : PREVIEW_MAX
  const first = depth > 0 ? EMBED_MAX : PREVIEW_FIRST
  const [more, setMore] = useState<{ id: NoteId | null; shown: number }>({ id: selfId, shown: first })
  let shown = more.shown
  if (more.id !== selfId) {
    // Another note: start at its first part (state adjusted while drawing, the way React asks for it).
    setMore({ id: selfId, shown: first })
    shown = first
  }
  // Relative picture links (`![[Art/gate.png]]`, `![[../gate.png]]`) count from the note's folder.
  const folder = selfId ? (notes.get(selfId)?.meta.folder ?? folderOf(selfId)) : ''
  const { body, fmLines, total, drawn } = useMemo(() => {
    const split = splitFrontmatter(source)
    // Lines the frontmatter block occupies, so preview line numbers map back to the raw file.
    const fm = (source.slice(0, split.bodyOffset).match(/\n/g) ?? []).length
    // The part that is drawn is a prefix of the note, so the lines (task ticks) are still the file's.
    const part = previewCut(split.body, shown)
    // A paragraph with a pathological run of * or _ would freeze the renderer: same guard as the brain's parser.
    return { body: tameDelimiters(part.text), fmLines: fm, total: part.total, drawn: part.cut ? part.text.length : 0 }
  }, [source, shown])
  const plugins = useMemo(() => {
    const pictures = picturesOf(assets)
    const resolve = (t: string): string | null => {
      if (!isMediaPath(t)) return resolver.resolve(t)
      const path = pictures.resolve(t, folder)
      return path === null ? null : imageKey(path)
    }
    return [remarkGfm, remarkNoLateAutolinks, [remarkWikilink, { resolve }]] as const
  }, [resolver, assets, folder])

  // What the renderers read that changes with every keystroke or vault change: through a ref, so the
  // renderers keep their identity and react-markdown updates links and embeds instead of remounting
  // them (an embedded video would take its still again on every keystroke).
  const live = useRef({ notes, assets, fmLines, source })
  live.current = { notes, assets, fmLines, source }
  const components = useMemo<Components>(
    () => ({
      a: (props) => previewLink(props, { notes: live.current.notes, assets: live.current.assets, selfId, depth }),
      p: ({ node: _node, children, ...rest }) => <p {...rest}>{tagify(children, toggleTag)}</p>,
      li: ({ node, children, ...rest }) => {
        // Task-list items: a click on the checkbox writes `[x] … ✅ date` back
        // into the note (the markdown file is the memory).
        const bodyLine = node?.position?.start.line
        const canToggle = !!selfId && bodyLine !== undefined && String(rest.className ?? '').includes('task-list-item')
        return (
          <li
            {...rest}
            onClick={
              canToggle
                ? (e) => {
                    const t = e.target as HTMLElement
                    if (t.tagName !== 'INPUT') return
                    e.preventDefault()
                    // The new state comes from the markdown shown, not from `checked` (already flipped by the click).
                    const { fmLines, source } = live.current
                    const line = fmLines + bodyLine - 1
                    const task = extractTasks(source).find((x) => x.line === line)
                    if (task) void toggleTask(selfId!, line, !task.done, source)
                  }
                : undefined
            }
          >
            {tagify(children, toggleTag)}
          </li>
        )
      },
      input: ({ node: _node, ...rest }) => <input {...rest} readOnly={!selfId} onChange={() => undefined} className={cx(selfId && 'cursor-pointer')} />,
    }),
    [depth, selfId, toggleTag, toggleTask],
  )

  return (
    <div className={className ?? 'md'}>
      <ReactMarkdown remarkPlugins={plugins as never} components={components}>
        {body}
      </ReactMarkdown>
      {drawn > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-2 text-[12px] text-dim" role="note">
          <span>
            Showing the first {groups(drawn)} of {groups(total)} characters.
          </span>
          {depth > 0 ? (
            <span>Open the note to read it all.</span>
          ) : shown < max ? (
            <button type="button" className="hud-btn" onClick={() => setMore({ id: selfId, shown: Math.min(max, shown + PREVIEW_STEP) })}>
              Show {groups(Math.min(PREVIEW_STEP, max - shown))} more
            </button>
          ) : (
            <span>That is as much as the preview draws (more would use gigabytes of memory); the rest is in the file.</span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One link resolver for every preview of the same notes (the open note and each note embedded in it): indexing
 * the vault takes time and memory in proportion to its size, so a preview must not build its own.
 */
let resolverCache: { notes: ReadonlyMap<NoteId, ParsedNote>; revision: number; resolver: LinkResolver } | null = null
function sharedResolver(notes: ReadonlyMap<NoteId, ParsedNote>, revision: number): LinkResolver {
  if (!resolverCache || resolverCache.notes !== notes || resolverCache.revision !== revision) {
    resolverCache = { notes, revision, resolver: new LinkResolver(notes.values()) }
  }
  return resolverCache.resolver
}

/**
 * The picture resolver of an asset map, one per map: indexing a drive's
 * pictures takes a moment, and every preview shares it until a picture
 * changes (the store copies the map only then).
 */
const pictureResolvers = new WeakMap<ReadonlyMap<string, VaultAsset>, AssetResolver>()

function picturesOf(assets: ReadonlyMap<string, VaultAsset>): AssetResolver {
  let r = pictureResolvers.get(assets)
  if (!r) pictureResolvers.set(assets, (r = new AssetResolver(assets.keys())))
  return r
}

/** The preview a link is rendered in. */
export interface LinkContext {
  notes: ReadonlyMap<NoteId, ParsedNote>
  assets: ReadonlyMap<string, VaultAsset>
  selfId: NoteId | null
  depth: number
}

/**
 * One `<a>` of the preview (exported for tests: a plain function, so the
 * handlers it renders can be called without a DOM). Links without
 * `data-target` are ordinary links. A wikilink to a note opens it, an embed of
 * one renders it inline; an unresolved one is a ghost link that creates the
 * note. A picture target resolved to `image:<path>` (`data-id`) renders the
 * picture (embed) or a link, and a click goes to the picture (`openNote` of
 * an image id selects it, so the inspector shows it, and opens it in the
 * image app); an unresolved one is plain text marked missing.
 */
export function previewLink(props: ComponentProps<'a'> & ExtraProps, ctx: LinkContext): ReactNode {
  const { node: _node, className: cls, children, ...rest } = props
  const data = rest as Record<string, string | undefined>
  const target = data['data-target']
  if (!target) {
    return (
      <a {...rest} className={cls} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  const id = data['data-id'] ?? null
  const embed = data['data-embed'] === 'true'
  if (isMediaPath(target)) {
    if (!id) {
      return (
        <span className="picture-missing" title={`No ${isVideoPath(target) ? 'video' : 'picture'} “${target}” in the vault`}>
          {embed ? target : children}
        </span>
      )
    }
    const path = imagePathOf(id)
    // Show the picture (its moon and inspector, where Open is one key away) rather than launch another app from a click in the text.
    const show = () => useAether.getState().select(imageKey(path), { fly: true })
    if (embed) {
      const asset = ctx.assets.get(path)
      return <PictureEmbed path={path} stamp={`${asset?.mtime ?? ''}:${asset?.size ?? ''}`} onOpen={show} />
    }
    return (
      <a
        {...rest}
        className="wikilink wikilink-picture"
        onClick={(e: MouseEvent) => {
          e.preventDefault()
          show()
        }}
        title={path}
      >
        {children}
      </a>
    )
  }
  if (embed && id && ctx.depth < 1 && id !== ctx.selfId) {
    const n = ctx.notes.get(id)
    if (n) {
      return (
        <span className="embed block">
          <span className="embed-title">⤷ {n.meta.title}</span>
          <MarkdownPreview source={n.raw} selfId={id} depth={ctx.depth + 1} className="md !p-0" />
        </span>
      )
    }
  }
  const onClick = (e: MouseEvent) => {
    e.preventDefault()
    if (id) useAether.getState().openNote(id, { fly: true })
    else void useAether.getState().createGhost(`ghost:${target}`)
  }
  return (
    <a {...rest} className={cls} onClick={onClick} title={id ? id : `Create "${target}"`}>
      {children}
    </a>
  )
}

/**
 * An embedded picture (`![[gate.png]]`), shown from the store's preview
 * (a placeholder while it loads, the file name when there is none). A real
 * button, so Tab reaches it and Enter or Space goes to the picture.
 */
function PictureEmbed({ path, stamp, onOpen }: { path: string; stamp: string; onOpen: () => void }) {
  const preview = usePreview(path, stamp)
  /** The object URL the browser could not decode (then the file name shows instead). */
  const [broken, setBroken] = useState<string | null>(null)
  const name = imageFileName(path)
  const url = preview.url !== broken ? preview.url : null
  // A video shows one still frame with a play badge: it plays in the OS player (its inspector's Open), never here.
  const video = isVideoPath(path)
  return (
    <button type="button" className="embed-picture" onClick={onOpen} title={video ? `${path} (video)` : path}>
      {url ? (
        <span className="still">
          <img src={url} alt={name} draggable={false} onError={() => setBroken(url)} />
          {video && (
            <span className="play-badge" aria-hidden>
              ▶
            </span>
          )}
        </span>
      ) : (
        <span className="embed-picture-wait">
          {video ? '▶' : '🖼'} {name}
          {preview.state === 'loading' ? ' …' : ''}
        </span>
      )}
    </button>
  )
}

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu

/** Turn `#tag` text runs into clickable filter chips. */
function tagify(children: React.ReactNode, toggleTag: (t: string) => void): React.ReactNode {
  if (typeof children === 'string') return splitTags(children, toggleTag)
  if (Array.isArray(children)) return children.map((c, i) => (typeof c === 'string' ? <span key={i}>{splitTags(c, toggleTag)}</span> : c))
  return children
}

function splitTags(text: string, toggleTag: (t: string) => void): React.ReactNode {
  if (!text.includes('#')) return text
  const out: React.ReactNode[] = []
  let last = 0
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = TAG_RE.exec(text))) {
    const tag = m[2] ?? ''
    if (/^\d+$/.test(tag)) continue
    const start = m.index + (m[1]?.length ?? 0)
    out.push(text.slice(last, start))
    out.push(
      <a key={k++} className="tag" href="#" onClick={(e) => (e.preventDefault(), toggleTag(tag.toLowerCase()))}>
        #{tag}
      </a>,
    )
    last = start + tag.length + 1
  }
  out.push(text.slice(last))
  return out
}
