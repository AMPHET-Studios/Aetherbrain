/**
 * The board toolbar's icons: 18 px line drawings in the current text colour, one per tool and a few for the buttons. Inline SVG so
 * that nothing is fetched (the app makes no network requests) and the colour follows the button's state.
 */
import type { ReactNode } from 'react'
import type { BoardTool } from '../api'

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {children}
    </svg>
  )
}

const TOOL_ICONS: Record<BoardTool, ReactNode> = {
  select: <path d="M4 2.5l9.5 6.2-4.2 1.1 2.4 4.6-1.9 1-2.4-4.6L4 13.2z" fill="currentColor" fillOpacity={0.15} />,
  hand: (
    <>
      <path d="M6.2 9V4.4a1 1 0 012 0V8m0-3.4V3.3a1 1 0 012 0V8m0-3a1 1 0 012 0v3.4m0-1.6a1 1 0 012 0V11c0 3-1.7 4.7-4.4 4.7-2 0-3.2-.9-4.2-2.6L3.3 10.4a1 1 0 011.6-1.1z" />
    </>
  ),
  note: (
    <>
      <path d="M3 3.5h12v8.2L11.2 15.5H3z" fill="currentColor" fillOpacity={0.1} />
      <path d="M11 15.5v-3.8h4M6 7h6M6 9.8h3.4" />
    </>
  ),
  pen: (
    <>
      <path d="M12.2 3l2.8 2.8-8.2 8.2-3.6.8.8-3.6z" fill="currentColor" fillOpacity={0.1} />
      <path d="M10.7 4.5l2.8 2.8" />
    </>
  ),
  line: (
    <>
      <path d="M3.5 14.5L14 4" />
      <path d="M8.6 4H14v5.4" />
    </>
  ),
  rect: <rect x="3" y="4.5" width="12" height="9" rx="1" />,
  ellipse: <ellipse cx="9" cy="9" rx="6.2" ry="4.6" />,
  eraser: (
    <>
      <path d="M7.4 14.5H15M3.4 10.4l5.6-5.6a1.4 1.4 0 012 0l2.3 2.3a1.4 1.4 0 010 2l-4.6 4.6H6.3L3.4 12.4a1.4 1.4 0 010-2z" fill="currentColor" fillOpacity={0.1} />
      <path d="M6.2 7.6l4.2 4.2" />
    </>
  ),
  sampler: (
    <>
      <path d="M11.6 3.2l3.2 3.2-1.4 1.4-3.2-3.2zM10.3 5.5l2.2 2.2-5.9 5.9-3 .8.8-3z" fill="currentColor" fillOpacity={0.1} />
      <path d="M3.6 14.4l.4-1.6" />
    </>
  ),
  crop: <path d="M5 2.5v10.5h10.5M2.5 5H13V15.5" />,
}

export function ToolIcon({ tool }: { tool: BoardTool }) {
  return <Svg>{TOOL_ICONS[tool]}</Svg>
}

const BUTTON_ICONS = {
  undo: <path d="M6.5 4L3 7.5 6.5 11M3.5 7.5H11a3.5 3.5 0 010 7H8" />,
  redo: <path d="M11.5 4L15 7.5 11.5 11M14.5 7.5H7a3.5 3.5 0 000 7h3" />,
  picture: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1.5" />
      <circle cx="6.5" cy="7.5" r="1.2" />
      <path d="M3 13l3.7-3.4 2.6 2.4 2.3-2 3.4 3" />
    </>
  ),
  plus: <path d="M9 3.5v11M3.5 9h11" />,
  chevron: <path d="M5 7.2l4 4 4-4" />,
  export: <path d="M9 11V2.8M5.8 5.8L9 2.6l3.2 3.2M3.5 10v4.5h11V10" />,
  help: (
    <>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M7.2 7.2a1.9 1.9 0 113 1.5c-.8.6-1.2 1-1.2 2M9 13v.1" />
    </>
  ),
  window: (
    <>
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" />
      <path d="M9.5 8.5H13V5.5M13 8.5L9.3 12.2" />
    </>
  ),
  dock: (
    <>
      <rect x="2.5" y="4" width="13" height="10" rx="1.5" />
      <path d="M13 8H9.5V11M9.5 8l3.7-3.7" />
    </>
  ),
  pin: <path d="M6 3h6l-.8 4.2L14 10H4l2.8-2.8zM9 10v5" />,
  minus: <path d="M4 9h10" />,
  close: <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" />,
  check: <path d="M4 9.5l3.2 3.2L14 5.5" />,
  eyeOff: <path d="M2.5 9s2.4-4.5 6.5-4.5S15.5 9 15.5 9s-2.4 4.5-6.5 4.5S2.5 9 2.5 9zM3 15L15 3" />,
  search: (
    <>
      <circle cx="8" cy="8" r="4.6" />
      <path d="M11.5 11.5L15 15" />
    </>
  ),
  edit: (
    <>
      <path d="M3 14.5h3.4L14.6 6.3a1.6 1.6 0 000-2.3l-.6-.6a1.6 1.6 0 00-2.3 0L3.5 11.6z" />
    </>
  ),
  arrange: (
    <>
      <rect x="2.5" y="3" width="6" height="6" rx="1" />
      <rect x="10.5" y="3" width="5" height="3" rx="1" />
      <rect x="10.5" y="8" width="5" height="7" rx="1" />
      <rect x="2.5" y="11" width="6" height="4" rx="1" />
    </>
  ),
  view: (
    <>
      <path d="M1.8 9S4.4 4.2 9 4.2 16.2 9 16.2 9 13.6 13.8 9 13.8 1.8 9 1.8 9z" />
      <circle cx="9" cy="9" r="2.2" />
    </>
  ),
}

export type ButtonIconName = keyof typeof BUTTON_ICONS

export function Icon({ name, size }: { name: ButtonIconName; size?: number }) {
  return <Svg {...(size ? { size } : {})}>{BUTTON_ICONS[name]}</Svg>
}
