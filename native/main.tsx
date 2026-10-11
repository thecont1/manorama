import { useEffect, useMemo, useState } from 'hono/jsx'
import { render } from 'hono/jsx/dom'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import GalleryList from './islands/GalleryList'
import { RevenueCatBilling, type BillingState } from './lib/billing'
import { authErrorMessage, beginProviderSignIn, getSessionAppUserId, installNativeAuth, type AuthProvider, type NativeGallerySelection } from './lib/session'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Native app root is missing')
document.body.classList.add('manorama-native')

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'

function NativeApp() {
  const [authError, setAuthError] = useState<string | null>(null)
  const [deepLinkSelection, setDeepLinkSelection] = useState<NativeGallerySelection | null>(null)
  const [billingState, setBillingState] = useState<BillingState | undefined>(undefined)
  const billing = useMemo(() => new RevenueCatBilling(undefined, setBillingState), [])
  const configureRevenueCat = async () => {
    const apiKey = import.meta.env.VITE_REVENUECAT_API_KEY?.trim()
    const appUserId = await getSessionAppUserId()
    if (!apiKey || !appUserId) return
    await billing.configure({ apiKey, appUserId })
  }
  const signIn = (provider: AuthProvider) => {
    setAuthError(null)
    void beginProviderSignIn(provider, apiBase).catch((reason) => setAuthError(authErrorMessage(reason)))
  }
  useEffect(() => {
    let cleanup: (() => Promise<void>) | undefined
    let active = true
    void installNativeAuth(apiBase, setAuthError, setDeepLinkSelection)
      .then((removeListener) => {
        cleanup = removeListener
        if (active) return configureRevenueCat()
        return undefined
      })
      .catch((reason) => setAuthError(authErrorMessage(reason)))
    return () => {
      active = false
      void cleanup?.()
    }
  }, [billing])
  return <GalleryList apiBase={apiBase} billing={billing} billingState={billingState} authError={authError} deepLinkSelection={deepLinkSelection} onSignIn={signIn} />
}

render(<NativeApp />, root)

const configureNativeChrome = async () => {
  try {
    // Overlay, not inset: the page owns the status-bar strip and paints its own
    // safe-area padding, so no native background band can show above a surface.
    await StatusBar.setOverlaysWebView({ overlay: true })
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {
    // Capacitor plugins are no-ops in the browser preview.
  }
  try {
    await SplashScreen.hide()
  } catch {
    // Capacitor plugins are no-ops in the browser preview.
  }
}
void configureNativeChrome()
