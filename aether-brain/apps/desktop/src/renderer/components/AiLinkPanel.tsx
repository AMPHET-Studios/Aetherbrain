import { useEffect, useState, type ReactNode } from 'react'
import { useAether } from '@aether/ui'
import type { AetherBridge, AiLinkPatch, AiLinkStatus, TunnelStatusDto } from '../../shared/ipc'
import { ElectronVaultAdapter } from '../vault/electron'
import { activityFailed, clientLabel, errorText, flyToPath, openPanel, useActivity, type FeedItem } from '../panels'
import { CompanionSection } from './CompanionSection'
import { ErrorLine, Overlay, Section } from './Overlay'

const RELEASES = 'https://github.com/YEASTINFECTIONCHEESE/desktop-tutorial/releases'

/**
 * What installs the Claude plugin, typed in a terminal. The marketplace is this repository (its `.claude-plugin/marketplace.json`
 * names the plugin `aether-brain` in a marketplace called `aether-brain`); plugin-install.test.ts keeps this, the docs and that file in step.
 */
const PLUGIN_COMMANDS = 'claude plugin marketplace add YEASTINFECTIONCHEESE/desktop-tutorial\nclaude plugin install aether-brain@aether-brain'

/** The URL shape ChatGPT and claude.ai need: the tunnel's public address + the secret path. */
function tunnelUrlTemplate(token: string): string {
  return `https://<your-tunnel>/mcp/${token}`
}

/** A tunnel that gives the local link a public HTTPS address (prints a *.trycloudflare.com URL). */
function tunnelCommand(port: number): string {
  return `cloudflared tunnel --url http://127.0.0.1:${port}`
}

function masked(url: string, token: string): string {
  return token ? url.replace(token, `${'•'.repeat(10)}${token.slice(-4)}`) : url
}

