export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const MOD = isMac ? '⌘' : 'Ctrl'

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(t)) return iso
  const diff = now - t
  const day = 86400000
  // Date-only values (the common frontmatter case) resolve to local midnight.
  if (iso.length === 10) {
    if (diff < 0) return iso
    if (diff < day) return 'today'
  }
  if (diff < 0) return iso.slice(0, 10)
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < day) return `${Math.floor(diff / 3600000)}h ago`
  if (diff < day * 2) return 'yesterday'
  if (diff < day * 30) return `${Math.floor(diff / day)}d ago`
  if (diff < day * 365) return `${Math.floor(diff / (day * 30))}mo ago`
  return `${Math.floor(diff / (day * 365))}y ago`
}

export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso)
  if (Number.isNaN(t)) return null
  return Math.floor((now - t) / 86400000)
}

/** True when the keyboard event originates from a text field. */
export function isTyping(e: KeyboardEvent | { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function plural(n: number, s: string, p = `${s}s`): string {
  return `${n} ${n === 1 ? s : p}`
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
