import { useEffect, useMemo, useState } from 'hono/jsx'
import { render } from 'hono/jsx/dom'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import GalleryList from './islands/GalleryList'
import { RevenueCatBilling, type BillingState } from './lib/billing'
import { authErrorMessage, beginDropboxSignIn, getSessionAppUserId, installNativeAuth } from './lib/session'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Native app root is missing')
const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'

function NativeApp() {
  const [authError, setAuthError] = useState<string | null>(null)
  const [billingState, setBillingState] = useState<BillingState | undefined>(undefined)
  const billing = useMemo(() => new RevenueCatBilling(undefined, setBillingState), [])
  const configureRevenueCat = async () => {
    const apiKey = import.meta.env.VITE_REVENUECAT_API_KEY?.trim()
    const appUserId = await getSessionAppUserId()
    if (!apiKey || !appUserId) return
    await billing.configure({ apiKey, appUserId })
  }
  const signIn = () => {
    setAuthError(null)
    void beginDropboxSignIn(apiBase).catch((reason) => setAuthError(authErrorMessage(reason)))
  }
  useEffect(() => {
    let cleanup: (() => Promise<void>) | undefined
    let active = true
    void installNativeAuth(apiBase, setAuthError)
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
  return <GalleryList apiBase={apiBase} billing={billing} billingState={billingState} authError={authError} onSignIn={signIn} />
}

render(<NativeApp />, root)

const configureNativeChrome = async () => {
  try {
    await StatusBar.setOverlaysWebView({ overlay: false })
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
