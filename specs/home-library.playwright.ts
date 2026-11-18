/// <reference types="node" />
// The homepage's Library band: the four appearances of the Library — dark,
// quiet and dark, quiet and light, light — dissolved into one another.
//
// These assertions are about the animation, not about the picture: that the
// dissolve is a dissolve and not a cut, that the caption swaps with the
// state and never sits two sentences at once, that the frame's bottom rule
// is far thicker than its other rules and holds the captions, and that the
// band is whole without scripting.

import { expect, test } from '@playwright/test'

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'

const STATES = [
  { name: 'Dark mode', caption: 'Every control, lit.' },
  { name: 'Quiet and Dark mode', caption: 'The interface steps back.' },
  { name: 'Quiet and Light mode', caption: 'Quiet, in daylight too.' },
  { name: 'Light mode', caption: 'The same Library. Different light.' },
]

const open = async (page: import('@playwright/test').Page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.home main#content')).toBeVisible()
}

/** The band, scrolled to and waiting for its captures to arrive. */
const bringUp = async (page: import('@playwright/test').Page) => {
  const band = page.locator('[data-library-loop]')
  await band.scrollIntoViewIfNeeded()
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLImageElement>('[data-library-layer] img')).every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true)
  return band
}

const state = (page: import('@playwright/test').Page) =>
  page.locator('[data-library-loop]').getAttribute('data-state')

