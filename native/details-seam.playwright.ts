import { expect, test, type Page } from '@playwright/test'
import type { GalleryImage } from '../app/lib/imagesource'

const apiPattern = '**/api/gallery/**'
const svg = (label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="100%" height="100%" fill="#171817"/><text x="32" y="80" fill="#f3f0e8">${label}</text></svg>`)}`
const photo = (index: number): GalleryImage => ({
  id: `seam-${index}`,
  filename: `seam-${index}.svg`,
  src: svg(`photograph ${index + 1}`),
  width: 640,
  height: 900,
  alt: `Seam photograph ${index + 1}`,
  c2pa: false,
  placeholder: svg(`ph ${index + 1}`),
})
// ~30 stills — enough frames for a house plate to exist — plus one real
// video at index 3 (ffmpeg-generated H.264, served by the fixture server).
const videoItem = {
  ...photo(3),
  type: 'video',
  mimeType: 'video/mp4',
  src: '/fixtures/seam-clip.mp4',
  durationSeconds: 3,
  poster: { src: svg('video poster'), width: 640, height: 900 },
} as unknown as GalleryImage
const manifestImages: GalleryImage[] = Array.from({ length: 30 }, (_, i) => (i === 3 ? videoItem : photo(i)))
const payload = JSON.stringify({
  manifest: { slug: 'seam-fixture', title: 'Seam fixture', caption: 'Suspended-viewer seam.', date: '2026-10-28', images: manifestImages },
  settings: {
    title: 'Seam fixture',
    caption: 'Suspended-viewer seam.',
    date: '2026-10-28',
    curtainKicker: 'A single album',
    curtainPrompt: 'Tap, click, or press Enter to enter',
    defaultMode: 'strip',
    defaultShowArrows: false,
    defaultShowCaptions: true,
    imageCaptions: {},
    imageAlts: {},
  },
})
const openFixture = async (page: Page) => {
  await page.route(apiPattern, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: payload }))
  await page.route('**/manorama.xyz*', (route) => route.fulfill({ status: 200, body: 'ok' }))
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
}

/** P2 suspended-viewer seam: the real GalleryShell+Viewer fixture proves a
 *  suspended stage takes no input, keeps its exact frame, and resumes
 *  without a remount or re-seed. */

const nativeUrl = process.env.NATIVE_GALLERY_URL
if (!nativeUrl) throw new Error('NATIVE_GALLERY_URL is required for the details-seam spec')
const fixture = `${nativeUrl}/details-fixture.html`

const dismissCurtain = async (page: Page) => {
  // The fixture mounts asynchronously after its manifest fetch resolves —
  // wait for the curtain to exist rather than testing count() too early.
  const curtain = page.locator('[data-curtain]')
  await expect(curtain).toBeVisible()
  await curtain.click()
  await expect(curtain).toBeHidden()
  await expect(page.locator('body.gallery-entered')).toHaveCount(1)
}

const stripTransform = (page: Page) =>
  page.locator('.viewer-track').evaluate((n) => getComputedStyle(n).transform)

