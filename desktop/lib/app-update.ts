import { APP_VERSION_URL, updateAvailableFor, type AppSurface, type AppVersionManifest } from '../../packages/core/app-version'

/**
 * The desktop app-freshness check. `downloads.manorama.xyz/latest.json`
 * is fetched once on Library load; the published version is compared
 * against the running build and a newer answer becomes the dismissible
 * banner + Settings row. Dismissal is per-version and device-local
 * (library-prefs.json) — a newer release re-arms the notice.
 *
 * The installed version comes from the Tauri bundle under the native
 * shell and from the build-time `__MANORAMA_APP_VERSION__` define under
 * the SwiftUI shell and plain-browser previews; neither answers → no
 * check, never a guess.
 */

export type AppUpdate = { version: string; url: string }

const desktopSurface = (): AppSurface =>
  typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? 'windows' : 'macos'

const installedVersion = async (): Promise<string | null> => {
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    const version = await getVersion()
    if (version) return version
  } catch {
    // Not under Tauri — the SwiftUI shell relies on the define below.
  }
  return typeof __MANORAMA_APP_VERSION__ === 'string' ? __MANORAMA_APP_VERSION__ : null
}

export const checkDesktopAppUpdate = async (fetcher: typeof fetch = fetch): Promise<AppUpdate | null> => {
  const installed = await installedVersion()
  if (!installed) return null
  const manifest = await fetcher(APP_VERSION_URL)
    .then((response) => (response.ok ? (response.json() as Promise<AppVersionManifest>) : null))
    .catch(() => null)
  return updateAvailableFor(manifest, desktopSurface(), installed)
}

/** A dismissed version hides the banner only for that release. */
export const updateStillPending = (update: AppUpdate | null, dismissedVersion: string | null | undefined): AppUpdate | null =>
  update && update.version !== dismissedVersion ? update : null
