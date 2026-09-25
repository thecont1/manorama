import { beforeEach, describe, expect, test } from 'bun:test'
import {
  adSuppressionFor,
  clearAdSuppression,
  listAdSuppressions,
  resetAdSuppressionStore,
  setAdSuppression,
} from './ads-visibility'

// No DB binding -> the repository's in-memory store, the same path the dev
// server takes.
beforeEach(() => resetAdSuppressionStore())

describe('ad suppression store', () => {
  test('a day suppression hides plates for that UTC day only', async () => {
    await setAdSuppression('day', '2026-10-01')
    expect(await adSuppressionFor('2026-10-01', 'US')).toBe('day')
    expect(await adSuppressionFor('2026-10-02', 'US')).toBeNull()
  })

  test('a region suppression hides plates for that region only', async () => {
    await setAdSuppression('region', 'IN')
    expect(await adSuppressionFor('2026-10-01', 'IN')).toBe('region')
    expect(await adSuppressionFor('2026-10-01', 'DE')).toBeNull()
    // An undetermined region never matches.
    expect(await adSuppressionFor('2026-10-01', '')).toBeNull()
  })

  test('suppression is idempotent and clearable', async () => {
    await setAdSuppression('region', 'IN')
    await setAdSuppression('region', 'IN')
    expect((await listAdSuppressions()).filter((row) => row.kind === 'region' && row.value === 'IN')).toHaveLength(1)
    await clearAdSuppression('region', 'IN')
    expect(await adSuppressionFor('2026-10-01', 'IN')).toBeNull()
    expect(await listAdSuppressions()).toHaveLength(0)
  })

  test('the list round-trips kind, value and ordering', async () => {
    await setAdSuppression('region', 'US')
    await setAdSuppression('day', '2026-10-01')
    const rows = await listAdSuppressions()
    expect(rows.map((row) => `${row.kind}:${row.value}`)).toEqual(['day:2026-10-01', 'region:US'])
    expect(rows[0].createdAt).toBeTruthy()
  })
})
