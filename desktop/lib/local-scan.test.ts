import { describe, expect, test } from 'bun:test'
import { MAX_GALLERY_ITEMS } from '../../packages/core/imagesource'
import {
  baseName,
  classifyRoot,
  galleryTitleForRoot,
  isDesktopImageName,
  joinPath,
  mergeRescannedItems,
  placeholderFor,
  scanLocalDirectory,
  toGalleryMediaItem,
  type LocalGalleryItem,
  type LocalScanEntry,
  type ReadDir,
} from './local-scan'

const dir = (entries: LocalScanEntry[]): ReadDir => async () => entries

const file = (name: string): LocalScanEntry => ({ name, isFile: true, isDirectory: false })
const subdir = (name: string): LocalScanEntry => ({ name, isFile: false, isDirectory: true })

const tree = (entries: Record<string, LocalScanEntry[]>): ReadDir => async (path) => {
  const found = entries[path]
  if (!found) throw new Error(`ENOENT: ${path}`)
  return found
}

describe('isDesktopImageName', () => {
  test('accepts the first-build formats, case-insensitively', () => {
    for (const name of ['a.jpg', 'a.jpeg', 'a.PNG', 'a.webp', 'a.avif', 'a.heic', 'a.HEIF']) {
      expect(isDesktopImageName(name)).toBe(true)
    }
  })

  test('rejects non-images, raw, tiff, video, and dotfiles', () => {
    for (const name of ['a.tiff', 'a.tif', 'a.cr2', 'a.dng', 'a.mp4', 'a.gif', 'a.txt', 'a', '.hidden.jpg', '.DS_Store']) {
      expect(isDesktopImageName(name)).toBe(false)
    }
  })
})

describe('path helpers', () => {
  test('joinPath and baseName handle trailing separators', () => {
    expect(joinPath('/Volumes/CARD/', 'DCIM')).toBe('/Volumes/CARD/DCIM')
    expect(joinPath('/Volumes/CARD', 'IMG_1.jpg')).toBe('/Volumes/CARD/IMG_1.jpg')
    expect(baseName('/Users/a/Photos/')).toBe('Photos')
    expect(galleryTitleForRoot('/Volumes/CARD')).toBe('CARD')
    expect(galleryTitleForRoot('/')).toBe('Local folder')
    // Over-length folder names clamp to the wire title limit.
    expect(galleryTitleForRoot(`/Volumes/${'x'.repeat(200)}`).length).toBe(120)
  })

  test('classifies /Volumes roots as cards with their mount point', () => {
    expect(classifyRoot('/Volumes/CARD')).toEqual({ sourceKind: 'card', mountPoint: '/Volumes/CARD' })
    expect(classifyRoot('/Volumes/EOS_DIGITAL/DCIM')).toEqual({
      sourceKind: 'card',
      mountPoint: '/Volumes/EOS_DIGITAL',
    })
    expect(classifyRoot('/Users/a/Photos')).toEqual({ sourceKind: 'folder' })
  })
})

