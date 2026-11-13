/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test'

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'
const STRIP_SHAPES = ['desktop', 'phone', 'tablet'] as const
const SHAPES = [...STRIP_SHAPES, 'duo'] as const

const MATRIX = [
  { name: 'phone', width: 375, height: 812, initial: 'phone' },
  { name: 'tablet', width: 768, height: 1024, initial: 'tablet' },
  { name: 'laptop', width: 1440, height: 900, initial: 'desktop' },
  { name: 'wide', width: 2560, height: 1440, initial: 'desktop' },
]

const open = async (page: Page, width = 1440, height = 900) => {
  await page.setViewportSize({ width, height })
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
  await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-fitted', 'true')
  await expect(page.locator('[data-demo-controls]')).toBeVisible()
}

const transform = (page: Page) =>
  page.locator('[data-demo-strip]').evaluate((el) => (el as HTMLElement).style.transform)

const offset = async (page: Page) => {
  const value = await transform(page)
  return Number(/translate3d\((-?[\d.]+)px/.exec(value)?.[1] ?? 0)
}

const visiblePhotoIds = (page: Page) => page.locator('[data-demo-screen]').evaluate((viewport) => {
  const view = viewport.getBoundingClientRect()
  return [...viewport.querySelectorAll<HTMLElement>('[data-photo-id], [data-diptych-frame]')]
    .filter((item) => !item.hidden)
    .filter((item) => {
      const box = item.getBoundingClientRect()
      return box.right > view.left + 1 && box.left < view.right - 1
    })
    .map((item) => item.dataset.photoId || item.dataset.imageId || '')
})

const centredPhotoId = (page: Page) => page.locator('[data-demo-screen]').evaluate((viewport) => {
  const view = viewport.getBoundingClientRect()
  const centre = view.left + view.width / 2
  const item = [...viewport.querySelectorAll<HTMLElement>('[data-photo-id]')].find((candidate) => {
    const box = candidate.getBoundingClientRect()
    return !candidate.hidden && box.left <= centre && box.right > centre
  })
  return item?.dataset.photoId || ''
})

const pause = async (page: Page) => {
  const button = page.locator('[data-demo-pause]')
  if ((await button.textContent()) === 'Pause') await button.click()
  await expect(button).toHaveText('Resume')
}

const currentDuoSpread = (page: Page) =>
  page.locator('[data-demo-duo-spread][data-current="true"]')

const duoContentQuads = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 1 })
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-demo-duo-spread][data-current="true"] [data-diptych-frame] img',
    })
    const quads: number[][] = []
    for (const nodeId of nodeIds) {
      const result = await cdp.send('DOM.getContentQuads', { nodeId })
      if (result.quads[0]) quads.push(result.quads[0])
    }
    return quads
  } finally {
    await cdp.detach()
  }
}

