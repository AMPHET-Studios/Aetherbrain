import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { basenameOf, folderOf } from '@aether/core'
import { useAether } from '../store'
import { MarkdownPreview } from './MarkdownPreview'
import { cx, MOD, relativeTime } from '../util'

const AUTOSAVE_MS = 900

/**
 * Split editor: raw markdown on the left (with [[ autocomplete), live
 * preview on the right. Autosaves; Ctrl/⌘+S saves now; Ctrl/⌘+E cycles
 * edit / split / preview; Esc closes (and saves).
 */
export function Editor() {
  const editorId = useAether((s) => s.editorId)
  const note = useAether((s) => (s.editorId ? (s.notes.get(s.editorId) ?? null) : null))
  const draft = useAether((s) => s.draft)
  const dirty = useAether((s) => s.dirty)
  const setDraft = useAether((s) => s.setDraft)
  const saveDraft = useAether((s) => s.saveDraft)
  const closeEditor = useAether((s) => s.closeEditor)
  const renameNote = useAether((s) => s.renameNote)
  const previewMode = useAether((s) => s.settings.previewMode)
  const setSettings = useAether((s) => s.setSettings)
  const search = useAether((s) => s.search)
  const readOnly = useAether((s) => s.adapter?.readOnly ?? false)

  const ta = useRef<HTMLTextAreaElement | null>(null)
  const [ac, setAc] = useState<{ start: number; query: string; items: { id: string; title: string }[]; index: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  // Autosave.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void saveDraft(), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [draft, dirty, saveDraft])

  // Focus the textarea when a note opens.
  useEffect(() => {
    if (editorId && previewMode !== 'preview') ta.current?.focus()
  }, [editorId, previewMode])

  const cycleMode = useCallback(() => {
    const order = ['split', 'edit', 'preview'] as const
    setSettings({ previewMode: order[(order.indexOf(previewMode) + 1) % order.length]! })
  }, [previewMode, setSettings])

  const updateAutocomplete = useCallback(
    (value: string, caret: number) => {
      const before = value.slice(0, caret)
      const open = before.lastIndexOf('[[')
      if (open < 0) return setAc(null)
      const close = before.lastIndexOf(']]')
      if (close > open) return setAc(null)
      const query = before.slice(open + 2)
      if (/\n/.test(query) || query.length > 60) return setAc(null)
      const items = search.suggestTitles(query.split('|')[0]?.split('#')[0] ?? '', 8)
      setAc({ start: open, query, items, index: 0 })
    },
    [search],
  )

  const acceptAutocomplete = useCallback(
    (item: { id: string; title: string }) => {
      const el = ta.current
      if (!el || !ac || draft === null) return
      const after = draft.slice(el.selectionStart)
      const hasClose = after.startsWith(']]')
      const insert = `[[${item.title}]]`
      const next = draft.slice(0, ac.start) + insert + (hasClose ? after.slice(2) : after)
      setDraft(next)
      const caret = ac.start + insert.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
      })
      setAc(null)
    },
    [ac, draft, setDraft],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void saveDraft()
      return
    }
    if (mod && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      cycleMode()
      return
    }
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      closeEditor()
      return
    }
    if (ac) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAc({ ...ac, index: (ac.index + 1) % Math.max(1, ac.items.length) })
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAc({ ...ac, index: (ac.index - 1 + ac.items.length) % Math.max(1, ac.items.length) })
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && ac.items[ac.index]) {
        e.preventDefault()
        acceptAutocomplete(ac.items[ac.index]!)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setAc(null)
        return
      }
    }
    if (e.key === 'Tab') {
      // Indent instead of leaving the field.
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart, selectionEnd, value } = el
      const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`
      setDraft(next)
      requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2))
    }
  }

  const title = note?.meta.title ?? ''
  const stats = useMemo(() => {
    if (!draft) return null
    const words = draft.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
    return `${words} words · ${draft.split('\n').length} lines`
  }, [draft])

  if (!editorId || !note || draft === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-dim">
        <div className="text-lg font-semibold text-ink">No neuron open</div>
        <div className="max-w-xs text-sm">
          Select a node and press <kbd>e</kbd>, double-click one, or <kbd>{MOD}</kbd>+<kbd>K</kbd> to search.
        </div>
      </div>
    )
  }

  const showEdit = previewMode !== 'preview'
  const showPreview = previewMode !== 'edit'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          {renaming !== null ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const folder = folderOf(note.meta.path)
                const name = renaming.trim()
                setRenaming(null)
                if (name && name !== basenameOf(note.meta.path)) void renameNote(editorId, `${folder ? folder + '/' : ''}${name}.md`)
              }}
            >
              <input
                autoFocus
                className="input !py-1 text-[15px] font-semibold"
                value={renaming}
                onChange={(e) => setRenaming(e.target.value)}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setRenaming(null))}
              />
            </form>
          ) : (
            <button
              type="button"
              className="block max-w-full truncate text-left text-[15px] font-semibold text-white hover:text-accent2"
              title="Rename file"
              onClick={() => !readOnly && setRenaming(basenameOf(note.meta.path))}
            >
              {title}
            </button>
          )}
          <div className="truncate font-mono text-[11px] text-faint">{note.meta.path}</div>
        </div>
        <span className={cx('text-[11px]', dirty ? 'text-inbox' : 'text-faint')} aria-live="polite">
          {readOnly ? 'read-only' : dirty ? 'unsaved…' : `saved · ${relativeTime(note.meta.updated)}`}
        </span>
        <button type="button" className="hud-btn" onClick={cycleMode} title={`Cycle edit / split / preview (${MOD}+E)`}>
          {previewMode === 'split' ? '⫿ Split' : previewMode === 'edit' ? '✎ Edit' : '◉ Preview'}
        </button>
        <button type="button" className="hud-btn" onClick={closeEditor} title="Close (Esc)">
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        {showEdit && (
          <div className={cx('relative min-w-0', showPreview ? 'w-1/2 border-r border-[var(--line)]' : 'w-full')}>
            <textarea
              ref={ta}
              className="editor-textarea"
              spellCheck={false}
              value={draft}
              readOnly={readOnly}
              onChange={(e) => {
                setDraft(e.target.value)
                updateAutocomplete(e.target.value, e.target.selectionStart)
              }}
              onKeyDown={onKeyDown}
              onClick={(e) => updateAutocomplete(e.currentTarget.value, e.currentTarget.selectionStart)}
              onBlur={() => setTimeout(() => setAc(null), 120)}
              aria-label="Markdown source"
            />
            {ac && ac.items.length > 0 && (
              <div className="panel rise absolute bottom-3 left-4 z-10 w-72 overflow-hidden py-1" role="listbox">
                <div className="px-3 py-1 text-[10px] font-semibold tracking-wider text-faint">LINK TO NEURON</div>
                {ac.items.map((it, i) => (
                  <button
                    type="button"
                    key={it.id}
                    role="option"
                    aria-selected={i === ac.index}
                    className={cx('block w-full truncate px-3 py-1.5 text-left text-[13px]', i === ac.index ? 'bg-accent/25 text-white' : 'text-dim hover:text-ink')}
                    onMouseDown={(e) => (e.preventDefault(), acceptAutocomplete(it))}
                  >
                    {it.title}
                    <span className="ml-2 font-mono text-[10px] text-faint">{it.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {showPreview && (
          <div className={cx('scroll min-w-0', showEdit ? 'w-1/2' : 'w-full')}>
            <MarkdownPreview source={draft} selfId={editorId} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-[var(--line)] px-4 py-1.5 text-[11px] text-faint">
        <span>{stats}</span>
        <span className="flex-1" />
        <span>
          <kbd>[[</kbd> link · <kbd>{MOD}</kbd>+<kbd>S</kbd> save · <kbd>{MOD}</kbd>+<kbd>E</kbd> view · <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  )
}
