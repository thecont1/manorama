import { describe, expect, test } from 'bun:test'
import { toSummary, type GalleryRecord } from './gallery-repository'
import type { GalleryImage, VideoItem } from './imagesource'

const still = (id: string, hidden = false): GalleryImage => ({
  id, filename: `${id}.jpg`, src: `/images/${id}.jpg`, width: 4, height: 3,
  alt: 'a photograph', c2pa: false, placeholder: '', ...(hidden ? { hidden: true as const } : {}),
})
const video = (id: string, hidden = false): VideoItem => ({
  type: 'video', id, filename: `${id}.mp4`, src: `/videos/${id}.mp4`, mimeType: 'video/mp4',
  width: 4, height: 3, poster: { src: `/posters/${id}.jpg`, width: 4, height: 3 },
  alt: 'a video', c2pa: false, placeholder: '', ...(hidden ? { hidden: true as const } : {}),
})
const record = (images: GalleryRecord['images']): GalleryRecord => ({
  slug: 'mixed', title: 'Mixed', caption: '', date: '', images,
})

describe('toSummary mediaCount', () => {
  test('counts visible stills and videos separately and hidden on its own', () => {
    const summary = toSummary(record([still('a'), still('b'), video('v'), still('hid-p', true), video('hid-v', true)]))
    expect(summary.mediaCount).toEqual({ stills: 2, videos: 1, hidden: 2 })
    // imageCount stays the full count — the vault's "Saving n of m" reads it.
    expect(summary.imageCount).toBe(5)
  })

  test('an all-still gallery reports no videos and no hidden', () => {
    const summary = toSummary(record([still('a'), still('b')]))
    expect(summary.mediaCount).toEqual({ stills: 2, videos: 0, hidden: 0 })
  })

  test('a fully hidden gallery reports zero visible media', () => {
    const summary = toSummary(record([still('a', true), video('v', true)]))
    expect(summary.mediaCount).toEqual({ stills: 0, videos: 0, hidden: 2 })
  })
})

