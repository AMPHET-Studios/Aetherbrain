
import { StrictMode, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { BoardView } from '/home/user/desktop-tutorial/aether-brain/packages/ui/src/board/BoardView.tsx'
import { getActiveBoard } from '/home/user/desktop-tutorial/aether-brain/packages/ui/src/board/active.ts'
import '/home/user/desktop-tutorial/aether-brain/packages/ui/src/styles.css'

type Json = Record<string, any>
const w = window as any

function colourOf(path: string): string {
  let n = 0
  for (const c of path) n = (n * 31 + c.charCodeAt(0)) >>> 0
  return 'hsl(' + (n % 360) + ' 70% 50%)'
}
async function png(width: number, height: number, fill: string): Promise<Blob> {
  const c = new OffscreenCanvas(width, height)
  const g = c.getContext('2d')!
  g.fillStyle = fill
  g.fillRect(0, 0, width, height)
  return c.convertToBlob({ type: 'image/png' })
}
w.makePng = async (width: number, height: number, fill: string) => new Uint8Array(await (await png(width, height, fill)).arrayBuffer())

// Every decode the page makes, by the size of the blob: the picture that claims a gigabyte must never be one of them.
w.__decodes = [] as number[]
const realCib = window.createImageBitmap.bind(window)
;(window as any).createImageBitmap = (...args: any[]) => {
  const src = args[0]
  if (src && typeof src.size === 'number') w.__decodes.push(src.size)
  return (realCib as any)(...args)
}

let root: ReturnType<typeof createRoot> | null = null

w.mount = async (cfg: Json) => {
  const H: Json = {
    saves: [] as string[],
    toasts: [] as { text: string; action?: string }[],
    toastActions: [] as (() => void)[],
    added: [] as string[],
    opens: [] as string[],
    copied: [] as string[],
    windowCalls: [] as string[],
    globalKeys: [] as string[],
    pastes: 0,
    raw: cfg.raw as string,
    files: new Map<string, Uint8Array>(),
    external: new Set<() => void>(),
    pictureSubs: new Set<() => void>(),
  }
  const assets: { path: string; mtime: number }[] = cfg.assets ?? []
  const small = await w.makePng(64, 48, '#336699')
  // A picture of the vault is drawn in a colour of its name; one that was dropped is shown as a small stand-in (the preview the
  // helper window would make), so that only the header read of the dropped file can be what costs anything.
  const make = async (p: string, px: number) => {
    if (!H.files.has(p)) return png(Math.min(200, px), Math.min(100, px), colourOf(p))
    return new Blob([small], { type: 'image/png' })
  }
  const win = cfg.window
    ? { floating: !!cfg.window.floating, alwaysOnTop: true, opacity: 1, supportsOpacity: true,
        popOut() { H.windowCalls.push('popOut') }, dock() { H.windowCalls.push('dock') },
        setAlwaysOnTop(on: boolean) { H.windowCalls.push('onTop:' + on); this.alwaysOnTop = on },
        setOpacity(o: number) { H.windowCalls.push('opacity:' + o); this.opacity = o } }
    : undefined
  const host: Json = {
    path: 'Boards/Gate.md',
    title: 'Gate',
    async load() { return H.raw },
    async save(raw: string, expectedBase?: string) {
      if (expectedBase !== undefined && expectedBase !== H.raw) throw new Error('The board was changed outside the board view')
      H.saves.push(raw)
      H.raw = raw
    },
    onExternalChange(cb: () => void) { H.external.add(cb); return () => H.external.delete(cb) },
    pictures: {
      async preview(p: string, px: number) { return make(p, px) },
      async original(p: string) { return make(p, 99999) },
      async add(files: { name: string; data: Uint8Array }[]) {
        return files.map((f) => { const p = 'Boards/Gate/' + f.name; H.files.set(p, f.data); H.added.push(f.name); return p })
      },
      async list() { return assets },
      exists: () => true,
      open: (p: string) => H.opens.push(p),
      reveal: (p: string) => H.opens.push('reveal:' + p),
      showInBrain: (p: string) => H.opens.push('brain:' + p),
      onChange(cb: () => void) { H.pictureSubs.add(cb); return () => H.pictureSubs.delete(cb) },
    },
    toast: (text: string, _tone?: string, action?: { label: string; run(): void }) => { H.toasts.push({ text, action: action?.label }); if (action) H.toastActions.push(action.run) },
    copyText: async (t: string) => { H.copied.push(t) },
    window: win,
  }
  w.H = H
  w.host = host
  window.addEventListener('keydown', (e) => { if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) H.globalKeys.push(e.key) })
  document.addEventListener('paste', () => { H.pastes++ })
  const el = document.getElementById('root')!
  root = createRoot(el)
  root.render(h(StrictMode, null, h(BoardView, { host: host as never, className: 'absolute inset-0' })))
}
w.unmount = () => { root?.unmount(); root = null }
w.active = () => getActiveBoard()
w.items = () => (getActiveBoard()?.state().doc.items ?? []) as any[]
w.state = () => getActiveBoard()?.state()
