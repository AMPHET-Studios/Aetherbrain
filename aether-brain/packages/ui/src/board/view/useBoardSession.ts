/**
 * React's way into the board session: the hook that creates one per open board and starts and stops it with the view, and the
 * hooks the components read it with. A component reads a slice of the controller's state (`useBoardState`) so that a drag, which
 * changes the state on every pointer move, re-renders only what shows the part that changed: the canvas draws on its own frame loop
 * and does not go through React at all.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BoardHost, BoardUiState } from '../api'
import { BoardSession, type SessionEnv, type SessionPhase, type SessionUi } from './boardSession'
import { browserEnv } from './env'

export interface UseBoardSessionOptions {
  /** The note's text when the caller already has it: the board opens on the first render, with no loading screen (and renders on a server). */
  initialRaw?: string
  /** Replaces the browser's side of the session (tests). */
  env?: SessionEnv
}

/**
 * The session of a board. It is made once per host (give the view a `key` when the board changes), started and stopped with the
 * component: stopping flushes a pending save and lets go of every listener, cache and timer.
 */
export function useBoardSession(host: BoardHost, ui: SessionUi, options: UseBoardSessionOptions = {}): { session: BoardSession; phase: SessionPhase; error: string } {
  const [session] = useState(() => {
    const s = new BoardSession({ host, env: options.env ?? browserEnv(), ui })
    if (options.initialRaw !== undefined) s.loadFromRaw(options.initialRaw)
    return s
  })
  // The callbacks of the latest render, without making a new session.
  useLayoutEffect(() => session.setUi(ui))
  useEffect(() => {
    session.start()
    if (session.phase === 'idle') void session.load()
    return () => void session.stop()
  }, [session])
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session])
  const phase = useSyncExternalStore(subscribe, () => session.phase, () => session.phase)
  const error = useSyncExternalStore(subscribe, () => session.error, () => session.error)
  return { session, phase, error }
}

/** Re-renders when anything the session reports changes (save state, messages, activity, pictures missing); returns a counter. */
export function useSessionVersion(session: BoardSession): number {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session])
  return useSyncExternalStore(subscribe, () => session.getVersion(), () => session.getVersion())
}

/**
 * A slice of the controller's state. `select` must be cheap; the component re-renders only when the slice differs by `equal`
 * (identity by default), and keeps the old value when it does not, which is what makes the store snapshot stable.
 */
export function useBoardState<T>(session: BoardSession, select: (state: BoardUiState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ value: T } | null>(null)
  const getSnapshot = (): T => {
    const next = select(session.controller.state)
    const prev = last.current
    if (prev && equal(prev.value, next)) return prev.value
    last.current = { value: next }
    return next
  }
  const subscribe = useCallback((cb: () => void) => session.controller.subscribe(cb), [session])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Whether the user asked for less motion: the entrance animations are left off then. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const q = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(q.matches)
    on()
    q.addEventListener('change', on)
    return () => q.removeEventListener('change', on)
  }, [])
  return reduced
}
