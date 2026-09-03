import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { VendoOverlay, VendoProvider } from '@vendoai/vendo/react'
import theme from '../.vendo/theme.json'

const container = document.getElementById('vendo-root')
if (container) {
  const root = createRoot(container)
  root.render(
    React.createElement(React.StrictMode, null,
      React.createElement(VendoProvider, { baseUrl: '/api/vendo', theme } as any,
        React.createElement(VendoOverlay, { launcher: { position: 'bottom-right', label: null } } as any),
      ),
    ),
  )
  // VendoOverlay defaults the aria-label to "AI agent" when label is null.
  // Restore the accessible name to match the visible "Ask Manu" branding.
  const fixLabel = () => {
    const btn = document.querySelector<HTMLButtonElement>('[data-vendo-launcher]')
    if (btn && btn.getAttribute('aria-label') !== 'Ask Manu') {
      btn.setAttribute('aria-label', 'Ask Manu')
    }
  }
  fixLabel()
  new MutationObserver(fixLabel).observe(document.body, { childList: true, subtree: true })
}