test.describe('the mounted homepage photo demo', () => {
  for (const viewport of MATRIX) {
    test(`every device and control fits at ${viewport.width}px`, async ({ page }) => {
      await open(page, viewport.width, viewport.height)
      const root = page.locator('[data-demo-stage]')
      await expect(root).toHaveAttribute('data-demo-preset', viewport.initial)
      await expect(page.locator('.home-signin-title')).toHaveCount(0)
      const rootBox = await root.boundingBox()
      expect(rootBox!.width).toBeCloseTo(viewport.width * 0.95, 0)
      expect(rootBox!.height).toBeCloseTo(viewport.height * 0.95 - 64, 0)

      for (const shape of SHAPES) {
        const button = page.locator(`[data-shape="${shape}"]`)
        await button.click()
        await expect(root).toHaveAttribute('data-demo-preset', shape)
        await expect(button).toHaveAttribute('aria-pressed', 'true')
        await page.waitForTimeout(500)
        const boxes = await page.evaluate(() => {
          const stage = document.querySelector('[data-demo-viewport]')!.getBoundingClientRect()
          const rect = document.querySelector('[data-demo-device]')!.getBoundingClientRect()
          const device = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          }
          const controls = document.querySelector('[data-demo-controls]')!.getBoundingClientRect()
          return {
            stage: { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom },
            device,
            controlsTop: controls.top,
          }
        })
        expect(boxes.device.left).toBeGreaterThanOrEqual(boxes.stage.left - 1)
        expect(boxes.device.right).toBeLessThanOrEqual(boxes.stage.right + 1)
        expect(boxes.device.top).toBeGreaterThanOrEqual(boxes.stage.top - 1)
        expect(boxes.device.bottom).toBeLessThanOrEqual(boxes.stage.bottom + 1)
        expect((boxes.device.left + boxes.device.right) / 2).toBeCloseTo((boxes.stage.left + boxes.stage.right) / 2, 0)
        expect(boxes.controlsTop).toBeGreaterThanOrEqual(boxes.stage.bottom - 1)
        const hit = await button.evaluate((el) => {
          const box = el.getBoundingClientRect()
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === el
        })
        expect(hit).toBe(true)
      }

      await page.locator('[data-demo-pause]').click()
      await expect(page.locator('[data-demo-pause]')).toHaveText('Resume')
      await page.locator('[data-demo-pause]').click()
      await expect(page.locator('[data-demo-pause]')).toHaveText('Pause')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }

  test('every non-fold shape contains the same flush, honest Manorama strip', async ({ page }) => {
    await open(page)
    await pause(page)

    for (const shape of STRIP_SHAPES) {
      await page.locator(`[data-shape="${shape}"]`).click()
      await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', shape)
      await page.waitForTimeout(500)
      const geometry = await page.locator('[data-demo-screen]').evaluate((viewport) => {
        const view = viewport.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1
        return {
          background: getComputedStyle(viewport).backgroundColor,
          viewportHeight: view.height,
          laptopBases: viewport.closest('[data-demo-device]')!.querySelectorAll('.home-demo-laptop-base').length,
          items: [...viewport.querySelectorAll<HTMLElement>('[data-photo-id]')].map((item) => {
            const image = item.querySelector<HTMLImageElement>('img.frame-img')
            const placeholder = item.querySelector<HTMLImageElement>('img.frame-ph')!
            const box = image?.getBoundingClientRect()
            const slot = item.getBoundingClientRect()
            return {
              slotLeft: slot.left,
              slotRight: slot.right,
              slotWidth: slot.width,
              slotHeight: slot.height,
              margin: getComputedStyle(item).margin,
              mounted: Boolean(image),
              width: box?.width ?? 0,
              height: box?.height ?? 0,
              naturalWidth: image?.naturalWidth ?? 0,
              naturalHeight: image?.naturalHeight ?? 0,
              sourceRatio: Number(placeholder.getAttribute('width')) / Number(placeholder.getAttribute('height')),
              objectFit: image ? getComputedStyle(image).objectFit : 'contain',
              dpr,
            }
          }),
        }
      })

      expect(geometry.background).toBe('rgb(10, 10, 10)')
      expect(geometry.laptopBases).toBe(shape === 'desktop' ? 1 : 0)
      expect(geometry.items.some((item) => item.mounted)).toBe(true)
      for (const [index, item] of geometry.items.entries()) {
        expect(item.margin).toBe('0px')
        expect(item.slotHeight).toBeCloseTo(geometry.viewportHeight, 0)
        expect(Math.abs(item.slotWidth / item.slotHeight - item.sourceRatio)).toBeLessThan(0.002)
        if (index > 0) expect(item.slotLeft).toBeCloseTo(geometry.items[index - 1]!.slotRight, 0)
        if (!item.mounted) continue
        expect(item.slotWidth).toBeCloseTo(item.width, 0)
        expect(item.height).toBeCloseTo(geometry.viewportHeight, 0)
        expect(item.naturalWidth).toBeGreaterThan(0)
        expect(item.naturalHeight).toBeGreaterThan(0)
        expect(Math.abs(item.width / item.height - item.sourceRatio)).toBeLessThan(0.002)
        expect(item.objectFit).not.toBe('cover')
        expect(item.width * item.dpr, `${shape} image ${index} width`).toBeLessThanOrEqual(item.naturalWidth + 1)
        expect(item.height * item.dpr, `${shape} image ${index} height`).toBeLessThanOrEqual(item.naturalHeight + 1)
      }
    }
  })

  test('the opening curtain and temporary chrome reproduce the viewer anatomy', async ({ page }) => {
    await open(page)
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-phase', 'curtain')
    const curtain = page.locator('[data-curtain]')
    await expect(curtain).toBeVisible()
    await expect(curtain.locator('.curtain-title')).toHaveText('italia, amore mio')
    await expect(curtain.locator('.curtain-caption')).toHaveText('family trip to Italy in October 2018')
    await expect(curtain.locator('.curtain-count')).toHaveText('15 photographs')
    await expect(curtain.locator('.curtain-mark')).toBeVisible()
    expect(await curtain.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur(28px)')
    await expect(page.locator('[data-demo-chrome-top]')).toContainText('Library')
    await expect(page.locator('[data-demo-position]')).toHaveText('1 of 15')
    await expect(page.locator('[data-demo-chrome-bottom]')).toContainText('Settings')
    await expect(page.locator('[data-demo-chrome-bottom]')).toContainText('Info')
    await expect(page.locator('[data-demo-chrome-bottom]')).not.toHaveClass(/is-visible/)
  })

  test('hovering the inert screen reveals the real Viewer chrome', async ({ page }) => {
    await open(page)
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-phase', 'travel')
    await expect(page.locator('[data-demo-chrome-bottom]')).not.toHaveClass(/is-visible/, { timeout: 8_000 })
    await page.locator('[data-demo-viewport]').hover()
    await expect(page.locator('[data-demo-chrome-top]')).toHaveClass(/is-visible/)
    await expect(page.locator('[data-demo-chrome-bottom]')).toHaveClass(/is-visible/)
    const url = page.url()
    await page.locator('[data-demo-viewport]').click()
    expect(page.url()).toBe(url)
  })

  test('the curtain words fade before the frosted veil lifts', async ({ page }) => {
    await open(page)
    const curtain = page.locator('[data-curtain]')
    await expect(curtain).toHaveClass(/fading/)
    await expect(curtain.locator('.curtain-content')).toHaveCSS('opacity', '0')
    await expect(curtain).toBeVisible()
    expect(Number(await curtain.evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0)
    await expect(curtain).toBeHidden()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-phase', 'travel')
  })

  test('each real device has a measured, clipped, hardware-safe viewer', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    const expected = {
      desktop: { model: 'MacBook Pro 14-inch', screen: [1512, 982], viewer: [1512, 946], inset: [36, 0] },
      phone: { model: 'iPhone 17 Pro', screen: [402, 874], viewer: [402, 874], inset: [0, 0] },
      tablet: { model: 'iPad Pro 11-inch (M5)', screen: [834, 1210], viewer: [834, 1210], inset: [0, 0] },
      duo: { model: 'iPhone Duo', screen: [951, 669], viewer: [951, 669], inset: [0, 0] },
    } as const

    for (const shape of SHAPES) {
      await page.locator(`[data-shape="${shape}"]`).click()
      const device = page.locator('[data-demo-device]')
      await expect(device).toHaveAttribute('data-demo-model', expected[shape].model)
      const geometry = await device.evaluate((element) => {
        const screen = element.querySelector<HTMLElement>('.home-demo-screen')!
        const viewer = element.querySelector<HTMLElement>('[data-demo-screen]')!
        const topChrome = element.querySelector<HTMLElement>('[data-demo-chrome-top]')!
        const screenStyle = getComputedStyle(screen)
        const box = (node: Element) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        }
        return {
          screen: [screen.offsetWidth, screen.offsetHeight],
          viewer: [viewer.offsetWidth, viewer.offsetHeight],
          inset: [viewer.offsetTop, viewer.offsetLeft],
          overflow: screenStyle.overflow,
          isolation: screenStyle.isolation,
          contain: screenStyle.contain,
          clipPath: screenStyle.clipPath,
          glass: getComputedStyle(element.querySelector<HTMLElement>('.home-demo-device-glass')!).backgroundColor,
          viewerBox: box(viewer),
          topChromeBox: box(topChrome),
          hardware: [...element.querySelectorAll('.home-demo-notch-strip, .home-demo-island, .home-demo-camera')].map((node) => ({
            kind: node.classList.contains('home-demo-island') ? 'island' : 'other',
            ...box(node),
          })),
        }
      })
      expect(geometry.screen).toEqual([...expected[shape].screen])
      expect(geometry.viewer).toEqual([...expected[shape].viewer])
      expect(geometry.inset).toEqual([...expected[shape].inset])
      expect(geometry.overflow).toBe('hidden')
      expect(geometry.isolation).toBe('isolate')
      expect(geometry.contain).toBe('paint')
      expect(geometry.clipPath).toContain('inset')
      expect(geometry.glass).toBe('rgb(5, 6, 6)')
      for (const hardware of geometry.hardware) {
        if (hardware.kind === 'island') {
          expect(hardware.bottom).toBeLessThanOrEqual(geometry.topChromeBox.top)
          continue
        }
        const overlaps = hardware.left < geometry.viewerBox.right && hardware.right > geometry.viewerBox.left &&
          hardware.top < geometry.viewerBox.bottom && hardware.bottom > geometry.viewerBox.top
        expect(overlaps).toBe(false)
      }
    }
  })

  test('the selector and touch hardware match the modern device drawings', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    await expect(page.locator('.home-demo-shape')).toHaveText(['Desktop', 'Mobile', 'Tablet', 'Foldable'])

    await page.locator('[data-shape="phone"]').click()
    const phone = page.locator('[data-demo-device]')
    await expect(phone.locator('.home-demo-side-button')).toHaveCount(4)
    await expect(phone.locator('[data-demo-island]')).toHaveCount(1)
    await expect(phone.locator('.home-demo-home-indicator')).toHaveCount(0)
    await expect(phone.locator('.home-demo-device-body')).toHaveCSS('box-shadow', /rgb/)

    await page.locator('[data-shape="tablet"]').click()
    const tablet = page.locator('[data-demo-device]')
    await expect(tablet).toHaveAttribute('data-orientation', 'portrait')
    await expect(tablet.locator('.home-demo-side-button')).toHaveCount(3)
    await expect(tablet.locator('[data-demo-camera]')).toHaveCount(1)
    await expect(tablet.locator('.home-demo-screen')).toHaveCSS('border-radius', '23px')
    await expect(tablet.locator('.home-demo-island, .home-demo-notch, .home-demo-home-indicator')).toHaveCount(0)
  })

  test('Foldable keeps straight honest photographs and right-safe controls clear of the gutter', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Image edge heights are measured with Chromium content quads.')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    await page.locator('[data-shape="duo"]').click()
    const spread = currentDuoSpread(page)
    const stage = spread.locator('[data-diptych-stage]')
    await expect(stage).toBeVisible()
    await expect(stage.locator('[data-diptych-frame]')).toHaveCount(2)
    await expect.poll(() => stage.locator('img').evaluateAll(
      (images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
    )).toBe(true)
    await expect(page.locator('[data-demo-hinge]')).toHaveCount(1)
    await expect(page.locator('[data-demo-island], [data-demo-notch], [data-demo-camera]')).toHaveCount(0)
    await expect(page.locator('[data-demo-strip]')).toHaveCount(0)
    await expect(page.locator('[data-mode], .home-demo-mode, .home-demo-modes')).toHaveCount(0)
    await expect(page.locator('[data-demo-screen] [data-stage]')).toHaveClass(/mode-strip/)
    await expect(page.locator('[data-demo-chrome-top]')).toHaveClass(/is-visible/)
    await expect(page.locator('[data-demo-chrome-bottom]')).toHaveClass(/is-visible/)

    const geometry = await spread.evaluate((element) => {
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }
      const viewer = document.querySelector<HTMLElement>('[data-demo-screen]')!
      const hinge = document.querySelector<HTMLElement>('[data-demo-hinge]')!
      const controls = [...document.querySelectorAll<HTMLElement>(
        '[data-demo-chrome-top] .m-chrome-pill, [data-demo-chrome-bottom] .m-chrome-pill',
      )]
      const scale = Number(document.querySelector('[data-demo-stage]')!.getAttribute('data-demo-scale'))
      const track = document.querySelector<HTMLElement>('[data-demo-duo-track]')!
      return {
        viewer: box(viewer),
        gutter: box(hinge),
        hingeWidth: hinge.offsetWidth,
        frames: [...element.querySelectorAll<HTMLElement>('[data-diptych-frame]')].map((frame) => {
          const image = frame.querySelector<HTMLImageElement>('img')!
          return {
            id: frame.dataset.imageId,
            x: parseFloat(getComputedStyle(frame).left),
            frameWidth: parseFloat(getComputedStyle(frame).width),
            frameHeight: parseFloat(getComputedStyle(frame).height),
            frameBox: box(frame),
            imageBox: box(image),
            imageWidth: image.offsetWidth,
            imageHeight: image.offsetHeight,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
            objectFit: getComputedStyle(image).objectFit,
          }
        }),
        controls: controls.map((control) => ({ text: control.textContent?.trim().replace(/^‹\s*/, ''), ...box(control) })),
        scale,
        dpr: window.devicePixelRatio || 1,
        trackTransition: getComputedStyle(track).transitionDuration,
        trackTransform: track.style.transform,
        perspective: [...document.querySelectorAll<HTMLElement>('[data-demo-device], [data-demo-device] *')].map((node) => ({
          perspective: getComputedStyle(node).perspective,
          is2D: new DOMMatrixReadOnly(getComputedStyle(node).transform).is2D,
          transformStyle: getComputedStyle(node).transformStyle,
        })),
      }
    })

    expect(geometry.hingeWidth).toBe(40)
    expect(geometry.frames[0]).toMatchObject({ x: 0, frameWidth: 455.5, frameHeight: 669 })
    expect(geometry.frames[1]).toMatchObject({ x: 495.5, frameWidth: 455.5, frameHeight: 669 })
    expect(parseFloat(geometry.trackTransition)).toBeLessThanOrEqual(0.000001)
    expect(geometry.trackTransform).toMatch(/^translateX\(-?[\d.]+px\)$/)
    expect(geometry.controls.map((control) => control.text)).toEqual(['Library', '3-4 of 15', 'Settings', 'Info'])
    for (let index = 1; index < geometry.controls.length; index += 1) {
      expect(geometry.controls[index]!.top).toBeGreaterThan(geometry.controls[index - 1]!.top)
      expect(geometry.controls[index]!.right).toBeCloseTo(geometry.controls[0]!.right, 0)
    }
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(geometry.gutter.right - 1)
    }
    for (const frame of geometry.frames) {
      if (frame.x === 0) {
        expect(frame.frameBox.right).toBeLessThanOrEqual(geometry.gutter.left + 1)
        expect(frame.imageBox.right).toBeLessThanOrEqual(geometry.gutter.left + 1)
      } else {
        expect(frame.frameBox.left).toBeGreaterThanOrEqual(geometry.gutter.right - 1)
        expect(frame.imageBox.left).toBeGreaterThanOrEqual(geometry.gutter.right - 1)
      }
      expect(frame.naturalWidth).toBeGreaterThan(0)
      expect(frame.objectFit).not.toBe('cover')
      expect(Math.abs(frame.imageWidth / frame.imageHeight - frame.naturalWidth / frame.naturalHeight)).toBeLessThan(0.002)
      expect(frame.imageWidth * geometry.scale * geometry.dpr).toBeLessThanOrEqual(frame.naturalWidth + 1)
      expect(frame.imageHeight * geometry.scale * geometry.dpr).toBeLessThanOrEqual(frame.naturalHeight + 1)
    }
    const centres = geometry.frames.map((frame) => (frame.imageBox.top + frame.imageBox.bottom) / 2)
    expect(Math.abs(centres[0]! - centres[1]!)).toBeLessThanOrEqual(1)
    expect(centres[0]!).toBeCloseTo((geometry.viewer.top + geometry.viewer.bottom) / 2, 0)
    for (const style of geometry.perspective) {
      expect(style.perspective).toBe('none')
      expect(style.is2D).toBe(true)
      expect(style.transformStyle).not.toBe('preserve-3d')
    }

    const quads = await duoContentQuads(page)
    expect(quads).toHaveLength(2)
    for (const quad of quads) {
      expect(quad).toHaveLength(8)
      const leftHeight = Math.abs(quad[7]! - quad[1]!)
      const rightHeight = Math.abs(quad[5]! - quad[3]!)
      expect(Math.abs(leftHeight - rightHeight)).toBeLessThanOrEqual(1)
      expect(Math.abs(quad[1]! - quad[3]!)).toBeLessThanOrEqual(1)
      expect(Math.abs(quad[7]! - quad[5]!)).toBeLessThanOrEqual(1)
    }

    const frozen = await page.locator('[data-demo-duo-track]').evaluate((track) => ({
      spread: track.getAttribute('data-demo-spread'),
      transform: getComputedStyle(track).transform,
    }))
    await page.waitForTimeout(1800)
    expect(await page.locator('[data-demo-duo-track]').evaluate((track) => ({
      spread: track.getAttribute('data-demo-spread'),
      transform: getComputedStyle(track).transform,
    }))).toEqual(frozen)
  })

  test('Foldable glides horizontally, pauses, holds, and rewinds behind the curtain', async ({ page }) => {
    test.setTimeout(100_000)
    await open(page)
    await page.locator('[data-shape="duo"]').click()
    const root = page.locator('[data-demo-stage]')
    const track = page.locator('[data-demo-duo-track]')
    await expect(root).toHaveAttribute('data-demo-phase', 'travel')
    await expect(currentDuoSpread(page).locator('[data-diptych-frame]')).toHaveCount(2)
    await expect(page.locator('[data-demo-chrome-bottom]')).not.toHaveClass(/is-visible/, { timeout: 8_000 })
    await page.locator('[data-demo-viewport]').hover()
    await expect(page.locator('[data-demo-chrome-top]')).toHaveClass(/is-visible/)
    await expect(page.locator('[data-demo-chrome-bottom]')).toHaveClass(/is-visible/)

    const initialSpread = await track.getAttribute('data-demo-spread')
    await expect.poll(() => track.getAttribute('data-demo-spread'), { timeout: 20_000 }).not.toBe(initialSpread)
    await pause(page)
    await page.waitForTimeout(100)
    const frozen = await track.evaluate((element) => getComputedStyle(element).transform)
    await page.waitForTimeout(400)
    expect(await track.evaluate((element) => getComputedStyle(element).transform)).toBe(frozen)
    await page.locator('[data-demo-pause]').click()

    const movement = await track.evaluate((element) => {
      const style = getComputedStyle(element)
      const matrix = new DOMMatrixReadOnly(style.transform)
      return {
        inline: (element as HTMLElement).style.transform,
        duration: style.transitionDuration,
        property: style.transitionProperty,
        horizontal: matrix.m41,
        vertical: matrix.m42,
        shear: matrix.m12,
        is2D: matrix.is2D,
      }
    })
    expect(movement.inline).toMatch(/^translateX\(-?[\d.]+px\)$/)
    expect(movement.duration).toBe('1.6s')
    expect(movement.property).toBe('transform')
    expect(movement.horizontal).toBeLessThan(0)
    expect(movement.vertical).toBe(0)
    expect(movement.shear).toBe(0)
    expect(movement.is2D).toBe(true)

    const arrivedSpread = await track.getAttribute('data-demo-spread')
    await page.waitForTimeout(1800)
    const settled = await track.evaluate((element) => getComputedStyle(element).transform)
    await page.waitForTimeout(800)
    expect(await track.getAttribute('data-demo-spread')).toBe(arrivedSpread)
    expect(await track.evaluate((element) => getComputedStyle(element).transform)).toBe(settled)

    await expect(root).toHaveAttribute('data-demo-phase', 'end', { timeout: 55_000 })
    await expect(page.locator('[data-demo-position]')).toHaveText('14-15 of 15')
    await expect(root).toHaveAttribute('data-demo-phase', 'rewind', { timeout: 5_000 })
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await expect(root).toHaveAttribute('data-demo-phase', 'curtain', { timeout: 5_000 })
    await expect.poll(() => currentDuoSpread(page).locator('[data-diptych-frame]').evaluateAll(
      (frames) => frames.map((frame) => frame.getAttribute('data-image-id')),
    )).toEqual(['italy-0302', 'italy-0503'])
    await expect(page.locator('[data-demo-position]')).toHaveText('1-2 of 15')
  })

  test('the device frame contrasts with the page theme', async ({ page }) => {
    await open(page)
    await pause(page)
    const body = page.locator('.home-demo-device-body')
    await expect(body).toHaveCSS('background-color', 'rgb(27, 29, 32)')
    await page.locator('.home-header-inner > [data-theme-toggle]').click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect(body).toHaveCSS('background-color', 'rgb(11, 12, 13)')
    await page.locator('.home-header-inner > [data-theme-toggle]').click()
    await expect(body).toHaveCSS('background-color', 'rgb(27, 29, 32)')
  })

  test('shape changes preserve the photograph while paused and during travel', async ({ page }) => {
    await open(page)
    await pause(page)

    for (const shape of ['phone', 'tablet', 'desktop'] as const) {
      const anchor = await centredPhotoId(page)
      await page.locator(`[data-shape="${shape}"]`).click()
      await expect.poll(() => visiblePhotoIds(page)).toContain(anchor)
    }

    await page.locator('[data-demo-pause]').click()
    const movingTransform = await transform(page)
    await expect.poll(() => transform(page)).not.toBe(movingTransform)
    const movingAnchor = await centredPhotoId(page)
    await page.locator('[data-shape="phone"]').click()
    await expect.poll(() => visiblePhotoIds(page)).toContain(movingAnchor)

    for (const shape of ['tablet', 'desktop', 'phone'] as const) {
      await page.locator(`[data-shape="${shape}"]`).click()
    }
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', 'phone')
    await expect(page.locator('[data-demo-strip]')).toHaveCount(1)
  })

  test('the demo has no layout selector and every shape stays in strip mode', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    await expect(page.locator('[data-mode], .home-demo-mode, .home-demo-modes')).toHaveCount(0)
    for (const shape of SHAPES) {
      await page.locator(`[data-shape="${shape}"]`).click()
      const stage = page.locator('[data-demo-screen] [data-stage]')
      await expect(stage).toHaveClass(/mode-strip/)
      expect(await stage.evaluate((element) => element.scrollTop)).toBe(0)
      if (shape === 'duo') {
        await expect(page.locator('[data-demo-duo-track]')).toHaveCount(1)
        await expect(page.locator('[data-demo-strip]')).toHaveCount(0)
      } else {
        await expect(page.locator('[data-demo-strip]')).toHaveCount(1)
        await expect(page.locator('[data-demo-duo-track]')).toHaveCount(0)
      }
    }
  })

  test('the count advances, chrome recedes, and the end card rewinds directly into a new cycle', async ({ page }) => {
    test.setTimeout(100_000)
    await open(page)
    const root = page.locator('[data-demo-stage]')
    await expect(page.locator('[data-demo-position]')).not.toHaveText('1 of 15', { timeout: 15_000 })
    await expect(page.locator('[data-demo-chrome-bottom]')).not.toHaveClass(/is-visible/, { timeout: 8_000 })
    await expect(root).toHaveAttribute('data-demo-phase', 'end', { timeout: 50_000 })
    await expect(page.locator('[data-demo-position]')).toHaveText('15 of 15')
    await expect(page.locator('[data-demo-chrome-bottom]')).toHaveClass(/is-visible/)
    await expect(page.locator('[data-demo-endcard]')).toContainText('The End.')
    const end = await page.evaluate(() => {
      const screen = document.querySelector('[data-demo-screen]')!.getBoundingClientRect()
      const card = document.querySelector('[data-demo-endcard]')!.getBoundingClientRect()
      return { screenRight: screen.right, cardRight: card.right }
    })
    expect(end.cardRight).toBeLessThanOrEqual(end.screenRight + 1)
    const endOffset = await offset(page)

    await expect(root).toHaveAttribute('data-demo-phase', 'rewind', { timeout: 5_000 })
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await expect.poll(() => offset(page), { timeout: 2_000 }).toBeGreaterThan(endOffset + 100)
    await expect(page.locator('[data-curtain]')).toBeVisible()
    await expect(root).toHaveAttribute('data-demo-phase', 'curtain', { timeout: 5_000 })
    await expect(page.locator('[data-curtain]')).toBeVisible()
    expect(await offset(page)).toBe(0)
    await expect(root).toHaveAttribute('data-demo-phase', 'travel', { timeout: 5_000 })
  })

  test('pause survives scrolling, and automatic playback stops off screen', async ({ page }) => {
    await open(page)
    const initial = await transform(page)
    await expect.poll(() => transform(page)).not.toBe(initial)
    await pause(page)
    const frozen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(frozen)

    await page.locator('.home-footer').scrollIntoViewIfNeeded()
    await page.locator('[data-demo-stage]').scrollIntoViewIfNeeded()
    expect(await transform(page)).toBe(frozen)
    await expect(page.locator('[data-demo-pause]')).toHaveText('Resume')
    await page.locator('[data-demo-pause]').click()
    await expect.poll(() => transform(page)).not.toBe(frozen)

    await page.locator('.home-footer').scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
    const offscreen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(offscreen)
    await page.locator('[data-demo-stage]').scrollIntoViewIfNeeded()
    await expect.poll(() => transform(page)).not.toBe(offscreen)
  })

  test('the pictorial viewer is inert and page scrolling works over it', async ({ page }) => {
    await open(page)
    await pause(page)
    const frozen = await transform(page)
    const url = page.url()
    const stage = page.locator('[data-demo-viewport]')
    const screen = page.locator('[data-demo-screen]')
    await expect(stage).toHaveAttribute('role', 'img')
    await expect(stage).toHaveAttribute('aria-label', 'A self-running Manorama gallery of Italy photographs inside a device frame, with an opening curtain, temporary controls, and an end card.')
    await expect(screen).toHaveAttribute('aria-hidden', 'true')
    await expect(screen).toHaveAttribute('inert', '')
    const controls = screen.locator('a, button, input, select, textarea, [tabindex]')
    expect(await controls.count()).toBeGreaterThan(0)
    expect(await controls.evaluateAll((elements) => elements.filter((element) => !element.closest('[inert]')).length)).toBe(0)
    await expect(page.locator('.home-demo > .home-demo-controls button')).toHaveCount(5)
    expect(await stage.evaluate((el) => getComputedStyle(el).cursor)).toBe('default')
    const box = await stage.boundingBox()
    expect(box).not.toBeNull()

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.wheel(0, 500)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    expect(await transform(page)).toBe(frozen)

    await stage.scrollIntoViewIfNeeded()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    expect(await transform(page)).toBe(frozen)

    const dragged = await stage.boundingBox()
    await page.mouse.move(dragged!.x + dragged!.width * 0.7, dragged!.y + dragged!.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragged!.x + dragged!.width * 0.3, dragged!.y + dragged!.height / 2, { steps: 6 })
    await page.mouse.up()
    expect(await transform(page)).toBe(frozen)

    await page.mouse.click(dragged!.x + dragged!.width / 2, dragged!.y + dragged!.height / 2)
    expect(page.url()).toBe(url)
  })

  test('reduced motion is a still strip with visible controls', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    const button = page.locator('[data-demo-pause]')
    await expect(button).toBeDisabled()
    await expect(button).toHaveText('Paused')
    await expect(page.locator('[data-curtain]')).toBeHidden()
    await expect(page.locator('[data-demo-chrome-top]')).toHaveClass(/is-visible/)
    await expect(page.locator('[data-demo-chrome-bottom]')).toHaveClass(/is-visible/)
    const frozen = await transform(page)
    await page.waitForTimeout(1300)
    expect(await transform(page)).toBe(frozen)

    await page.locator('[data-shape="tablet"]').click()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', 'tablet')
    expect(await transform(page)).toBe(frozen)

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(button).toBeEnabled()
    await expect(button).toHaveText('Pause')
    await expect.poll(() => transform(page)).not.toBe(frozen)
  })

  test('the embedded viewer leaves the homepage URL, storage, body, and keyboard alone', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('home-demo-sentinel', 'unchanged'))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/?keep=1#original`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-fitted', 'true')
    const url = page.url()
    const storage = await page.evaluate(() => ({ ...localStorage }))

    await expect(page.locator('[data-demo-position]')).not.toHaveText('1 of 15', { timeout: 20_000 })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.locator('[data-shape="phone"]').click()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-preset', 'phone')

    expect(page.url()).toBe(url)
    expect(await page.evaluate(() => ({ ...localStorage }))).toEqual(storage)
    expect(await page.evaluate(() => localStorage.getItem('home-demo-sentinel'))).toBe('unchanged')
    await expect(page.locator('body')).not.toHaveClass(/gallery-entered/)
  })

  test('the demo makes only same-origin requests', async ({ page }) => {
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await open(page)
    await page.waitForTimeout(1500)
    const origin = new URL(BASE).origin
    expect(requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)).toEqual([])
  })
})

