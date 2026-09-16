import { scanDropboxFolder } from './dropbox-public'
import { scanDriveFolder } from './gdrive-public'
import { scanICloudAlbum } from './icloud-shared'
import type { GalleryImage } from './imagesource'

/**
 * Gallery source dispatch. The admin drops one of three recognized link
 * shapes — Dropbox shared folder, Google Drive shared folder, iCloud
 * shared album — and this module routes it to the right scanner. Each
 * scanner returns a canonical sourceUrl so different spellings of the
 * same source dedupe through the (owner_id, source_url) unique index.
 *
 * All three providers read public links only: Dropbox and Google Drive
 * authenticate as the app (Basic credentials / API key), iCloud shared
 * albums need no credentials at all. There are no per-user source tokens.
 */

export type SourceProvider = 'dropbox' | 'gdrive' | 'icloud'

export type SourceScan = { provider: SourceProvider; sourceUrl: string; title: string; images: GalleryImage[] }

export type SourceEnv = {
  DROPBOX_APP_KEY?: string
  DROPBOX_APP_SECRET?: string
  GOOGLE_DRIVE_API_KEY?: string
}

export const UNRECOGNIZED_LINK_MESSAGE =
  'Paste a public Dropbox folder, Google Drive folder, or iCloud shared album link'

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
  return null
}

export const scanSource = async (input: string, env: SourceEnv, fetchImpl: typeof fetch = fetch): Promise<SourceScan> => {
  const provider = detectSource(input)
  if (!provider) throw new Error(UNRECOGNIZED_LINK_MESSAGE)
  switch (provider) {
    case 'dropbox':
      return { provider, ...(await scanDropboxFolder(input, env, fetchImpl)) }
    case 'gdrive':
      return { provider, ...(await scanDriveFolder(input, env, fetchImpl)) }
    case 'icloud':
      return { provider, ...(await scanICloudAlbum(input, fetchImpl)) }
  }
}
