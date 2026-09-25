import { useAether } from '../store'

export interface VaultSource {
  id: string
  label: string
  description: string
  /** Disabled sources still render, greyed, with a reason. */
  disabledReason?: string
  open: () => Promise<void> | void
}

/**
 * Shown when no vault is open (or while one loads). Sources are injected by
 * the host app: the demo vault, a browser folder (File System Access API) or
 * an Electron folder picker.
 */
export function Welcome({ sources }: { sources: VaultSource[] }) {
  const status = useAether((s) => s.status)
  const error = useAether((s) => s.error)
  const progress = useAether((s) => s.loadProgress)
  if (status === 'ready') return null
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center">
      <div className="panel rise w-[560px] max-w-[92vw] p-7">
        <div className="mb-1 flex items-center gap-3">
          <span
            className="inline-block h-5 w-5 rounded-full pulse"
            style={{ background: 'radial-gradient(circle at 35% 35%, #fff, #8f7cff 45%, #4de2ff 100%)', boxShadow: '0 0 24px #8f7cff' }}
          />
          <h1 className="text-[22px] font-semibold tracking-tight text-white">Aether Brain</h1>
        </div>
        <p className="mb-5 text-[13.5px] leading-relaxed text-dim">
          A local-first second brain you fly through. Notes are neurons, <span className="text-accent2">[[wikilinks]]</span> are synapses, folders are
          constellations, tags are fields, time is an orbit. Markdown files on disk are the only source of truth.
        </p>
        {status === 'loading' && (
          <div className="mb-4" aria-live="polite">
            <div className="flex items-center gap-2 text-[13px] text-dim">
              <span className="spin inline-block h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent" />
              {progress ? `${progress.label}… ${progress.done.toLocaleString()}${progress.total ? ` / ${progress.total.toLocaleString()}` : ''}` : 'Reading vault…'}
            </div>
            {progress && progress.total > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-[width] duration-150" style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }} />
              </div>
            )}
          </div>
        )}
        {status === 'error' && <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-[12.5px] text-danger">{error}</div>}
        <div className="flex flex-col gap-2">
          {sources.map((s) => (
            <button
              type="button"
              key={s.id}
              disabled={!!s.disabledReason || status === 'loading'}
              onClick={() => void s.open()}
              className="group flex items-center gap-3 rounded-xl border border-[var(--panel-border)] bg-black/20 px-4 py-3 text-left transition hover:border-accent/60 hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="flex-1">
                <span className="block text-[14px] font-semibold text-white">{s.label}</span>
                <span className="block text-[12px] text-dim">{s.disabledReason ?? s.description}</span>
              </span>
              <span className="text-faint transition group-hover:text-accent2">→</span>
            </button>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-faint">No accounts. No telemetry. Nothing leaves this machine.</p>
      </div>
    </div>
  )
}
