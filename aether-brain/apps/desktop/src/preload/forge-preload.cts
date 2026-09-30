/// <reference lib="dom" />
/**
 * Preload of the Concept Forge window (sandboxed, context-isolated). Exposes
 * `window.aetherForge` to the user's concept-forge.html and, once its DOM is
 * there, adds the link's own UI to the page: a "🪐 Save to Brain" button
 * (Ctrl+Shift+B) and a small dialog that files the drawing and its grade into
 * a project's Critique planet. That UI runs in the page's main world (it
 * reads the page's canvases and grade), so it is one self-contained function,
 * forgeLinkMain, sent as source text.
 * (CommonJS on purpose — Electron preloads run in a sandbox that loads CJS.)
 */
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AetherForgeBridge, ForgeProjectDto, ForgeSaveDto, ForgeSaveResult } from '../shared/ipc'

/** Same channels as `IPC` in shared/ipc.ts (a sandboxed preload cannot import it at runtime). */
const IPC = {
  forgeProjects: 'forge:win:projects',
  forgeSave: 'forge:win:save',
} as const

/** The message alone, without Electron's "Error invoking remote method …" wrapper. */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '')
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    throw new Error(errorText(err))
  }
}

/** Main passes the app version as `--aether-forge-version=…`. */
const versionArg = process.argv.find((a) => a.startsWith('--aether-forge-version='))

const bridge: AetherForgeBridge = {
  projects: () => call<ForgeProjectDto[]>(IPC.forgeProjects),
  save: (dto: ForgeSaveDto) => call<ForgeSaveResult>(IPC.forgeSave, dto),
  version: versionArg ? versionArg.slice(versionArg.indexOf('=') + 1) : '',
}

contextBridge.exposeInMainWorld('aetherForge', bridge)

/**
 * The page side of the link. It runs in the page's main world from its
 * source text, so it uses nothing from this module, and it must never break
 * the page: everything is guarded, its UI lives in a closed shadow root, its
 * only global is `__aetherForgeLink`, and it takes no key but Ctrl+Shift+B
 * (Concept Forge's own Space, n, b, e, [, ], g, r, l, Ctrl+Z/Y stay the page's).
 */
