import { describe, expect, test } from 'bun:test'
import {
  createReorderSession,
  discardReorder,
  layoutPhotoRows,
  moveHeldItem,
  pickUpItem,
  putDownItem,
  reorderIsDirty,
  visibleRowRange,
} from './reorder-session'

const items = ['a', 'b', 'c', 'd'].map((id, index) => ({
  id,
  orderKey: `ref-${id}`,
  width: index % 2 ? 800 : 1200,
  height: 800,
}))

describe('reorder session', () => {
  test('tap-to-pick and tap-to-put moves by stable id and supports cancel', () => {
    const initial = createReorderSession(items)
    const held = pickUpItem(initial, 'c')
    expect(putDownItem(held, 'c').heldId).toBeNull()
    expect(reorderIsDirty(putDownItem(held, 'c'))).toBe(false)
    const moved = putDownItem(held, 'a')
    expect(moved.items.map((item) => item.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(moved.heldId).toBeNull()
    expect(reorderIsDirty(moved)).toBe(true)
  })

  test('keyboard moves keep the held item and Reset restores saved keys', () => {
    const held = pickUpItem(createReorderSession(items), 'b')
    const moved = moveHeldItem(held, 99)
    expect(moved.items.map((item) => item.id)).toEqual(['a', 'c', 'd', 'b'])
    expect(moved.heldId).toBe('b')
    const restored = discardReorder(moved)
    expect(restored.items.map((item) => item.orderKey)).toEqual(['ref-a', 'ref-b', 'ref-c', 'ref-d'])
    expect(restored.heldId).toBeNull()
    expect(reorderIsDirty(restored)).toBe(false)
  })
})

describe('photo matrix layout', () => {
  test('keeps every cell aspect-true and virtualises complete rows', () => {
    const many = [...items, ...items.map((item) => ({ ...item, id: `${item.id}-2`, orderKey: `${item.orderKey}-2` }))]
    const layout = layoutPhotoRows(many, 300, 100)
    expect(layout.rows.length).toBeGreaterThan(1)
    for (const row of layout.rows) {
      for (const cell of row.cells) expect(cell.width).toBe(100 * cell.item.width / cell.item.height)
    }
    const range = visibleRowRange(layout.rows, 100, 0, 100)
    expect(range.start).toBe(0)
    expect(range.end).toBeLessThan(layout.rows.length - 1)
  })
})
