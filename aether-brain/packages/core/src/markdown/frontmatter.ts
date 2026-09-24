import yaml from 'js-yaml'
import type { Frontmatter } from '../types'

const FM_OPEN = /^(?:﻿)?---[ \t]*\r?\n/
const FM_CLOSE = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

export interface SplitResult {
  frontmatter: Frontmatter
  body: string
  /** Character index where the body starts inside the original string. */
  bodyOffset: number
  /** True when a frontmatter block was present (even if empty). */
  hasFrontmatter: boolean
}

/**
 * Split a markdown document into YAML frontmatter + body.
 * Tolerant: invalid YAML yields an empty object rather than throwing, because a
 * single broken note should never take the whole graph down.
 */
export function splitFrontmatter(raw: string): SplitResult {
  const open = FM_OPEN.exec(raw)
  if (!open) return { frontmatter: {}, body: raw, bodyOffset: 0, hasFrontmatter: false }
  const rest = raw.slice(open[0].length)
  const close = FM_CLOSE.exec(rest)
  if (!close) return { frontmatter: {}, body: raw, bodyOffset: 0, hasFrontmatter: false }
  const yamlText = rest.slice(0, close.index)
  const bodyOffset = open[0].length + close.index + close[0].length
  let frontmatter: Frontmatter = {}
  try {
    const parsed = yaml.load(yamlText, { schema: yaml.JSON_SCHEMA })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Frontmatter
    }
  } catch {
    frontmatter = {}
  }
  return { frontmatter, body: raw.slice(bodyOffset), bodyOffset, hasFrontmatter: true }
}

/** Serialize frontmatter + body back into a markdown document. */
export function joinFrontmatter(frontmatter: Frontmatter, body: string): string {
  const keys = Object.keys(frontmatter)
  if (keys.length === 0) return body
  const text = yaml.dump(frontmatter, { lineWidth: 120, noRefs: true, flowLevel: 1, quotingType: '"' }).trimEnd()
  const trimmedBody = body.replace(/^\s*\n/, '')
  return `---\n${text}\n---\n\n${trimmedBody}`
}

/**
 * Update frontmatter keys on a raw document, preserving the body byte-for-byte.
 * Pass `undefined` as a value to delete a key.
 */
export function updateFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const { frontmatter, body } = splitFrontmatter(raw)
  const next: Frontmatter = { ...frontmatter }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k]
    else next[k] = v
  }
  return joinFrontmatter(next, body)
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') {
    return v
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return []
}

export function asString(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  return s.length ? s : null
}

/** Normalize a date-ish frontmatter value to an ISO string (date or datetime). */
export function asIsoDate(v: unknown): string | null {
  const s = asString(v)
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}
