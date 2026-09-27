import { deviceGalleryRequest, type LocalCatalogue, type LocalGalleryRecord } from './catalogue'

/**
 * Catalogue sync: gallery-level metadata only. The wire shape is fixed by
 * `deviceGalleryRequest` — title, sourceKind, itemCount, deviceId,
 * deviceLabel — and the server re-parses it against `parseDeviceGalleryInput`,
 * which rejects unknown keys outright. No path, filename, or byte can ride
 * along even if this function were misused.
 *
 * Failures are quiet by contract: sync must never block local viewing.
 */

export type CatalogueSyncResult = {
  synced: number
  failed: number
}

export const syncDeviceGalleries = async (
  apiBase: string,
  token: string,
  catalogue: LocalCatalogue,
  fetcher: typeof fetch = fetch,
): Promise<CatalogueSyncResult> => {
  const result: CatalogueSyncResult = { synced: 0, failed: 0 }
  for (const record of catalogue.galleries) {
    const request = deviceGalleryRequest(apiBase, record, catalogue)
    try {
      const response = await fetcher(request.url, {
        method: request.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(request.body),
      })
      if (response.ok) result.synced += 1
      else result.failed += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}

/** Best-effort remote cleanup for a locally removed gallery. Removing a
 *  gallery is a catalogue action only — it deletes a metadata row, never a
 *  file, and it must not block the local removal. */
export const removeDeviceGallery = async (
  apiBase: string,
  token: string,
  record: LocalGalleryRecord,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  try {
    await fetcher(`${apiBase.replace(/\/+$/, '')}/api/device-galleries/${record.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    // The next successful sync window can reconcile; local state is already final.
  }
}
