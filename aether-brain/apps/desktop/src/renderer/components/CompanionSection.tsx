import { useEffect, useState } from 'react'
import type { AetherBridge, CompanionStatus } from '../../shared/ipc'
import { errorText } from '../panels'
import { ErrorLine, Section } from './Overlay'

function state(st: CompanionStatus): { text: string; tone: string } {
  if (st.error) return { text: st.error, tone: 'bg-danger' }
  if (!st.enabled) return { text: 'Off: the Unreal app can’t see this brain.', tone: 'bg-faint' }
  if (!st.running) return { text: 'Starting…', tone: 'bg-inbox' }
  if (st.connected) return { text: `The Unreal app is showing this brain (port ${st.port}).`, tone: 'bg-untagged shadow-[0_0_10px_#9dffb3]' }
  return { text: `On (port ${st.port}): waiting for the Unreal app.`, tone: 'bg-inbox' }
}

/** The AI link panel's section for the Unreal companion app. */
export function CompanionSection({ bridge }: { bridge: AetherBridge }) {
  const [st, setSt] = useState<CompanionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      bridge.companionStatus().then(
        (s) => alive && setSt(s),
        (err: unknown) => alive && setError(errorText(err)),
      )
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [bridge])

  const configure = async (patch: Parameters<AetherBridge['companionConfigure']>[0]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setSt(await bridge.companionConfigure(patch))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = () => {
    if (window.confirm('Make a new token for the Unreal app?\n\nThe app reads it from companion.json by itself; one set up by hand needs the new one.')) {
      void configure({ regenerateToken: true })
    }
  }

  const s = st ? state(st) : null
  return (
    <Section title="Unreal companion" aside="the brain in Unreal Engine 5, live">
      <ErrorLine text={error} />
      {!st ? (
        <p className="text-[12.5px] text-dim">Loading…</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={st.enabled}
              disabled={busy}
              className={`hud-btn ${st.enabled ? '!border-accent/60 text-ink' : ''}`}
              onClick={() => void configure({ enabled: !st.enabled })}
            >
              <span className={`inline-block h-2 w-2 rounded-full ${st.enabled ? 'bg-accent' : 'bg-faint'}`} aria-hidden />
              {st.enabled ? 'Companion link on' : 'Companion link off'}
            </button>
            <button type="button" className="hud-btn" disabled={busy} onClick={regenerate}>
              New token…
            </button>
          </div>
          {s && (
            <div className="mb-2 flex items-center gap-2 text-[12px] text-dim" aria-live="polite">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.tone}`} aria-hidden />
              {s.text}
            </div>
          )}
          <p className="text-[11.5px] leading-relaxed text-faint">
            The Unreal app (in <code className="font-mono text-ink">unreal/</code> of the source; you build it once in Unreal Engine) draws this brain with
            Unreal&apos;s lighting and flies through it; a click there selects and flies here too, double-click opens the note here. It reads the address and
            token from <code className="font-mono text-ink">{st.file}</code>, on this computer only (127.0.0.1). It sees titles, colours and positions, never
            what your notes say.
          </p>
        </>
      )}
    </Section>
  )
}
