import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AetherApp,
  FsAccessVaultAdapter,
  createDemoVault,
  createStressVault,
  resetDemoVault,
  supportsFsAccess,
  useAether,
  type VaultSource,
} from '@aether/ui'
import '@aether/ui/styles.css'

const params = new URLSearchParams(location.search)
const stress = Number(params.get('stress') ?? 0)
const stressEdges = Number(params.get('edges') ?? Math.round(stress * 2.5))

const sources: VaultSource[] = [
  {
    id: 'demo',
    label: 'Open the demo vault',
    description: '60 linked notes about drawing, game dev, graphics and knowledge work. Edits persist in this browser.',
    open: async () => useAether.getState().openVault(await createDemoVault()),
  },
  {
    id: 'folder',
    label: 'Open a folder on this computer',
    description: 'Your own markdown vault, read and written in place (Chromium browsers).',
    ...(supportsFsAccess ? {} : { disabledReason: 'Needs the File System Access API (Chrome / Edge) — or use the desktop app.' }),
    open: async () => {
      const a = await FsAccessVaultAdapter.pick()
      if (a) await useAether.getState().openVault(a)
    },
  },
  {
    id: 'stress',
    label: 'Stress test · 1,000 neurons / 2,500 synapses',
    description: 'Synthetic vault for checking the 60 fps budget. Also: ?stress=2000&edges=6000',
    open: () => useAether.getState().openVault(createStressVault(stress || 1000, stressEdges || 2500)),
  },
  {
    id: 'reset',
    label: 'Reset demo vault',
    description: 'Forget local edits to the bundled demo.',
    open: async () => {
      await resetDemoVault()
      await useAether.getState().openVault(await createDemoVault())
    },
  },
]

const autoOpen = stress > 0 ? 'stress' : params.has('demo') || params.get('vault') === 'demo' ? 'demo' : undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AetherApp sources={sources} autoOpen={autoOpen} onPickVault={() => useAether.setState({ status: 'idle' })} />
  </StrictMode>,
)
