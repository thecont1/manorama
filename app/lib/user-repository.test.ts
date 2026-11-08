import { beforeEach, describe, expect, test } from 'bun:test'
import { seedTestUser } from './test-fixtures'
import {
  getUserByAccountId,
  resetUserStore,
  setLastSeenLocation,
  touchLastSeen,
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
