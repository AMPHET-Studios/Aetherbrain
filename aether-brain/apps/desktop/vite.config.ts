import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** Renderer build. The main process is compiled separately with tsc (tsconfig.main.json). */
export default defineConfig({
  root: r('./src/renderer'),
  // .env.development / .env.production live next to this file, not under the renderer root.
  envDir: r('.'),
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@aether\/ui\/styles\.css$/, replacement: r('../../packages/ui/src/styles.css') },
      { find: /^@aether\/core$/, replacement: r('../../packages/core/src/index.ts') },
      { find: /^@aether\/graph$/, replacement: r('../../packages/graph/src/index.ts') },
      { find: /^@aether\/ui$/, replacement: r('../../packages/ui/src/index.ts') },
    ],
    dedupe: ['three', 'react', 'react-dom', '@react-three/fiber', 'zustand'],
  },
  server: {
    port: 5174,
    strictPort: true,
    fs: { allow: [r('../..')] },
  },
  worker: { format: 'es' },
  build: {
    outDir: r('./dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    // Two pages: the brain window and the reference board's floating window (src/renderer/board.html). Dev serving needs no
    // entry for it: the dev server answers /board.html from the root.
    rolldownOptions: {
      input: {
        index: r('./src/renderer/index.html'),
        board: r('./src/renderer/board.html'),
      },
    },
  },
})
