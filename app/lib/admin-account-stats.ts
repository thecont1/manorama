import { detectSource, type SourceProvider } from './sources'
import { DEVICE_KINDS, isDeviceExpired, isDeviceKind, type DeviceKind } from '../../packages/core/devices'

/**
 * Per-account activity for the master ops console. The console shows counts
 * and provider names only — a source_url never leaves this fold, so the
 * table can say "Dropbox ×2" without holding anyone's links.
 */

export type AdminGallerySource = SourceProvider | 'other'
export type AdminSourceCount = { provider: AdminGallerySource; count: number }
export type AdminDeviceCount = { kind: DeviceKind; count: number }

export type AccountActivity = {
  /** Pipeline galleries — the Free tier's expiring shelf. */
  temporaryGalleryCount: number
  hiddenGalleryCount: number
  /** Soonest future expiry among temporary galleries; absent when none. */
  nextGalleryExpiryAt?: string
  mediaCount: number
  /** Gallery sources by provider, most-used first. */
  sources: AdminSourceCount[]
  latestGalleryAt?: string
  /** Live native devices by kind — web sign-ins register none. */
  devices: AdminDeviceCount[]
}

export const emptyAccountActivity = (): AccountActivity => ({
  temporaryGalleryCount: 0,
  hiddenGalleryCount: 0,
  mediaCount: 0,
  sources: [],
  devices: [],
})

type GalleryStatsRow = Record<string, unknown>
type DeviceStatsRow = Record<string, unknown>

const ownerOf = (row: Record<string, unknown>): string | null =>
  typeof row.owner_id === 'string' && row.owner_id.length > 0 ? row.owner_id : null

export const summarizeAccountActivity = (
  galleryRows: readonly GalleryStatsRow[],
  deviceRows: readonly DeviceStatsRow[],
  now = Date.now(),
): Map<string, AccountActivity> => {
  const activity = new Map<string, AccountActivity>()
  const at = (ownerId: string): AccountActivity => {
    let entry = activity.get(ownerId)
    if (!entry) {
      entry = emptyAccountActivity()
      activity.set(ownerId, entry)
    }
    return entry
  }

  for (const row of galleryRows) {
    const ownerId = ownerOf(row)
    if (!ownerId) continue
    const entry = at(ownerId)
    if (row.retention === 'pipeline') {
      entry.temporaryGalleryCount += 1
      if (typeof row.expires_at === 'string') {
        const expiryMs = Date.parse(row.expires_at)
        if (!Number.isNaN(expiryMs) && expiryMs > now
          && (!entry.nextGalleryExpiryAt
            || Date.parse(entry.nextGalleryExpiryAt) > expiryMs)) {
          entry.nextGalleryExpiryAt = row.expires_at
        }
      }
    }
    if (typeof row.hidden_at === 'string' && row.hidden_at.length > 0) entry.hiddenGalleryCount += 1
    entry.mediaCount += Number(row.media_count) || 0
    if (typeof row.created_at === 'string' && row.created_at.length > 0
      && (!entry.latestGalleryAt || row.created_at > entry.latestGalleryAt)) {
      entry.latestGalleryAt = row.created_at
    }
    if (typeof row.source_url === 'string' && row.source_url.length > 0) {
      const provider: AdminGallerySource = detectSource(row.source_url) ?? 'other'
      const existing = entry.sources.find((s) => s.provider === provider)
      if (existing) existing.count += 1
      else entry.sources.push({ provider, count: 1 })
    }
  }
  for (const entry of activity.values()) {
    entry.sources.sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider))
  }

  const deviceCounts = new Map<string, Map<DeviceKind, number>>()
  for (const row of deviceRows) {
    const ownerId = ownerOf(row)
    if (!ownerId || !isDeviceKind(row.kind) || typeof row.last_seen_at !== 'string') continue
    if (isDeviceExpired({ lastSeenAt: row.last_seen_at }, now)) continue
    let kinds = deviceCounts.get(ownerId)
    if (!kinds) {
      kinds = new Map()
      deviceCounts.set(ownerId, kinds)
    }
    kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1)
  }
  for (const [ownerId, kinds] of deviceCounts) {
    at(ownerId).devices = DEVICE_KINDS
      .filter((kind) => (kinds.get(kind) ?? 0) > 0)
      .map((kind) => ({ kind, count: kinds.get(kind) ?? 0 }))
  }

  return activity
}
