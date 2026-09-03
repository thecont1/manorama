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
        React.createElement(VendoOverlay, { launcher: { position: 'bottom-right', label: 'Ask Manu' } } as any),
      ),
    ),
  )
}
