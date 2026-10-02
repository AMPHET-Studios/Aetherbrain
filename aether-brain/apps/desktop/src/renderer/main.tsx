import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AetherApp, createDemoVault, registerCommands, registerHelpRows, registerKey, useAether, type VaultSource } from '@aether/ui'
import '@aether/ui/styles.css'
import type { AiActivityDto } from '../shared/ipc'
import { ElectronVaultAdapter } from './vault/electron'
import { RootsPanel } from './components/RootsPanel'
import { AiLinkPanel } from './components/AiLinkPanel'
import { ChatPanel, registerChat } from './components/ChatPanel'
import { LibraryPanel, registerLibrary } from './components/LibraryPanel'
import { activityFailed, clientLabel, errorText, flyToPath, openPanel, pushActivity, samePath, togglePanel, usePanel } from './panels'
import { useForgeScreen } from './forge'
import './companion'

const bridge = ElectronVaultAdapter.bridge()
const isWindows = bridge?.platform === 'win32'

const sources: VaultSource[] = [
  {
    id: 'folder',
    label: 'Open a vault folder…',
    description: 'A folder of markdown notes on this computer. Files are read and written in place and watched for changes.',
    ...(bridge ? {} : { disabledReason: 'Electron bridge not available (are you running the renderer in a plain browser?).' }),
    open: async () => {
      try {
        const a = await ElectronVaultAdapter.pick()
        if (a) await useAether.getState().openVault(a)
      } catch (err) {
        useAether.setState({ status: 'error', error: errorText(err) })
      }
    },
  },
  ...(isWindows
    ? [
        {
          id: 'drives',
          label: 'Mirror whole drives…',
          description: 'Tick drives such as D:\\ and F:\\ and fly through their real folder tree as one brain: drives are suns, folders planets.',
          open: () => openPanel('drives'),
        },
      ]
    : []),
  {
    id: 'demo',
    label: 'Open the demo vault',
    description: '70 linked starter notes. Edits persist locally; nothing touches your disk.',
    open: async () => useAether.getState().openVault(await createDemoVault()),
  },
]

/** Desktop keys, palette commands and cheatsheet rows (the panels need the Electron bridge). */
function registerDesktopKeys(): void {
  if (!bridge) return
  registerKey('v', () => togglePanel('roots'))
  registerKey('a', () => togglePanel('ai'))
  registerCommands([
    { id: 'vault-folders', title: 'Vault folders: add folders or drives, skip folders, rescan…', keys: 'v', group: 'vault', run: () => openPanel('roots') },
    { id: 'ai-link', title: 'AI link: connect Claude and ChatGPT…', keys: 'a', group: 'vault', run: () => openPanel('ai') },
    ...(isWindows ? [{ id: 'mirror-drives', title: 'Mirror whole drives…', group: 'vault' as const, run: () => openPanel('drives') }] : []),
  ])
  registerHelpRows('Desktop', [
    ['v', 'Vault folders: add folders or whole drives'],
    ['a', 'AI link: Claude & ChatGPT'],
  ])
}

let lastReadToast = 0

/** An AI tool call through the link: feed + toast; writes select and fly to what they touched. */
function onAiActivity(a: AiActivityDto): void {
  pushActivity(a)
  const s = useAether.getState()
  const who = clientLabel(a.client)
  if (a.write && activityFailed(a)) {
    // Nothing changed on disk: say so, and leave the camera alone.
    s.toast(`${who}: ${a.summary}`, 'error')
  } else if (a.write) {
    s.toast(`${who} ${a.summary || a.tool}`, 'success')
    // Never yank the camera away from a note being typed.
    if (a.path && !s.dirty) flyToPath(a.path)
  } else if (Date.now() - lastReadToast > 8000) {
    // Reads come in bursts; one toast now and then says the link is in use.
    lastReadToast = Date.now()
    s.toast(`${who} ${a.summary || a.tool}`, 'info')
  }
}

/** Above the toasts while the Concept Forge star's live screen is in view (the screen fills the top): how to draw on it. */
function ForgeScreenHint() {
  const shown = useForgeScreen()
  if (!shown) return null
  return (
    <div className="panel rise pointer-events-none fixed bottom-[64px] left-1/2 z-[30] -translate-x-1/2 px-3 py-1.5 text-[12px] text-dim" role="status">
      <span className="text-ink">★ Concept Forge · live</span> — <kbd>Enter</kbd> or click the screen to draw
    </div>
  )
}

/** The vault name in the top bar opens the vault folders panel (the welcome screen outside Electron). */
const onPickVault = bridge ? () => openPanel('roots') : () => useAether.setState({ status: 'idle' })

function Desktop() {
  const panel = usePanel()
  return (
    <>
      <AetherApp sources={sources} onPickVault={onPickVault} />
      {(panel === 'roots' || panel === 'drives') && <RootsPanel mode={panel} />}
      {panel === 'ai' && <AiLinkPanel />}
      {panel === 'library' && <LibraryPanel />}
      <ChatPanel />
      <ForgeScreenHint />
    </>
  )
}

async function boot() {
  // Main-process progress (directory scan + file reads) feeds the welcome screen.
  bridge?.onProgress((p) => {
    if (p.done) return
    useAether.getState().setLoadProgress(
      p.phase === 'scanning'
        ? { label: `Scanning folders (${p.dirs.toLocaleString()}) · notes found`, done: p.found, total: 0 }
        : { label: 'Reading notes', done: p.files, total: p.found },
    )
  })
  bridge?.onAiActivity(onAiActivity)
  registerDesktopKeys()
  registerChat()
  registerLibrary()
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <Desktop />
    </StrictMode>,
  )
  // Reopen the last vault (CLI, AETHER_VAULT or the remembered roots) automatically.
  const last = await ElectronVaultAdapter.last()
  if (!last) return
  try {
    const a = await ElectronVaultAdapter.open(last)
    if (!a) return
    const skipped = last.filter((r) => !a.roots.some((x) => samePath(x.path, r, bridge?.platform ?? '')))
    await useAether.getState().openVault(a)
    if (skipped.length) useAether.getState().toast(`Not reachable right now, skipped: ${skipped.join(', ')}`, 'info')
  } catch (err) {
    useAether.setState({ status: 'error', error: `Could not reopen ${last.join(' + ')}: ${errorText(err)}` })
  }
}

void boot()
