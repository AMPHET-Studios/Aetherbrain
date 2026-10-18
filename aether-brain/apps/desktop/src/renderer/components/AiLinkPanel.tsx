import { useEffect, useState, type ReactNode } from 'react'
import { useAether } from '@aether/ui'
import type { AiLinkPatch, AiLinkStatus } from '../../shared/ipc'
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

            <Client name="ChatGPT" note="needs the link on and a tunnel">
              <li>Switch the link on (above).</li>
              <li>
                Give it a public HTTPS address: install cloudflared and run this; it prints an https://…trycloudflare.com address.
                <Snippet text={tunnelCommand(st.port)} what="the tunnel command" />
              </li>
              <li>In ChatGPT: Settings → Security and login → turn on Developer mode.</li>
              <li>
                Go to chatgpt.com/plugins → + → Connection: this URL with &lt;your-tunnel&gt; replaced by the address from step 2; Authentication: No
                authentication.
                <Snippet text={tunnelUrl} display={showToken ? tunnelUrl : masked(tunnelUrl, st.token)} what="the ChatGPT connection URL" />
              </li>
            </Client>

            <Client name="claude.ai (web)" note="same tunnel as ChatGPT">
              <li>Switch the link on and run the tunnel (ChatGPT steps 1–2).</li>
              <li>In claude.ai: Settings → Connectors → Add custom connector, and paste the same https://&lt;your-tunnel&gt;/mcp/… URL.</li>
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
