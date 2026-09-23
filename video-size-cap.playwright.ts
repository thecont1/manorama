import { test, expect, type Page, type Browser } from '@playwright/test'

/**
 * Desktop video size caps.
 *
 *   horizontal strip  → a video is at most 70% of viewport height, and is
 *                       vertically centred in its frame
 *   vertical scroll   → a video is at most 60% of viewport width
 *
 * Both are desktop-only rules: phones keep the full-bleed treatment.
 */

const BASE = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'
const ALBUM = `${BASE}/thecontrarian/mixed-album`

test.setTimeout(180_000)

const enter = async (page: Page) => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.goto(ALBUM)
    if (await page.locator('.control-logo').count()) break
    await page.waitForTimeout(1000)
  }
  await page.locator('.control-logo').waitFor({ state: 'attached', timeout: 60000 })
  const curtain = page.locator('[data-curtain]')
  for (let i = 0; i < 10 && await curtain.count(); i += 1) {
    await curtain.first().click({ force: true }).catch(() => {})
    await page.waitForTimeout(700)
  }
  await page.waitForTimeout(800)
}

/** The settings panel toggles, so drive it on visibility, not presence. */
const setMode = async (page: Page, mode: string) => {
  const logo = page.locator('.control-logo')
  const radio = page.locator(`input[name="view-mode"][value="${mode}"]`)
  for (let i = 0; i < 12; i += 1) {
    if (await radio.isVisible().catch(() => false)) break
    await logo.click({ force: true }).catch(() => {})
    await page.waitForTimeout(600)
  }
  await radio.waitFor({ state: 'visible', timeout: 30000 })
  await radio.check()
  await page.waitForTimeout(2000)
}

const measure = (page: Page) => page.evaluate(() => {
  const stage = document.querySelector('.viewer-stage, .stage') as HTMLElement | null
  const frame = document.querySelector('[data-media-type="video"]') as HTMLElement | null
  const poster = frame?.querySelector('.frame-ph') as HTMLElement | null
  const video = frame?.querySelector('video') as HTMLElement | null
  if (!stage || !frame || !poster) return null
  const s = stage.getBoundingClientRect()
  const p = poster.getBoundingClientRect()
  const f = frame.getBoundingClientRect()
  const v = video?.getBoundingClientRect()
  return {
    stageW: s.width, stageH: s.height,
    posterW: p.width, posterH: p.height,
    video: v ? { w: v.width, h: v.height, top: v.top, left: v.left } : null,
    poster: { top: p.top, left: p.left },
    capped: frame.className.includes('viewer-frame--video-capped'),
    gapTop: p.top - f.top,
    gapBottom: f.bottom - p.bottom,
  }
})

const DESKTOP = { viewport: { width: 1440, height: 900 } }
const MOBILE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
}

const withContext = async (browser: Browser, opts: any, mode: string, fn: (m: any) => void) => {
  const ctx = await browser.newContext(opts)
  const page = await ctx.newPage()
  try {
    await enter(page)
    await setMode(page, mode)
    const m = await measure(page)
    expect(m, 'the video frame should be measurable').not.toBeNull()
    fn(m)
  } finally {
    await ctx.close()
  }
}

test('desktop strip: a video is at most 70% of viewport height', async ({ browser }) => {
  await withContext(browser, DESKTOP, 'strip', (m) => {
    expect(m.capped).toBe(true)
    expect(m.posterH / m.stageH).toBeLessThanOrEqual(0.7 + 0.005)
    expect(m.posterH / m.stageH).toBeGreaterThan(0.65)
  })
})

test('desktop strip: the video is vertically centred in its frame', async ({ browser }) => {
  await withContext(browser, DESKTOP, 'strip', (m) => {
    expect(m.capped).toBe(true)
    // Equal space above and below is what "centred" means here.
    expect(Math.abs(m.gapTop - m.gapBottom)).toBeLessThanOrEqual(1)
    expect(m.gapTop).toBeGreaterThan(0)
  })
})

test('desktop vertical: a video is at most 60% of viewport width', async ({ browser }) => {
  await withContext(browser, DESKTOP, 'vertical', (m) => {
    expect(m.capped).toBe(true)
    expect(m.posterW / m.stageW).toBeLessThanOrEqual(0.6 + 0.005)
    expect(m.posterW / m.stageW).toBeGreaterThan(0.55)
  })
})

test('a capped video still occupies exactly its poster box', async ({ browser }) => {
  await withContext(browser, DESKTOP, 'vertical', (m) => {
    expect(m.video).not.toBeNull()
    expect(Math.abs(m.video.w - m.posterW)).toBeLessThanOrEqual(1)
    expect(Math.abs(m.video.h - m.posterH)).toBeLessThanOrEqual(1)
    expect(Math.abs(m.video.top - m.poster.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(m.video.left - m.poster.left)).toBeLessThanOrEqual(1)
  })
})

test('mobile strip is exempt from the cap', async ({ browser }) => {
  await withContext(browser, MOBILE, 'strip', (m) => {
    expect(m.capped).toBe(false)
    // Full-bleed: the clip still fills the stage height.
    expect(m.posterH / m.stageH).toBeGreaterThan(0.95)
  })
})

test('mobile vertical is exempt from the cap', async ({ browser }) => {
  await withContext(browser, MOBILE, 'vertical', (m) => {
    expect(m.capped).toBe(false)
    expect(m.posterW / m.stageW).toBeGreaterThan(0.95)
  })
})
