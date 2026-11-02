/** Provider word for a gallery's source link, matched on host alone — the
 *  scanner graph stays server-side, so this never imports `detectSource`.
 *  Moved here from native/lib/library-media.ts so the gallery route can
 *  label the owner panel's source line the same way the native library
 *  cards do. */
export const sourceLabelFor = (sourceUrl: string | null | undefined): string => {
  if (!sourceUrl) return 'gallery'
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    return 'local folder'
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'dropbox.com') return 'Dropbox'
  if (host === 'drive.google.com') return 'Google Drive'
  if (host === 'icloud.com' || host === 'share.icloud.com') return 'iCloud'
  if (host === 'mega.nz' || host === 'mega.co.nz') return 'MEGA'
  return 'gallery'
}
