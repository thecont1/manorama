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
  /** Mirror ids whose account-level hidden flag the source record adopted
   *  — the caller stamps hiddenAt locally so the next sync does not
   *  re-fight the account. */
  adoptedHidden: string[]
}

export const syncDeviceGalleries = async (
  apiBase: string,
  token: string,
  catalogue: LocalCatalogue,
  fetcher: typeof fetch = fetch,
): Promise<CatalogueSyncResult> => {
  const result: CatalogueSyncResult = { synced: 0, failed: 0, adoptedHidden: [] }
  // A sibling device hides by PATCHing the mirror row directly, so the
  // account flag is newer than anything an un-patched source record
  // carries — it must win over this device's stale hidden=false.
  const remote = await fetcher(`${apiBase.replace(/\/+$/, '')}/api/device-galleries`, {
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(async (response) => {
      if (!response.ok) return null
      const body = (await response.json().catch(() => null)) as
        { galleries?: Array<{ id: string; hidden?: boolean }> } | null
      return body && Array.isArray(body.galleries) ? body.galleries : null
    })
    .catch(() => null)
  // A read that fails or answers malformed aborts before a single PUT —
  // writing blind could overwrite an account-level hide this device
  // cannot see. An answered empty list still proceeds.
  if (!remote) {
    result.failed = catalogue.galleries.length
    return result
  }
  const remoteHidden = new Map(remote.map((row) => [row.id, Boolean(row.hidden)]))
  for (const record of catalogue.galleries) {
    const request = deviceGalleryRequest(apiBase, record, catalogue)
    // A record that never chose to hide defers to the account flag; one
    // that decided for itself (hiddenAt set, or an explicit unhide that
    // already PATCHed the mirror) stays authoritative for its own state.
    if (remoteHidden.get(record.id) && !record.hiddenAt) {
      request.body = { ...request.body, hidden: true }
      result.adoptedHidden.push(record.id)
    }
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
