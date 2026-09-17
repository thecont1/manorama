import { beforeAll, describe, expect, test } from 'bun:test'
import { createManoramaApi } from './api'
import { createGallery, getGallery, resetGalleryStore, toSummary, updateGalleryImages, updateGalleryOrder } from './lib/gallery-repository'
import { resetUserStore } from './lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import { getUserByDropboxId } from './lib/user-repository'
import { isVideoItem, stillSourceOf, type GalleryMediaItem, type VideoItem } from './lib/imagesource'
import { ogBaseImageUrl, ogItemKey } from './lib/og-card'

/**
 * The media-union contract: galleries hold images and videos in one
 * ordered sequence, and every existing key path (ordering, refresh
 * dedupe, summaries, OG selection) treats them identically.
 */

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }

let api: ReturnType<typeof createManoramaApi>
let cookie: string
let ownerSlug: string

const photoItem = (id: string, ref: string): GalleryMediaItem => ({
  id,
  ref,
  filename: `${id}.jpg`,
  src: `/api/icloud/image?album=t&photo=${ref}&c=large`,
  width: 2048,
  height: 1536,
  alt: 'A photograph',
  c2pa: false,
  placeholder: '',
  variants: [{ width: 256, src: `/api/icloud/image?album=t&photo=${ref}&c=small`, format: 'jpeg' }],
})

const videoItem = (id: string, ref: string): VideoItem => ({
  type: 'video',
  id,
  ref,
  filename: `${id}.mp4`,
  src: `/api/icloud/video?album=t&photo=${ref}&c=movie`,
  mimeType: 'video/mp4',
  width: 1280,
  height: 720,
  durationSeconds: 42,
  poster: { src: `/api/icloud/image?album=t&photo=${ref}&c=poster`, width: 1280, height: 720 },
  alt: 'A video',
  c2pa: false,
  placeholder: '',
  variants: [{ width: 1280, src: `/api/icloud/image?album=t&photo=${ref}&c=poster`, format: 'jpeg' }],
})

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  cookie = await sessionCookieFor(TEST_OWNER.dropboxAccountId)
  ownerSlug = (await getUserByDropboxId(TEST_OWNER.dropboxAccountId))!.ownerSlug
  api = createManoramaApi()
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'mixed-media',
    title: 'Mixed Media',
    caption: '',
    date: '',
    createdAt: '2026-09-17T00:00:00.000Z',
    sourceUrl: 'https://www.icloud.com/sharedalbum/#MIXEDTOKEN',
    images: [photoItem('p-1', 'guid-p1'), videoItem('v-1', 'guid-v1'), photoItem('p-2', 'guid-p2')],
  })
})

describe('the media union survives a repository round-trip', () => {
  test('a stored video keeps its discriminant and every video field', async () => {
    const gallery = await getGallery(TEST_OWNER.dropboxAccountId, 'mixed-media')
    const item = gallery?.images[1]
    expect(item && isVideoItem(item)).toBe(true)
    const video = item as VideoItem
    expect(video.mimeType).toBe('video/mp4')
    expect(video.poster.src).toContain('c=poster')
    expect(video.durationSeconds).toBe(42)
  })

  test('images carry no `type` key — all-photo manifests need no migration', async () => {
    const gallery = await getGallery(TEST_OWNER.dropboxAccountId, 'mixed-media')
    expect('type' in (gallery!.images[0] as object)).toBe(false)
    // And a JSON round-trip of an all-photo manifest is byte-identical.
    const photos = [photoItem('p-1', 'guid-p1'), photoItem('p-2', 'guid-p2')]
    expect(JSON.parse(JSON.stringify(photos))).toEqual(photos)
  })

  test('ordering keys videos by `ref` exactly like images', async () => {
    const reordered = await updateGalleryOrder(
      TEST_OWNER.dropboxAccountId,
      'mixed-media',
      ['guid-v1', 'guid-p2', 'guid-p1'],
    )
    expect(reordered?.images.map((item) => item.ref)).toEqual(['guid-v1', 'guid-p2', 'guid-p1'])
    expect(isVideoItem(reordered!.images[0])).toBe(true)
    // Restore source order for the tests that follow.
    await updateGalleryOrder(TEST_OWNER.dropboxAccountId, 'mixed-media', ['guid-p1', 'guid-v1', 'guid-p2'])
  })

  test('an order listing unknown keys appends the rest instead of dropping them', async () => {
    const reordered = await updateGalleryOrder(TEST_OWNER.dropboxAccountId, 'mixed-media', ['guid-nope'])
    expect(reordered?.images).toHaveLength(3)
  })

  test('updateGalleryImages accepts a mixed sequence', async () => {
    const updated = await updateGalleryImages(
      TEST_OWNER.dropboxAccountId,
      'mixed-media',
      [videoItem('v-2', 'guid-v2'), photoItem('p-1', 'guid-p1')],
    )
    expect(updated?.images).toHaveLength(2)
    expect(isVideoItem(updated!.images[0])).toBe(true)
    await updateGalleryImages(
      TEST_OWNER.dropboxAccountId,
      'mixed-media',
      [photoItem('p-1', 'guid-p1'), videoItem('v-1', 'guid-v1'), photoItem('p-2', 'guid-p2')],
    )
  })
})

