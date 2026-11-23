import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  blockProductionApi,
  buildCatalogue,
  installBridge,
  photoBridgePayload,
  photosFrom,
} from './desktop-admin-fixture'

/**
 * The browser twin of `app/islands/Viewer.frame-ph.test.tsx`: the preview
 * layer (`img.frame-ph`) must paint in the same staged box as the full
 * image (`img.frame-img`), and a source smaller than the stage must never
 * be stretched to fill it — invariant 13, measured through the app's real
 * stylesheet instead of stamped style props.
 *
 * The desktop catalogue fixture is the harness that opens the shared
 * viewer with real CSS: the bridge answers the catalogue/session seam,
 * the gallery is one synthetic 64×64 photograph, and its original is held
 * in flight so the preview layer is still mounted when the boxes are read.
 */

const base = process.env.DESKTOP_URL ?? 'http://localhost:5176'
const SOURCE = process.env.MANORAMA_DESKTOP_SOURCE ?? '/Users/home/Pictures'
const TINY_DIM = 64
const TINY_NAME = 'frame-ph-tiny-64.jpg'

const donors = (() => {
  try {
    return photosFrom(SOURCE, 1)
  } catch {
    return []
  }
})()

/** A real 64×64 JPEG derived from a fixture photograph — the suite reads
 *  dims with sips already, so the same tool makes the small file. */
const makeTiny = () => {
  const donor = donors[0]
  if (!donor) return null
  const path = join(mkdtempSync(join(tmpdir(), 'frame-ph-')), TINY_NAME)
  try {
    execFileSync('sips', ['-z', String(TINY_DIM), String(TINY_DIM), donor.path, '--out', path])
    return { id: 'tiny-1', name: TINY_NAME, path, width: TINY_DIM, height: TINY_DIM }
  } catch {
    return null
  }
}

const tiny = makeTiny()
const built = tiny ? buildCatalogue([tiny], SOURCE) : null

test('the 64×64 preview and full image share one honest box at DPR 1', async ({ browser }) => {
  test.skip(!tiny || !built, `no usable source photograph under ${SOURCE}`)
  const context = await browser.newContext({
    viewport: { width: 1280, height: 840 },
    deviceScaleFactor: 1,
  })
  // The original is gated so the preview stays mounted while the boxes
  // are measured; releasing it lets the page finish cleanly.
  let releaseTiny: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseTiny = resolve
  })
  try {
    const page = await context.newPage()
    // Any photo name the fixture does not serve fails fast instead of
    // reaching a real network.
    await page.route('**/photos/*', (route) => route.fulfill({ status: 404 }))
    await page.route(`**/photos/${TINY_NAME}`, async (route) => {
      await gate
      await route.fulfill({ path: tiny!.path, contentType: 'image/jpeg' })
    })
    await blockProductionApi(page)
    await page.addInitScript(installBridge, photoBridgePayload(built!))
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.desktop-catalogue')).toBeVisible({ timeout: 15_000 })
    // dev serves the stylesheet out of the module graph — an unstyled page
    // still measures plausible boxes, so the titlebar's app-CSS height is
    // the load gate.
    await expect
      .poll(() => page.evaluate(() => {
        const bar = document.querySelector('.desktop-titlebar')
        return bar ? getComputedStyle(bar).height : 'none'
      }), { timeout: 15_000 })
      .toBe('28px')

    // The card's title opens the viewer at the first — only — photograph.
    // The thumbnail surfaces cannot be the way in: their box is the gated
    // image's, so the strip item stays invisible while the original is held.
    await page.locator('[data-gallery-card="11111111-2222-4333-8444-555555555555"] .lib-card-title').first().click()
    await expect(page.locator('.curtain')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Enter gallery' }).click()
    await expect(page.locator('[data-curtain]')).toBeHidden({ timeout: 15_000 })

    const frame = page.locator('.viewer-frame[data-media-type="image"]').first()
    await expect(frame.locator('img.frame-ph')).toBeAttached({ timeout: 15_000 })
    await expect(frame.locator('img.frame-img')).toBeAttached({ timeout: 15_000 })

    const boxes = await frame.evaluate((element) => {
      const rect = (selector: string) => {
        const box = element.querySelector(selector)?.getBoundingClientRect()
        return box ? { width: box.width, height: box.height } : null
      }
      return { preview: rect('img.frame-ph'), full: rect('img.frame-img') }
    })
    expect(boxes.preview).not.toBeNull()
    expect(boxes.full).not.toBeNull()
    // One staged box for both layers — the preview must not fall back to
    // the frame-filling 100%/100% the CSS would give it unstaged.
    expect(Math.abs(boxes.preview!.width - boxes.full!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(boxes.preview!.height - boxes.full!.height)).toBeLessThanOrEqual(1)
    // And the box itself answers to the source's own pixels: a 64×64 at
    // DPR 1 has no business painting larger than 64 in either dimension
    // (+1 covers sub-pixel rounding).
    expect(boxes.preview!.width).toBeGreaterThan(0)
    expect(boxes.preview!.width).toBeLessThanOrEqual(TINY_DIM + 1)
    expect(boxes.preview!.height).toBeLessThanOrEqual(TINY_DIM + 1)
    expect(boxes.full!.width).toBeLessThanOrEqual(TINY_DIM + 1)
    expect(boxes.full!.height).toBeLessThanOrEqual(TINY_DIM + 1)

    releaseTiny()
  } finally {
    releaseTiny()
    await context.close()
  }
})
