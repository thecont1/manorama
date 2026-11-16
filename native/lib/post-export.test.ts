import { describe, expect, test } from 'bun:test'
import type { ImageProgramRuntime } from './image-program'
import {
  exportPhotosForShare,
  toBase64,
  type PostFileStore,
  type PostPhotoReader,
  type PostShareSheet,
} from './post-export'
import type { PostToXPhoto } from './post-to-x'

/**
 * The export's contract: every photograph is prepared on the device, the
 * files reach the share sheet in the gallery's order, a photograph that cannot
 * be prepared is left out and counted rather than failing the post, and the
 * folder the photographs were written into is taken away afterwards.
 */

const photo = (id: string): PostToXPhoto => ({
  id,
  filename: `${id}.jpg`,
  width: 3000,
  height: 2000,
  alt: `Photograph ${id}`,
  src: `https://manorama.test/api/dropbox/file?filename=${id}.jpg`,
  preview: `https://manorama.test/api/dropbox/thumbnail?filename=${id}.jpg`,
  encrypted: false,
})

const bytes = (length: number) => new Uint8Array(length).fill(3)

/** A runtime that reports a fixed size and records the sizes it was asked for. */
const runtime = (width: number, height: number, encoded: number[][] = []): ImageProgramRuntime => ({
  decode: async () => ({
    width,
    height,
    encode: async (target: { width: number; height: number }) => {
      encoded.push([target.width, target.height])
      return bytes(8)
    },
  }),
})

type StoreCall = { path: string; base64: string }
const fakeStore = () => {
  const writes: StoreCall[] = []
  const removals: string[] = []
  const store: PostFileStore = {
    write: async (path, base64) => {
      writes.push({ path, base64 })
      return `file:///cache/${path}`
    },
    remove: async (path) => { removals.push(path) },
  }
  return { store, writes, removals }
}

const fakeSheet = () => {
  const shares: { title?: string; text?: string; url?: string; files?: string[] }[] = []
  const sheet: PostShareSheet = {
    share: async (options) => { shares.push(options) },
  }
  return { sheet, shares }
}

const reader = (available: readonly string[]): PostPhotoReader => async (each) =>
  available.includes(each.id) ? { bytes: bytes(2048), mimeType: 'image/jpeg' } : undefined

describe('toBase64', () => {
  test('encodes bytes without blowing the argument limit', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=')
    const large = new Uint8Array(0x8000 + 10).fill(65)
    expect(atob(toBase64(large)).length).toBe(large.length)
  })
})

describe('exportPhotosForShare', () => {
  test('prepares every photograph and hands the files to the share sheet', async () => {
    const { store, writes, removals } = fakeStore()
    const { sheet, shares } = fakeSheet()
    const encoded: number[][] = []
    const report = await exportPhotosForShare({
      photos: [photo('a'), photo('b')],
      text: 'Fog over the harbour',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a', 'b']),
      runtime: runtime(3000, 2000, encoded),
      sheet,
      store,
    })

    expect(report.outcome).toBe('shared')
    expect(report.posted).toBe(2)
    expect(report.skipped).toBe(0)
    // The long edge is X's ceiling, and the portrait fits inside it.
    expect(encoded).toEqual([[2048, 1365], [2048, 1365]])
    expect(writes.map((write) => write.path)).toEqual([
      expect.stringContaining('01-a.jpg'),
      expect.stringContaining('02-b.jpg'),
    ])
    expect(shares).toHaveLength(1)
    expect(shares[0].files).toHaveLength(2)
    expect(shares[0].text).toBe('Fog over the harbour')
    expect(shares[0].url).toBe('https://manorama.xyz/quiet-owner/kashmir')
    // The photographs were never a saved copy: the folder is taken away.
    expect(removals).toHaveLength(1)
  })

  test('leaves out a photograph that cannot be read, and counts it', async () => {
    const { store } = fakeStore()
    const { sheet, shares } = fakeSheet()
    const report = await exportPhotosForShare({
      photos: [photo('a'), photo('b')],
      text: '',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a']),
      runtime: runtime(3000, 2000),
      sheet,
      store,
    })
    expect(report.outcome).toBe('shared')
    expect(report.posted).toBe(1)
    expect(report.skipped).toBe(1)
    expect(shares[0].files).toHaveLength(1)
  })

  test('leaves out a photograph the device cannot decode, and counts it', async () => {
    const { store } = fakeStore()
    const { sheet } = fakeSheet()
    const failing: ImageProgramRuntime = {
      decode: async () => { throw new Error('This device could not read that photograph') },
    }
    const report = await exportPhotosForShare({
      photos: [photo('a')],
      text: '',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a']),
      runtime: failing,
      sheet,
      store,
    })
    expect(report.outcome).toBe('failed')
    expect(report.posted).toBe(0)
    expect(report.skipped).toBe(1)
    expect(report.note).toContain('could not be prepared')
  })

  test('reports a cancelled share as a cancellation, not a failure', async () => {
    const { store } = fakeStore()
    const sheet: PostShareSheet = {
      share: async () => { throw new Error('Share canceled') },
    }
    const report = await exportPhotosForShare({
      photos: [photo('a')],
      text: '',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a']),
      runtime: runtime(3000, 2000),
      sheet,
      store,
    })
    expect(report.outcome).toBe('cancelled')
    expect(report.note).toBe('')
  })

  test('reports a share sheet that refuses as a failure', async () => {
    const { store } = fakeStore()
    const sheet: PostShareSheet = {
      share: async () => { throw new Error('the sheet exploded') },
    }
    const report = await exportPhotosForShare({
      photos: [photo('a')],
      text: '',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a']),
      runtime: runtime(3000, 2000),
      sheet,
      store,
    })
    expect(report.outcome).toBe('failed')
    expect(report.note).toContain('share sheet')
  })

  test('takes the folder away even when the share fails', async () => {
    const { store, removals } = fakeStore()
    const sheet: PostShareSheet = {
      share: async () => { throw new Error('the sheet exploded') },
    }
    await exportPhotosForShare({
      photos: [photo('a')],
      text: '',
      title: 'Kashmir',
      url: 'https://manorama.xyz/quiet-owner/kashmir',
      read: reader(['a']),
      runtime: runtime(3000, 2000),
      sheet,
      store,
    })
    expect(removals).toHaveLength(1)
  })
})
