import { probeDropboxFolder } from './dropbox-public'
import { probeDriveFolder } from './gdrive-public'
import { probeGPhotosAlbum } from './gphotos-shared'
import { probeICloudAlbum } from './icloud-shared'
import type { FreshnessItem, ProbeOutcome } from './source-freshness'
import { detectSource, type SourceEnv } from './sources'

/**
 * The server-side source-freshness probe.
 *
 * One step ahead of a refresh: a probe is a metadata-only listing — no
 * image bytes, no per-item dimension calls — compared against the stored
 * manifest's keys and per-item change tokens. Outcomes:
 *
 *  - 'changed'   the source provably differs → the caller runs the full
 *                refresh pipeline.
 *  - 'unchanged' the listing matches the manifest exactly.
 *  - 'unknown'   the listing was incomplete, budget-exhausted, or the
 *                manifest predates change tokens — the honest "we could
 *                not tell", never silently 'unchanged'.
 *  - 'device'    the source is end-to-end encrypted (MEGA, ente, Proton —
 *                the server never sees the key) and only a shell holding
 *                the key can list it. The device does its own compare via
 *                `deviceListingOutcome` and reports the verdict back.
 *  - 'skipped'   there is nothing to probe (no source URL, or a source
 *                kind — like the dev-only local folder — the probe does
 *                not cover).
 */
export const probeSource = async (
  gallery: { sourceUrl?: string | null; images: readonly FreshnessItem[] },
  env: SourceEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeOutcome> => {
  const sourceUrl = gallery.sourceUrl
  if (!sourceUrl) return { status: 'skipped', reason: 'no-source' }
  const provider = detectSource(sourceUrl)
  switch (provider) {
    case 'dropbox':
      return probeDropboxFolder(sourceUrl, gallery.images, env, fetchImpl)
    case 'gdrive':
      return probeDriveFolder(sourceUrl, gallery.images, env, fetchImpl)
    case 'icloud':
      return probeICloudAlbum(sourceUrl, gallery.images, fetchImpl)
    case 'gphotos':
      return probeGPhotosAlbum(sourceUrl, gallery.images, fetchImpl)
    case 'mega':
    case 'ente':
    case 'proton':
      return { status: 'device', reason: 'encrypted-source' }
    case 'local':
      return { status: 'skipped', reason: 'local-source' }
    default:
      return { status: 'skipped', reason: 'unrecognized-source' }
  }
}
