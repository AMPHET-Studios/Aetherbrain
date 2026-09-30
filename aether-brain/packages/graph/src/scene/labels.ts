/**
 * Label of the Today hub: how many tasks the brief holds, a tick when there
 * are none, and how many of them are late.
 */
export function todayLabel(total: number, overdue: number): string {
  if (total <= 0) return '☀ Today ✓'
  return overdue > 0 ? `☀ Today · ${total} · ${overdue} late` : `☀ Today · ${total}`
}