/** On/off switch in the HUD button style. */
function Switch({ on, label, disabled, onToggle, autoFocus }: { on: boolean; label: string; disabled?: boolean; onToggle: () => void; autoFocus?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`hud-btn ${on ? 'active' : ''}`}
      disabled={disabled}
      onClick={onToggle}
      data-autofocus={autoFocus ? true : undefined}
    >
      <span className={`relative inline-block h-3.5 w-6 rounded-full transition ${on ? 'bg-accent/70' : 'bg-white/15'}`} aria-hidden>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-all ${on ? 'left-3' : 'left-0.5'}`} />
      </span>
      {label}
    </button>
  )
}

/** Copy button that says so for a moment. */
function Copy({ text, what, label = 'Copy' }: { text: string; what: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  const copy = async () => {
    try {
      await ElectronVaultAdapter.bridge()?.copyText(text)
      setDone(true)
    } catch (err) {
      useAether.getState().toast(`Copy failed: ${errorText(err)}`, 'error')
    }
  }
  return (
    <button type="button" className="hud-btn shrink-0" onClick={() => void copy()} aria-label={`Copy ${what}`}>
      {done ? 'Copied ✓' : label}
    </button>
  )
}

/** Monospace block with a copy button beside it; `display` is what shows (e.g. the token masked), `text` what is copied. */
function Snippet({ text, display, what }: { text: string; display?: string; what: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <pre className="scroll max-h-40 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink">
        {display ?? text}
      </pre>
      <Copy text={text} what={what} />
    </div>
  )
}

/** The Portable exe unpacks to a temporary folder that is deleted when it quits: a setup that names its path breaks. */
function PortableWarning({ what }: { what: string }) {
  return (
    <li className="list-none text-inbox">
      ⚠ You are running the Portable exe: it unpacks to a temporary folder that changes every launch and is deleted when the app quits, so {what} stops working.
      Install Aether Brain with the setup exe first, or use the .mcpb.
    </li>
  )
}

/**
 * In place of a setup snippet while no folder vault is open: the server
 * needs at least one --vault folder, and without one it exits at start.
 */
function NeedsVault({ mcpb }: { mcpb?: boolean }) {
  return (
    <p className="mt-1.5 rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 text-[12px] text-inbox">
      Open a vault folder first (<kbd>v</kbd>): this setup names the folders the server reads, and none is open.
      {mcpb ? ' Or use the .mcpb above: it asks for its folders itself.' : ''}
    </p>
  )
}

function Client({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="mb-3 rounded-xl border border-[var(--line)] bg-black/20 px-4 py-3 last:mb-0">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[13.5px] font-semibold text-white">{name}</span>
        {note && <span className="text-[11.5px] text-faint">{note}</span>}
      </div>
      <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-dim marker:text-faint">{children}</ol>
    </div>
  )
}

/**
 * The tunnel for ChatGPT and claude.ai as a button: download cloudflared once (asked first, with what it is and where from), start the
 * tunnel (the link is switched on for it), show the address ready to paste, stop. The state lives in main: it changes by itself too
 * (a tunnel that ends, a download's progress), so this listens.
 */
function TunnelControl({ bridge, token, showToken }: { bridge: AetherBridge; token: string; showToken: boolean }) {
  const [t, setT] = useState<TunnelStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    bridge.tunnelStatus().then(
      (s) => alive && setT(s),
      (err: unknown) => alive && setError(errorText(err)),
    )
    const off = bridge.onTunnelState((s) => alive && setT(s))
    return () => {
      alive = false
      off()
    }
  }, [bridge])

  const run = async (call: () => Promise<TunnelStatusDto>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setT(await call())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!t) return <p className="mt-1.5 text-[12px] text-faint">{error ?? 'Looking for cloudflared…'}</p>
  const problem = error ?? t.error
  const full = t.url ? `${t.url}/mcp/${token}` : ''
  const warning = 'Anyone with this URL can use your brain, including its pictures, until you stop the tunnel.'
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {t.downloading ? (
        <p className="text-[12px] text-dim" aria-live="polite">
          Downloading cloudflared… {Math.min(100, Math.floor((t.downloading.done / t.downloading.total) * 100))}%
        </p>
      ) : t.state === 'on' && t.url ? (
        <>
          <Snippet text={full} display={showToken ? full : masked(full, token)} what="the ChatGPT connection URL" />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="hud-btn" disabled={busy} onClick={() => void run(() => bridge.tunnelStop())}>
              Stop tunnel
            </button>
            <span className="text-[11.5px] leading-relaxed text-inbox">
              A new address can take a few seconds, sometimes a minute or two, before it answers on your network. {warning}
            </span>
          </div>
        </>
      ) : t.state === 'starting' ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-dim" aria-live="polite">
            Starting the tunnel…
          </span>
          <button type="button" className="hud-btn" disabled={busy} onClick={() => void run(() => bridge.tunnelStop())}>
            Cancel
          </button>
        </div>
      ) : t.program ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="hud-btn active" disabled={busy} onClick={() => void run(() => bridge.tunnelStart())}>
            Start tunnel
          </button>
          <span className="text-[11.5px] leading-relaxed text-faint">
            Switches the link on if it is off, then opens the tunnel. {warning}
          </span>
        </div>
      ) : t.download ? (
        asking ? (
          <div className="rounded-lg border border-[var(--line)] bg-black/30 px-3 py-2 text-[12px] leading-relaxed text-dim">
            Download <span className="text-ink">{t.download.file}</span> ({t.download.mb} MB) from {t.download.from} into this app&rsquo;s data folder? The app checks it against a
            checksum it already knows and throws it away if it differs.
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="hud-btn active"
                disabled={busy}
                onClick={() => {
                  setAsking(false)
                  void run(() => bridge.tunnelDownload())
                }}
              >
                Download ({t.download.mb} MB)
              </button>
              <button type="button" className="hud-btn" onClick={() => setAsking(false)}>
                Not now
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="hud-btn" disabled={busy} onClick={() => setAsking(true)}>
              Download cloudflared…
            </button>
            <span className="text-[11.5px] leading-relaxed text-faint">
              The tunnel needs one small program, cloudflared ({t.download.mb} MB). You are asked before anything is downloaded.
            </span>
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] leading-relaxed text-faint">
            The tunnel needs cloudflared on this computer: install it (for example <code className="font-mono text-ink">brew install cloudflared</code>), then check again.
          </span>
          <button type="button" className="hud-btn" disabled={busy} onClick={() => void run(() => bridge.tunnelStatus())}>
            Check again
          </button>
        </div>
      )}
      {problem && (
        <p className="text-[12px] text-danger" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

/** One line of status next to the switches. */
function linkState(st: AiLinkStatus, hasVault: boolean): { text: string; tone: 'ok' | 'off' | 'wait' | 'error' } {
  if (st.running) return { text: `Listening on ${st.host}:${st.port}. Only this computer can reach it (a tunnel can share it).`, tone: 'ok' }
  if (!st.enabled) return { text: 'Off. Claude Desktop and Claude Code work without it; the Claude plugin, ChatGPT and claude.ai need it.', tone: 'off' }
  if (st.error) return { text: 'Not running (see the error above).', tone: 'error' }
  return { text: hasVault ? 'Starting…' : 'Starts once a vault folder is open.', tone: 'wait' }
}

const TONE: Record<'ok' | 'off' | 'wait' | 'error', string> = {
  ok: 'bg-untagged shadow-[0_0_10px_#9dffb3]',
  off: 'bg-faint',
  wait: 'bg-inbox',
  error: 'bg-danger',
}

/** AI link overlay (`a`): let Claude and ChatGPT search, read and write the brain. */
export function AiLinkPanel() {
  const bridge = ElectronVaultAdapter.bridge()
  // A folder vault: the demo is not on disk, and the setups below need real folders.
  const hasVault = useAether((s) => s.adapter instanceof ElectronVaultAdapter)
  // On Windows the Claude Code command is quoted for PowerShell.
  const windows = bridge?.platform === 'win32'
  const activity = useActivity()
  const [st, setSt] = useState<AiLinkStatus | null>(null)
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToken, setShowToken] = useState(false)

  // Status changes on its own (the link starts after a vault loads), so poll while open.
  useEffect(() => {
    if (!bridge) return
    let alive = true
    const load = () =>
      bridge.aiStatus().then(
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
  useEffect(() => {
    if (st) setPort(String(st.port))
  }, [st?.port])

  const configure = async (patch: AiLinkPatch) => {
    if (!bridge || busy) return
    setBusy(true)
    setError(null)
    try {
      setSt(await bridge.aiConfigure(patch))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const applyPort = () => {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) return setError('The port must be a whole number from 1024 to 65535.')
    if (st && n !== st.port) void configure({ port: n })
  }

  const regenerate = () => {
    const ok = window.confirm(
      'Make a new secret token?\n\nEvery connector that uses the old URL (ChatGPT, claude.ai, a running tunnel) stops working until you paste the new URL. Claude Desktop and Claude Code are not affected.',
    )
    if (ok) void configure({ regenerateToken: true })
  }

  const keys = { a: () => openPanel(null), v: () => openPanel('roots') }

  if (!bridge) {
    return (
      <Overlay title="AI link" hint="desktop app only" keys={keys}>
        <p className="text-[12.5px] text-dim">The AI link runs in the Aether Brain desktop app.</p>
      </Overlay>
    )
  }

  const state = st ? linkState(st, hasVault) : null
  const tunnelUrl = st ? tunnelUrlTemplate(st.token) : ''

  return (
    <Overlay title="AI link" hint="Claude and ChatGPT talk to this brain directly" width="w-[780px]" keys={keys}>
      <ErrorLine text={error ?? st?.error} />
      {!st ? (
        <p className="text-[12.5px] text-dim">Loading…</p>
      ) : (
        <>
          <Section title="Link">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Switch on={st.enabled} label={st.enabled ? 'Link on' : 'Link off'} disabled={busy} autoFocus onToggle={() => void configure({ enabled: !st.enabled })} />
              <Switch on={st.readOnly} label="Read-only" disabled={busy} onToggle={() => void configure({ readOnly: !st.readOnly })} />
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  applyPort()
                }}
              >
                <label className="text-[12px] text-dim" htmlFor="ai-port">
                  Port
                </label>
                <input
                  id="ai-port"
                  className="input !w-20 !py-1 !text-[12.5px]"
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                />
                <button type="submit" className="hud-btn" disabled={busy || port === String(st.port)}>
                  Apply
                </button>
              </form>
            </div>
            {state && (
              <div className="mb-3 flex items-center gap-2 text-[12px] text-dim" aria-live="polite">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONE[state.tone]}`} aria-hidden />
                {state.text}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="section-title shrink-0">Local URL</span>
              <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--line)] bg-black/30 px-3 py-1.5 font-mono text-[12px] text-ink" title={showToken ? st.url : undefined}>
                {showToken ? st.url : masked(st.url, st.token)}
              </code>
              <button type="button" className="hud-btn shrink-0" aria-pressed={showToken} onClick={() => setShowToken((v) => !v)}>
                {showToken ? 'Hide' : 'Show'}
              </button>
              <Copy text={st.url} what="the local URL" />
              <button type="button" className="hud-btn shrink-0" disabled={busy} onClick={regenerate}>
                New token…
              </button>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-faint">
              The token in the URL is the password: anyone with the URL can use the brain while the link (and a tunnel) runs.
              {st.readOnly ? ' Read-only: AIs can search and read, not write.' : ' AIs can create and edit notes, tasks and folders; they never delete files.'}
            </p>
          </Section>

          <Section title="Connect">
            <Client name="Claude Desktop" note="runs its own copy of the brain server; this window can stay closed">
              <li>
                Easiest: download <span className="text-ink">aether-brain .mcpb</span> from the{' '}
                <a className="text-accent2 underline-offset-2 hover:underline" href={RELEASES} target="_blank" rel="noreferrer">
                  Releases page
                </a>{' '}
                and double-click it; Claude Desktop installs it and asks which folders to use. Its own <span className="text-ink">Skip these folders</span> setting
                (comma-separated names) is separate from this app's exclusions.
              </li>
              <li>
                Or in Claude Desktop open Settings → Developer → Edit Config, paste this (merge it into <code className="font-mono text-ink">mcpServers</code> if
                the file already has servers), save, and restart Claude Desktop.
                {hasVault ? <Snippet text={st.claudeDesktopConfig} what="the Claude Desktop config" /> : <NeedsVault mcpb />}
              </li>
              {st.portable && <PortableWarning what="this config" />}
            </Client>

            <Client name="Claude Code" note="terminal">
              <li>
                {windows ? 'Run this once in PowerShell (not Command Prompt):' : 'Run this once in a terminal:'}
                {hasVault ? <Snippet text={st.claudeCodeCommand} what="the Claude Code command" /> : <NeedsVault />}
              </li>
              {st.portable && <PortableWarning what="the registered command" />}
              <li className="text-faint">
                The config and the command above hold your vault folders and skipped folders as they are now: copy them again after changing either.
              </li>
              <li>
                Start <code className="font-mono text-ink">claude</code> anywhere and ask about your notes; <code className="font-mono text-ink">/mcp</code> shows the
                link.
              </li>
            </Client>

            <Client name="Claude plugin" note="Claude Code · needs this app open with the link on">
              <li>
                {windows ? 'Run these two lines once in PowerShell' : 'Run these two lines once in a terminal'} (it needs Node.js 20 or newer; inside Claude Code the same two are{' '}
                <code className="font-mono text-ink">/plugin marketplace add …</code> and <code className="font-mono text-ink">/plugin install …</code>):
                <Snippet text={PLUGIN_COMMANDS} what="the plugin commands" />
              </li>
              <li>
                Claude can then send in a screenshot or picture file, look at your pictures and fly this view to things. With the link off or this app closed it says
                so, and the tools appear by themselves once it is on.
              </li>
            </Client>

            <Client name="ChatGPT" note="needs a tunnel: a button gives your brain a public address">
              <li>
                Press Start tunnel. It switches the link on if it is off and gives your brain a public https address ChatGPT can reach; the connection URL
                appears here, ready to copy. A new address comes with every start.
                <TunnelControl bridge={bridge} token={st.token} showToken={showToken} />
              </li>
              <li>In ChatGPT: Settings → Security and login → turn on Developer mode.</li>
              <li>Go to chatgpt.com/plugins → + → Connection: the URL from step 1; Authentication: No authentication.</li>
              <li className="text-faint">
                Rather run the tunnel yourself? Install cloudflared and run this, then use https://&lt;your-tunnel&gt;/mcp/… as the URL:
                <Snippet text={tunnelCommand(st.port)} what="the tunnel command" />
                <Snippet text={tunnelUrl} display={showToken ? tunnelUrl : masked(tunnelUrl, st.token)} what="the ChatGPT connection URL template" />
              </li>
            </Client>

            <Client name="claude.ai (web)" note="same tunnel as ChatGPT">
              <li>Press Start tunnel (ChatGPT step 1).</li>
              <li>In claude.ai: Settings → Connectors → Add custom connector, and paste the same connection URL.</li>
            </Client>
          </Section>

          <CompanionSection bridge={bridge} />

          <Section title="Activity" aside="calls through the link; Claude Desktop's own server shows up as edits">
            <Activity items={activity} />
          </Section>
        </>
      )}
    </Overlay>
  )
}

function Activity({ items }: { items: FeedItem[] }) {
  if (!items.length) {
    return <p className="text-[12px] text-faint">Nothing yet. When Claude or ChatGPT use the link, each call shows up here.</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((a) => {
        const path = a.path
        const failed = activityFailed(a)
        const body = (
          <>
            <span className="w-16 shrink-0 font-mono text-[11px] text-faint">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${failed ? 'bg-danger' : a.write ? 'bg-untagged' : 'bg-faint'}`} aria-hidden />
            <span className="shrink-0 text-ink">{clientLabel(a.client)}</span>
            <span className={`min-w-0 flex-1 truncate ${failed ? 'text-danger' : 'text-dim'}`} title={a.summary || a.tool}>
              {a.summary || a.tool}
            </span>
          </>
        )
        return (
          <li key={a.seq}>
            {path ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-accent/10"
                onClick={() => {
                  openPanel(null)
                  flyToPath(path)
                }}
                title={`Fly to ${path}`}
              >
                {body}
              </button>
            ) : (
              <div className="flex items-center gap-2 px-2 py-1 text-[12px]">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
