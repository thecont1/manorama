/**
 * The native-shell origins trusted to call Manorama endpoints cross-origin.
 * The API group and the downloads host share this one rule: Capacitor,
 * Tauri and the SwiftUI shell origins — plus http://localhost:* for dev —
 * may read responses; ambient-cookie origins never do. API calls
 * authenticate with an explicit bearer token, so allowing these grants
 * nothing a browser origin could exploit; the downloads manifests are
 * public anyway — the header just lets the webview's fetch() see them.
 */
const APP_ORIGINS = new Set([
  'capacitor://localhost',
  'tauri://localhost',
  'manorama://localhost',
  // The Android WebView origin under Capacitor's default androidScheme —
  // same trust class as the scheme origins.
  'https://localhost',
])

export const isAppOrigin = (origin: string | null | undefined): boolean => {
  if (!origin) return false
  if (APP_ORIGINS.has(origin)) return true
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && url.hostname === 'localhost'
  } catch {
    return false
  }
}
