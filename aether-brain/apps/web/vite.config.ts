import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@aether\/ui\/styles\.css$/, replacement: r('../../packages/ui/src/styles.css') },
      { find: /^@aether\/core$/, replacement: r('../../packages/core/src/index.ts') },
      { find: /^@aether\/graph$/, replacement: r('../../packages/graph/src/index.ts') },
      { find: /^@aether\/ui$/, replacement: r('../../packages/ui/src/index.ts') },
    ],
    // One copy of three/react across the workspace.
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber', 'zustand'],
  },
  server: {
    fs: { allow: [r('../..')] },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
})
