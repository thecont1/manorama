import { describe, expect, test } from 'bun:test'
import { summarizeAccountActivity } from './admin-account-stats'

const NOW = Date.parse('2026-11-23T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const gallery = (overrides: Record<string, unknown> = {}) => ({
  owner_id: 'acct_a',
  source_url: null,
  retention: 'retained',
  expires_at: null,
  hidden_at: null,
  created_at: '2026-11-01 10:00:00',
  media_count: 0,
  ...overrides,
})

const device = (overrides: Record<string, unknown> = {}) => ({
  owner_id: 'acct_a',
  kind: 'iphone',
  last_seen_at: new Date(NOW - DAY).toISOString(),
  ...overrides,
})

describe('summarizeAccountActivity', () => {
  test('counts sources by provider, most-used first, without leaking URLs', () => {
    const { sources } = summarizeAccountActivity([
      gallery({ source_url: 'https://www.dropbox.com/scl/fo/abc/xyz?rlkey=1', media_count: 3 }),
      gallery({ source_url: 'https://drive.google.com/drive/folders/abc', media_count: 2 }),
      gallery({ source_url: 'https://www.dropbox.com/scl/fo/def/uvw?rlkey=2', media_count: 4 }),
      gallery({ source_url: 'https://example.com/not-a-provider' }),
      gallery({ source_url: null }),
    ], [], NOW).get('acct_a')!
    expect(sources).toEqual([
      { provider: 'dropbox', count: 2 },
      { provider: 'gdrive', count: 1 },
      { provider: 'other', count: 1 },
    ])
    expect(JSON.stringify(sources)).not.toContain('scl/fo')
  })

  test('temporary galleries count only future expiries for nextGalleryExpiryAt', () => {
    const { temporaryGalleryCount, nextGalleryExpiryAt } = summarizeAccountActivity([
      gallery({ retention: 'pipeline', expires_at: new Date(NOW + 10 * DAY).toISOString() }),
      gallery({ retention: 'pipeline', expires_at: new Date(NOW + 4 * DAY).toISOString() }),
      gallery({ retention: 'pipeline', expires_at: new Date(NOW - DAY).toISOString() }),
      gallery({ retention: 'retained', expires_at: null }),
    ], [], NOW).get('acct_a')!
    expect(temporaryGalleryCount).toBe(3)
    expect(nextGalleryExpiryAt).toBe(new Date(NOW + 4 * DAY).toISOString())
  })

  test('hidden galleries and media counts aggregate per owner', () => {
    const activity = summarizeAccountActivity([
      gallery({ hidden_at: '2026-11-02 00:00:00', media_count: 5 }),
      gallery({ owner_id: 'acct_b', hidden_at: null, media_count: 7 }),
      gallery({ media_count: 'not-a-number' }),
    ], [], NOW)
    expect(activity.get('acct_a')).toMatchObject({ hiddenGalleryCount: 1, mediaCount: 5 })
    expect(activity.get('acct_b')).toMatchObject({ hiddenGalleryCount: 0, mediaCount: 7 })
  })

  test('latestGalleryAt is the newest created_at', () => {
    const { latestGalleryAt } = summarizeAccountActivity([
      gallery({ created_at: '2026-10-01 09:00:00' }),
      gallery({ created_at: '2026-11-20 18:30:00' }),
      gallery({ created_at: '2026-11-05 00:00:00' }),
    ], [], NOW).get('acct_a')!
    expect(latestGalleryAt).toBe('2026-11-20 18:30:00')
  })

  test('devices count live kinds in DEVICE_KINDS order; expired and malformed rows drop', () => {
    const { devices } = summarizeAccountActivity([], [
      device({ kind: 'mac' }),
      device({ kind: 'iphone' }),
      device({ kind: 'mac' }),
      device({ kind: 'android', last_seen_at: new Date(NOW - 200 * DAY).toISOString() }),
      device({ kind: 'toaster' }),
      device({ owner_id: undefined }),
    ], NOW).get('acct_a')!
    expect(devices).toEqual([
      { kind: 'mac', count: 2 },
      { kind: 'iphone', count: 1 },
    ])
  })

  test('an owner with only devices still gets an entry; unknown owners are skipped', () => {
    const activity = summarizeAccountActivity([], [device({ owner_id: 'acct_only_devices' })], NOW)
    expect(activity.get('acct_only_devices')?.devices).toEqual([{ kind: 'iphone', count: 1 }])
    expect(activity.get('acct_missing')).toBeUndefined()
  })
})
