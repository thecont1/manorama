import { test, expect, type Page } from '@playwright/test'

/**
 * Video playback behaviour, against the real dev fixture (`mixed-album`
 * carries one genuine MP4 at the head of the sequence).
 *
 * The contract under test:
 *   1. A video is already RUNNING once it is loaded — it does not wait to
 *      become the active slide.
 *   2. The <video> occupies exactly its poster's box, so the clip never
 *      visibly separates from the still it replaces.
 *   3. On a poor connection the frame stays a still image.
 */

const BASE = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'
const ALBUM = `${BASE}/thecontrarian/mixed-album`

// Each case loads a real gallery and a real multi-MB MP4 (and the first
// one pays for Vite's cold on-demand transform), so 30s is far too tight.
test.setTimeout(120_000)

/** The dev server seeds its demo galleries asynchronously at boot, so a
 *  suite that starts too early gets "There is no gallery here". */
const gotoGallery = async (page: Page, url: string) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.goto(url)
    if (await page.locator('.control-logo').count()) return
    await page.waitForTimeout(1000)
  }
  throw new Error(`gallery never became available at ${url} — is the dev server seeded?`)
}

/** Lifts the opening curtain; video is gated on gallery entry. The
 *  curtain swallows pointer events until it animates out, and clicking
 *  before hydration is silently dropped — so wait for the island first. */
const enterGallery = async (page: Page) => {
  await gotoGallery(page, ALBUM)
  await page.locator('.control-logo').waitFor({ state: 'attached', timeout: 60000 })
  const curtain = page.locator('[data-curtain]')
  if (await curtain.count()) {
    await curtain.first().click({ force: true }).catch(() => {})
    await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      await curtain.first().click({ force: true }).catch(() => {})
      await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
    })
  }
  await page.locator('[data-media-type="video"]').first().waitFor({ state: 'attached', timeout: 60000 })
}

/** Waits until a <video> exists and has actually advanced its clock. */
const waitForMotion = async (page: Page) => {
  await expect(async () => {
    const moving = await page.evaluate(() =>
      Array.from(document.querySelectorAll('video')).some((v) => !v.paused && v.currentTime > 0))
    expect(moving).toBe(true)
  }).toPass({ timeout: 45000 })
}

test('a loaded video is already running, not parked waiting for its turn', async ({ page }) => {
  await enterGallery(page)
  await waitForMotion(page)

  const state = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map((v) => ({
    paused: v.paused,
    currentTime: v.currentTime,
    muted: v.muted,
  })))
  expect(state.length).toBeGreaterThan(0)
  // Every mounted clip is playing — none is waiting to be activated.
  expect(state.every((v) => !v.paused)).toBe(true)
  expect(state.some((v) => v.currentTime > 0)).toBe(true)
})

test('a video stays mounted and keeps running while the visitor is on a neighbouring frame', async ({ page }) => {
  await enterGallery(page)
  await waitForMotion(page)

  // Step off the video (it is the first frame) onto the adjacent photo.
  // The clip must remain mounted and keep advancing rather than being
  // torn down and restarted when the visitor returns.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(800)

  const away = await page.evaluate(() => {
    const v = document.querySelector('video') as HTMLVideoElement | null
    return v ? { present: true, paused: v.paused, t: v.currentTime } : { present: false, paused: true, t: 0 }
  })
  expect(away.present).toBe(true)
  expect(away.paused).toBe(false)

  await page.waitForTimeout(800)
  const later = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime)
  // Still advancing while off-slide: it was never paused-and-rewound.
  expect(later).toBeGreaterThan(away.t)
})

test('the video occupies exactly its poster box', async ({ page }) => {
  await enterGallery(page)
  await waitForMotion(page)

  const geometry = await page.evaluate(() => {
    const slide = document.querySelector('[data-video-slide]')
    const frame = slide?.closest('.viewer-frame')
    const video = frame?.querySelector('video') as HTMLVideoElement | null
    const poster = frame?.querySelector('.frame-ph') as HTMLImageElement | null
    if (!video || !poster) return null
    const v = video.getBoundingClientRect()
    const p = poster.getBoundingClientRect()
    return { v: { x: v.x, y: v.y, w: v.width, h: v.height }, p: { x: p.x, y: p.y, w: p.width, h: p.height } }
  })
  expect(geometry).not.toBeNull()
  // Same box, within sub-pixel rounding.
  expect(Math.abs(geometry!.v.x - geometry!.p.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry!.v.y - geometry!.p.y)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry!.v.w - geometry!.p.w)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry!.v.h - geometry!.p.h)).toBeLessThanOrEqual(1)
})

test('at most one clip is ever audible', async ({ page }) => {
  await enterGallery(page)
  await waitForMotion(page)

  const unmuted = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).filter((v) => !v.muted).length)
  expect(unmuted).toBeLessThanOrEqual(1)
})

test('a poor connection keeps the frame a still image', async ({ browser }) => {
  // Data Saver is the unambiguous signal: mount no <video> at all and
  // leave the poster as the whole frame.
  const context = await browser.newContext()
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { saveData: true, effectiveType: '2g', downlink: 0.3, addEventListener() {}, removeEventListener() {} },
    })
  })
  const page = await context.newPage()
  try {
    await enterGallery(page)
    await page.waitForTimeout(3000)
    await expect(page.locator('video')).toHaveCount(0)
    // The still is still there.
    await expect(page.locator('[data-media-type="video"] .frame-ph').first()).toBeAttached()
  } finally {
    await context.close()
  }
})
