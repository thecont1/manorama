/** @jsxImportSource react */
import { StrictMode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { VendoOverlay, VendoProvider, VendoSlot } from '@vendoai/vendo/react'
import theme from '../.vendo/theme.json'

// Mounted only by the authenticated owner administration page. Same-origin
// Cloudflare Access cookies/headers flow naturally; no browser JWT is minted
// and no client-supplied subject is ever trusted — the wire verifies the
// Access session server-side and fails closed without one.
const container = document.getElementById('vendo-root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <VendoProvider baseUrl="/api/vendo" theme={theme}>
        <VendoOverlay launcher={{ position: 'bottom-right', label: null }} />
        {/* The pinned gallery-inventory generated view. Portal target lives
            in the hono/jsx Admin island; React never owns that tree. With no
            pin authored yet the slot renders its empty-state CTA (or nothing,
            if the host hides it) — never breaks the admin page. */}
        {(() => {
          const slotHost = document.getElementById('vendo-slot-gallery-inventory')
          return slotHost ? createPortal(
            <VendoSlot
              id="gallery-inventory"
              label="Gallery inventory"
              description="Admin dashboard area for dense gallery inventory and health views: gallery list with image counts and stale/failed refresh state."
              emptyState={{
                title: 'Gallery inventory builds itself',
                subtitle: 'ask Manu for a gallery inventory — pin it here',
                suggestions: [
                  'Show a gallery inventory with image counts',
                  'Which galleries are stale since their last refresh?',
                ],
              }}
            />,
            slotHost,
          ) : null
        })()}
      </VendoProvider>
    </StrictMode>,
  )

  // The bare launcher (label: null) keeps the custom "ask Manu" orb styling,
  // but its default accessible name is "AI agent". Restore the "Ask Manu"
  // name with a BOUNDED fixer: the observer disconnects the moment the label
  // is set, instead of observing the DOM forever.
  const fixLauncherLabel = (): boolean => {
    const launcher = document.querySelector<HTMLButtonElement>('[data-vendo-launcher]')
    if (!launcher) return false
    if (launcher.getAttribute('aria-label') !== 'Ask Manu') {
      launcher.setAttribute('aria-label', 'Ask Manu')
    }
    return true
  }
  if (!fixLauncherLabel()) {
    const observer = new MutationObserver(() => {
      if (fixLauncherLabel()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  // A Cloudflare Access sign-in normally remounts the whole page. When it
  // happens without a reload (re-authentication in another tab, then focus
  // returns here), announce it so Vendo's identity latch re-opens and its
  // pollers quietly re-check instead of staying signed-out until refresh.
  window.addEventListener('focus', () => {
    window.dispatchEvent(new Event('vendo:identity-changed'))
  })
}
