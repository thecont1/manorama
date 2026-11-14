import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { APP_VERSION_URL, updateAvailableFor, type AppSurface, type AppVersionManifest } from '../../packages/core/app-version'

/**
 * The mobile app-freshness check. `downloads.manorama.xyz/latest.json` is
 * fetched once on Library load; `mobile.<platform>` is compared against
 * the installed bundle and a newer answer becomes the dismissible banner
 * + Settings row. Dismissal is per-version, device-local, and re-arms on
 * the next release. Until a platform's store listing ships the manifest
 * has no entry for it and the check quietly answers null — a dev or
 * TestFlight build never nags about a release it cannot install.
 */

export type AppUpdate = { version: string; url: string }

const DISMISSED_KEY = 'manorama:update-dismissed'

export const dismissedUpdateVersion = async (): Promise<string | null> =>
  (await Preferences.get({ key: DISMISSED_KEY }).catch(() => ({ value: null }))).value ?? null

export const dismissAppUpdate = async (version: string): Promise<void> => {
  await Preferences.set({ key: DISMISSED_KEY, value: version }).catch(() => {})
}

export const checkAppUpdate = async (fetcher: typeof fetch = fetch): Promise<AppUpdate | null> => {
  if (!Capacitor.isNativePlatform()) return null
  const surface: AppSurface = Capacitor.getPlatform() === 'android' ? 'android' : 'ios'
  const installed = await App.getInfo().then((info) => info.version).catch(() => null)
  if (!installed) return null
  const manifest = await fetcher(APP_VERSION_URL)
    .then((response) => (response.ok ? (response.json() as Promise<AppVersionManifest>) : null))
    .catch(() => null)
  return updateAvailableFor(manifest, surface, installed)
}