describe('scanLocalDirectory', () => {
  test('collects top-level images and exactly one subdir level', async () => {
    const entries = tree({
      '/card': [
        file('b.jpg'),
        file('a.png'),
        file('notes.txt'),
        subdir('DCIM'),
        subdir('deep'),
      ],
      '/card/DCIM': [file('IMG_10.jpg'), file('IMG_2.jpg'), subdir('nested')],
      '/card/DCIM/nested': [file('too-deep.jpg')],
      '/card/deep': [file('c.webp'), subdir('level2')],
      '/card/deep/level2': [file('too-deep-2.jpg')],
    })
    const scan = await scanLocalDirectory('/card', entries)
    expect(scan.items.map((item) => item.id)).toEqual(['a.png', 'b.jpg', 'DCIM/IMG_2.jpg', 'DCIM/IMG_10.jpg', 'deep/c.webp'])
    expect(scan.truncated).toBeUndefined()
    expect(scan.items.find((item) => item.id === 'DCIM/IMG_2.jpg')?.path).toBe('/card/DCIM/IMG_2.jpg')
  })

  test('carries shell-probed dims onto items, at root and in subdirs', async () => {
    const entries = tree({
      '/card': [
        { name: 'a.jpg', isFile: true, isDirectory: false, width: 3000, height: 2000 },
        { name: 'no-dims.png', isFile: true, isDirectory: false },
        { name: 'zero.webp', isFile: true, isDirectory: false, width: 0, height: 0 },
        subdir('DCIM'),
      ],
      '/card/DCIM': [{ name: 'rotated.heic', isFile: true, isDirectory: false, width: 3024, height: 4032 }],
    })
    const scan = await scanLocalDirectory('/card', entries)
    const byId = new Map(scan.items.map((item) => [item.id, item]))
    // Real dims ride the item into the catalogue, so the picker's matrix
    // cells match each photograph's aspect instead of the 1200×800 guess.
    expect(byId.get('a.jpg')).toMatchObject({ width: 3000, height: 2000 })
    expect(byId.get('DCIM/rotated.heic')).toMatchObject({ width: 3024, height: 4032 })
    // Absent or zero dims stay absent — the placeholder guess only fills
    // the render box downstream, never the record.
    expect(byId.get('no-dims.png')?.width).toBeUndefined()
    expect(byId.get('zero.webp')?.width).toBeUndefined()
  })

  test('sorts with natural collation across files and subdirs', async () => {
    const entries = tree({
      '/root': [file('IMG_10.jpg'), file('IMG_2.jpg'), file('IMG_1.jpg'), subdir('roll2')],
      '/root/roll2': [file('IMG_3.jpg')],
    })
    const scan = await scanLocalDirectory('/root', entries)
    expect(scan.items.map((item) => item.id)).toEqual(['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'roll2/IMG_3.jpg'])
  })

  test('a subdirectory that vanishes mid-scan contributes nothing', async () => {
    const flaky: ReadDir = async (path) => {
      if (path === '/card/ejected') throw new Error('ENOENT')
      return path === '/card' ? [file('top.jpg'), subdir('ejected')] : []
    }
    const scan = await scanLocalDirectory('/card', flaky)
    expect(scan.items.map((item) => item.id)).toEqual(['top.jpg'])
  })

  test('caps at MAX_GALLERY_ITEMS and reports the uncapped count', async () => {
    const names = Array.from({ length: MAX_GALLERY_ITEMS + 5 }, (_, i) => file(`IMG_${String(i).padStart(5, '0')}.jpg`))
    const scan = await scanLocalDirectory('/big', dir(names))
    expect(scan.items).toHaveLength(MAX_GALLERY_ITEMS)
    expect(scan.truncated).toBe(MAX_GALLERY_ITEMS + 5)
    // The cap keeps the FIRST items in sort order, not an arbitrary subset.
    expect(scan.items.at(-1)?.id).toBe(`IMG_${String(MAX_GALLERY_ITEMS - 1).padStart(5, '0')}.jpg`)
  })
})

describe('mergeRescannedItems', () => {
  const item = (id: string, name = id.split('/').at(-1)!): LocalGalleryItem => ({ id, name, path: `/root/${id}` })

  test('arranged positions survive a rescan; new files append in scan order', () => {
    const previous = [item('b.jpg'), item('a.jpg'), item('c.jpg')]
    const scan = [item('a.jpg'), item('b.jpg'), item('c.jpg'), item('d.jpg')]
    expect(mergeRescannedItems(scan, previous).map((i) => i.id)).toEqual(['b.jpg', 'a.jpg', 'c.jpg', 'd.jpg'])
  })

  test('vanished files drop out and fresh item data wins', () => {
    const previous = [item('gone.jpg'), { ...item('kept.jpg'), width: 100 }]
    const scan = [{ ...item('kept.jpg'), width: 4000 }]
    const merged = mergeRescannedItems(scan, previous)
    expect(merged.map((i) => i.id)).toEqual(['kept.jpg'])
    expect(merged[0]!.width).toBe(4000)
  })

  test('a first scan with no prior order is the scan itself', () => {
    const scan = [item('a.jpg'), item('b.jpg')]
    expect(mergeRescannedItems(scan, []).map((i) => i.id)).toEqual(['a.jpg', 'b.jpg'])
  })
})

describe('toGalleryMediaItem', () => {
  test('references the original via the injected URL and guesses dims until loaded', () => {
    const item = toGalleryMediaItem({ id: 'IMG_1.jpg', name: 'IMG_1.jpg', path: '/card/IMG_1.jpg' }, (p) => `asset://localhost${p}`)
    expect(item.src).toBe('asset://localhost/card/IMG_1.jpg')
    expect(item.filename).toBe('IMG_1.jpg')
    expect(item.width).toBeGreaterThan(0)
    expect(item.height).toBeGreaterThan(0)
    expect(item.c2pa).toBe(true)
    expect(item.placeholder.startsWith('data:image/svg+xml')).toBe(true)
    expect(placeholderFor(3, 2)).toContain("viewBox='0 0 3 2'")
  })

  test('uses learned dims when present', () => {
    const item = toGalleryMediaItem(
      { id: 'IMG_1.jpg', name: 'IMG_1.jpg', path: '/card/IMG_1.jpg', width: 6000, height: 4000 },
      (p) => p,
    )
    expect(item.width).toBe(6000)
    expect(item.height).toBe(4000)
  })
})
