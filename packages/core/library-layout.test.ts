import { describe, expect, test } from 'bun:test'
import { libraryLayout } from './library-layout'

const entry = (slug: string, extra: Partial<{ retention: 'retained' | 'pipeline'; pinnedAt: string | null; position: number | null }> = {}) =>
  ({ slug, retention: 'retained' as const, pinnedAt: null, ...extra })

const slugs = (count: number, prefix = 'g') => Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`))

describe('libraryLayout', () => {
  test('pinned galleries strip on every tier and keep their home card — the pin is display only', () => {
    // Retention never decides the section: a retained-unpinned gallery
    // compacts next to a pipeline one, and a pinned pipeline gallery
    // strips right alongside the permanent set while staying compact.
    const entries = [
      entry('kept', { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      entry('a'), entry('b'),
      entry('pipe', { retention: 'pipeline' }),
      entry('temp-pinned', { retention: 'pipeline', pinnedAt: '2026-10-02T00:00:00.000Z' }),
    ]
    for (const tier of ['free', 'pro'] as const) {
      expect(libraryLayout(entries, tier)).toEqual({
        strips: ['kept', 'temp-pinned'],
        // Every gallery keeps its home card — pinned ones included, in
        // arrival order like any unpositioned card.
        compact: ['kept', 'a', 'b', 'pipe', 'temp-pinned'],
      })
    }
  })

  test('with no pins everything is a compact card', () => {
    for (const tier of ['free', 'pro'] as const) {
      const layout = libraryLayout(slugs(12), tier)
      expect(layout.strips).toEqual([])
      expect(layout.compact).toEqual(slugs(12).map((item) => item.slug))
    }
  })

  test('pinned galleries strip oldest pin first, with no cap', () => {
    const entries = slugs(12)
    for (let index = 4; index < 9; index += 1) {
      entries[index].pinnedAt = `2026-10-0${index - 3}T00:00:00.000Z`
    }
    const layout = libraryLayout(entries, 'pro')
    // Five pins, five strips — pinning spends no permanence, so no limit.
    expect(layout.strips).toEqual(['g-4', 'g-5', 'g-6', 'g-7', 'g-8'])
    // And all twelve keep their home cards in arrival order.
    expect(layout.compact).toEqual(slugs(12).map((item) => item.slug))
  })

  test('empty and small libraries still resolve both lists', () => {
    expect(libraryLayout(slugs(2), 'pro').compact).toEqual(slugs(2).map((item) => item.slug))
    expect(libraryLayout([], 'pro')).toEqual({ strips: [], compact: [] })
    expect(libraryLayout([], 'free')).toEqual({ strips: [], compact: [] })
  })

  test('a manual position outranks pin date inside the strip section only', () => {
    const entries = [
      entry('old-pin', { pinnedAt: '2026-01-01T00:00:00.000Z' }),
      entry('new-pin', { pinnedAt: '2026-10-01T00:00:00.000Z', position: 0 }),
      entry('mid-pin', { pinnedAt: '2026-06-01T00:00:00.000Z', position: 1 }),
      entry('late-pin', { pinnedAt: '2026-12-01T00:00:00.000Z' }),
    ]
    // Positioned pins lead in rank order; the unpositioned ones keep
    // their pin-date order at the tail.
    expect(libraryLayout(entries, 'pro').strips).toEqual(['new-pin', 'mid-pin', 'old-pin', 'late-pin'])
    // In the home section a pin's position belongs to the strip rank
    // space — every pinned card keeps arrival order instead.
    expect(libraryLayout(entries, 'pro').compact).toEqual(['old-pin', 'new-pin', 'mid-pin', 'late-pin'])
  })

  test('a manual position reorders home cards without disturbing pin membership', () => {
    const entries = [
      entry('a'), entry('b', { position: 0 }), entry('c'), entry('d', { position: 1 }),
      entry('pinned', { pinnedAt: '2026-01-01T00:00:00.000Z', position: 5 }),
    ]
    const layout = libraryLayout(entries, 'pro')
    expect(layout.strips).toEqual(['pinned'])
    // Positioned home cards lead in rank order; unpositioned keep
    // arrival order behind them — the pinned card joins them at its
    // arrival slot rather than its strip rank.
    expect(layout.compact).toEqual(['b', 'd', 'a', 'c', 'pinned'])
  })

  test('a pinned card keeps its arrival slot between positioned and unpositioned home cards', () => {
    const entries = [
      entry('top', { position: 0 }),
      entry('pinned-mid', { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      entry('plain'),
      entry('bottom', { position: 1 }),
    ]
    const layout = libraryLayout(entries, 'pro')
    expect(layout.strips).toEqual(['pinned-mid'])
    // Positioned cards still lead; the pinned card sits in arrival order
    // among the unpositioned, exactly where it would sit unpinned.
    expect(layout.compact).toEqual(['top', 'bottom', 'pinned-mid', 'plain'])
  })
})
