import { createPortal, useEffect, useId, useRef, useState } from 'hono/jsx/dom'
import type { Child, JSXNode } from 'hono/jsx/dom'
import { pushOverlay } from '../../lib/overlay-stack'
import { watchVisualViewport } from '../../lib/visual-viewport'
import { Button } from './Button'

/** Bottom sheet (compact) / centred dialog (≥720px). Renders into
 *  document.body through a portal and registers with the shared overlay
 *  stack: scrim + Escape close only when dismissible, focus lands on the
 *  heading (never an input, so we never force the keyboard open), and the
 *  background is inert while open. `half` caps at half the visual viewport;
 *  when the keyboard is open it may grow so the pinned footer stays
 *  reachable (`--m-keyboard-inset` > 0 → `.m-sheet--kb`). */
type Props = {
  open: boolean
  onClose: () => void
  title: string
  children?: Child
  footer?: Child
  size?: 'auto' | 'half'
  dismissible?: boolean
}

export function Sheet({ open, onClose, title, children, footer, size = 'auto', dismissible = true }: Props) {
  const headingId = `m-sheet-title-${useId()}`
  const hostRef = useRef<HTMLDivElement>(null)
  const [kb, setKb] = useState(false)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    if (!open || !hostRef.current) return
    const host = hostRef.current
    const release = pushOverlay({
      host,
      onEscape: dismissible ? onClose : undefined,
    })
    const unwatch = watchVisualViewport(host)
    const vv = typeof visualViewport === 'undefined' ? null : visualViewport
    const onVv = () => setKb(Number.parseFloat(host.style.getPropertyValue('--m-keyboard-inset') || '0') > 0)
    vv?.addEventListener('resize', onVv)
    vv?.addEventListener('scroll', onVv)
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => {
      cancelAnimationFrame(frame)
      vv?.removeEventListener('resize', onVv)
      vv?.removeEventListener('scroll', onVv)
      unwatch()
      release()
    }
  }, [open, dismissible, onClose])

  useEffect(() => {
    if (!open) setEntered(false)
  }, [open])

  if (!open) return null

  const sheetClasses = [
    'm-sheet',
    size === 'half' ? 'm-sheet--half' : '',
    size === 'half' && kb ? 'm-sheet--kb' : '',
    entered ? '' : 'm-sheet--entering',
  ].filter(Boolean).join(' ')

  return createPortal(
    <div ref={hostRef} class="m-sheet-host">
      <div
        class={`m-scrim ${entered ? 'm-scrim--open' : ''}`}
        onClick={() => { if (dismissible) onClose() }}
      />
      <div class={sheetClasses} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div class="m-sheet-head">
          <h2 class="m-sheet-title" id={headingId} tabIndex={-1} ref={(el: HTMLElement | null) => el?.focus()}>{title}</h2>
          {dismissible ? <Button variant="quiet" onClick={onClose} aria-label="Close">Close</Button> : null}
        </div>
        <div class="m-sheet-body">{children}</div>
        {footer ? <div class="m-sheet-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  ) as JSXNode
}

export default Sheet
