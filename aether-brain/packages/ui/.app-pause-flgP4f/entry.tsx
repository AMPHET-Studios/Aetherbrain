
import '/home/user/desktop-tutorial/aether-brain/packages/ui/src/styles.css'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryVaultAdapter, newBoardNote } from '@aether/core'
import { useAether } from '/home/user/desktop-tutorial/aether-brain/packages/ui/src/store.ts'
import { AetherApp } from '/home/user/desktop-tutorial/aether-brain/packages/ui/src/App.tsx'

const files = [
  { path: 'Inbox/Idea.md', content: '# Idea\n\nA note about a gate. [[Gate]]\n' },
  { path: 'Inbox/Gate.md', content: '# Gate\n\nThe gate.\n' },
  { path: 'Boards/Reference.md', content: newBoardNote('Reference', new Date('2026-10-01T10:00:00')) },
]
const vault = new MemoryVaultAdapter(files, { name: 'A rather long vault name here' })
const w = window as unknown as Record<string, unknown>
w.app = { useAether }
w.ready = (async () => {
  createRoot(document.getElementById('root')!).render(h(AetherApp, { sources: [] }))
  await useAether.getState().openVault(vault)
})()
