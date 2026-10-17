/**
 * Text drawn next to a body in the scene. Pure, so it is tested without WebGL.
 */

/** Longest label of a picture before its middle is left out. */
export const PICTURE_LABEL_MAX = 26

/**
 * A picture's file name as a label. Generated pictures have names of 70 characters
 * (`Lucid_Origin_Heroic_frontfacing_AAA_3D_render_of_an_ancientfut_7_d10496eb-b5f2-….jpg`), and a board holds
 * dozens of them side by side, so past `max` characters the middle goes: the start says what it is, the end keeps the
 * file type and enough of the tail to tell two of them apart. The full name shows on hover and selection.
 */
export function shortFileLabel(name: string, max: number = PICTURE_LABEL_MAX): string {
  const limit = Math.max(8, Math.floor(max))
  // Counted in code points, so an emoji in a file name is never cut in half.
  const chars = Array.from(name)
  if (chars.length <= limit) return name
  const keep = limit - 1
  const head = Math.ceil(keep * 0.55)
  const tail = keep - head
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}
