import { canGoBack, type OwnerNavState } from '../../packages/core/owner-navigation'

/** The Android hardware back chain, as a pure decision so every branch and
 *  its precedence is unit-testable without Capacitor. The listener maps each
 *  outcome onto the real surface — the order here is the contract:
 *  overlays always win over screen navigation. */
export type BackDecision =
  | 'close-global'
  | 'close-viewer-modal'
  | 'close-overlay'
  | 'return-to-library'
  | 'nav-back'
  | 'close-account-menu'
  | 'exit'

export type BackInput = {
  globalViewOpen: boolean
  viewerModalOpen: boolean
  overlayDepth: number
  nav: OwnerNavState
  accountMenuOpen: boolean
}

export const decideBack = (input: BackInput): BackDecision => {
  if (input.globalViewOpen) return 'close-global'
  if (input.viewerModalOpen) return 'close-viewer-modal'
  if (input.overlayDepth > 0) return 'close-overlay'
  if (canGoBack(input.nav))
    return input.nav.screen.kind === 'viewer' ? 'return-to-library' : 'nav-back'
  if (input.accountMenuOpen) return 'close-account-menu'
  return 'exit'
}
