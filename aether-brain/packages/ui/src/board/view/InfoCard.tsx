/**
 * A small card with the facts of one picture of the board: its name, where it is in the vault, its own size in pixels, the size it is
 * shown at, and its type. It follows the picture (a moved or resized one updates; one that is deleted closes the card).
 */
import { useEffect } from 'react'
import { cx } from '../../util'
import type { BoardSession } from './boardSession'
import { Icon } from './icons'
import { POPUP_BG } from './Menu'
import { infoRows } from './session'
import { useBoardState, useSessionVersion } from './useBoardSession'

export function InfoCard({ session, id, onClose, reducedMotion }: { session: BoardSession; id: number; onClose(): void; reducedMotion: boolean }) {
  useSessionVersion(session)
  // The item itself: a moved, resized or cropped picture is a new object.
  const item = useBoardState(session, (s) => s.doc.items.find((it) => it.id === id) ?? null)
  const info = item && item.kind === 'picture' ? session.pictureInfo(id) : null
  const path = info?.path
  const known = !!info?.natural
  useEffect(() => {
    if (!item || item.kind !== 'picture') onClose()
  }, [item, onClose])
  // The picture's real size is not known until it has been read at full size: ask for it.
  useEffect(() => {
    if (path && !known) session.probeNatural(path)
  }, [session, path, known])
  if (!info) return null
  return (
    <div
      role="dialog"
      aria-label="Picture info"
      data-board-overlay
      className={cx('panel absolute bottom-3 right-3 z-30 w-[300px] max-w-[calc(100%-1.5rem)] p-3 text-[12px]', !reducedMotion && 'rise')}
      style={{ background: POPUP_BG }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="section-title flex-1">Picture info</span>
        <button type="button" className="hud-btn !h-6 !w-6 !justify-center !px-0" aria-label="Close picture info" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <dl className="grid grid-cols-[88px_1fr] gap-x-2 gap-y-1">
        {infoRows(info).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-faint">{label}</dt>
            <dd className="min-w-0 select-text break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
