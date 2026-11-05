import { describe, expect, test } from 'bun:test'
import { libraryLayout } from './library-layout'

const entry = (slug: string, extra: Partial<{ retention: 'retained' | 'pipeline'; pinnedAt: string | null }> = {}) =>
  ({ slug, retention: 'retained' as const, pinnedAt: null, ...extra })

const slugs = (count: number, prefix = 'g') => Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`))

describe('libraryLayout', () => {
  test('pinned galleries strip on every tier — the pin is display only', () => {
    // Retention never decides the section: a retained-unpinned gallery
    // compacts next to a pipeline one, and a pinned pipeline gallery
    // strips right alongside the permanent set.
    const entries = [
      entry('kept', { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      entry('a'), entry('b'),
      entry('pipe', { retention: 'pipeline' }),
      entry('temp-pinned', { retention: 'pipeline', pinnedAt: '2026-10-02T00:00:00.000Z' }),
    ]
    for (const tier of ['free', 'pro'] as const) {
      expect(libraryLayout(entries, tier)).toEqual({
        strips: ['kept', 'temp-pinned'],
        compact: ['a', 'b', 'pipe'],
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
    expect(layout.compact).toEqual(['g-0', 'g-1', 'g-2', 'g-3', 'g-9', 'g-10', 'g-11'])
  })

  test('empty and small libraries still resolve both lists', () => {
    expect(libraryLayout(slugs(2), 'pro').compact).toEqual(slugs(2).map((item) => item.slug))
    expect(libraryLayout([], 'pro')).toEqual({ strips: [], compact: [] })
    expect(libraryLayout([], 'free')).toEqual({ strips: [], compact: [] })
  })
})
