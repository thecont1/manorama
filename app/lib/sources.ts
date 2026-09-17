import { scanDropboxFolder } from './dropbox-public'
import { extractDriveFolderId, scanDriveFolder } from './gdrive-public'
import { extractAlbumToken, isICloudDriveLink, scanICloudAlbum } from './icloud-shared'
import { extractMegaLink, scanMegaSource } from './mega-public'
import type { GalleryMediaItem } from './imagesource'

/**
 * Gallery source dispatch. The admin drops one of the recognized link
 * shapes — Dropbox shared folder, Google Drive shared folder, iCloud
 * shared album, MEGA shared folder or collection — and this module routes it to the
 * right scanner. Each scanner returns a canonical sourceUrl so
 * different spellings of the same source dedupe through the
 * (owner_id, source_url) unique index.
 *
 * All providers read public links only: Dropbox and Google Drive
 * authenticate as the app (Basic credentials / API key); iCloud shared
 * albums and MEGA need no credentials at all (MEGA's share key rides in
 * the link fragment). There are no per-user source tokens.
 */

export type SourceProvider = 'dropbox' | 'gdrive' | 'icloud' | 'mega'

export type SourceScan = { provider: SourceProvider; sourceUrl: string; title: string; images: GalleryMediaItem[] }

export type SourceEnv = {
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  GOOGLE_DRIVE_API_KEY?: string
}

export const UNRECOGNIZED_LINK_MESSAGE =
  'Paste a public Dropbox folder, Google Drive folder, iCloud shared album, or MEGA folder/collection link'

export const detectSource = (input: string): SourceProvider | null => {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'dropbox.com') return 'dropbox'
  if (host === 'drive.google.com') return 'gdrive'
  if (host === 'icloud.com' && url.pathname.startsWith('/sharedalbum/')) return 'icloud'
  if (host === 'share.icloud.com' && url.pathname.startsWith('/photos/')) return 'icloud'
  if (host === 'mega.nz' || host === 'mega.co.nz') return 'mega'
  return null
}

/**
 * Recognizes a share URL embedded in our own path — the `/…` quick-add
 * entry point. The browser mangles a pasted URL on the way into the
 * address bar, so every layer is undone in order:
 *
 *  - a leading `/` from the pathname join
 *  - percent-encoding (guarded: a stray `%` must not throw)
 *  - the collapsed scheme separator (`https:/x` → `https://x`), which
 *    browsers and proxies produce from `//`
 *  - a missing scheme entirely (`dropbox.com/…` → `https://dropbox.com/…`)
 *
 * Returns the reconstructed URL and its provider, or null when the tail
 * is not a share link. Gallery slugs are `[a-z0-9-]` with no dot, so a
 * slug can never be mistaken for a provider host — the catch-all always
 * falls through to the real route for them.
 */
export const embeddedSourceCandidate = (raw: string): { candidate: string; provider: SourceProvider } | null => {
  if (typeof raw !== 'string') return null
  let candidate = raw.trim()
  if (!candidate) return null
  candidate = candidate.replace(/^\/+/, '')
  if (!candidate) return null
  // A pasted URL arrives percent-encoded from some clients and raw from
  // others; decoding a already-raw string is a no-op, and a malformed
  // escape must not throw.
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // Keep the undecoded form — it may still be a valid link.
  }
  candidate = candidate.trim()
  if (!candidate) return null
  // `https://x` collapsed to `https:/x` (or more slashes) by path
  // normalization — restore exactly two.
  candidate = candidate.replace(/^(https?):\/+/i, '$1://')
  if (!/^https?:\/\//i.test(candidate)) {
    // Reject anything carrying another scheme (ftp:, javascript:, data:)
    // rather than gluing https:// onto it.
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return null
    candidate = `https://${candidate}`
  }
  const provider = detectSource(candidate)
  if (provider) return { candidate, provider }
  // iCloud Drive links are recognized so the interstitial can explain the
  // Shared Album requirement instead of 404-ing.
  if (isICloudDriveLink(candidate)) return { candidate, provider: 'icloud' }
  return null
}

/**
 * Do two links point at the same source, without contacting the provider?
 *
 * Only the scanners know a source's true canonical form, but re-scanning
 * just to discover "you already have this" is wasteful and fragile. This
 * is a conservative, network-free approximation: same provider, and the
 * provider's own identity token matches. A false negative merely costs
 * the scan that would have happened anyway; there are no false positives
 * across providers.
 */
export const canonicalSourceMatches = (storedSourceUrl: string, candidateUrl: string): boolean => {
  const storedProvider = detectSource(storedSourceUrl)
  const candidateProvider = detectSource(candidateUrl)
  if (!storedProvider || storedProvider !== candidateProvider) return false
  if (storedSourceUrl === candidateUrl) return true

  // A provider's public identity is not always enough to identify the
  // authorization context. MEGA reuses the folder/collection handle with a
  // fragment key; Drive resource keys and Dropbox rlkeys similarly affect
  // access. Reopen only when both identity AND access key match. A false
  // negative merely causes the normal scanner/canonicalizer to run.
  switch (storedProvider) {
    case 'icloud': {
      const storedToken = extractAlbumToken(storedSourceUrl)
      const candidateToken = extractAlbumToken(candidateUrl)
      return Boolean(storedToken && candidateToken && storedToken === candidateToken)
    }
    case 'mega': {
      try {
        const stored = extractMegaLink(storedSourceUrl)
        const candidate = extractMegaLink(candidateUrl)
        return Boolean(stored && candidate && stored.kind === candidate.kind && stored.id === candidate.id && stored.key === candidate.key)
      } catch {
        return false
      }
    }
    case 'gdrive': {
      try {
        const stored = extractDriveFolderId(storedSourceUrl)
        const candidate = extractDriveFolderId(candidateUrl)
        return Boolean(stored && candidate && stored.id === candidate.id && stored.resourceKey === candidate.resourceKey)
      } catch {
        return false
      }
    }
    case 'dropbox': {
      try {
        const stored = new URL(storedSourceUrl)
        const candidate = new URL(candidateUrl)
        const normalizedPath = (url: URL) => url.pathname.replace(/\/+$/, '')
        return normalizedPath(stored) === normalizedPath(candidate) && stored.searchParams.get('rlkey') === candidate.searchParams.get('rlkey')
      } catch {
        return false
      }
    }
  }
}

export const scanSource = async (input: string, env: SourceEnv, fetchImpl: typeof fetch = fetch): Promise<SourceScan> => {
  const provider = detectSource(input)
  if (!provider) {
    // iCloud Drive links look like album links but enumerate folders only
    // behind an authenticated CloudKit session — steer the owner to the
    // Photos Shared Album link instead.
    if (isICloudDriveLink(input)) throw new Error('iCloud Drive links cannot be read — share a Shared Album from Photos instead (icloud.com/sharedalbum or share.icloud.com/photos)')
    throw new Error(UNRECOGNIZED_LINK_MESSAGE)
  }
  switch (provider) {
    case 'dropbox':
      return { provider, ...(await scanDropboxFolder(input, env, fetchImpl)) }
    case 'gdrive':
      return { provider, ...(await scanDriveFolder(input, env, fetchImpl)) }
    case 'icloud':
      return { provider, ...(await scanICloudAlbum(input, fetchImpl)) }
    case 'mega':
      return { provider, ...(await scanMegaSource(input, fetchImpl)) }
  }
}
