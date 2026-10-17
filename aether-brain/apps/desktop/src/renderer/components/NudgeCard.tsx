/**
 * The nudge card: a small quiet card under the top bar that offers to plan the day, check in on it or wrap it up (nudges.ts says
 * when). No sound, no focus taken, no number in it. Unanswered for two minutes it goes away by itself and comes back in an hour;
 * ✕ is "not today"; "Turn nudges off" (or the chat's ⚙, or the palette) switches the cards off.
 */
import { useEffect, useRef, useState } from 'react'
import { useAether } from '@aether/ui'
import { ElectronVaultAdapter } from '../vault/electron'
import { NUDGE_TEXT, QUIET_MS, answerNudge, currentRecord, nextNudge, type NudgeKind } from '../nudges'
import { sendDayPrompt, setNudges, useChatOccupied } from './ChatPanel'

const bridge = ElectronVaultAdapter.bridge()
/** How often the host looks for something to offer (it also looks when the window comes back). */
const CHECK_MS = 60_000

export interface NudgeViewProps {
  kind: NudgeKind
  onStart(): void
  onLater(): void
  onSkip(): void
  onOff(): void
  /** The pointer is over the card: it is being read, so it stays. */
  onHover?(over: boolean): void
}

/** The card itself (nothing but what to show and what each button does). */
export function NudgeView({ kind, onStart, onLater, onSkip, onOff, onHover }: NudgeViewProps) {
  const t = NUDGE_TEXT[kind]
  return (
    <div
      className="panel rise fixed inset-x-0 top-[68px] z-[35] mx-auto w-[min(400px,calc(100vw-24px))] px-4 py-3"
      role="status"
      aria-live="polite"
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden="true" className="text-[18px] leading-none">
          {t.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-white">{t.title}</div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-dim">{t.body}</p>
          <div className="mt-2 flex items-center gap-1.5">
            <button type="button" className="hud-btn primary" onClick={onStart}>
              {t.action}
            </button>
            <button type="button" className="hud-btn" onClick={onLater}>
              In an hour
            </button>
            <span className="flex-1" />
            <button type="button" className="text-[11px] text-faint hover:text-dim" onClick={onOff}>
              Turn nudges off
            </button>
          </div>
        </div>
        <button type="button" className="hud-btn !px-1.5" onClick={onSkip} aria-label="Not today" title="Not today">
          ✕
        </button>
      </div>
    </div>
  )
}

/** Looks for something to offer and shows it (nothing is drawn while there is nothing). */
export function NudgeCard() {
  const brief = useAether((s) => s.brief)
  const view = useAether((s) => s.view)
  const paletteOpen = useAether((s) => s.paletteOpen)
  const helpOpen = useAether((s) => s.helpOpen)
  const chat = useChatOccupied()
  const [kind, setKind] = useState<NudgeKind | null>(null)
  const [hover, setHover] = useState(false)
  const open = brief ? brief.overdue.length + brief.today.length : 0
  const occupied = chat || paletteOpen || helpOpen || view === 'boards'
  // The timer's look reads the latest of these, not the ones it was set up with.
  const live = useRef({ open, occupied })
  live.current = { open, occupied }

  useEffect(() => {
    if (!bridge) return
    let alive = true
    const check = async () => {
      const status = await bridge.chatStatus().catch(() => null)
      if (!alive || !status) return
      const here = document.visibilityState === 'visible' && document.hasFocus()
      const next = nextNudge(new Date(), currentRecord(), { on: status.nudges, ready: status.ready, open: live.current.open, here, occupied: live.current.occupied })
      // A card that is up stays: it is never swapped for another.
      if (next) setKind((cur) => cur ?? next)
    }
    void check()
    const timer = setInterval(() => void check(), CHECK_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  // The chat (or the palette, the cheatsheet, the boards) has the person's attention now: put the card off, quietly.
  useEffect(() => {
    if (kind && occupied) {
      answerNudge(kind, 'later')
      setKind(null)
    }
  }, [kind, occupied])

  // Nobody answered: it goes by itself, and comes back in an hour.
  useEffect(() => {
    if (!kind || hover) return
    const timer = setTimeout(() => {
      answerNudge(kind, 'later')
      setKind(null)
    }, QUIET_MS)
    return () => clearTimeout(timer)
  }, [kind, hover])

  if (!kind) return null
  const done = (how: 'skip' | 'later') => {
    answerNudge(kind, how)
    setKind(null)
  }
  return (
    <NudgeView
      kind={kind}
      onStart={() => {
        setKind(null)
        sendDayPrompt(kind)
      }}
      onLater={() => done('later')}
      onSkip={() => done('skip')}
      onOff={() => {
        done('skip')
        void setNudges(false)
      }}
      onHover={setHover}
    />
  )
}