function forgeLinkMain(): void {
  type Grade = Record<string, unknown>
  interface Shot {
    canvas: HTMLCanvasElement
    png: Uint8Array
  }
  interface Layer {
    el: HTMLCanvasElement
    rect: DOMRect
    score: number
  }

  const PROJECT_KEY = 'aetherForge.project'
  const GRADE_NAMES = ['lastGrade', 'LAST_GRADE', 'currentGrade', 'gradeResult', 'lastResult']
  const MAX_GRADE_BYTES = 256 * 1024
  /** Nesting levels of objects / arrays kept from a grade. */
  const MAX_DEPTH = 6
  const MAX_PNG = 40 * 1024 * 1024
  const MAX_TITLE = 200
  // Canvas ids / classes, word by word (`drawCanvas`, `grid-overlay`): a drawing
  // layer is preferred, overlays and widgets are never part of the drawing.
  const PREFER = /^(draw|paint|art|main|canvas|board|sketch)/
  const AVOID = /^(overlay|grid|guide|cursor|preview|thumb|ring|meter|hud|ui|gui)/

  const w = window as Window & { aetherForge?: AetherForgeBridge; __aetherForgeLink?: boolean }
  try {
    const bridge = w.aetherForge
    if (w.__aetherForgeLink || !bridge || typeof bridge.projects !== 'function' || typeof bridge.save !== 'function') return
    Object.defineProperty(w, '__aetherForgeLink', { value: true })

    /* ---------------- capture: the drawing as the page shows it ---------------- */

    const wordsOf = (el: Element): string[] =>
      `${el.id} ${el.getAttribute('class') ?? ''}`
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)

    /** On-screen area of a shown element, or 0. */
    const shownArea = (el: Element, r: DOMRect): number => {
      if (r.width < 2 || r.height < 2) return 0
      const vw = Math.min(r.right, innerWidth) - Math.max(r.left, 0)
      const vh = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)
      if (vw <= 0 || vh <= 0) return 0
      if (typeof el.checkVisibility === 'function') {
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return 0
      } else {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return 0
      }
      return vw * vh
    }

    /** The drawing canvas (largest shown, drawing-like names count 4×) and the layers stacked exactly on it, in DOM order. */
    const findLayers = (): { main: Layer; stack: Layer[] } | null => {
      const found: Layer[] = []
      for (const el of Array.from(document.querySelectorAll('canvas'))) {
        if (!el.width || !el.height) continue
        const words = wordsOf(el)
        if (words.some((x) => AVOID.test(x))) continue
        const rect = el.getBoundingClientRect()
        const area = shownArea(el, rect)
        if (area > 0) found.push({ el, rect, score: area * (words.some((x) => PREFER.test(x)) ? 4 : 1) })
      }
      let main: Layer | null = null
      for (const l of found) if (!main || l.score > main.score) main = l
      if (!main) return null
      const m = main.rect
      const near = (a: number, b: number) => Math.abs(a - b) <= 2
      const stack = found.filter((l) => near(l.rect.left, m.left) && near(l.rect.top, m.top) && near(l.rect.width, m.width) && near(l.rect.height, m.height))
      return { main, stack }
    }

    const probe = document.createElement('canvas')
    probe.width = probe.height = 1
    const probeCtx = probe.getContext('2d', { willReadFrequently: true })
    /** True when a CSS color paints anything (any syntax the page's CSS can compute to). */
    const paints = (color: string): boolean => {
      if (!probeCtx || !color) return false
      probeCtx.clearRect(0, 0, 1, 1)
      probeCtx.fillStyle = 'rgba(0, 0, 0, 0)'
      probeCtx.fillStyle = color
      probeCtx.fillRect(0, 0, 1, 1)
      return (probeCtx.getImageData(0, 0, 1, 1).data[3] ?? 0) > 0
    }
    /** The first background color that paints, from the canvas up to <html>. */
    const backgroundOf = (el: Element): string | null => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = getComputedStyle(e).backgroundColor
        if (paints(bg)) return bg
      }
      return null
    }

    /** The layers flattened over the page's background (white when it has none), at the drawing's own resolution. */
    const compose = (main: Layer, stack: Layer[]): HTMLCanvasElement => {
      const out = document.createElement('canvas')
      out.width = main.el.width
      out.height = main.el.height
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('This drawing is too large to capture')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
      const bg = backgroundOf(main.el)
      if (bg) {
        ctx.fillStyle = bg
        ctx.fillRect(0, 0, out.width, out.height)
      }
      for (const l of stack) ctx.drawImage(l.el, 0, 0, out.width, out.height)
      return out
    }

    const toPng = (c: HTMLCanvasElement): Promise<Blob> =>
      new Promise((resolve, reject) => {
        try {
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('This drawing is too large to capture'))), 'image/png')
        } catch (err) {
          reject(err)
        }
      })

    const isSecurityError = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'SecurityError'

    const capture = async (): Promise<Shot> => {
      const found = findLayers()
      if (!found) throw new Error('No drawing found: this page shows no canvas')
      let canvas = compose(found.main, found.stack)
      let blob: Blob
      try {
        blob = await toPng(canvas)
      } catch (err) {
        if (!isSecurityError(err) || found.stack.length < 2) throw err
        // Another layer holds a picture from the web (a reference): the drawing layer alone.
        canvas = compose(found.main, [found.main])
        blob = await toPng(canvas)
      }
      return { canvas, png: new Uint8Array(await blob.arrayBuffer()) }
    }

    /* ---------------- grade: the page's own, as plain JSON ---------------- */

    const utf8 = (s: string): number => {
      let n = 0
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        n += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 2 : 3
      }
      return n
    }

    /** Page objects that are not data (DOM, events, binary, collections JSON can't hold). */
    const hostObject = (v: object): boolean =>
      v === w ||
      (typeof Node === 'function' && v instanceof Node) ||
      (typeof Event === 'function' && v instanceof Event) ||
      ArrayBuffer.isView(v) ||
      v instanceof ArrayBuffer ||
      v instanceof Map ||
      v instanceof Set ||
      v instanceof WeakMap ||
      v instanceof WeakSet ||
      v instanceof Promise ||
      v instanceof RegExp ||
      (typeof Blob === 'function' && v instanceof Blob)

    /** A JSON-safe copy within `limit` bytes: functions, DOM and cycles dropped, ≤ MAX_DEPTH levels, long text cut. */
    const cloneWithin = (root: unknown, limit: number): unknown => {
      let left = limit
      const ancestors: object[] = []
      const walk = (v: unknown, depth: number): unknown => {
        if (left <= 0) return undefined
        if (v === null) {
          left -= 4
          return null
        }
        if (typeof v === 'string') {
          let s = v
          let cost = utf8(JSON.stringify(s))
          // Too long for what is left: cut it until it fits (a few rounds, each by the overshoot).
          while (cost > left && s.length) {
            s = s.slice(0, Math.floor((s.length * Math.max(0, left - 2)) / cost))
            cost = utf8(JSON.stringify(s))
          }
          left -= cost
          return s
        }
        if (typeof v === 'number') {
          const n = Number.isFinite(v) ? v : null
          left -= n === null ? 4 : String(n).length
          return n
        }
        if (typeof v === 'boolean') {
          left -= 5
          return v
        }
        if (typeof v !== 'object' || depth >= MAX_DEPTH || ancestors.includes(v) || hostObject(v)) return undefined
        const toJSON = (v as { toJSON?: unknown }).toJSON
        // A Date becomes its ISO text, like JSON.stringify does.
        if (typeof toJSON === 'function') return walk(toJSON.call(v), depth + 1)
        ancestors.push(v)
        try {
          left -= 2
          if (Array.isArray(v)) {
            const out: unknown[] = []
            for (let i = 0; i < v.length && left > 0; i++) {
              let x: unknown
              try {
                x = walk(v[i], depth + 1)
              } catch {
                x = undefined
              }
              out.push(x === undefined ? null : x)
              left -= 1
            }
            return out
          }
          const out: Record<string, unknown> = {}
          for (const k of Object.keys(v)) {
            if (left <= 0) break
            let x: unknown
            try {
              x = walk((v as Record<string, unknown>)[k], depth + 1)
            } catch {
              continue
            }
            if (x === undefined) continue
            left -= utf8(JSON.stringify(k)) + 1
            // defineProperty: a key named __proto__ stays a plain key.
            Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true })
          }
          return out
        } finally {
          ancestors.pop()
        }
      }
      try {
        return walk(root, 0)
      } catch {
        return undefined
      }
    }

    /** A JSON-safe grade of at most 256 KB, or null. */
    const cloneGrade = (v: unknown): Grade | null => {
      for (let limit = MAX_GRADE_BYTES - 1024; limit >= 4096; limit = Math.floor(limit / 2)) {
        const out = cloneWithin(v, limit)
        if (!out || typeof out !== 'object' || Array.isArray(out) || !Object.keys(out).length) return null
        if (utf8(JSON.stringify(out)) <= MAX_GRADE_BYTES) return out as Grade
      }
      return null
    }

    /** An object, or the last object of an array (a grade history). */
    const lastObject = (v: unknown): unknown => {
      if (!Array.isArray(v)) return v && typeof v === 'object' ? v : null
      for (let i = v.length - 1; i >= 0; i--) {
        const x: unknown = v[i]
        if (x && typeof x === 'object' && !Array.isArray(x)) return x
      }
      return null
    }

    /** A global of the page by name: indirect eval also sees a classic script's top-level `let` / `const`. */
    const readGlobal = (name: string): unknown => {
      try {
        return (0, eval)(`typeof ${name} !== 'undefined' ? ${name} : undefined`)
      } catch {
        // A CSP without 'unsafe-eval': plain window properties still work.
      }
      try {
        return (w as unknown as Record<string, unknown>)[name]
      } catch {
        return undefined
      }
    }

    const readGrade = (): Grade | null => {
      for (const name of GRADE_NAMES) {
        const g = cloneGrade(lastObject(readGlobal(name)))
        if (g) return g
      }
      try {
        const ls = w.localStorage
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i)
          if (!key || !/grade/i.test(key)) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(ls.getItem(key) ?? '')
          } catch {
            continue
          }
          const g = cloneGrade(lastObject(parsed))
          if (g) return g
        }
      } catch {
        // Storage blocked: no grade history.
      }
      return null
    }

    /** First usable value of `keys` (compared lowercase without `_`, `-`, spaces) on the grade or one level inside it. */
    const pick = <T,>(g: Grade | null, keys: string[], accept: (v: unknown) => T | null): T | null => {
      if (!g) return null
      const layers: Grade[] = [g]
      for (const v of Object.values(g)) if (v && typeof v === 'object' && !Array.isArray(v)) layers.push(v as Grade)
      for (const layer of layers) {
        const byKey = new Map<string, unknown>()
        for (const k of Object.keys(layer)) byKey.set(k.toLowerCase().replace(/[\s_-]/g, ''), layer[k])
        for (const k of keys) {
          const got = byKey.has(k) ? accept(byKey.get(k)) : null
          if (got !== null) return got
        }
      }
      return null
    }
    const letterOf = (v: unknown): string | null => {
      const t = typeof v === 'string' ? v.trim().toUpperCase() : ''
      return /^[A-F][+-]?$/.test(t) ? t : null
    }
    const scoreOf = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
      if (!Number.isFinite(n) || n < 0) return null
      const s = n > 0 && n <= 1 && !Number.isInteger(n) ? n * 100 : n
      return s <= 100 ? Math.round(s) : null
    }
    const clean = (t: string): string | null => {
      const s = t.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim()
      return s && s.length <= 60 ? s : null
    }
    const nameOf = (v: unknown): string | null => {
      if (typeof v === 'string') return clean(v)
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        for (const k of ['name', 'title', 'label']) if (typeof o[k] === 'string') return clean(o[k] as string)
      }
      return null
    }

    /** The drill the page shows as active: the pressed / selected / current / .active entry of a nav. */
    const navDrill = (): string | null => {
      const navs = document.querySelectorAll('nav, [role="navigation"], [role="tablist"], [class*="nav" i], [id*="nav" i], [class*="drill" i], [id*="drill" i]')
      for (const nav of Array.from(navs)) {
        const el = nav.querySelector('[aria-pressed="true"], [aria-selected="true"], [aria-current]:not([aria-current="false"]), .active, .selected, .is-active')
        const text = el ? clean(el.textContent ?? '') || clean(el.getAttribute('aria-label') ?? '') || clean(el.getAttribute('title') ?? '') : null
        if (text) return text
      }
      return null
    }

    /* ---------------- UI: a button, a dialog, toasts (closed shadow root) ---------------- */

    const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      el.append(...kids)
      return el
    }

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .fab { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; display: inline-flex; align-items: center; gap: 6px;
        padding: 9px 14px; border-radius: 999px; border: 1px solid rgba(143, 247, 255, 0.35); background: rgba(10, 12, 26, 0.72);
        -webkit-backdrop-filter: blur(12px) saturate(140%); backdrop-filter: blur(12px) saturate(140%); color: #eaf8ff;
        font-size: 13px; font-weight: 600; line-height: 1; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); cursor: pointer; user-select: none;
        transition: border-color 0.15s, box-shadow 0.15s; }
      .fab:hover { border-color: rgba(143, 247, 255, 0.8); box-shadow: 0 6px 28px rgba(0, 0, 0, 0.4), 0 0 18px rgba(143, 247, 255, 0.28); }
      .fab:focus-visible, .btn:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #8ff7ff; outline-offset: 2px; }
      .scrim { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 16px; background: rgba(2, 3, 10, 0.5); }
      .scrim[hidden], .msg[hidden] { display: none; }
      .dlg { width: min(440px, 100%); max-height: 100%; overflow: auto; margin: 0; padding: 18px; display: grid; gap: 12px;
        border-radius: 14px; border: 1px solid rgba(143, 247, 255, 0.28); background: rgba(12, 14, 30, 0.94);
        -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); color: #e6ecff; font-size: 13px; box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5); }
      h2 { margin: 0; font-size: 15px; font-weight: 650; color: #f2f6ff; }
      .found { display: flex; gap: 12px; align-items: center; }
      .thumb { flex: none; width: 120px; height: 90px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); }
      .grade { font-size: 20px; font-weight: 700; color: #8ff7ff; }
      .sub { margin-top: 3px; color: #a9b3d6; }
      .field { display: grid; gap: 5px; color: #a9b3d6; font-size: 12px; }
      select, input[type="text"] { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06); color: #eef2ff; font-size: 13px; }
      option { background: #11142a; color: #eef2ff; }
      .where { color: #7f8bb3; font-size: 12px; }
      .check { display: flex; gap: 8px; align-items: center; color: #dfe6ff; }
      .msg { margin: 0; color: #ffb0b0; }
      .row { display: flex; justify-content: flex-end; gap: 8px; }
      .btn { padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.06);
        color: #eef2ff; font-size: 13px; font-weight: 600; cursor: pointer; }
      .btn.primary { background: #8ff7ff; border-color: #8ff7ff; color: #04131a; }
      .btn:disabled, select:disabled, input:disabled { opacity: 0.5; cursor: default; }
      .toasts { position: fixed; right: 18px; bottom: 64px; z-index: 2147483647; display: grid; gap: 8px; justify-items: end; pointer-events: none; }
      .toast { pointer-events: auto; max-width: min(420px, calc(100vw - 36px)); padding: 10px 14px; border-radius: 10px; cursor: pointer;
        background: rgba(10, 12, 26, 0.92); border: 1px solid rgba(143, 247, 255, 0.45); color: #eaf8ff; font-size: 13px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
      .toast.error { border-color: rgba(255, 120, 120, 0.7); color: #ffe0e0; }
    `

    const hostEl = document.createElement('aether-forge-link')
    hostEl.setAttribute('style', 'all: initial !important;')
    const shadow = hostEl.attachShadow({ mode: 'closed' })
    if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in shadow) {
      // A constructed sheet: a page CSP that blocks inline <style> doesn't apply to it.
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(CSS)
      shadow.adoptedStyleSheets = [sheet]
    } else {
      shadow.append(h('style', {}, CSS))
    }

    const fab = h(
      'button',
      { class: 'fab', type: 'button', title: 'Save this drawing to a project in Aether Brain (Ctrl+Shift+B)', 'aria-keyshortcuts': 'Control+Shift+B' },
      '🪐 Save to Brain',
    )
    const thumb = h('canvas', { class: 'thumb', width: '240', height: '180', role: 'img', 'aria-label': 'The drawing that will be saved' })
    const gradeLine = h('div', { class: 'grade' })
    const gradeSub = h('div', { class: 'sub' })
    const sizeSub = h('div', { class: 'sub' })
    const project = h('select', {})
    const where = h('div', { class: 'where' })
    const title = h('input', { type: 'text', maxlength: String(MAX_TITLE), autocomplete: 'off', spellcheck: 'false' })
    const practice = h('input', { type: 'checkbox' })
    const msg = h('p', { class: 'msg', role: 'alert', hidden: '' })
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel')
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save')
    const form = h(
      'form',
      // tabindex: a click on the dialog's background keeps focus (and keys) in the dialog.
      { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'aether-forge-title', tabindex: '-1' },
      h('h2', { id: 'aether-forge-title' }, '🪐 Save to Aether Brain'),
      h('div', { class: 'found' }, thumb, h('div', {}, gradeLine, gradeSub, sizeSub)),
      h('label', { class: 'field' }, 'Project', project, where),
      h('label', { class: 'field' }, 'Title', title),
      h('label', { class: 'check' }, practice, 'Practice the top fix tomorrow'),
      msg,
      h('div', { class: 'row' }, cancel, saveBtn),
    )
    const scrim = h('div', { class: 'scrim', hidden: '' }, form)
    const toasts = h('div', { class: 'toasts' })
    shadow.append(fab, scrim, toasts)

    const textOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)) || 'Something went wrong'

    const toast = (message: string, error = false): void => {
      const t = h('div', { class: error ? 'toast error' : 'toast', role: error ? 'alert' : 'status' }, message)
      t.addEventListener('click', () => t.remove())
      toasts.append(t)
      while (toasts.childElementCount > 3) toasts.firstElementChild?.remove()
      setTimeout(() => t.remove(), error ? 8000 : 4000)
    }

    /** Run a handler of the link's UI; a failure becomes a toast, never an error in the page. */
    const safely = (fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        try {
          toast(textOf(err), true)
        } catch {
          // Nothing left to show it with.
        }
      }
    }

    /** Bumped by every open and close, so answers for a dialog that is gone change nothing. */
    let seq = 0
    let shot: Shot | null = null
    let grade: Grade | null = null
    let projects: ForgeProjectDto[] = []
    let problems: string[] = []
    let saving = false
    let before: Element | null = null

    const problem = (m: string): void => {
      problems = [...problems, m]
      msg.textContent = problems.join(' · ')
      msg.hidden = false
    }
    const sync = (): void => {
      saveBtn.disabled = saving || !shot || !project.value || project.disabled
      const p = projects.find((x) => x.id === project.value)
      where.textContent = p ? `Into ${p.critique}` : ''
    }

    const drawThumb = (c: HTMLCanvasElement): void => {
      const ctx = thumb.getContext('2d')
      if (!ctx) return
      const k = Math.min(thumb.width / c.width, thumb.height / c.height)
      const dw = c.width * k
      const dh = c.height * k
      ctx.clearRect(0, 0, thumb.width, thumb.height)
      ctx.drawImage(c, (thumb.width - dw) / 2, (thumb.height - dh) / 2, dw, dh)
    }

    const fillProjects = (list: ForgeProjectDto[]): void => {
      projects = Array.isArray(list) ? list : []
      if (!projects.length) {
        project.replaceChildren(h('option', { value: '' }, 'No projects yet'))
        problem('No projects in Aether Brain yet: make one there (p), then try again')
        return
      }
      let remembered: string | null = null
      try {
        remembered = w.localStorage.getItem(PROJECT_KEY)
      } catch {
        // Storage blocked: the first project.
      }
      project.replaceChildren(...projects.map((p) => h('option', { value: p.id }, p.status && p.status !== 'active' ? `${p.title} (${p.status})` : p.title)))
      project.value = projects.some((p) => p.id === remembered) ? (remembered ?? '') : (projects[0]?.id ?? '')
      project.disabled = false
    }

    const open = (): void => {
      if (!scrim.hidden) return
      // A drawing element in fullscreen (the top layer) would hide the dialog; a pointer lock would hide the pointer.
      const full = document.fullscreenElement
      if (full && full !== document.documentElement) {
        document.exitFullscreen().then(
          () => safely(open),
          () => undefined,
        )
        return
      }
      if (document.pointerLockElement) document.exitPointerLock()
      const run = ++seq
      before = document.activeElement === hostEl ? null : document.activeElement
      shot = null
      projects = []
      problems = []
      saving = false
      grade = readGrade()
      const letter = pick(grade, ['letter', 'lettergrade', 'gradeletter', 'grade', 'mark', 'rank'], letterOf)
      const score = pick(grade, ['score', 'overall', 'total', 'totalscore', 'overallscore', 'percent', 'pct', 'points'], scoreOf)
      const drill = pick(grade, ['drill', 'drillname', 'drilltitle', 'exercise', 'mode', 'category'], nameOf)
      gradeLine.textContent = letter || score !== null ? [letter, score !== null ? `${score}/100` : null].filter(Boolean).join(' · ') : 'Not graded'
      gradeSub.textContent = grade ? (drill ? `Drill: ${drill}` : 'Grade found') : 'No grade found: the drawing is saved without one'
      sizeSub.textContent = 'Looking for the drawing…'
      title.value = (drill ?? navDrill() ?? 'Study').slice(0, MAX_TITLE)
      practice.checked = true
      practice.disabled = !grade
      msg.hidden = true
      msg.textContent = ''
      saveBtn.textContent = 'Save'
      project.replaceChildren(h('option', { value: '' }, 'Loading projects…'))
      project.disabled = true
      thumb.getContext('2d')?.clearRect(0, 0, thumb.width, thumb.height)
      scrim.hidden = false
      sync()
      title.focus()
      title.select()
      capture().then(
        (s) =>
          safely(() => {
            if (run !== seq) return
            shot = s
            drawThumb(s.canvas)
            sizeSub.textContent = `${s.canvas.width} × ${s.canvas.height} px`
            if (s.png.length > MAX_PNG) problem('This drawing is larger than 40 MB as a PNG and can’t be saved')
            sync()
          }),
        (err: unknown) =>
          safely(() => {
            if (run !== seq) return
            sizeSub.textContent = ''
            problem(isSecurityError(err) ? 'This drawing can’t be saved: its canvas holds a picture from the web (browser security)' : textOf(err))
            sync()
          }),
      )
      Promise.resolve()
        .then(() => bridge.projects())
        .then(
          (list) =>
            safely(() => {
              if (run !== seq) return
              fillProjects(list)
              sync()
            }),
          (err: unknown) =>
            safely(() => {
              if (run !== seq) return
              project.replaceChildren(h('option', { value: '' }, 'No projects'))
              problem(textOf(err))
              sync()
            }),
        )
    }

    const close = (): void => {
      if (scrim.hidden) return
      seq++
      scrim.hidden = true
      shot = null
      grade = null
      const focused = shadow.activeElement
      if (focused instanceof HTMLElement) focused.blur()
      const back = before
      before = null
      // Give the keyboard back to the page (its shortcuts ignore keys aimed at our UI).
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
    }

    const save = async (): Promise<void> => {
      const s = shot
      const projectId = project.value
      if (!s || !projectId || saving || s.png.length > MAX_PNG) return
      const run = seq
      saving = true
      saveBtn.textContent = 'Saving…'
      sync()
      try {
        const dto: ForgeSaveDto = {
          projectId,
          title: title.value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
          png: s.png,
          grade,
          practiceTomorrow: practice.checked && !practice.disabled,
        }
        const res = await bridge.save(dto)
        try {
          w.localStorage.setItem(PROJECT_KEY, projectId)
        } catch {
          // Storage blocked: the choice isn't remembered.
        }
        if (run === seq) close()
        const planet = res.imagePath.split('/').slice(-2, -1)[0] ?? 'Critique'
        toast(`Saved to ${res.project} ▸ ${planet}`)
      } catch (err) {
        safely(() => {
          toast(textOf(err), true)
          if (run !== seq) return
          saving = false
          saveBtn.textContent = 'Save'
          sync()
        })
      }
    }

    /** Tab and Shift+Tab stay inside the dialog. */
    const trapTab = (e: KeyboardEvent): void => {
      const list = [project, title, practice, cancel, saveBtn].filter((el) => !el.disabled)
      const first = list[0]
      const last = list[list.length - 1]
      if (!first || !last) return
      const active = shadow.activeElement
      const inside = list.some((el) => el === active)
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }

    // Keep focus where it was when the button is clicked (a focused button would take the page's keys).
    fab.addEventListener('mousedown', (e) => e.preventDefault())
    fab.addEventListener('click', () => safely(open))
    cancel.addEventListener('click', () => safely(close))
    project.addEventListener('change', () => safely(sync))
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) safely(close)
    })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      save().catch(() => undefined)
    })
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') safely(() => trapTab(e))
    })
    // What happens in the link's UI stays there: the page's shortcuts and pointer handlers never see it.
    for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu']) {
      shadow.addEventListener(type, (e) => e.stopPropagation())
    }
    for (const type of ['wheel', 'touchstart']) shadow.addEventListener(type, (e) => e.stopPropagation(), { passive: true })
    w.addEventListener(
      'keydown',
      (e) => {
        try {
          // Esc closes the dialog wherever focus is (it is modal: the page doesn't get it meanwhile).
          if (e.key === 'Escape' && !scrim.hidden) {
            e.preventDefault()
            e.stopImmediatePropagation()
            safely(close)
            return
          }
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
          if (e.code !== 'KeyB' && String(e.key).toLowerCase() !== 'b') return
          e.preventDefault()
          e.stopImmediatePropagation()
          if (!e.repeat) safely(scrim.hidden ? open : close)
        } catch {
          // Never break the page's own keys.
        }
      },
      true,
    )

    document.documentElement.append(hostEl)
  } catch {
    // The page must keep working whatever happens here.
  }
}

// After the page's own scripts (a classic script's `let lastGrade` is there by then), into its main world.
window.addEventListener(
  'DOMContentLoaded',
  () => {
    webFrame.executeJavaScript(`(${forgeLinkMain.toString()})()`).catch(() => undefined)
  },
  { once: true },
)
