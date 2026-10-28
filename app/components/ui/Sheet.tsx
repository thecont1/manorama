import { useEffect, useId, useRef, useState } from 'hono/jsx'
import type { Child } from 'hono/jsx/dom'
import { pushOverlay } from '../../lib/overlay-stack'
import { watchVisualViewport } from '../../lib/visual-viewport'
import { Button } from './Button'

/** Bottom sheet (compact) / centred dialog (≥720px). Renders a fixed-position
 *  host inline and registers it with the shared overlay stack, which inerts
 *  the host's sibling chain (hono's createPortal produces a fresh vnode every
 *  render, which re-runs effects on every parent render — measured — so the
 *  portal path is unusable for hook-bearing components). Scrim + Escape close
 *  only when dismissible; focus lands on the heading once per open (never an
 *  input, so we never force the keyboard open or steal focus while the parent
 *  re-renders); the background is inert while open. `half` caps at half the
 *  visual viewport; when the keyboard is open it may grow so the pinned
 *  footer stays reachable (`--m-keyboard-inset` > 0 → `.m-sheet--kb`). */
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
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Parents pass fresh inline callbacks every render; the overlay must be
  // pushed exactly once per open, so the effect never depends on them.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [kb, setKb] = useState(false)
  const [entered, setEntered] = useState(false)
  // The open lifecycle is guarded by this ref rather than effect deps or
  // cleanup: hono re-invokes effects on renders whose deps have not changed
  // and runs cleanups at its own cadence (measured — re-pushing or releasing
  // from there stole focus mid-typing and raced the rAF queue). Release
  // therefore happens exactly two ways: the `open` prop flips false, or the
  // host leaves the document (MutationObserver), both independent of hono's
  // effect-cleanup timing.
  const activation = useRef<{ release(): void } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (open && host && !activation.current && typeof document !== 'undefined') {
      const release = pushOverlay({
        host,
        onEscape: dismissible ? () => onCloseRef.current() : undefined,
      })
      const unwatch = watchVisualViewport(host)
      const vv = typeof visualViewport === 'undefined' ? null : visualViewport
      const onVv = () => setKb(Number.parseFloat(host.style.getPropertyValue('--m-keyboard-inset') || '0') > 0)
      vv?.addEventListener('resize', onVv)
      vv?.addEventListener('scroll', onVv)
      // Initial focus lands on the heading once per open — a callback ref
      // would re-run and pull focus off whatever the user is typing in.
      headingRef.current?.focus()
      const frame = requestAnimationFrame(() => setEntered(true))
      const observer = new MutationObserver(() => {
        if (!host.isConnected) activation.current?.release()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      activation.current = {
        release() {
          activation.current = null
          cancelAnimationFrame(frame)
          observer.disconnect()
          vv?.removeEventListener('resize', onVv)
          vv?.removeEventListener('scroll', onVv)
          unwatch()
          release()
        },
      }
    } else if (!open && activation.current) {
      activation.current.release()
    }
  })

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

  return (
    <div ref={hostRef} class="m-sheet-host">
      <div
        class={`m-scrim ${entered ? 'm-scrim--open' : ''}`}
        onClick={() => { if (dismissible) onCloseRef.current() }}
      />
      <div class={sheetClasses} role="dialog" aria-modal="true" aria-labelledby={headingId}>
        <div class="m-sheet-head">
          <h2 class="m-sheet-title" id={headingId} tabIndex={-1} ref={headingRef}>{title}</h2>
          {dismissible ? <Button variant="quiet" onClick={() => onCloseRef.current()} aria-label="Close">Close</Button> : null}
        </div>
        <div class="m-sheet-body">{children}</div>
        {footer ? <div class="m-sheet-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export default Sheet
