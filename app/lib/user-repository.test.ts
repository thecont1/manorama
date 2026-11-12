import { beforeEach, describe, expect, test } from 'bun:test'
import { seedTestUser } from './test-fixtures'
import {
  getUserByAccountId,
  OWNER_SLUG_MAX,
  resetUserStore,
  setLastSeenLocation,
  touchLastSeen,
  upsertUser,
} from './user-repository'

beforeEach(() => {
  resetUserStore()
})

describe('last-seen activity', () => {
  test('a sign-in stamp lands unconditionally', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_plain' })
    await setLastSeenLocation(user.accountId, 'IN', 'BOM')
    const stored = await getUserByAccountId(user.accountId)
    expect(stored?.lastSeenAt).toBeTruthy()
    expect(stored?.lastSeenCountry).toBe('IN')
    expect(stored?.lastSeenColo).toBe('BOM')
  })

  test('touchLastSeen stamps once, then the day-throttle refuses a re-stamp', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_throttle' })
    touchLastSeen(user.accountId, { country: 'IN', colo: 'BOM' })
    // The write is fire-and-forget but resolves on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const first = (await getUserByAccountId(user.accountId))?.lastSeenAt
    expect(first).toBeTruthy()
    // A second touch inside the interval must not move the stamp — wait
    // past a second boundary so a re-stamp would read differently.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    touchLastSeen(user.accountId, { country: 'DE', colo: 'FRA' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await getUserByAccountId(user.accountId)
    expect(second?.lastSeenAt).toBe(first)
    expect(second?.lastSeenCountry).toBe('IN')
  })

  test('the stale guard inside setLastSeenLocation honours its interval', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_guard' })
    await setLastSeenLocation(user.accountId, 'IN', 'BOM')
    const first = (await getUserByAccountId(user.accountId))?.lastSeenAt
    await new Promise((resolve) => setTimeout(resolve, 1100))
    // A 60s-fresh stamp refuses the write; a 1ms interval permits it.
    await setLastSeenLocation(user.accountId, 'DE', 'FRA', undefined, 60_000)
    expect((await getUserByAccountId(user.accountId))?.lastSeenAt).toBe(first)
    await setLastSeenLocation(user.accountId, 'DE', 'FRA', undefined, 1)
    const moved = await getUserByAccountId(user.accountId)
    expect(moved?.lastSeenAt).not.toBe(first)
    expect(moved?.lastSeenCountry).toBe('DE')
  })
})

describe('derived owner slugs', () => {
  test('a suffixed slug never exceeds the 48-character cap', async () => {
    // A 48-char base that is already taken forces the numeric-suffix path —
    // the stem must yield to keep the derived slug inside the cap.
    const longName = 'a'.repeat(60)
    const first = await upsertUser({ accountId: 'acct_slug_long1', displayName: longName })
    expect(first.ownerSlug).toBe('a'.repeat(OWNER_SLUG_MAX))
    const second = await upsertUser({ accountId: 'acct_slug_long2', displayName: longName })
    expect(second.ownerSlug.length).toBeLessThanOrEqual(OWNER_SLUG_MAX)
    expect(second.ownerSlug.endsWith('-2')).toBe(true)
    const third = await upsertUser({ accountId: 'acct_slug_long3', displayName: longName })
    expect(third.ownerSlug.length).toBeLessThanOrEqual(OWNER_SLUG_MAX)
    expect(third.ownerSlug.endsWith('-3')).toBe(true)
  })
})
