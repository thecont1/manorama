import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { readFileSync } from 'node:fs'
import type { Context, Handler, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import sharp from 'sharp'
import renderer from './routes/_renderer'
import viewerPage from './routes/[owner]/[slug]'
import { createManoramaApi } from './api'
import { resetUserStore, getUserByDropboxId } from './lib/user-repository'
import { createGallery, resetGalleryStore } from './lib/gallery-repository'
import { seedTestUser, TEST_OWNER, TEST_SESSION_SECRET } from './lib/test-fixtures'
import type { GalleryMediaItem, VideoItem } from './lib/imagesource'

/**
 * End-to-end server rendering for mixed galleries: the gallery page must
 * emit a per-gallery OG tag and a video frame that ships its poster
 * without a <video> element, and the OG route must return a genuinely
 * composited JPEG.
 */

const honoxContext = async (c: Context, next: Next) => {
  await contextStorage.run(c, () => next())
}

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET, PUBLIC_HOST: 'manorama.xyz' }
let ownerSlug: string

const photo: GalleryMediaItem = {
  id: 'p-1',
  ref: 'guid-p1',
  filename: 'first.jpg',
  src: '/api/icloud/image?album=t&photo=guid-p1&c=large',
  width: 2048,
  height: 1536,
  alt: 'The first photograph',
  c2pa: false,
  placeholder: '',
  variants: [{ width: 256, src: '/api/icloud/image?album=t&photo=guid-p1&c=small', format: 'jpeg' }],
}

const video: VideoItem = {
  type: 'video',
  id: 'v-1',
  ref: 'guid-v1',
  filename: 'clip.mp4',
  src: '/api/icloud/video?album=t&photo=guid-v1&c=movie',
  mimeType: 'video/mp4',
  width: 1280,
  height: 720,
  durationSeconds: 97,
  poster: { src: '/api/icloud/image?album=t&photo=guid-v1&c=poster', width: 1280, height: 720 },
  alt: 'A drifting backwater',
  c2pa: false,
  placeholder: '',
  variants: [{ width: 1280, src: '/api/icloud/image?album=t&photo=guid-v1&c=poster', format: 'jpeg' }],
}

const mountRoute = (app: Hono, path: string, route: unknown) => {
  const get = app.get.bind(app) as (p: string, ...h: Handler[]) => void
  if (Array.isArray(route)) get(path, ...(route as Handler[]))
  else get(path, route as Handler)
}

const buildApp = () => {
  const app = new Hono()
  app.use('*', honoxContext)
  app.use('*', renderer)
  mountRoute(app, '/:owner/:slug', viewerPage)
  return app
}

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  ownerSlug = (await getUserByDropboxId(TEST_OWNER.dropboxAccountId))!.ownerSlug
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'mixed',
    title: 'Mixed Gallery',
    caption: 'Photographs and moving pictures',
    date: '',
    images: [photo, video],
  })
  await createGallery(TEST_OWNER.dropboxAccountId, {
    slug: 'video-first',
    title: 'Video First',
    caption: '',
    date: '',
    images: [video, photo],
  })
})

describe('the gallery page advertises a per-gallery OG card', () => {
  test('og:image points at the gallery card keyed by the first item', async () => {
    const response = await buildApp().request(`/${ownerSlug}/mixed`, {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(`/api/og/${ownerSlug}/mixed?i=guid-p1`)
    expect(html).toContain('og:image:type')
    expect(html).toContain('image/jpeg')
    expect(html).toContain('content="1200"')
    expect(html).toContain('content="630"')
  })

  test('reordering changes the cache-busting key', async () => {
    const response = await buildApp().request(`/${ownerSlug}/video-first`, {}, env)
    // The video is first here, so its ref drives the key.
    expect(await response.text()).toContain('?i=guid-v1')
  })
})

describe('video frames render as posters on the server', () => {
  test('viewer source gates active video mounting on curtain entry and closed modals', () => {
    // This is the lifecycle boundary hidden by SSR: a video-first gallery
    // must not autoplay under the opening curtain, and opening either modal
    // must unmount/pause it. Keep the three gates explicit in Viewer.
    const source = readFileSync(new URL('./islands/Viewer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("galleryEntered && !modalOpen && !infoOpen && imageIndex === index")
    expect(source).toContain('setGalleryEntered(true)')
    expect(source).toContain('setGalleryEntered(false)')
  })

  test('a video item emits its poster and no <video> element in SSR HTML', async () => {
    const html = await (await buildApp().request(`/${ownerSlug}/mixed`, {}, env)).text()
    expect(html).toContain('data-media-type="video"')
    expect(html).toContain('c=poster')
    // Nothing is active before hydration, so no media element is shipped.
    expect(html).not.toContain('<video')
  })

  test('photographs still render exactly as before', async () => {
    const html = await (await buildApp().request(`/${ownerSlug}/mixed`, {}, env)).text()
    expect(html).toContain('data-media-type="image"')
    expect(html).toContain('The first photograph')
  })

  test('the frame count matches the mixed sequence', async () => {
    const html = await (await buildApp().request(`/${ownerSlug}/mixed`, {}, env)).text()
    expect(html.match(/data-media-type=/g)).toHaveLength(2)
  })
})

describe('the OG route composites a real card', () => {
  test('a gallery yields a 1200x630 JPEG built from its first frame', async () => {
    const jpeg = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 30, g: 70, b: 50 } } }).jpeg().toBuffer()
    const png = await sharp({ create: { width: 360, height: 96, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 0.6 } } }).png().toBuffer()
    const realFetch = globalThis.fetch
    // Stand in for the image proxy and the pill asset; the compositor
    // itself is the real jimp path.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('pill')) return new Response(png as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } })
      return new Response(jpeg as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    try {
      const response = await createManoramaApi().request(`/api/og/${ownerSlug}/mixed?i=guid-p1`, {}, env)
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('image/jpeg')
      const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
      expect(meta.format).toBe('jpeg')
      expect(meta.width).toBe(1200)
      expect(meta.height).toBe(630)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('a video-first gallery composites from the poster, never the MP4', async () => {
    const jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 20, b: 20 } } }).jpeg().toBuffer()
    const requested: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requested.push(String(input))
      return new Response(jpeg as unknown as BodyInit, { headers: { 'Content-Type': 'image/jpeg' } })
    }) as typeof fetch
    try {
      const response = await createManoramaApi().request(`/api/og/${ownerSlug}/video-first?i=guid-v1`, {}, env)
      expect(response.status).toBe(200)
      expect(requested.some((url) => url.includes('c=poster'))).toBe(true)
      expect(requested.some((url) => url.includes('/api/icloud/video'))).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
