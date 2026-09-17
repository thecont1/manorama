/**
 * Scan-failure copy, shared by the admin dashboard and the quick-add
 * interstitial. Scanner errors are written for operators; these are the
 * sentences a visitor sees. Both surfaces must say the same thing about
 * the same failure, so the mapping lives here rather than in either
 * island.
 *
 * The input is deliberately `unknown`: callers pass a caught error, a
 * server-supplied `{ error }` string, or nothing at all.
 */
export const friendlySourceError = (error: unknown) => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/Use a public Dropbox folder link/i.test(message)) return 'Paste a public Dropbox folder link, not a file link.'
  if (/Use a public Google Drive folder link/i.test(message)) return 'Paste a Google Drive folder link, not a file link.'
  if (/Use a public iCloud shared album link/i.test(message)) return 'Paste a public iCloud Shared Album link (icloud.com/sharedalbum or share.icloud.com/photos).'
  if (/Google Drive folder was not found|could not read that Google Drive/i.test(message)) return 'Manorama could not read that Google Drive folder. Check that it is shared with "Anyone with the link".'
  if (/could not read that iCloud|could not locate that shared album/i.test(message)) return 'Manorama could not read that iCloud album. Check that it is a public Shared Album link.'
  if (/iCloud Drive links cannot be read/i.test(message)) return 'That is an iCloud Drive link, which Apple keeps behind sign-in. In Photos, share a Shared Album instead and paste its public link.'
  if (/Use a public MEGA|usable key|MEGA link was not found|could not read that MEGA|MEGA folder was not found/i.test(message)) return 'Paste a public MEGA folder or collection link (mega.nz/folder/… or mega.nz/collection/…) with its #key fragment.'
  if (/MEGA is rate limiting|bandwidth limit/i.test(message)) return 'MEGA is rate limiting requests — wait a few minutes and try again.'
  if (/No photos or videos were found/i.test(message)) return 'No photos or videos were found at that link. Add images or videos to the shared album and try again.'
  if (/No (image files|photos) were found/i.test(message)) return 'No supported image files were found at that link. Add JPG, WebP, AVIF, HEIC, or HEIF images and try again.'
  if (/401|403|409|not_found|access_denied|shared_link/i.test(message)) return 'Manorama could not read that link. Check that it is public, downloading is enabled, and the URL points to the folder or album itself.'
  if (/not configured|credentials are not configured/i.test(message)) return 'Manorama is temporarily unable to reach that service. Please try again later.'
  return 'We could not read that link. Check the URL and try again.'
}
