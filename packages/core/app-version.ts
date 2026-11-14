/**
 * The in-app update check, platform-free.
 *
 * `downloads.manorama.xyz/latest.json` is the release pointer — a mutable
 * R2 object, bumped per release with no deploy. The shells fetch it on
 * Library load, compare the published version for their surface against
 * their own build, and show a dismissible notice when the source is
 * newer. The manifest shape is owned here so every shell parses the same
 * contract; the downloads host's own LatestManifest mirrors it.
 */

export const APP_VERSION_URL = 'https://downloads.manorama.xyz/latest.json'
export const APP_DOWNLOADS_URL = 'https://downloads.manorama.xyz/'

export type AppSurface = 'macos' | 'windows' | 'ios' | 'android'

export type AppVersionManifest = {
  /** The desktop release version — mac, windows and linux ship together. */
  version?: string
  released?: string
  assets?: { mac?: string; windows?: string; linux?: string; all?: string[] }
  /** Per-platform mobile releases; absent until that store listing ships. */
  mobile?: {
    ios?: { version?: string; url?: string } | null
    android?: { version?: string; url?: string } | null
  }
}

/** Numeric semver triple compare: 1.10.0 > 1.9.0, missing segments read
 *  as 0, non-numeric input compares equal (unparseable → no notice). */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  if (pa.some((n) => !Number.isFinite(n)) || pb.some((n) => !Number.isFinite(n))) return 0
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

/** The published version for one surface plus where to send the user.
 *  Desktop surfaces link the downloads page (which picks per-OS); mobile
 *  surfaces link their store URL and answer null until one is published. */
export const latestForSurface = (
  manifest: AppVersionManifest | null | undefined,
  surface: AppSurface,
): { version: string; url: string } | null => {
  if (!manifest) return null
  if (surface === 'ios' || surface === 'android') {
    const mobile = manifest.mobile?.[surface]
    return mobile?.version && mobile.url ? { version: mobile.version, url: mobile.url } : null
  }
  return manifest.version ? { version: manifest.version, url: APP_DOWNLOADS_URL } : null
}

/** True when the published version is strictly newer than the build. */
export const updateAvailableFor = (manifest: AppVersionManifest | null | undefined, surface: AppSurface, installed: string) => {
  const latest = latestForSurface(manifest, surface)
  return latest && compareVersions(latest.version, installed) > 0 ? latest : null
}
