/**
 * Label placement without piling: labels are offered most important first, and each one is kept only if its box
 * clears the boxes already kept. Pure (numbers in, a yes or no out), so it is tested without a canvas; the scene
 * allocates nothing per frame with it (`reset` keeps the storage).
 */

/** Priority bands, highest first: what the user is pointing at, the landmarks, what is linked to the focus, then by size on screen. */
export const LABEL_PRIORITY = {
  selected: 1_000_000,
  hovered: 900_000,
  landmark: 800_000,
  linked: 600_000,
  planet: 300_000,
  note: 200_000,
} as const

export class LabelPlacer {
  /** Kept boxes: x0, y0, x1, y1 each. */
  private boxes = new Float32Array(4 * 256)
  private n = 0

  /** Forget every kept box (the storage stays). */
  reset(): void {
    this.n = 0
  }

  /** How many boxes are kept. */
  get count(): number {
    return this.n
  }

  /** True when the box (left, top, width, height), grown by `margin` on every side, touches no kept box. */
  fits(left: number, top: number, w: number, h: number, margin = 3): boolean {
    const x0 = left - margin
    const y0 = top - margin
    const x1 = left + w + margin
    const y1 = top + h + margin
    const b = this.boxes
    for (let k = 0; k < this.n; k++) {
      const o = k * 4
      if (x0 < b[o + 2]! && x1 > b[o]! && y0 < b[o + 3]! && y1 > b[o + 1]!) return false
    }
    return true
  }

  /** Keep the box (no check: `fits` first, or `force` for one that must be drawn). */
  add(left: number, top: number, w: number, h: number): void {
    if ((this.n + 1) * 4 > this.boxes.length) {
      const bigger = new Float32Array(this.boxes.length * 2)
      bigger.set(this.boxes)
      this.boxes = bigger
    }
    const o = this.n * 4
    this.boxes[o] = left
    this.boxes[o + 1] = top
    this.boxes[o + 2] = left + w
    this.boxes[o + 3] = top + h
    this.n++
  }

  /** Keep the box when it fits; says whether it did. */
  tryPlace(left: number, top: number, w: number, h: number, margin = 3): boolean {
    if (!this.fits(left, top, w, h, margin)) return false
    this.add(left, top, w, h)
    return true
  }
}
