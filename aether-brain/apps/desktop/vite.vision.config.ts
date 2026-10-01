import { defaultClientConditions, defineConfig, type Plugin } from 'vite'
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/** The ONNX runtime files transformers.js loads (its default build, `.asyncify`), resolved the way it resolves them. */
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']

/**
 * Ships the ONNX runtime's WebAssembly next to the page (dist/vision/ort/):
 * transformers.js would otherwise fetch it from a CDN, and the helper has no
 * network.
 */
function shipOrt(outDir: string): Plugin {
  return {
    name: 'aether-ship-ort',
    apply: 'build',
    closeBundle() {
      const transformers = realpathSync(r('./node_modules/@huggingface/transformers'))
      const req = createRequire(path.join(transformers, 'package.json'))
      mkdirSync(path.join(outDir, 'ort'), { recursive: true })
      for (const f of ORT_FILES) copyFileSync(req.resolve(`onnxruntime-web/${f}`), path.join(outDir, 'ort', f))
    },
  }
}

/**
 * The librarian's vision helper page (see src/main/library/vision.ts):
 * dist/vision/index.html, its script with transformers.js bundled, and the
 * ONNX runtime. Loaded only by the hidden helper, from its own scheme.
 */
export default defineConfig({
  root: r('./src/vision'),
  base: './',
  publicDir: false,
  logLevel: 'warn',
  plugins: [shipOrt(r('./dist/vision'))],
  resolve: {
    // The ONNX runtime build that loads its WebAssembly from wasmPaths (our copy) instead of
    // bundling a second one of its own.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  build: {
    outDir: r('./dist/vision'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 4000,
  },
})
