import { describe, expect, test } from 'bun:test'
import { groupConsecutivePortraits } from '../app/lib/portrait-pairs'

describe('groupConsecutivePortraits', () => {
  test('pairs only immediately consecutive portrait images and preserves source indices', () => {
    const groups = groupConsecutivePortraits([
      { id: 'landscape', width: 1600, height: 1000 },
      { id: 'portrait-a', width: 900, height: 1400 },
      { id: 'portrait-b', width: 800, height: 1500 },
      { id: 'portrait-c', width: 950, height: 1300 },
      { id: 'landscape-again', width: 1600, height: 1000 },
    ])

    expect(groups.map((group) => ({ kind: group.kind, ids: group.items.map(({ image }) => image.id), indices: group.items.map(({ imageIndex }) => imageIndex) }))).toEqual([
      { kind: 'single', ids: ['landscape'], indices: [0] },
      { kind: 'portrait-pair', ids: ['portrait-a', 'portrait-b'], indices: [1, 2] },
      { kind: 'single', ids: ['portrait-c'], indices: [3] },
      { kind: 'single', ids: ['landscape-again'], indices: [4] },
    ])
  })
})