test.describe('the Library band', () => {
  test('the loop walks the four states in order and comes back around', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const band = await bringUp(page)
    await expect(band).toHaveAttribute('data-state', '0')

    const seen: string[] = []
    for (let step = 0; step < 4; step += 1) {
      const current = await state(page)
      if (seen.length === 0 || seen[seen.length - 1] !== current) seen.push(current!)
      // One state is held for 3.6s and the dissolve takes 1.1s, so the next
      // state arrives inside five seconds.
      await expect
        .poll(() => state(page), { timeout: 8000 })
        .not.toBe(current)
    }
    expect(seen).toEqual(['0', '1', '2', '3'])
    // And the loop comes back to where it started.
    await expect.poll(() => state(page), { timeout: 8000 }).toBe('0')
  })

  test('the change is a dissolve: two states are briefly on screen together', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    const samples = await page.evaluate(async () => {
      const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-library-layer]'))
      const out: number[][] = []
      const started = performance.now()
      while (performance.now() - started < 6000) {
        out.push(layers.map((layer) => Number(getComputedStyle(layer).opacity)))
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return out
    })

    const blended = samples.filter((opacities) =>
      opacities.filter((value) => value > 0.05 && value < 0.95).length >= 2,
    )
    const settled = samples.filter((opacities) =>
      opacities.filter((value) => value > 0.99).length === 1,
    )
    expect(blended.length, 'a dissolve, not a cut').toBeGreaterThan(0)
    expect(settled.length, 'each state comes to rest').toBeGreaterThan(0)
  })

  test('the caption names the state that is on screen, and never two at once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    const readings = await page.evaluate(async () => {
      const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-library-layer]'))
      const captions = Array.from(document.querySelectorAll<HTMLElement>('[data-library-caption]'))
      const out: { settled: number; visible: number[] }[] = []
      const started = performance.now()
      while (performance.now() - started < 9000) {
        const layerOpacities = layers.map((layer) => Number(getComputedStyle(layer).opacity))
        const captionOpacities = captions.map((caption) => Number(getComputedStyle(caption).opacity))
        out.push({
          // The state the picture has come to rest on. During the dissolve
          // there is no settled state, and the caption is allowed to be
          // either of the two.
          settled: layerOpacities.findIndex((value) => value > 0.98),
          visible: captionOpacities
            .map((value, i) => (value > 0.08 ? i : -1))
            .filter((i) => i >= 0),
        })
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return out
    })

    // Never two captions on the rail at the same time.
    expect(readings.every((reading) => reading.visible.length <= 1)).toBe(true)
    // And whenever the picture has come to rest, the caption on the rail is
    // the one that names it.
    const settled = readings.filter((reading) => reading.settled >= 0)
    expect(settled.length).toBeGreaterThan(0)
    for (const reading of settled) {
      expect(reading.visible).toEqual([reading.settled])
    }
  })

  test('the frame holds the captions in a bottom rule far thicker than its sides', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const band = await bringUp(page)

    const frame = await band.evaluate((el) => {
      const style = getComputedStyle(el)
      const rail = el.querySelector<HTMLElement>('.home-library-rail')!.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return {
        top: parseFloat(style.borderTopWidth),
        left: parseFloat(style.borderLeftWidth),
        bottom: parseFloat(style.borderBottomWidth),
        railTop: rail.top,
        railBottom: rail.bottom,
        frameBottom: box.bottom,
      }
    })

    expect(frame.top).toBe(2)
    expect(frame.left).toBe(2)
    // The bottom rule is the caption bar: many times the rule at the sides.
    expect(frame.bottom).toBeGreaterThan(frame.top * 10)
    // The captions sit inside that rule, not under the picture.
    expect(frame.railTop).toBeGreaterThan(frame.frameBottom - frame.bottom - 1)
    expect(frame.railBottom).toBeLessThanOrEqual(frame.frameBottom + 1)
  })

  test('the picture is held at its own ratio and is never stretched', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const band = await bringUp(page)
    const measured = await band.evaluate(async (el) => {
      const stage = el.querySelector<HTMLElement>('.home-library-stage')!.getBoundingClientRect()
      const image = el.querySelector<HTMLImageElement>('[data-library-layer="0"] img')!
      // Read the file itself: a picture chosen from a `w` srcset reports a
      // density-corrected `naturalWidth`, not the file's pixel count.
      const probe = new Image()
      probe.src = image.currentSrc
      await probe.decode()
      return {
        stageRatio: stage.width / stage.height,
        imageRatio: probe.naturalWidth / probe.naturalHeight,
        drawnWidth: image.getBoundingClientRect().width,
        naturalWidth: probe.naturalWidth,
      }
    })
    expect(Math.abs(measured.stageRatio - measured.imageRatio)).toBeLessThan(0.01)
    // The served file is never blown up past its own pixels.
    expect(measured.drawnWidth).toBeLessThanOrEqual(measured.naturalWidth)
  })

  test('the viewable area is exactly half the capture, so a retina screen lands it one for one', async ({ browser }) => {
    // The frame is at most 1312 CSS pixels wide and its 2-pixel rules take
    // four of them, so the viewable area is 1308 and the file is 2616.
    for (const { scale, expected } of [
      { scale: 1, expected: 'lib-dark-sm.avif' },
      { scale: 2, expected: 'lib-dark.avif' },
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: scale,
      })
      const page = await context.newPage()
      await open(page)
      await bringUp(page)
      const measured = await page.evaluate(async () => {
        const band = document.querySelector<HTMLElement>('[data-library-loop]')!
        const stage = band.querySelector<HTMLElement>('.home-library-stage')!.getBoundingClientRect()
        const image = band.querySelector<HTMLImageElement>('[data-library-layer="0"] img')!
        // The picture in the page is chosen from a `w` srcset, so its own
        // `naturalWidth` is the density-corrected width, not the file's.
        // Read the file itself for the true pixel count.
        const probe = new Image()
        probe.src = image.currentSrc
        await probe.decode()
        return {
          viewWidth: stage.width,
          viewHeight: stage.height,
          fileWidth: probe.naturalWidth,
          fileHeight: probe.naturalHeight,
          served: image.currentSrc.split('/').pop(),
        }
      })
      // The file the browser is given is exactly what this screen needs:
      // the viewable area's own pixels at 1×, twice them at 2×.
      expect(measured.viewWidth).toBeCloseTo(1308, 0)
      expect(measured.served, `at ${scale}×`).toBe(expected)
      expect(measured.fileWidth).toBeCloseTo(measured.viewWidth * scale, 0)
      // The half-size file rounds the height to a whole pixel, so it may
      // sit half a pixel off the viewable area's height.
      expect(Math.abs(measured.fileHeight - measured.viewHeight * scale)).toBeLessThanOrEqual(1)
      await context.close()
    }
  })

  test('the frame is steel in both themes, and the type on it stays cream', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    const read = async () =>
      page.evaluate(() => {
        const band = document.querySelector<HTMLElement>('[data-library-loop]')!
        const rail = band.querySelector<HTMLElement>('.home-library-rail')!
        return {
          frame: getComputedStyle(band).borderTopColor,
          rule: getComputedStyle(band).borderBottomColor,
          type: getComputedStyle(rail).color,
        }
      })

    const dark = await read()
    await page.evaluate(() => document.documentElement.classList.add('light'))
    await page.waitForTimeout(300)
    const light = await read()

    // Steel is steel: the frame does not turn with the theme.
    expect(dark.frame).toBe('rgb(100, 108, 120)')
    expect(light.frame).toBe(dark.frame)
    expect(light.rule).toBe(dark.rule)
    // And the type on the rule is the same cream in both.
    expect(dark.type).toBe('rgb(243, 240, 232)')
    expect(light.type).toBe(dark.type)
  })

  test('the pause control stops the loop, and the band is whole without scripting', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await open(page)
    const band = await bringUp(page)

    const pause = page.locator('[data-library-pause]')
    await expect(pause).toBeVisible()
    await expect(pause).toHaveText('pause')
    await pause.click()
    await expect(pause).toHaveText('play')

    const held = await state(page)
    // Longer than one hold and one dissolve: the loop is stopped.
    await page.waitForTimeout(6000)
    expect(await state(page)).toBe(held)
    await context.close()

    // Without scripting the band still shows its first state, and the pause
    // control — which would have nothing to pause — stays hidden.
    const plain = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1440, height: 900 },
    })
    const bare = await plain.newPage()
    await bare.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(bare.locator('[data-library-loop]')).toHaveAttribute('data-state', '0')
    await expect(bare.locator('.home-library-caption').first()).toBeVisible()
    await expect(bare.locator('[data-library-pause]')).toBeHidden()
    await plain.close()
  })

  test('a visitor who asks for less motion gets the first state and stays there', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()
    await open(page)
    const band = page.locator('[data-library-loop]')
    await band.scrollIntoViewIfNeeded()
    await expect(band).toHaveAttribute('data-state', '0')
    await page.waitForTimeout(6000)
    await expect(band).toHaveAttribute('data-state', '0')
    await context.close()
  })

  test('the pause control is a keyboard-reachable button with the house focus ring', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    // Tab from the top of the document until the control takes focus.
    await page.evaluate(() => {
      window.scrollTo(0, 0)
      document.body.focus()
    })
    let landed = false
    for (let step = 0; step < 40 && !landed; step += 1) {
      await page.keyboard.press('Tab')
      landed = await page.evaluate(
        () => document.activeElement?.hasAttribute('data-library-pause') ?? false,
      )
    }
    expect(landed, 'the control is in the tab path').toBe(true)

    const focus = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-library-pause]')!
      const style = getComputedStyle(button)
      const box = button.getBoundingClientRect()
      return {
        visible: button.matches(':focus-visible'),
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        height: Math.round(box.height),
      }
    })
    expect(focus.visible).toBe(true)
    // The house ring: the accent, solid, with the page's own offset.
    expect(focus.outline).toBe('solid 2px rgb(252, 15, 192)')
    // And a touch target the size of the header's own controls.
    expect(focus.height).toBeGreaterThanOrEqual(44)
  })

  test('the band names every state in its captions', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)
    const captions = await page.locator('.home-library-caption').allTextContents()
    expect(captions.length).toBe(4)
    for (let index = 0; index < STATES.length; index += 1) {
      expect(captions[index]).toContain(STATES[index]!.name)
      expect(captions[index]).toContain(STATES[index]!.caption)
    }
  })
})
