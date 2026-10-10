/**
 * Small conversions between DOM events and the plain data the session takes. The browser's DataTransfer is only readable while its
 * event is being handled, so a drop or a paste is read out here, at once, into a snapshot; the rest of the work is async.
 */
import type { KeyIn, PointerIn, WheelIn } from '../api'
import type { TransferSnapshot } from './session'

/** What a drag or a paste carries, read out of the transfer. Files come from `files` and, when that is empty, from the items of kind file. */
export function snapshotTransfer(dt: DataTransfer | null): TransferSnapshot<File> {
  const empty: TransferSnapshot<File> = { files: [], uriList: '', html: '', text: '' }
  if (!dt) return empty
  const files: File[] = Array.from(dt.files ?? [])
  if (files.length === 0 && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  const read = (type: string): string => {
    try {
      return dt.getData(type)
    } catch {
      return ''
    }
  }
  return { files, uriList: read('text/uri-list'), html: read('text/html'), text: read('text/plain') }
}

/** Whether a drag over the board carries something it could take (files, an address, text); other drags are left to the page. */
export function dragCarriesContent(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const types = Array.from(dt.types ?? [])
  return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain') || types.includes('text/html')
}

export function keyInOf(e: KeyboardEvent): KeyIn {
  return { key: e.key, code: e.code, down: e.type === 'keydown', shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, repeat: e.repeat }
}

export function pointerInOf(e: PointerEvent, rect: { left: number; top: number }): PointerIn {
  return {
    id: e.pointerId,
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    // A move reports button -1 ("none changed"); the controller reads `buttons` for what is down.
    button: e.button < 0 ? 0 : e.button,
    buttons: e.buttons,
    shift: e.shiftKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    meta: e.metaKey,
    pointerType: e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse',
    pressure: e.pressure,
    time: e.timeStamp,
  }
}

export function wheelInOf(e: WheelEvent, rect: { left: number; top: number }): WheelIn {
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaMode: e.deltaMode,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  }
}

/** Text fields (and anything editable) keep their keys. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}
