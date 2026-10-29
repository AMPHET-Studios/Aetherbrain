// Copies what the thumbnail helper's PDF page serves to dist/pdfjs: pdf.js (the minified build), its worker and our host module.
// Run by `build:main`. The helper's `aether-pdf` scheme serves exactly these three names and nothing else.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const require = createRequire(import.meta.url)
const lib = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build')
const out = path.join(root, 'dist', 'pdfjs')
mkdirSync(out, { recursive: true })
copyFileSync(path.join(lib, 'pdf.min.mjs'), path.join(out, 'pdf.mjs'))
copyFileSync(path.join(lib, 'pdf.worker.min.mjs'), path.join(out, 'pdf.worker.mjs'))
copyFileSync(path.join(root, 'src', 'pdf-host', 'host.mjs'), path.join(out, 'host.mjs'))
console.log('pdfjs copied to', out)