describe('gallery summaries badge videos for the admin rail', () => {
  test('toSummary marks videos and carries their duration and poster', async () => {
    const gallery = await getGallery(TEST_OWNER.dropboxAccountId, 'mixed-media')
    const summary = toSummary(gallery!)
    const entries = summary.images as Array<{ type?: string; durationSeconds?: number }>
    expect(entries[1].type).toBe('video')
    expect(entries[1].durationSeconds).toBe(42)
    // Image entries stay exactly as they were — no invented `type`.
    expect(entries[0].type).toBeUndefined()
    expect(summary.imageCount).toBe(3)
  })

  test('every item exposes a still through variants[0], video included', async () => {
    const gallery = await getGallery(TEST_OWNER.dropboxAccountId, 'mixed-media')
    for (const item of gallery!.images) {
      expect(item.variants?.[0]?.src).toBeTruthy()
    }
  })
})

describe('OG card source selection', () => {
  test('a video first item contributes its poster, not its MP4', () => {
    expect(ogBaseImageUrl(videoItem('v-1', 'guid-v1'))).toContain('c=poster')
    expect(ogBaseImageUrl(videoItem('v-1', 'guid-v1'))).not.toContain('/api/icloud/video')
  })

  test('stillSourceOf agrees for both media kinds', () => {
    expect(stillSourceOf(videoItem('v-1', 'g'))).toContain('c=poster')
    expect(stillSourceOf(photoItem('p-1', 'g'))).toContain('c=large')
  })

  test('HEIC images fall back to their JPEG rendition', () => {
    const heic = { ...photoItem('h-1', 'guid-h'), filename: 'IMG_0001.HEIC' }
    expect(ogBaseImageUrl(heic)).toContain('c=small')
  })

  test('dropbox and drive thumbnails are bumped to their largest rendition', () => {
    const dropbox = { ...photoItem('d-1', 'guid-d'), src: '/api/dropbox/thumbnail?sourceUrl=x&filename=y&size=w256h256' }
    expect(ogBaseImageUrl(dropbox)).toContain('size=w2048h2048')
    const drive = { ...photoItem('g-1', 'guid-g'), src: '/api/drive/thumbnail?id=x&size=w256' }
    expect(ogBaseImageUrl(drive)).toContain('size=w2048')
  })

  test('an empty gallery has no base image and no cache key', () => {
    expect(ogBaseImageUrl(undefined)).toBeNull()
    expect(ogItemKey(undefined)).toBe('')
  })

  test('the cache key is the first item key, so a reorder busts it', () => {
    expect(ogItemKey(photoItem('p-1', 'guid-p1'))).toBe('guid-p1')
    expect(ogItemKey(videoItem('v-1', 'guid-v1'))).toBe('guid-v1')
    // No ref (Dropbox) falls back to the filename.
    const noRef = { ...photoItem('p-3', 'x'), ref: undefined }
    expect(ogItemKey(noRef)).toBe('p-3.jpg')
  })
})

describe('the OG route always yields an image', () => {
  test('an unknown owner redirects to the static card', async () => {
    const response = await api.request('/api/og/nobody/mixed-media', {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('/og-image.png')
  })

  test('an unknown gallery redirects to the static card', async () => {
    const response = await api.request(`/api/og/${ownerSlug}/no-such-gallery`, {}, env)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toContain('/og-image.png')
  })

  test('the OG route is public — a crawler carries no cookie', async () => {
    const response = await api.request('/api/og/nobody/mixed-media', {}, env)
    expect(response.status).not.toBe(401)
  })
})

describe('the iCloud video proxy', () => {
  test('rejects a request missing its references with 400', async () => {
    const response = await api.request('/api/icloud/video', {}, env)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Missing iCloud video reference' })
  })

  test('is public like the image proxies, not session-gated', async () => {
    const response = await api.request('/api/icloud/video?album=a', {}, env)
    expect(response.status).toBe(400)
    expect(response.status).not.toBe(401)
  })
})

describe('create responses carry a gallery address for quick-add', () => {
  test('a duplicate source returns 409 with the existing gallery and its URL', async () => {
    const response = await api.request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ url: 'https://www.icloud.com/sharedalbum/#MIXEDTOKEN' }),
    }, env)
    expect(response.status).toBe(409)
    const payload = await response.json() as { galleryUrl?: string; gallery?: { slug?: string }; error?: string }
    expect(payload.gallery?.slug).toBe('mixed-media')
    expect(payload.galleryUrl).toBe(`/${ownerSlug}/mixed-media`)
    expect(payload.error).toBeTruthy()
  })

  test('an unauthenticated create is still rejected', async () => {
    const response = await api.request('/api/galleries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.icloud.com/sharedalbum/#MIXEDTOKEN' }),
    }, env)
    expect(response.status).toBe(401)
  })
})
