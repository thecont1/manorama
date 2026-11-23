import { beforeEach, describe, expect, test } from 'bun:test'
import { seedTestUser } from './test-fixtures'
import {
  getUserByAccountId,
  LAST_SEEN_COUNTRY_FLOOR_MS,
  lastSeenWriteAllowed,
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
    await setLastSeenLocation(user.accountId, 'IN')
    const stored = await getUserByAccountId(user.accountId)
    expect(stored?.lastSeenAt).toBeTruthy()
    expect(stored?.lastSeenCountry).toBe('IN')
  })

  test('Cloudflare\'s unknown country never overwrites a real reading', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_xx' })
    await setLastSeenLocation(user.accountId, 'IN')
    // Sign-in path (no throttle): the timestamp still moves, the country stays.
    await setLastSeenLocation(user.accountId, 'XX')
    const stored = await getUserByAccountId(user.accountId)
    expect(stored?.lastSeenCountry).toBe('IN')
    expect(stored?.lastSeenAt).toBeTruthy()
  })

  test('touchLastSeen stamps once, then the day-throttle refuses a re-stamp', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_throttle' })
    touchLastSeen(user.accountId, { country: 'IN' })
    // The write is fire-and-forget but resolves on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const first = (await getUserByAccountId(user.accountId))?.lastSeenAt
    expect(first).toBeTruthy()
    // A second touch inside the interval must not move the stamp — wait
    // past a second boundary so a re-stamp would read differently. The
    // different country is inside the 15-minute floor, so it cannot pass
    // the country-change clause either.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    touchLastSeen(user.accountId, { country: 'DE' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await getUserByAccountId(user.accountId)
    expect(second?.lastSeenAt).toBe(first)
    expect(second?.lastSeenCountry).toBe('IN')
  })

  test('the stale guard inside setLastSeenLocation honours its interval', async () => {
    const user = await seedTestUser({ accountId: 'acct_seen_guard' })
    await setLastSeenLocation(user.accountId, 'IN')
    const first = (await getUserByAccountId(user.accountId))?.lastSeenAt
    await new Promise((resolve) => setTimeout(resolve, 1100))
    // A 60s-fresh stamp refuses the write; a 1ms interval permits it.
    await setLastSeenLocation(user.accountId, 'DE', undefined, 60_000)
    expect((await getUserByAccountId(user.accountId))?.lastSeenAt).toBe(first)
    await setLastSeenLocation(user.accountId, 'DE', undefined, 1)
    const moved = await getUserByAccountId(user.accountId)
    expect(moved?.lastSeenAt).not.toBe(first)
    expect(moved?.lastSeenCountry).toBe('DE')
  })
})

describe('lastSeenWriteAllowed', () => {
  const now = Date.parse('2026-11-23T12:00:00Z')
  const DAY = 24 * 60 * 60 * 1000

  test('sign-in and missing stamps always write', () => {
    expect(lastSeenWriteAllowed(now - 1000, 'IN', 'DE', now, 0)).toBe(true)
    expect(lastSeenWriteAllowed(undefined, undefined, 'IN', now, DAY)).toBe(true)
    expect(lastSeenWriteAllowed(NaN, undefined, 'IN', now, DAY)).toBe(true)
  })

  test('routine activity writes once the stamp is a day old', () => {
    expect(lastSeenWriteAllowed(now - DAY - 1, 'IN', 'IN', now, DAY)).toBe(true)
    expect(lastSeenWriteAllowed(now - DAY - 1, 'IN', undefined, now, DAY)).toBe(true)
  })

  test('inside the day only a different country past the floor passes', () => {
    const fresh = now - 60 * 1000
    expect(lastSeenWriteAllowed(fresh, 'IN', 'IN', now, DAY)).toBe(false)
    expect(lastSeenWriteAllowed(fresh, 'IN', 'DE', now, DAY)).toBe(false)
    expect(lastSeenWriteAllowed(fresh, 'IN', undefined, now, DAY)).toBe(false)
    const moved = now - LAST_SEEN_COUNTRY_FLOOR_MS - 1
    expect(lastSeenWriteAllowed(moved, 'IN', 'DE', now, DAY)).toBe(true)
    // A stamp with no country yet fills in on the same rule.
    expect(lastSeenWriteAllowed(moved, undefined, 'IN', now, DAY)).toBe(true)
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
