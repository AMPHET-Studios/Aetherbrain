import { useMemo, type MouseEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { LinkResolver, remarkWikilink, splitFrontmatter, type NoteId } from '@aether/core'
import { useAether } from '../store'
import { cx } from '../util'

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
 * link creates it.
 */
export function MarkdownPreview({ source, selfId = null, depth = 0, className }: Props) {
  const notes = useAether((s) => s.notes)
  const revision = useAether((s) => s.revision)
  const openNote = useAether((s) => s.openNote)
  const createGhost = useAether((s) => s.createGhost)
  const toggleTag = useAether((s) => s.toggleTag)
  const toggleTask = useAether((s) => s.toggleTask)

  const resolver = useMemo(() => new LinkResolver(notes.values()), [notes, revision])
  const { body, fmLines } = useMemo(() => {
    const split = splitFrontmatter(source)
    // Lines the frontmatter block occupies, so preview line numbers map back to the raw file.
    const fm = (source.slice(0, split.bodyOffset).match(/\n/g) ?? []).length
    return { body: split.body, fmLines: fm }
  }, [source])
  const plugins = useMemo(() => [remarkGfm, [remarkWikilink, { resolve: (t: string) => resolver.resolve(t) }]] as const, [resolver])

  const components = useMemo<Components>(
    () => ({
      a: (props) => {
        const { node: _node, className: cls, children, ...rest } = props as typeof props & {
          'data-target'?: string
          'data-id'?: string
          'data-embed'?: string
          'data-heading'?: string
        }
        const target = (rest as Record<string, string | undefined>)['data-target']
        if (!target) {
          return (
            <a {...rest} className={cls} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }
        const id = (rest as Record<string, string | undefined>)['data-id'] ?? null
        const embed = (rest as Record<string, string | undefined>)['data-embed'] === 'true'
        if (embed && id && depth < 1 && id !== selfId) {
          const n = notes.get(id)
          if (n) {
            return (
              <span className="embed block">
                <span className="embed-title">
                  ⤷ {n.meta.title}
                </span>
                <MarkdownPreview source={n.raw} selfId={id} depth={depth + 1} className="md !p-0" />
              </span>
            )
          }
        }
        const onClick = (e: MouseEvent) => {
          e.preventDefault()
          if (id) openNote(id, { fly: true })
          else void createGhost(`ghost:${target}`)
        }
        return (
          <a {...rest} className={cls} onClick={onClick} title={id ? id : `Create "${target}"`}>
            {children}
          </a>
        )
      },
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
                    void toggleTask(selfId!, fmLines + bodyLine - 1, !(t as HTMLInputElement).checked)
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
    [notes, depth, selfId, openNote, createGhost, toggleTag, toggleTask, fmLines],
  )

  return (
    <div className={className ?? 'md'}>
      <ReactMarkdown remarkPlugins={plugins as never} components={components}>
        {body}
      </ReactMarkdown>
    </div>
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
