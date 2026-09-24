import { useEffect, useRef, useState } from 'react'
import { titleFromText } from '@aether/core'
import { useAether } from '../store'
import { MOD } from '../util'

/**
 * Quick capture: one box, one keystroke, lands in Inbox/ as a real .md file
 * with frontmatter. The first line becomes the title.
 */
export function Capture() {
  const view = useAether((s) => s.view)
  const setView = useAether((s) => s.setView)
  const capture = useAether((s) => s.capture)
  const readOnly = useAether((s) => s.adapter?.readOnly ?? false)
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (view === 'capture') requestAnimationFrame(() => ta.current?.focus())
  }, [view])

  if (view !== 'capture') return null

  const submit = async (open = false) => {
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const tagList = tags
        .split(/[,\s#]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
      const id = await capture(text, tagList)
      setText('')
      setTags('')
      setView('graph')
      if (open) useAether.getState().openNote(id, { fly: true })
    } finally {
      setBusy(false)
    }
  }

  const title = text.trim() ? titleFromText(text) : ''

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-black/40 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && setView('graph')} role="dialog" aria-label="Quick capture">
      <div className="panel rise w-[600px] max-w-[92vw] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
          <span className="text-inbox">✦</span>
          <span className="text-[13px] font-semibold text-white">Capture → Inbox</span>
          <span className="flex-1" />
          <span className="truncate text-[11.5px] text-faint">{title ? `Inbox/${title}.md` : 'first line becomes the title'}</span>
        </div>
        <textarea
          ref={ta}
          className="editor-textarea !h-48 !font-sans !text-[15px]"
          placeholder="What's on your mind? Use [[links]] and #tags freely…"
          value={text}
          readOnly={readOnly}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void submit(e.shiftKey)
            }
          }}
          aria-label="Capture text"
        />
        <div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2">
          <input
            className="input !w-52 !py-1.5 !text-[12.5px]"
            placeholder="tags: idea, drawing"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), void submit(e.shiftKey))}
            aria-label="Tags"
          />
          <span className="flex-1 text-[11px] text-faint">
            <kbd>{MOD}</kbd>+<kbd>Enter</kbd> save · <kbd>⇧{MOD}Enter</kbd> save & open · <kbd>Esc</kbd> cancel
          </span>
          <button type="button" className="hud-btn" onClick={() => setView('graph')}>
            Cancel
          </button>
          <button type="button" className="hud-btn primary" disabled={!text.trim() || busy || readOnly} onClick={() => void submit(false)}>
            {busy ? 'Saving…' : 'Capture'}
          </button>
        </div>
      </div>
    </div>
  )
}
