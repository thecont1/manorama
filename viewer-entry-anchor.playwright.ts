import { expect, test, type Page } from '@playwright/test'

/**
 * P4 entry anchor. A nonzero ?photo= entry must stay docked when an earlier
 * frame decodes after the retired 150-frame reseed cap (about 2.5s at 60Hz).
 * The anchor follows the decode reflow, not a frame-count guess.
 *
 * The fixture is the gallery's own frame list, read before entering: the
 * entry is a photograph with a photograph before it and at least two frames
 * after it, so it can dock flush to the stage edge instead of clamping at the
 * end of the strip. Its sequence number comes from the manifest index the
 * viewer renders, never from a hardcoded position.
 */

const base = process.env.GALLERY_URL ?? 'http://localhost:5173'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'
const slug = process.env.GALLERY_SLUG ?? 'dev-dropbox'

/** 40:1 — wider than any photograph a gallery stages at full strip height, so
 *  this frame's decode is guaranteed to change its width and move the entry. */
const WIDE = '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="100"><rect width="100%" height="100%" fill="#171817"/></svg>'

const dismissCurtain = async (page: Page) => {
  const curtain = page.locator('[data-curtain]')
  if (!(await curtain.isVisible().catch(() => false))) return
  await expect.poll(async () => {
    if (await curtain.isHidden().catch(() => true)) return true
    await curtain.click({ timeout: 2_000 }).catch(() => {})
    return curtain.isHidden().catch(() => true)
  }, { timeout: 30_000, intervals: [500] }).toBe(true)
}

type Frame = { id: string; index: number; photo: boolean }

/** The frames currently mounted, with the manifest index the viewer assigned
 *  them (1-based) and whether the record is a still rather than a clip. */
const mountedFrames = (page: Page): Promise<Frame[]> =>
  page.locator('.viewer-frame[data-index]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-image-id') ?? '',
    index: Number(node.getAttribute('data-index')),
    photo: node.getAttribute('data-media-type') === 'image',
  })))

test('a slow decode after the old reseed cap still docks the entered photograph', async ({ page }) => {
  test.setTimeout(120_000)
  const probe = await page.request.get(`${base}/${owner}/${slug}`)
  test.skip(probe.status() !== 200, 'seeded gallery is not reachable')

  // Every image stays parked until the test releases it, so the entry loads on
  // manifest geometry and the decode reflow lands afterwards.
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let widen: string | null = null
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.resourceType() !== 'image' || request.url().includes('logo')) {
      await route.continue().catch(() => {})
      return
    }
    await gate
    if (widen && request.url() === widen) {
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: WIDE }).catch(() => {})
      return
    }
    await route.continue().catch(() => {})
  })

  // First pass: the gallery lists its own frames. Read them at the default
  // entry, before deciding what to enter.
  await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
  await dismissCurtain(page)
  await expect(page.locator('.viewer-frame[data-index]').first()).toBeVisible({ timeout: 30_000 })
  const listed = await mountedFrames(page)
  const sequenceLabel = (await page.locator('.stage-seq').getAttribute('aria-label')) ?? ''
  const total = Number(sequenceLabel.match(/of (\d+)/)?.[1] ?? 0)
  test.skip(total < 4, 'gallery is too short to enter mid-strip and still dock')

  // A photograph with a photograph before it (the frame whose decode can move
  // it) and two frames after it (room to reach the stage's left edge).
  const entry = listed.find((frame) => frame.photo && frame.index >= 2
    && listed.some((other) => other.index === frame.index - 1 && other.photo)
    && total - frame.index >= 2)
  test.skip(!entry, 'gallery has no photograph that can exercise the entry anchor')
  const at = entry!

  // Second pass: enter at that photograph's real sequence number.
  await page.goto(`${base}/${owner}/${slug}?photo=${encodeURIComponent(at.id)}`, { waitUntil: 'domcontentloaded' })
  await dismissCurtain(page)
  const sequence = page.locator('.stage-seq-num')
  await expect(sequence).toHaveText(String(at.index), { timeout: 30_000 })

  const entryFrame = page.locator(`.viewer-frame[data-image-id="${at.id}"]`).first()
  const earlier = page.locator(`.viewer-frame[data-index="${at.index - 1}"]`).first()
  const earlierSrc = await earlier.locator('img.frame-img').first().getAttribute('src')
  test.skip(!earlierSrc, 'the preceding photograph has no mounted image to reshape')
  widen = new URL(earlierSrc!, base).href
  const before = await earlier.boundingBox()

  // Longer than the retired 150-frame cap, while the earlier frames are still withheld.
  await page.waitForTimeout(4_000)
  await expect(sequence).toHaveText(String(at.index))
  release()

  // The earlier frame decodes at a different aspect, so its width changes —
  // that is the reflow the entry used to drift on. Wait for it explicitly
  // rather than inferring it from elapsed time.
  const earlierWidth = () => expect.poll(async () => (await earlier.boundingBox())?.width ?? 0, { timeout: 30_000 })
  await earlierWidth().toBeGreaterThan((before?.width ?? 0) + 40)
  // The 40:1 fixture actually landed: its staged width dwarfs any manifest width.
  await earlierWidth().toBeGreaterThan(1_500)

  await expect.poll(async () => entryFrame.locator('img.frame-img').first().evaluate(
    (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
  ), { timeout: 20_000 }).toBe(true)
  await expect(sequence).toHaveText(String(at.index))
  await expect.poll(async () => {
    const [frameBox, stageBox] = await Promise.all([entryFrame.boundingBox(), page.locator('[data-stage]').boundingBox()])
    if (!frameBox || !stageBox) return Number.POSITIVE_INFINITY
    return Math.abs(frameBox.x - stageBox.x)
  }, { timeout: 20_000, message: 'the entered frame must sit on the stage edge after the earlier frame reflows' }).toBeLessThan(3)
})
