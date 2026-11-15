import type { D1Database } from '@cloudflare/workers-types'
import {
  DEVICE_COLOUR_SLOTS,
  DEVICE_EXPIRY_DAYS,
  isDeviceExpired,
  isDeviceKind,
  sortDevices,
  type Device,
  type DeviceKind,
} from '../../packages/core/devices'

export type DeviceEnv = { DB?: D1Database }

const requireDb = (env?: DeviceEnv): D1Database => {
  if (!env?.DB) throw new Error('Devices require the D1 database binding')
  return env.DB
}

type DeviceRow = {
  id: string
  kind: string
  ordinal: number
  colour: number
  first_seen_at: string
  last_seen_at: string
}

const rowToDevice = (row: DeviceRow): Device | null => {
  if (!isDeviceKind(row.kind)) return null
  return {
    id: row.id,
    kind: row.kind,
    ordinal: row.ordinal,
    colour: row.colour,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }
}

const DEVICE_SELECT = 'SELECT id, kind, ordinal, colour, first_seen_at, last_seen_at FROM devices WHERE owner_id = ?'

const expiryCutoff = (now: string): string =>
  new Date(Date.parse(now) - DEVICE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()

/** The account's live devices. Expiry is evaluated here rather than by a
 *  sweeper: a device unseen for the whole window is simply not listed, and
 *  the next register call removes it (and its mirrors) for good. */
export const listDevices = async (ownerId: string, env?: DeviceEnv): Promise<Device[]> => {
  const db = requireDb(env)
  const result = await db.prepare(`${DEVICE_SELECT} ORDER BY kind ASC, ordinal ASC`).bind(ownerId).all<DeviceRow>()
  const now = Date.now()
  const devices = (result.results ?? [])
    .map(rowToDevice)
    .filter((device): device is Device => device !== null && !isDeviceExpired(device, now))
  return sortDevices(devices)
}

/** Every live device, including the ones the list would hide — the register
 *  path needs the true palette occupancy. */
const liveDevices = async (db: D1Database, ownerId: string): Promise<Device[]> => {
  const result = await db.prepare(DEVICE_SELECT).bind(ownerId).all<DeviceRow>()
  const now = Date.now()
  return (result.results ?? [])
    .map(rowToDevice)
    .filter((device): device is Device => device !== null && !isDeviceExpired(device, now))
}

export type RegisterDeviceResult =
  | { status: 'ok'; device: Device }
  | { status: 'full' }
  | { status: 'missing' }

/**
 * Records this device against the account. The first call on a device picks
 * its number (next for its kind) and its pill colour (the lowest slot no live
 * device is wearing); every later call only refreshes `last_seen_at`, at most
 * once per UTC day. The kind, number and colour never change afterwards —
 * "Mac 2" keeps meaning the same machine on every device of the account.
 *
 * The sweep runs first and in the same batch, so a device that expired has
 * already released its colour before a new slot is chosen.
 */
export const registerDevice = async (ownerId: string, id: string, kind: DeviceKind, env?: DeviceEnv): Promise<RegisterDeviceResult> => {
  const db = requireDb(env)
  const now = new Date().toISOString()
  const cutoff = expiryCutoff(now)
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`

  const existing = await liveDevices(db, ownerId)
  const known = existing.find((device) => device.id === id)
  if (!known && existing.length >= DEVICE_COLOUR_SLOTS) return { status: 'full' }

  await db.batch([
    // Sweep: an expired device takes its mirrors with it.
    db.prepare('DELETE FROM device_galleries WHERE owner_id = ? AND device_id IN (SELECT id FROM devices WHERE owner_id = ? AND last_seen_at < ?)')
      .bind(ownerId, ownerId, cutoff),
    db.prepare('DELETE FROM devices WHERE owner_id = ? AND last_seen_at < ?').bind(ownerId, cutoff),
    // A known device only refreshes the stamp, and only once a day.
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE owner_id = ? AND id = ? AND last_seen_at < ?')
      .bind(now, ownerId, id, dayStart),
    // A new device takes the next number for its kind and the lowest free
    // colour. Both are decided inside the statement so a concurrent register
    // cannot hand out the same pair.
    db.prepare(`INSERT INTO devices (owner_id, id, kind, ordinal, colour, first_seen_at, last_seen_at)
      SELECT ?, ?, ?, COALESCE((SELECT MAX(ordinal) FROM devices WHERE owner_id = ? AND kind = ?), 0) + 1,
        (SELECT MIN(column1) FROM (VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9), (10), (11))
          WHERE column1 NOT IN (SELECT colour FROM devices WHERE owner_id = ?)),
        ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM devices WHERE owner_id = ? AND id = ?)`)
      .bind(ownerId, id, kind, ownerId, kind, ownerId, now, now, ownerId, id),
  ])

  const row = await db.prepare(`${DEVICE_SELECT} AND id = ?`).bind(ownerId, id).first<DeviceRow>()
  const device = row ? rowToDevice(row) : null
  return device ? { status: 'ok', device } : { status: 'missing' }
}

/** Forgetting a device removes it and every mirror it published — the two
 *  only make sense together. A device still in use re-registers on its next
 *  launch with a fresh number and colour. */
export const forgetDevice = async (ownerId: string, id: string, env?: DeviceEnv): Promise<boolean> => {
  const db = requireDb(env)
  const results = await db.batch([
    db.prepare('DELETE FROM device_galleries WHERE owner_id = ? AND device_id = ?').bind(ownerId, id),
    db.prepare('DELETE FROM devices WHERE owner_id = ? AND id = ?').bind(ownerId, id),
  ])
  return (results[1]?.meta.changes ?? 0) > 0
}
