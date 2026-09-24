import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AetherApp, createDemoVault, useAether, type VaultSource } from '@aether/ui'
import '@aether/ui/styles.css'
import { ElectronVaultAdapter } from './vault/electron'

const hasBridge = !!ElectronVaultAdapter.bridge()

const sources: VaultSource[] = [
  {
    id: 'folder',
    label: 'Open a vault folder…',
    description: 'A folder of markdown notes on this computer. Files are read and written in place and watched for changes.',
    ...(hasBridge ? {} : { disabledReason: 'Electron bridge not available (are you running the renderer in a plain browser?).' }),
    open: async () => {
      const a = await ElectronVaultAdapter.pick()
      if (a) await useAether.getState().openVault(a)
    },
  },
  {
    id: 'demo',
    label: 'Open the demo vault',
    description: '60 linked starter notes. Edits persist locally; nothing touches your disk.',
    open: async () => useAether.getState().openVault(await createDemoVault()),
  },
]

async function boot() {
  const root = createRoot(document.getElementById('root')!)
  root.render(
    <StrictMode>
      <AetherApp sources={sources} onPickVault={() => useAether.setState({ status: 'idle' })} />
    </StrictMode>,
  )
  // Reopen the last vault automatically.
  const last = await ElectronVaultAdapter.last()
  if (last) {
    const a = await ElectronVaultAdapter.open(last)
    if (a) await useAether.getState().openVault(a)
  }
}

void boot()
