import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const pkg = JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string }

/**
 * The AI link's MCP server as one self-contained ESM file for Node:
 * dist/mcp/aether-mcp.mjs. Electron main imports it for the in-app link;
 * Claude Desktop (.mcpb), Claude Code and a terminal run it directly. Every
 * dependency is bundled (only node: built-ins stay imports), so it runs from
 * any folder without node_modules.
 */
export default defineConfig({
  root: r('.'),
  publicDir: false,
  logLevel: 'warn',
  define: {
    __AETHER_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: [{ find: /^@aether\/core$/, replacement: r('../../packages/core/src/index.ts') }],
  },
  ssr: {
    noExternal: true,
    target: 'node',
  },
  build: {
    ssr: r('./src/mcp/server.ts'),
    outDir: r('./dist/mcp'),
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    sourcemap: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        format: 'es',
        entryFileNames: 'aether-mcp.mjs',
        // Some bundled CommonJS code calls require() for Node built-ins; give it a real one.
        banner: "import { createRequire as __aetherCreateRequire } from 'node:module';\nconst require = __aetherCreateRequire(import.meta.url);",
      },
    },
  },
})
