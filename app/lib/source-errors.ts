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
  if (/Proton Drive link is password-protected|password-protected links are not supported/i.test(message)) return 'That Proton Drive link carries its own password — password-protected Proton Drive links are not supported yet.'
  if (/no longer supported by Proton/i.test(message)) return 'That Proton Drive link is no longer supported — ask the owner for a fresh link.'
  if (/complete public Proton Drive link/i.test(message)) return 'Paste a public Proton Drive link (drive.proton.me/urls/…) with its #password fragment.'
  if (/Proton Drive sources are scanned on your device/i.test(message)) return message
  if (/password-protected/i.test(message)) return 'That Ente album is password-protected — password-protected albums are not supported yet.'
  if (/Ente album key is malformed|complete public Ente album link/i.test(message)) return 'Paste a public Ente album link (albums.ente.io/…) with its #key fragment.'
  if (/expired or was revoked/i.test(message)) return 'That Ente album link has expired or was revoked. Ask the owner for a fresh link.'
  if (/Ente sources are scanned on your device/i.test(message)) return message
  if (/No photos or videos were found/i.test(message)) return 'No photos or videos were found at that link. Add images or videos to the shared album and try again.'
  if (/No (image files|photos) were found/i.test(message)) return 'No supported image files were found at that link. Add JPG, WebP, AVIF, HEIC, or HEIF images and try again.'
  // Count-cap refusals already carry owner-facing text — the number and
  // the limit are the point, so pass them through rather than rephrasing.
  if (/galleries are limited to/i.test(message)) return message
  if (/401|403|409|not_found|access_denied|shared_link/i.test(message)) return 'Manorama could not read that link. Check that it is public, downloading is enabled, and the URL points to the folder or album itself.'
  if (/taking a very long time|too large/i.test(message)) return 'That album is taking a very long time to read — it may be too large. Try again, or split it into smaller folders.'
  if (/not configured|credentials are not configured/i.test(message)) return 'Manorama is temporarily unable to reach that service. Please try again later.'
  return 'We could not read that link. Check the URL and try again.'
}
