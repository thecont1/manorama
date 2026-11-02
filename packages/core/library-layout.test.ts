import { describe, expect, test } from 'bun:test'
import { libraryLayout, STRIP_LIMIT_PRO, STRIP_PREVIEW_ITEMS } from './library-layout'

const entry = (slug: string, extra: Partial<{ retention: 'retained' | 'pipeline'; pinnedAt: string | null }> = {}) =>
  ({ slug, retention: 'retained' as const, pinnedAt: null, ...extra })

const slugs = (count: number, prefix = 'g') => Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`))

describe('libraryLayout', () => {
  test('free: retained galleries strip, pipeline galleries compact', () => {
    const entries = [
      entry('a'), entry('pipe-1', { retention: 'pipeline' }),
      entry('b'), entry('c'), entry('pipe-2', { retention: 'pipeline' }),
    ]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['a', 'b', 'c'],
      compact: ['pipe-1', 'pipe-2'],
    })
  })

  test('free: retained galleries past the cap compact instead of disappearing', () => {
    // A downgrade keeps every retained gallery — the FREE_RETAINED_LIMIT
    // cap binds on creation, not retroactively — so the overflow must land
    // in compact rows rather than in neither list.
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('pipe', { retention: 'pipeline' })]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['a', 'b', 'c'],
      compact: ['d', 'pipe'],
    })
  })

  test('pro with no pins: the ten most recent strip, the rest compact', () => {
    const layout = libraryLayout(slugs(12), 'pro')
    expect(layout.strips).toHaveLength(STRIP_LIMIT_PRO)
    expect(layout.strips[0]).toBe('g-0')
    expect(layout.compact).toEqual(['g-10', 'g-11'])
  })

  test('pro: pinned galleries lead by pinnedAt, recency fills to the cap', () => {
    const entries = slugs(12)
    entries[10].pinnedAt = '2026-10-02T00:00:00.000Z'
    entries[11].pinnedAt = '2026-10-01T00:00:00.000Z'
    const layout = libraryLayout(entries, 'pro')
    // Oldest pin first; then the most recent unpinned until ten.
    expect(layout.strips.slice(0, 2)).toEqual(['g-11', 'g-10'])
    expect(layout.strips.slice(2)).toEqual(['g-0', 'g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'g-6', 'g-7'])
    expect(layout.compact).toEqual(['g-8', 'g-9'])
  })

  test('pro: a pin bump in past the cap drops the oldest recent strip', () => {
    const entries = slugs(12)
    entries.forEach((item, index) => {
      if (index < 10 && index !== 9) item.pinnedAt = `2026-10-0${index + 1}T00:00:00.000Z`
    })
    const layout = libraryLayout(entries, 'pro')
    // Nine pins lead; g-9 is the most recent unpinned and takes slot ten.
    expect(layout.strips).toHaveLength(10)
    expect(layout.strips[0]).toBe('g-0')
    expect(layout.strips[9]).toBe('g-9')
    expect(layout.compact).toEqual(['g-10', 'g-11'])
  })

  test('fewer galleries than the cap gives no compact rows', () => {
    expect(libraryLayout(slugs(4), 'pro').compact).toEqual([])
    expect(libraryLayout(slugs(4), 'pro').strips).toHaveLength(4)
    expect(libraryLayout([], 'pro')).toEqual({ strips: [], compact: [] })
    expect(STRIP_PREVIEW_ITEMS).toBe(12)
  })
})
