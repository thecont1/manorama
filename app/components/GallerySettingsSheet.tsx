import { useEffect, useRef, useState } from 'hono/jsx'
import { Sheet } from './ui/Sheet'
import { ActionGroup, ActionRow } from './ui/ActionRow'
import { Button } from './ui/Button'
import OwnerGalleryPanel, { type OwnerGalleryPanelProps } from './viewer/OwnerGalleryPanel'

type Props = OwnerGalleryPanelProps & {
  open: boolean
  onClose: () => void
  /** Click interception for anchors inside the panel — the desktop shell
   *  routes upgrade/sign-in links through it. */
  onClick?: (event: MouseEvent) => void
}

/** The Library's gallery settings as the same two-layer dialog the
 *  viewer's Settings popover hosts: the front layer carries the common
 *  actions (share, reorder, refresh) under the gallery's own head, and
 *  "More Settings" drills into the rest — name, caption, address, source
 *  and removal. Escape and the scrim step back a layer before closing,
 *  exactly like the viewer's drill-in.
 *
 *  One panel instance owns both layers: swapping `layer` keeps the
 *  refresh controller, elapsed count and any open editor alive across
 *  the drill — two mounted panels would each hold half the truth. */
export default function GallerySettingsSheet({ open, onClose, onClick, ...panel }: Props) {
  const [more, setMore] = useState(false)
  const moreHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const moreRowWrapRef = useRef<HTMLDivElement | null>(null)
  const wasMoreRef = useRef(more)
  // Reopening always lands on the front layer; the drill-in is per-open.
  useEffect(() => {
    if (!open) setMore(false)
  }, [open])

  // Focus follows the drill, like the viewer's Settings popover: the rest
  // layer's heading on push, the "More Settings" row on the way back.
  useEffect(() => {
    if (more && !wasMoreRef.current) {
      moreHeadingRef.current?.focus()
    } else if (!more && wasMoreRef.current) {
      moreRowWrapRef.current?.querySelector<HTMLElement>('button')?.focus()
    }
    wasMoreRef.current = more
  })

  const handleClose = () => {
    if (more) setMore(false)
    else onClose()
  }

  return (
    <Sheet open={open} onClose={handleClose} title="Gallery Settings">
      <div class="m-dark" onClick={onClick}>
        {more ? (
          <>
            <Button variant="quiet" onClick={() => setMore(false)} class="m-backbtn" aria-label="Back to Gallery Settings">
              <svg viewBox="0 0 24 24" aria-hidden="true" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M15 6l-6 6 6 6"/></svg>
              Gallery Settings
            </Button>
            <h3 class="m-actiongroup-label" tabIndex={-1} ref={moreHeadingRef}>More Settings</h3>
          </>
        ) : null}
        <OwnerGalleryPanel {...panel} layer={more ? 'rest' : 'quick'} />
        {more ? null : (
          <ActionGroup>
            <div ref={moreRowWrapRef}>
              <ActionRow label="More Settings" onClick={() => setMore(true)} />
            </div>
          </ActionGroup>
        )}
      </div>
    </Sheet>
  )
}
