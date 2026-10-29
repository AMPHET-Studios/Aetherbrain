// The PDF half of the thumbnail helper's page (see src/main/thumbnailer.ts, "PDF"). The helper's preload cannot load a library, so the
// page does: this module runs pdf.js on the bytes the preload posts and posts back the first page's pixels. It is served, with pdf.js and
// its worker, by the helper session's `aether-pdf` scheme and by nothing else; the session refuses every other request, so a document
// that asks for a font, an image or a link outside itself gets nothing. Plain JavaScript on purpose: it is copied, not compiled.
import * as pdfjs from './pdf.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.mjs', import.meta.url).href

/** Most pixels a rendered page may have: a poster-sized page is drawn at the size asked for, never at its own. */
const MAX_SIDE = 1024

async function render(bytes, px) {
  const side = Math.max(1, Math.min(MAX_SIDE, Math.floor(px)))
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    // A document is data here: no scripts, no forms, no XFA, no fetching more of itself, no eval, no font or cmap files to load.
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    useSystemFonts: true,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    const page = await doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const scale = side / Math.max(base.width, base.height)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.round(viewport.width))
    const height = Math.max(1, Math.round(viewport.height))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    // A page has no background of its own: paper is white.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    await page.render({ canvasContext: ctx, canvas, viewport }).promise
    const image = ctx.getImageData(0, 0, width, height)
    return { width, height, buffer: image.data.buffer }
  } finally {
    await task.destroy()
  }
}

window.addEventListener('message', (event) => {
  const m = event.data
  if (event.source !== window || !m || m.aether !== 'pdf' || typeof m.id !== 'number') return
  render(m.bytes, m.px).then(
    (out) => window.postMessage({ aether: 'pdf-done', id: m.id, ...out }, '*', [out.buffer]),
    () => window.postMessage({ aether: 'pdf-done', id: m.id, buffer: null }, '*'),
  )
})

window.postMessage({ aether: 'pdf-ready' }, '*')
