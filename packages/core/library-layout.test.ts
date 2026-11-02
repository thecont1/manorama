import { describe, expect, test } from 'bun:test'
import { libraryLayout } from './library-layout'

const entry = (slug: string, extra: Partial<{ retention: 'retained' | 'pipeline'; pinnedAt: string | null }> = {}) =>
  ({ slug, retention: 'retained' as const, pinnedAt: null, ...extra })

const slugs = (count: number, prefix = 'g') => Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`))

describe('libraryLayout', () => {
  test('free: the retained set strips, pipeline galleries compact', () => {
    const entries = [
      entry('a'), entry('pipe-1', { retention: 'pipeline' }),
      entry('b'), entry('c'), entry('pipe-2', { retention: 'pipeline' }),
    ]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['a', 'b', 'c'],
      compact: ['pipe-1', 'pipe-2'],
    })
  })

  test('free: every retained gallery strips — permanence is what the section shows', () => {
    // A downgrade keeps every retained gallery — the cap binds at pin
    // time, not retroactively — so an over-cap surplus is still permanent
    // and still belongs under "Your galleries".
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('pipe', { retention: 'pipeline' })]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['a', 'b', 'c', 'd'],
      compact: ['pipe'],
    })
  })

  test('free: pinned retained galleries lead by pinnedAt, legacy unpinned follow', () => {
    const entries = [
      entry('a', { pinnedAt: '2026-10-02T00:00:00.000Z' }),
      entry('legacy'),
      entry('b', { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      entry('pipe', { retention: 'pipeline' }),
    ]
    expect(libraryLayout(entries, 'free')).toEqual({
      strips: ['b', 'a', 'legacy'],
      compact: ['pipe'],
    })
  })

  test('pro: with no pins everything is a compact card', () => {
    const layout = libraryLayout(slugs(12), 'pro')
    expect(layout.strips).toEqual([])
    expect(layout.compact).toEqual(slugs(12).map((item) => item.slug))
  })

  test('pro: pinned galleries strip, oldest pin first, with no cap', () => {
    const entries = slugs(12)
    for (let index = 4; index < 9; index += 1) {
      entries[index].pinnedAt = `2026-10-0${index - 3}T00:00:00.000Z`
    }
    const layout = libraryLayout(entries, 'pro')
    // Five pins, five strips — Visionary pins any number.
    expect(layout.strips).toEqual(['g-4', 'g-5', 'g-6', 'g-7', 'g-8'])
    expect(layout.compact).toEqual(['g-0', 'g-1', 'g-2', 'g-3', 'g-9', 'g-10', 'g-11'])
  })

  test('empty and small libraries still resolve both lists', () => {
    expect(libraryLayout(slugs(2), 'pro').compact).toEqual(slugs(2).map((item) => item.slug))
    expect(libraryLayout([], 'pro')).toEqual({ strips: [], compact: [] })
    expect(libraryLayout([], 'free')).toEqual({ strips: [], compact: [] })
  })
})
