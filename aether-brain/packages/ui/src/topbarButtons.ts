/**
 * Buttons the host app adds to the top bar (the desktop's chat). The web app adds none. Kept in a module of its own so the
 * package's views stay free of what only one host has; the host registers before the first render.
 */
export interface TopBarButton {
  id: string
  /** The icon. */
  icon: string
  /** The word beside it: it gives way on a narrow window (the title keeps it). */
  word: string
  title: string
  /** The key it is also on, shown on a wide window. */
  key?: string
  run(): void
  /** Whether it shows as pressed, and how to hear that it changed. Leave both out for a plain button. */
  pressed?(): boolean
  subscribe?(listener: () => void): () => void
}

const buttons: TopBarButton[] = []

/** Add a button to the top bar; one with the id of an earlier button replaces it. */
export function registerTopBarButton(button: TopBarButton): void {
  const at = buttons.findIndex((b) => b.id === button.id)
  if (at >= 0) buttons[at] = button
  else buttons.push(button)
}

/** The registered buttons, in the order they were added. */
export function topBarButtons(): readonly TopBarButton[] {
  return buttons
}