test.describe('the demo static and failure states', () => {
  test('the first photograph and provider menu work without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport)
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'false')
      await expect(page.locator('[data-demo-controls]')).toBeHidden()
      await expect(page.locator('.home-demo-static')).toBeVisible()
      const first = page.locator('.home-demo-static img')
      await expect(first).toBeVisible()
      await expect.poll(() => first.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await expect(page.locator('h1')).toBeVisible()
      await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
      if (viewport.width < 1024) {
        await page.locator('.home-nav-menu summary').click()
        await page.locator('.home-nav-signin').click()
      } else {
        await page.locator('.home-signin-trigger').click()
      }
      await expect(page.locator('.home-signin-list a')).toHaveCount(3)
      await expect(page.locator('.home-signin-list a').first()).toBeVisible()
    }
    await context.close()
  })

  test('blocking island enhancement leaves the static photograph and native disclosures', async ({ page }) => {
    await page.route('**/app/client.ts*', (route) => route.abort())
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'false')
    await expect(page.locator('[data-demo-controls]')).toBeHidden()
    await expect(page.locator('.home-demo-static img')).toBeVisible()
    await page.locator('.home-signin-trigger').click()
    await expect(page.locator('.home-signin-list a').first()).toBeVisible()
    await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
  })

  test('enhancement waits for every photograph instead of exposing empty frames', async ({ page }) => {
    let releaseLast!: () => void
    const lastImage = new Promise<void>((resolve) => { releaseLast = resolve })
    await page.route('**/home-demo/italy-0544-lg.*', async (route) => {
      await lastImage
      await route.continue()
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'false')
    await expect(page.locator('.home-demo-static img')).toBeVisible()
    await expect(page.locator('[data-demo-device]')).toHaveCount(0)

    releaseLast()
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true', { timeout: 30_000 })
    const mounted = page.locator('[data-demo-strip] img.frame-img')
    expect(await mounted.count()).toBeGreaterThan(0)
    const empty = await mounted.evaluateAll((images) =>
      images.filter((image) => !(image as HTMLImageElement).complete || (image as HTMLImageElement).naturalWidth === 0)
        .map((image) => image.closest('[data-photo-id]')?.getAttribute('data-photo-id')),
    )
    expect(empty).toEqual([])
  })

  test('blocking every demo image hides the controls and broken photographs', async ({ page }) => {
    await page.route('**/home-demo/**', (route) => route.abort())
    await page.setViewportSize({ width: 2560, height: 1440 })
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
    await expect(page.locator('[data-demo-controls]')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('[data-photo-id]:visible')).toHaveCount(0)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('a[href="/thecontrarian/italy"]')).toBeVisible()
    await page.locator('.home-signin-trigger').click()
    await expect(page.locator('.home-signin-list a').first()).toBeVisible()
  })
})