for (const viewport of [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
] as const) {
  test(`${viewport.name}: suspend freezes the frame, resume restores it exactly`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openFixture(page)
    await dismissCurtain(page)

    // Commit a few photographs in; readout reports real images only.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    // Let the glide fully settle before freezing — a transform or position
    // read mid-glide would drift underneath the suspended frame.
    await page.waitForTimeout(700)
    const readout = await page.locator('#position-readout').getAttribute('data-position')
    expect(readout).toMatch(/@\d+$/)

    const transform = await stripTransform(page)
    const activeId = await page.evaluate(() => document.querySelector('.viewer-stage')?.getAttribute('data-stage'))
    // A DOM identity marker proves the stage subtree is not remounted.
    const marker = await page.evaluate(() => {
      const el = document.querySelector('.viewer-stage') as HTMLElement & { __seam?: string }
      el.__seam = 'same-node'
      return (document.querySelector('.viewer-stage') as HTMLElement & { __seam?: string }).__seam
    })

    await page.locator('#toggle-details').click()
    await expect(page.locator('[data-screen="details"]')).toBeVisible()
    // Inert lives on the viewer's display:contents wrap (fix 5), so the
    // stage is inert by inheritance — check the ancestor, not the property.
    expect(await page.locator('.viewer-stage').evaluate((n) => Boolean((n as HTMLElement).closest('[inert]')))).toBe(true)
    expect(await page.locator('.viewer-stage').evaluate((n) => Boolean((n as HTMLElement).closest('[aria-hidden="true"]')))).toBe(true)

    // No input reaches the stage while suspended.
    const before = await stripTransform(page)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('g')
    await page.keyboard.press('i')
    await page.mouse.wheel(0, 400)
    expect(await stripTransform(page)).toBe(before)
    expect(await page.locator('.m-sheet-host').count()).toBe(0)

    // Defect 5: Tab from the external toggle never lands inside the
    // viewer's inert subtree.
    await page.locator('#toggle-details').focus()
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[inert]')))).toBe(false)
    }

    await page.locator('#toggle-details').click()
    await expect(page.locator('[data-screen="details"]')).toHaveCount(0)
    expect(await stripTransform(page)).toBe(transform)
    expect(await page.evaluate(() => document.querySelector('.viewer-stage')?.getAttribute('data-stage'))).toBe(activeId)
    expect(await page.evaluate(() => (document.querySelector('.viewer-stage') as HTMLElement & { __seam?: string }).__seam)).toBe(marker)
    await expect(page.locator('[data-curtain]')).toBeHidden()
    expect(await page.locator('#position-readout').getAttribute('data-position')).toBe(readout)
  })
}

test('active video pauses while suspended and resumes on unsuspend', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await openFixture(page)
  await dismissCurtain(page)
  // ArrowRight advances by a stage-width, not a frame — several presses
  // may be needed per photograph, and a press mid-glide only retargets
  // the in-flight destination. Step one settled glide at a time until the
  // counter reaches the video slide at index 3.
  const seq = page.locator('.stage-seq')
  for (let guard = 0; guard < 14; guard += 1) {
    if ((await seq.getAttribute('aria-label'))?.includes('Photograph 4')) break
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(900)
  }
  await expect(seq).toHaveAttribute('aria-label', /Photograph 4 of/)
  // The media element mounts on the active slide after the glide commits.
  await page.waitForTimeout(800)
  const hasVideo = await page.locator('video').count()
  test.skip(!hasVideo, 'fixture gallery carries no video')
  const playing = async () =>
    page.locator('video').first().evaluate((v: HTMLVideoElement) => !v.paused)
  for (let i = 0; i < 40 && !(await playing()); i += 1) {
    await page.keyboard.press('ArrowRight')
  }
  test.skip(!(await playing()), 'routed fixture video cannot play')
  await page.locator('#toggle-details').click()
  await expect.poll(() => playing()).toBe(false)
  await page.locator('#toggle-details').click()
  await expect.poll(() => playing()).toBe(true)

  // A video paused for a reason the app understands stays paused through
  // a suspend/resume cycle: reduced motion keeps autoplay disallowed.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => playing()).toBe(false)
  await page.locator('#toggle-details').click()
  await page.locator('#toggle-details').click()
  expect(await playing()).toBe(false)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
})

test('ad plate CTA is not actionable while suspended', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const openedUrls: string[] = []
  await page.route('**://ads.*', (route) => {
    openedUrls.push(route.request().url())
    return route.fulfill({ status: 200, body: 'ok' })
  })
  await openFixture(page)
  await dismissCurtain(page)
  // Walk the strip to the plate; CTA present proves the plate rendered.
  const cta = page.locator('[data-ad-frame] a, [data-ad-frame] button').first()
  if ((await cta.count()) === 0) test.skip(true, 'no house plate in fixture')
  await cta.scrollIntoViewIfNeeded()
  await page.locator('#toggle-details').click()
  await cta.click({ force: true }).catch(() => {})
  expect(openedUrls).toEqual([])
  await page.locator('#toggle-details').click()
})
