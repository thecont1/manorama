/** Visually-hidden live region for screen-reader announcements. The region
 *  is cleared and refilled on the next frame so identical consecutive
 *  messages are still re-announced. */
let region: HTMLElement | null = null
let queued: number | null = null

const ensureRegion = (): HTMLElement => {
  // Same-document check too: a cached region from another document (test
  // fixture, iframe) still reports isConnected.
  if (region?.isConnected && region.ownerDocument === document) return region
  region = document.createElement('div')
  region.className = 'm-sr-only'
  // Live regions inside inert subtrees are hidden from the a11y tree, so the
  // overlay stack must never inert this one while a sheet or menu is open.
  region.setAttribute('data-overlay-exempt', '')
  region.setAttribute('aria-live', 'polite')
  region.setAttribute('aria-atomic', 'true')
  document.body.appendChild(region)
  return region
}

export const announce = (message: string, politeness: 'polite' | 'assertive' = 'polite'): void => {
  const el = ensureRegion()
  el.setAttribute('aria-live', politeness)
  if (queued !== null) cancelAnimationFrame(queued)
  el.textContent = ''
  queued = requestAnimationFrame(() => {
    queued = null
    el.textContent = message
  })
}
