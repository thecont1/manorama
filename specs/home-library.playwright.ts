/// <reference types="node" />
// The homepage's Library band: the four appearances of the Library — dark,
// quiet and dark, quiet and light, light — dissolved into one another.
//
// These assertions are about the animation and about the picture: that the
// dissolve is a dissolve and not a cut, that the caption swaps with the
// state and never sits two sentences at once, that the frame's bottom rule
// is far thicker than its other rules and holds the captions, that the
// band is whole without scripting, and that the file the browser is given
// is the capture at its own size — so a 2× screen is handed the pixels it
// asked for, and the picture it shows is the picture that was captured.

import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'

const STATES = [
  { name: 'Dark mode', caption: 'Every control, lit.' },
  { name: 'Quiet and Dark mode', caption: 'The interface steps back.' },
  { name: 'Quiet and Light mode', caption: 'Quiet, in daylight too.' },
  { name: 'Light mode', caption: 'The same Library. Different light.' },
]

/** The four captures, as they are captured and as the homepage serves them. */
const CAPTURES = [
  { served: '/home/lib-dark.webp', source: 'demo-captures/library/01-dark-mode.png' },
  { served: '/home/lib-quiet-dark.webp', source: 'demo-captures/library/02-quiet-dark-mode.png' },
  { served: '/home/lib-quiet-light.webp', source: 'demo-captures/library/03-quiet-light-mode.png' },
  { served: '/home/lib-light.webp', source: 'demo-captures/library/04-light-mode.png' },
]

const open = async (page: import('@playwright/test').Page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.home main#content')).toBeVisible()
}

