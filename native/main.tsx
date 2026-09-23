import { render } from 'hono/jsx/dom'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import GalleryList from './islands/GalleryList'
import './styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('Native app root is missing')

const apiBase = import.meta.env.VITE_API_BASE || 'https://manorama.xyz'
render(<GalleryList apiBase={apiBase} />, root)

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
