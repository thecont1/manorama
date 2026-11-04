import { describe, expect, test } from 'bun:test'
import type { GalleryMediaItem } from './imagesource'
import { mergeMigratedImages } from './encrypted-migration'

const item = (ref: string, extra: Partial<GalleryMediaItem> = {}): GalleryMediaItem => ({
  id: `mega-${ref}`, ref, filename: `${ref}.jpg`, src: '', width: 1, height: 1, alt: '', c2pa: false, placeholder: '', ...extra,
}) as GalleryMediaItem

describe('mergeMigratedImages', () => {
  test('keeps stored order and hidden flags for items the scan still reports', () => {
    const existing = [item('a'), item('b', { hidden: true }), item('c')]
    const scanned = [item('c'), item('b'), item('a')]
    const merged = mergeMigratedImages(existing, scanned)
    expect(merged.map((i) => i.ref)).toEqual(['a', 'b', 'c'])
    expect(merged[1]?.hidden).toBe(true)
    expect(merged[0]?.hidden).toBeUndefined()
  })

  test('appends scan-only items after the retained order and drops vanished items', () => {
    const existing = [item('a'), item('gone')]
    const scanned = [item('a'), item('fresh')]
    const merged = mergeMigratedImages(existing, scanned)
    expect(merged.map((i) => i.ref)).toEqual(['a', 'fresh'])
  })

  test('takes scanned media refs over stored srcs on matched items', () => {
    const existing = [item('n1', { src: '/api/mega/file?node=n1&k=oldkey' })]
    const scanned = [item('n1', { src: '', media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'F1', nodeId: 'n1' } })]
    const merged = mergeMigratedImages(existing, scanned)
    expect(merged[0]?.src).toBe('')
    expect((merged[0] as { media?: { kind: string } }).media?.kind).toBe('encrypted')
  })

  test('falls back to filename when neither side carries a ref', () => {
    const existing = [{ ...item('x'), ref: undefined, filename: 'same.jpg' } as GalleryMediaItem]
    const scanned = [{ ...item('y'), ref: undefined, filename: 'same.jpg' } as GalleryMediaItem]
    const merged = mergeMigratedImages(existing, scanned)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe('mega-y')
  })
})
