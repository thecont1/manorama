import { describe, expect, test } from 'bun:test'
import { libraryLayout, LIBRARY_STRIP_LIMIT, PIN_LIMIT } from './library-layout'

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
    // A downgrade keeps every retained gallery — the retained cap binds on
    // creation, not retroactively — so the overflow must land in compact
    // cards rather than in neither list.
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('pipe', { retention: 'pipeline' })]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['a', 'b', 'c'],
      compact: ['d', 'pipe'],
    })
  })

  test('pro with no pins: the three most recent strip, the rest compact', () => {
    const layout = libraryLayout(slugs(12), 'pro')
    expect(layout.strips).toEqual(['g-0', 'g-1', 'g-2'])
    expect(layout.compact).toEqual(slugs(9).map((_, index) => `g-${index + 3}`))
  })

  test('pro: pinned galleries lead by pinnedAt, recency fills to the limit', () => {
    const entries = slugs(12)
    entries[10].pinnedAt = '2026-10-02T00:00:00.000Z'
    entries[11].pinnedAt = '2026-10-01T00:00:00.000Z'
    const layout = libraryLayout(entries, 'pro')
    // Oldest pin first; then the most recent unpinned until three.
    expect(layout.strips).toEqual(['g-11', 'g-10', 'g-0'])
    expect(layout.compact).toEqual(['g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'g-6', 'g-7', 'g-8', 'g-9'])
  })

  test('pro: a pin bump in past the limit drops the oldest recent strip', () => {
    const entries = slugs(12)
    entries[0].pinnedAt = '2026-10-01T00:00:00.000Z'
    entries[1].pinnedAt = '2026-10-02T00:00:00.000Z'
    const layout = libraryLayout(entries, 'pro')
    // Two pins lead; g-2 is the most recent unpinned and takes slot three.
    expect(layout.strips).toEqual(['g-0', 'g-1', 'g-2'])
    expect(layout.compact[0]).toBe('g-3')
  })

  test('fewer galleries than the limit gives no compact cards', () => {
    expect(libraryLayout(slugs(2), 'pro').compact).toEqual([])
    expect(libraryLayout(slugs(2), 'pro').strips).toHaveLength(2)
    expect(libraryLayout([], 'pro')).toEqual({ strips: [], compact: [] })
  })

  test('the strip limit and the pin limit are the same three', () => {
    // A pin is a claim on a strip slot — a fourth pin has nowhere to go.
    expect(LIBRARY_STRIP_LIMIT).toBe(3)
    expect(PIN_LIMIT).toBe(LIBRARY_STRIP_LIMIT)
  })
})