/** The band, scrolled to and waiting for its first capture to arrive. */
const bringUp = async (page: import('@playwright/test').Page) => {
  const band = page.locator('[data-library-loop]')
  await band.scrollIntoViewIfNeeded()
  // Only the first capture is in the markup; the loop fetches the rest as
  // it reaches them.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('[data-library-layer="0"] img')
        return !!img && img.complete && img.naturalWidth > 0
      }),
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

  test('the canvas is the capture’s own size, so a retina screen lands it one for one', async ({ browser }) => {
    // The captures are 3456×2168, which is a 1728×1084 window at 2×. The
    // canvas is drawn at that logical size, and the file is the capture
    // itself, so a retina screen lands the capture's own pixels one for
    // one on the device's.
    for (const scale of [1, 2]) {
      const context = await browser.newContext({
        viewport: { width: 2560, height: 1440 },
        deviceScaleFactor: scale,
      })
      const page = await context.newPage()
      await open(page)
      await bringUp(page)
      const measured = await page.evaluate(async () => {
        const band = document.querySelector<HTMLElement>('[data-library-loop]')!
        const stage = band.querySelector<HTMLElement>('.home-library-stage')!.getBoundingClientRect()
        const image = band.querySelector<HTMLImageElement>('[data-library-layer="0"] img')!
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
      expect(measured.viewWidth).toBeCloseTo(1728, 0)
      expect(measured.viewHeight).toBeCloseTo(1084, 0)
      // One file for every screen: the capture's own width.
      expect(measured.served, `at ${scale}×`).toBe('lib-dark.webp')
      expect(measured.fileWidth).toBe(3456)
      expect(measured.fileHeight).toBe(2168)
      // The file is never smaller than the device pixels the canvas asks
      // for, so the browser never has to invent any.
      expect(measured.fileWidth).toBeGreaterThanOrEqual(measured.viewWidth * scale)
      // And on a retina screen it is exactly them.
      if (scale === 2) {
        expect(measured.fileWidth).toBeCloseTo(measured.viewWidth * scale, 0)
        expect(measured.fileHeight).toBeCloseTo(measured.viewHeight * scale, 0)
      }
      await context.close()
    }
  })

  test('the file is the capture at its own size, and shows the same picture', async ({ page }) => {
    // Put the original capture in front of the browser, byte for byte, so
    // the two can be compared as the browser actually shows them — not as
    // one decoder reads them.
    await page.route('**/__capture/*.png', async (route) => {
      const name = route.request().url().split('/').pop()!
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: readFileSync(resolve('demo-captures/library', name)),
      })
    })

    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    for (const capture of CAPTURES) {
      const measured = await page.evaluate(
        async ({ served, original }) => {
          const render = async (url: string) => {
            const img = new Image()
            img.src = url
            await img.decode()
            const canvas = document.createElement('canvas')
            canvas.width = img.naturalWidth
            canvas.height = img.naturalHeight
            const ctx = canvas.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(img, 0, 0)
            return {
              w: img.naturalWidth,
              h: img.naturalHeight,
              data: ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data,
            }
          }
          const a = await render(original)
          const b = await render(served)
          let max = 0
          let sum = 0
          let over2 = 0
          for (let i = 0; i < a.data.length; i += 4) {
            let worst = 0
            for (let c = 0; c < 3; c++) {
              const d = Math.abs(a.data[i + c]! - b.data[i + c]!)
              if (d > max) max = d
              sum += d
              if (d > worst) worst = d
            }
            if (worst > 2) over2++
          }
          const pixels = a.data.length / 4
          return {
            captureWidth: a.w,
            captureHeight: a.h,
            servedWidth: b.w,
            servedHeight: b.h,
            maxChannelDiff: max,
            meanAbsDiff: sum / (pixels * 3),
            pctOver2: (over2 / pixels) * 100,
          }
        },
        {
          served: `${BASE}${capture.served}`,
          original: `${BASE}/__capture/${capture.source.split('/').pop()}`,
        },
      )

      // The picture is never resized: the file is the capture's own size,
      // which is what a 2× screen asks a 1728-wide canvas for.
      expect(measured.captureWidth).toBe(3456)
      expect(measured.captureHeight).toBe(2168)
      expect(measured.servedWidth).toBe(measured.captureWidth)
      expect(measured.servedHeight).toBe(measured.captureHeight)

      // And it shows the same picture: measured against what the browser
      // renders for the capture itself. The file is a lossless WebP, so
      // the two agree to within the rounding of the browser's colour
      // conversion — one level, and not one pixel beyond it.
      expect(measured.maxChannelDiff).toBeLessThanOrEqual(1)
      expect(measured.meanAbsDiff).toBeLessThanOrEqual(0.05)
      expect(measured.pctOver2).toBe(0)
    }
  })

  test('the band never shows an empty layer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await bringUp(page)

    // Watch the loop go right round, and check at every moment that the
    // layer on show has its picture in it. The loop fetches each capture
    // as it reaches it, so this is where a fetch that never arrived would
    // show up as a band with a hole in it.
    const readings = await page.evaluate(async () => {
      const band = document.querySelector<HTMLElement>('[data-library-loop]')!
      const layers = Array.from(band.querySelectorAll<HTMLElement>('[data-library-layer]'))
      const out: { state: string; empty: boolean }[] = []
      const started = performance.now()
      while (performance.now() - started < 20000) {
        const state = band.dataset.state ?? '0'
        const layer = layers.find((candidate) => candidate.dataset.libraryLayer === state)
        const opacity = layer ? Number(getComputedStyle(layer).opacity) : 0
        // Only the layer that is actually on show matters.
        if (opacity > 0.5) {
          const img = layer?.querySelector('img')
          out.push({ state, empty: !img || !img.complete || img.naturalWidth === 0 })
        }
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      return out
    })

    expect(readings.length, 'the loop was watched').toBeGreaterThan(0)
    expect(
      readings.filter((reading) => reading.empty).length,
      'a layer was empty while it was on show',
    ).toBe(0)
    // And every state was reached with its picture in place.
    expect(new Set(readings.map((reading) => reading.state)).size).toBe(4)
  })

  test('the page asks for one capture at a time, not all four', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const response = await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    const html = await response!.text()
    // Only the first capture is in the markup: the band is whole without
    // scripting, and the page does not ask for four pictures at once.
    // `data-library-src` is not a `src`, so the tags are read whole.
    const images = [...html.matchAll(/<img[^>]*>/g)].map((match) => match[0])
    const sources = images
      .filter((tag) => /\ssrc="\/home\/(lib-[a-z-]+\.webp)"/.test(tag))
      .map((tag) => tag.match(/\ssrc="\/home\/(lib-[a-z-]+\.webp)"/)![1])
    expect(sources).toEqual(['lib-dark.webp'])
    // Every capture names where it will come from.
    for (const capture of CAPTURES) {
      expect(html).toContain(`data-library-src="${capture.served}"`)
    }
  })

  test('a narrower screen shrinks the canvas and never upscales the file', async ({ browser }) => {
    for (const width of [375, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      })
      const page = await context.newPage()
      await open(page)
      await bringUp(page)
      const measured = await page.evaluate(async () => {
        const band = document.querySelector<HTMLElement>('[data-library-loop]')!
        const stage = band.querySelector<HTMLElement>('.home-library-stage')!.getBoundingClientRect()
        const image = band.querySelector<HTMLImageElement>('[data-library-layer="0"] img')!
        const probe = new Image()
        probe.src = image.currentSrc
        await probe.decode()
        return {
          viewWidth: stage.width,
          fileWidth: probe.naturalWidth,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }
      })
      // Smaller than the full size, and the file is still never stretched
      // past its own pixels.
      expect(measured.viewWidth).toBeLessThan(1728)
      expect(measured.fileWidth).toBeGreaterThanOrEqual(measured.viewWidth)
      // And the frame never pushes the page sideways.
      expect(measured.overflow).toBeLessThanOrEqual(1)
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