describe('toLibrarySummaries', () => {
  const named = (slug: string, images: GalleryRecord['images'], extra: Partial<GalleryRecord> = {}): GalleryRecord => ({
    slug, title: slug, caption: '', date: '', images, ...extra,
  })

  test('strip galleries ship the whole rail incl. hidden; counts stay full', async () => {
    const { toLibrarySummaries } = await import('./gallery-repository')
    const images = Array.from({ length: 20 }, (_, index) => still(`i${index}`, index === 3))
    // Visionary strips are the pinned set — these three carry the pin.
    const summaries = toLibrarySummaries([
      named('new', images, { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      named('old', [still('a'), still('hidden-cover', true)], { pinnedAt: '2026-10-02T00:00:00.000Z' }),
      named('blank', [still('h1', true), still('h2', true)], { pinnedAt: '2026-10-03T00:00:00.000Z' }),
      named('x1', [still('x')]), named('x2', [still('x')]), named('x3', [still('x')]),
      named('x4', [still('x')]), named('x5', [still('x')]), named('x6', [still('x')]),
      named('x7', [still('x')]), named('x8', [still('x')]), named('x9', [still('x')]),
      named('x10', [still('x')]), named('x11', [still('x')]),
    ], 'pro')
    const strip = summaries[0]
    expect(strip.layout).toBe('strip')
    // The rail is the whole gallery — no preview window, no "+N" tile.
    expect(strip.images).toHaveLength(20)
    expect(strip.images[3].hidden).toBe(true)
    expect(strip.imageCount).toBe(20)
    expect(strip.mediaCount).toEqual({ stills: 19, videos: 0, hidden: 1 })
    const compact = summaries.find((summary) => summary.layout === 'compact')
    expect(compact).toBeTruthy()
    // Compact galleries ship exactly one cover; the hidden item did not count.
    expect(compact!.images).toHaveLength(1)
    expect(compact!.images[0].id).toBe('x')
  })

  test('compact galleries ship exactly their first visible item', async () => {
    const { toLibrarySummaries } = await import('./gallery-repository')
    const records = Array.from({ length: 13 }, (_, index) => named(`g-${index}`, [still(`s-${index}`)]))
    // Three pins is three strips; g-12 lands in compact territory and its
    // first item is hidden, so its cover must be the second.
    for (const index of [0, 1, 2]) records[index].pinnedAt = `2026-10-0${index + 1}T00:00:00.000Z`
    records[12].images = [still('hid', true), still('cover')]
    const summaries = toLibrarySummaries(records, 'pro')
    const compact = summaries.filter((summary) => summary.layout === 'compact')
    expect(compact).toHaveLength(10)
    expect(compact.every((summary) => summary.images.length === 1)).toBe(true)
    expect(compact[9].images[0].id).toBe('cover')
    // A compact gallery whose items are all hidden ships an empty cover.
    const tail = toLibrarySummaries([...records.slice(0, 12), named('dark', [still('h', true)])], 'pro')
    expect(tail[12].layout).toBe('compact')
    expect(tail[12].images).toEqual([])
  })
})

describe('setGalleryPinned', () => {
  test('pin and unpin round-trip through the in-memory store', async () => {
    const { createGallery, getGallery, listGalleries, resetGalleryStore, setGalleryPinned } = await import('./gallery-repository')
    const { resetUserStore, upsertUser } = await import('./user-repository')
    resetUserStore()
    resetGalleryStore()
    const user = await upsertUser({ accountId: 'dbid:test-pin', displayName: 'Pin QA' })
    await createGallery(user.accountId, { slug: 'pintest', title: 'Pin', caption: '', date: '', images: [still('p')] })
    const pinned = await setGalleryPinned(user.accountId, 'pintest', true)
    expect(pinned?.pinnedAt).toBeTruthy()
    const listed = await listGalleries(user.accountId)
    expect(listed[0].pinnedAt).toBe(pinned!.pinnedAt)
    const summary = (await import('./gallery-repository')).toSummary(listed[0])
    expect(summary.pinnedAt).toBe(pinned!.pinnedAt)
    const cleared = await setGalleryPinned(user.accountId, 'pintest', false)
    expect(cleared?.pinnedAt).toBeNull()
    expect(await setGalleryPinned(user.accountId, 'missing', true)).toBeNull()
    const found = await getGallery(user.accountId, 'pintest')
    expect(found?.pinnedAt).toBeNull()
    expect(found?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(found?.manifestVersion).toBe(1)
    expect(toSummary(found!).id).toBe(found!.id)
  })
})

describe('updateGalleryRecord migration_devices guard', () => {
  test('a stale expected snapshot returns null and leaves the row untouched; a matching one writes', async () => {
    const { createGallery, getGallery, resetGalleryStore, updateGalleryRecord } = await import('./gallery-repository')
    const { resetUserStore, upsertUser } = await import('./user-repository')
    resetUserStore()
    resetGalleryStore()
    const user = await upsertUser({ accountId: 'dbid:test-cas', displayName: 'CAS QA' })
    await createGallery(user.accountId, { slug: 'castest', title: 'CAS', caption: '', date: '', images: [still('c')] })
    const gallery = (await getGallery(user.accountId, 'castest'))!
    // Simulate a lost update: the row now holds devA while the caller built
    // its union on the earlier [] snapshot.
    const withDevice = await updateGalleryRecord(user.accountId, { ...gallery, migrationDevices: ['devA'] })
    expect(withDevice?.migrationDevices).toEqual(['devA'])
    const stale = await updateGalleryRecord(user.accountId,
      { ...gallery, migrationDevices: ['devB'] },
      undefined,
      { migrationDevices: [] },
    )
    expect(stale).toBeNull()
    expect((await getGallery(user.accountId, 'castest'))?.migrationDevices).toEqual(['devA'])
    const fresh = (await getGallery(user.accountId, 'castest'))!
    const retried = await updateGalleryRecord(user.accountId,
      { ...fresh, migrationDevices: ['devA', 'devB'] },
      undefined,
      { migrationDevices: fresh.migrationDevices ?? [] },
    )
    expect(retried?.migrationDevices).toEqual(['devA', 'devB'])
  })
})
