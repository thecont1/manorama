import { render } from 'hono/jsx/dom'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import GalleryList from './islands/GalleryList'
import { RevenueCatBilling } from './lib/billing'
import { beginDropboxSignIn, getSessionAppUserId, installNativeAuth } from './lib/session'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Native app root is missing')

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'
const billing = new RevenueCatBilling()
render(
  <GalleryList
    apiBase={apiBase}
    billing={billing}
    onSignIn={() => void beginDropboxSignIn(apiBase)}
  />,
  root,
)

const configureRevenueCat = async () => {
  const apiKey = import.meta.env.VITE_REVENUECAT_API_KEY?.trim()
  const appUserId = await getSessionAppUserId()
  if (!apiKey || !appUserId) return
  await billing.configure({ apiKey, appUserId })
}

void installNativeAuth(apiBase).then(configureRevenueCat).catch(() => undefined)

/** Configure the native status bar and dismiss the launch splash screen. */
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
    // The browser build has no native splash screen to hide.
  }
}

void configureNativeChrome()
