import { expect, test, type Page } from '@playwright/test'
import type { GalleryMediaItem } from '../packages/core/imagesource'
import { DEMO_PHOTOS, demoRenditionPath } from '../app/components/home/demo/manifest'

const nativeUrl = process.env.NATIVE_GALLERY_URL
const describeNative = nativeUrl ? test.describe : test.describe.skip
const dimensions = [[1800, 2700], [2400, 3600], [3600, 2400], [3000, 2000], [3600, 2400], [1200, 1800], [180, 120]]
const images = dimensions.map(([width, height], index) => ({
  id: `duo-${index}`, filename: `${index}.svg`, width, height, alt: `Photograph ${index + 1}`, c2pa: false,
  src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${index % 2 ? '#777' : '#aaa'}"/></svg>`)}`,
  placeholder: '',
}))
const snapshot = (width: number, height: number, pose: 'flat' | 'book' | 'laptop' | 'closed') => ({
  viewport: { width, height }, horizontalSizeClass: pose === 'closed' ? 'compact' : 'regular',
  verticalSizeClass: 'regular', verticalBarEdge: 'trailing',
  safeAreaInsets: { top: 24, right: 12, bottom: 12, left: 0 },
  regions: pose === 'book' ? [{ kind: 'division', active: true, frame: { x: width * .48, y: 0, width: 18, height } }]
    : pose === 'laptop' ? [{ kind: 'division', active: true, frame: { x: 0, y: height * .46, width, height: 26 } }] : [],
})
const pose = async (page: Page, value: ReturnType<typeof snapshot>) => {
  await page.setViewportSize(value.viewport)
  await page.evaluate((layout) => {
    Object.assign(window, { __MANORAMA_IOS_LAYOUT__: layout })
    window.dispatchEvent(new Event('manorama:layout'))
  }, value)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))))
}
const openGallery = async (page: Page, items: GalleryMediaItem[] = images, arrows = false) => {
  await page.addInitScript((layout) => Object.assign(window, { __MANORAMA_IOS_LAYOUT__: layout }), snapshot(951, 669, 'flat'))
  await page.route('**/api/gallery/**', (route) => route.fulfill({ json: {
    manifest: { slug: 'duo-repair', title: 'Duo', caption: '', date: '', images: items },
    settings: { title: 'Duo', caption: '', date: '', curtainKicker: '', curtainPrompt: 'Enter', defaultMode: 'spread', defaultShowCaptions: false, defaultShowArrows: arrows, imageCaptions: {}, imageAlts: {} },
  } }))
  await page.goto(`${nativeUrl}/?owner=fixture&slug=duo-repair`, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-curtain]').click()
  await expect(page.locator('[data-diptych-stage]')).toBeVisible()
  await expect(page.locator('[data-curtain]')).toBeHidden()
}
const photoBoxes = async (page: Page) => {
  await expect.poll(() => page.locator('[data-diptych-frame] img').evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).naturalWidth > 0))).toBe(true)
  return page.locator('[data-diptych-frame] img').evaluateAll((nodes) => nodes.map((node) => {
  const image = node as HTMLImageElement
  return { id: image.closest('[data-image-id]')?.getAttribute('data-image-id'), ...image.getBoundingClientRect().toJSON(), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }
}))
}

describeNative('Duo responsive Spread', () => {
  test.use({ viewport: { width: 951, height: 669 } })

  test('flat pairs share the largest honest height with a small gutter', async ({ page }) => {
    await openGallery(page)
    for (const start of [0, 2, 4]) {
      if (start) await page.keyboard.press('ArrowRight')
      await expect(page.locator('[data-diptych-frame]').first()).toHaveAttribute('data-image-id', `duo-${start}`)
      const boxes = await photoBoxes(page)
      expect(boxes.map((box) => box.id)).toEqual([`duo-${start}`, `duo-${start + 1}`])
      expect(boxes[0].height).toBeCloseTo(boxes[1].height, 0)
      expect(boxes[1].x - boxes[0].right).toBeGreaterThanOrEqual(8)
      expect(boxes[1].x - boxes[0].right).toBeLessThanOrEqual(16)
      for (const box of boxes) {
        expect(box.width / box.height).toBeCloseTo(box.naturalWidth / box.naturalHeight, 2)
        expect(box.width).toBeLessThanOrEqual(box.naturalWidth)
        expect(box.height).toBeLessThanOrEqual(box.naturalHeight)
      }
    }
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diptych-frame]')).toHaveCount(1)
    await expect(page.locator('[data-diptych-frame]')).toHaveAttribute('data-image-id', 'duo-6')
    const [last] = await photoBoxes(page)
    expect(last.width).toBeLessThanOrEqual(180)
    expect(last.height).toBeLessThanOrEqual(120)
  })

  test('book, laptop and closed transitions preserve identity and stay navigable', async ({ page }) => {
    await openGallery(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diptych-frame]').first()).toHaveAttribute('data-image-id', 'duo-2')
    for (const state of ['book', 'laptop', 'flat'] as const) {
      await pose(page, snapshot(951, 669, state))
      await expect(page.locator('[data-diptych-frame]').first()).toHaveAttribute('data-image-id', 'duo-2')
      const boxes = await photoBoxes(page)
      if (state === 'book') {
        expect(boxes[0].right).toBeLessThanOrEqual(951 * .48)
        expect(boxes[1].x).toBeGreaterThanOrEqual(951 * .48 + 18)
      } else if (state === 'laptop') {
        expect(boxes[0].bottom).toBeLessThanOrEqual(669 * .46)
        expect(boxes[1].y).toBeGreaterThanOrEqual(669 * .46 + 26)
      }
      for (const box of boxes) expect(box.height).toBeGreaterThan(0)
    }
    await pose(page, snapshot(382, 580, 'closed'))
    await expect(page.locator('[data-stage]')).toHaveClass(/mode-strip/)
    await expect(page.locator('[data-diptych-stage]')).toHaveCount(0)
    await expect(page.locator('[data-index="3"] img.frame-img')).toBeVisible()
    const track = page.locator('[data-track]')
    const beforePan = await track.evaluate((node) => (node as HTMLElement).style.transform)
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => track.evaluate((node) => (node as HTMLElement).style.transform)).not.toBe(beforePan)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-chrome-position]')).toHaveAttribute('aria-label', /Photograph 4 of 7/)
    await pose(page, snapshot(951, 669, 'flat'))
    await expect(page.locator('[data-diptych-stage]')).toBeVisible()
    await expect(page.locator('[data-diptych-frame][aria-current="true"]')).toHaveAttribute('data-image-id', 'duo-3')
  })

  test('folding during a Strip glide preserves the reported photograph and restores Spread', async ({ page }) => {
    await openGallery(page)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diptych-frame]').first()).toHaveAttribute('data-image-id', 'duo-2')
    await pose(page, snapshot(382, 580, 'closed'))
    await page.keyboard.press('ArrowRight')
    const travel = await page.locator('[data-track]').evaluate(async (node) => {
      const before = (node as HTMLElement).style.transform
      await new Promise(requestAnimationFrame)
      return { before, after: (node as HTMLElement).style.transform, anchor: document.querySelector('[data-chrome-position]')!.getAttribute('aria-label')! }
    })
    expect(travel.after).not.toBe(travel.before)
    const index = Number(travel.anchor.match(/Photograph (\d+) of/)![1]) - 1
    await pose(page, snapshot(951, 669, 'book'))
    await expect(page.locator('[data-diptych-frame][aria-current="true"]')).toHaveAttribute('data-image-id', `duo-${index}`)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('[data-diptych-frame]').first()).toHaveAttribute('data-image-id', `duo-${Math.min(6, Math.floor(index / 2) * 2 + 2)}`)
  })

  test('decoded pixels limit both photographs at high display density', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 951, height: 669 }, deviceScaleFactor: 3 })
    const page = await context.newPage()
    try {
      await openGallery(page, [images[0], { ...images[6], width: 3600, height: 2400 }])
      await expect.poll(async () => (await photoBoxes(page))[1].height).toBeCloseTo(40, 0)
      const boxes = await photoBoxes(page)
      expect(boxes[0].height).toBeCloseTo(40, 0)
      for (const box of boxes) {
        expect(box.width * 3).toBeLessThanOrEqual(box.naturalWidth + .1)
        expect(box.height * 3).toBeLessThanOrEqual(box.naturalHeight + .1)
      }
    } finally {
      await context.close()
    }
  })

  test('a mode explicitly selected while closed replaces the saved Spread preference', async ({ page }) => {
    await openGallery(page)
    await pose(page, snapshot(382, 580, 'closed'))
    await page.getByRole('button', { name: 'Show controls', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
    await page.getByRole('radio', { name: 'One by one', exact: true }).click()
    await page.keyboard.press('Escape')
    await pose(page, snapshot(951, 669, 'flat'))
    await expect(page.locator('[data-stage]')).toHaveClass(/mode-single/)
    await expect(page.locator('[data-diptych-stage]')).toHaveCount(0)
  })

  test('an explicitly paused video stays paused across compact fallback and reopening', async ({ page }) => {
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 160
      canvas.height = 90
      const ctx = canvas.getContext('2d')!
      const stream = canvas.captureStream(12)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/mp4' })
      const chunks: Blob[] = []
      recorder.ondataavailable = (event) => chunks.push(event.data)
      const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
      let frame = 0
      const timer = setInterval(() => {
        ctx.fillStyle = ++frame % 2 ? '#444' : '#555'
        ctx.fillRect(0, 0, 160, 90)
      }, 60)
      recorder.start()
      await new Promise((resolve) => setTimeout(resolve, 800))
      recorder.stop()
      await stopped
      clearInterval(timer)
      stream.getTracks().forEach((track) => track.stop())
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))
    })
    await page.route('**/duo-pause.mp4', (route) => route.fulfill({ contentType: 'video/mp4', body: Buffer.from(bytes) }))
    await openGallery(page, [{
      ...images[0], id: 'duo-video', type: 'video', filename: 'duo-pause.mp4',
      src: `${nativeUrl}/duo-pause.mp4`, mimeType: 'video/mp4', width: 160, height: 90,
      poster: { src: images[0].src, width: 1800, height: 2700 }, alt: 'Pause fixture',
    }, images[1], images[2]])
    await expect(page.locator('[data-diptych-frame]')).toHaveCount(1)
    const video = page.locator('video')
    await expect.poll(() => video.evaluate((node) => !node.paused && node.readyState >= 2)).toBe(true)
    const videoBox = (await video.boundingBox())!
    expect(videoBox.width).toBeLessThanOrEqual(160)
    expect(videoBox.height).toBeLessThanOrEqual(90)
    const pauseBox = (await page.getByRole('button', { name: 'Pause video: Pause fixture', exact: true }).boundingBox())!
    expect(pauseBox.width).toBe(44)
    expect(pauseBox.height).toBe(44)
    await page.getByRole('button', { name: 'Pause video: Pause fixture', exact: true }).click()
    for (const state of ['book', 'laptop', 'closed', 'flat'] as const) {
      await pose(page, snapshot(state === 'closed' ? 382 : 951, state === 'closed' ? 580 : 669, state))
      await expect.poll(() => video.evaluate((node) => node.readyState >= 2)).toBe(true)
      await expect(page.getByRole('button', { name: 'Play video: Pause fixture', exact: true })).toBeVisible()
      expect(await video.evaluate((node) => node.paused)).toBe(true)
    }
    await page.getByRole('button', { name: 'Play video: Pause fixture', exact: true }).click()
    await expect.poll(() => video.evaluate((node) => node.paused)).toBe(false)
  })

  test('photographic browser evidence preserves order through every injected pose', async ({ page }, testInfo) => {
    const photos = DEMO_PHOTOS.map((photo) => ({
      id: photo.id, filename: `${photo.id}.jpg`, src: `${nativeUrl}${demoRenditionPath(photo.id, 'lg', 'jpg')}`,
      width: photo.lg.width, height: photo.lg.height, alt: photo.alt, c2pa: false, placeholder: `${nativeUrl}${demoRenditionPath(photo.id, 'lg', 'jpg')}`,
    }))
    await openGallery(page, photos, true)
    for (const state of ['flat', 'book', 'laptop', 'closed'] as const) {
      await pose(page, snapshot(state === 'closed' ? 382 : 951, state === 'closed' ? 580 : 669, state))
      await page.getByRole('button', { name: 'Show controls', exact: true }).focus()
      await page.keyboard.press('Enter')
      const buttons = await page.locator('nav.m-chrome--side button:visible, .stage-arrows--system-side > button:visible').all()
      const targets = await Promise.all(buttons.map((button) => button.boundingBox()))
      for (let i = 0; i < targets.length; i++) {
        const box = targets[i]!
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
        if (state === 'laptop') expect(box.y).toBeGreaterThanOrEqual(669 * .46 + 26 - .1)
        for (const other of targets.slice(i + 1)) {
          expect(box.y + box.height <= other!.y || other!.y + other!.height <= box.y).toBe(true)
        }
      }
      if (state !== 'closed') {
        const boxes = await photoBoxes(page)
        expect(boxes.map((box) => box.id)).toEqual(photos.slice(0, 2).map((photo) => photo.id))
      } else {
        const firstPhoto = page.locator('[data-track] img.frame-img').first()
        await expect(firstPhoto).toHaveClass(/is-loaded/)
        await expect(firstPhoto).toHaveCSS('opacity', '1')
        await expect.poll(() => firstPhoto.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      }
      const screenshot = testInfo.outputPath(`browser-injected-${state}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`browser-injected-${state}`, { path: screenshot, contentType: 'image/png' })
      await testInfo.attach(`browser-injected-${state}-layout`, {
        body: Buffer.from(JSON.stringify(await page.evaluate(() => window.__MANORAMA_IOS_LAYOUT__), null, 2)), contentType: 'application/json',
      })
    }
  })

  test('the native photo picker stays inside its usable region in book and laptop poses', async ({ page }) => {
    await openGallery(page)
    for (const state of ['book', 'laptop'] as const) {
      await pose(page, snapshot(951, 669, state))
      await page.getByRole('button', { name: 'Show controls', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.locator('[data-chrome-position]').click()
      const picker = page.locator('[data-global-view]')
      await expect(picker).toBeVisible()
      const region = (await picker.boundingBox())!
      for (const selector of ['.native-global-header', '[data-global-scroll]']) {
        const box = (await picker.locator(selector).boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(region.x)
        expect(box.y).toBeGreaterThanOrEqual(region.y)
        expect(box.x + box.width).toBeLessThanOrEqual(region.x + region.width + 1)
        expect(box.y + box.height).toBeLessThanOrEqual(region.y + region.height + 1)
      }
      await page.getByRole('button', { name: 'Close photo picker', exact: true }).click()
      await expect(picker).toBeHidden()
    }
  })

  test('Library and an open add draft stay in the usable region across book and laptop poses', async ({ page }) => {
    await page.addInitScript((layout) => {
      Object.assign(window, { __MANORAMA_IOS_LAYOUT__: layout })
      localStorage.setItem('capacitor-storage_manorama.session-token', JSON.stringify('duo-fixture-token'))
      localStorage.setItem('capacitor-storage_manorama.owner-slug', JSON.stringify('fixture'))
    }, snapshot(951, 669, 'book'))
    await page.route('**/api/**', (route) => route.fulfill({ json: { galleries: [], devices: [], identities: [], suppressions: [], show: false } }))
    await page.goto(`${nativeUrl}/`, { waitUntil: 'domcontentloaded' })
    const library = page.locator('.native-account-shell')
    await expect(library).toBeVisible()
    for (const state of ['book', 'laptop'] as const) {
      await pose(page, snapshot(951, 669, state))
      const box = (await library.locator('.native-library-rail').boundingBox())!
      const galleries = (await library.locator('.native-list-card').boundingBox())!
      if (state === 'book') {
        expect(box.x).toBeGreaterThanOrEqual(951 * .48 + 18 - .1)
        expect(galleries.x + galleries.width).toBeLessThanOrEqual(951 * .48 + .1)
      } else {
        expect(box.y).toBeGreaterThanOrEqual(669 * .46 + 26 - .1)
        expect(galleries.y + galleries.height).toBeLessThanOrEqual(669 * .46 + .1)
      }
      expect(box.x + box.width).toBeLessThanOrEqual(951)
      expect(box.y + box.height).toBeLessThanOrEqual(669)
    }
    await library.getByRole('button', { name: 'Add Gallery', exact: true }).click()
    const add = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Add a gallery', exact: true }) })
    const draft = add.getByRole('textbox', { name: /Shared folder or album link/ })
    await draft.fill('Unfinished Duo draft')
    for (const state of ['book', 'laptop', 'closed', 'flat'] as const) {
      await pose(page, snapshot(state === 'closed' ? 382 : 951, state === 'closed' ? 580 : 669, state))
      await expect(add).toBeVisible()
      await expect(draft).toHaveValue('Unfinished Duo draft')
      const box = (await add.boundingBox())!
      if (state === 'book') expect(box.x).toBeGreaterThanOrEqual(951 * .48 + 18 - .1)
      if (state === 'laptop') expect(box.y).toBeGreaterThanOrEqual(669 * .46 + 26 - .1)
    }
    await add.getByRole('button', { name: 'Close', exact: true }).click()
  })

  test('Library uses honest compact covers and pinned strips across Duo poses', async ({ page }, testInfo) => {
    const photos = DEMO_PHOTOS.map((photo) => ({
      id: photo.id, filename: `${photo.id}.jpg`, src: `${nativeUrl}${demoRenditionPath(photo.id, 'lg', 'jpg')}`,
      width: photo.lg.width, height: photo.lg.height, alt: photo.alt, c2pa: false, placeholder: '',
    }))
    const galleries = ['A quiet afternoon', 'Along the coast', 'Portraits', 'Small hours', 'A very long gallery title that must wrap without pushing its menu off screen'].map((title, index) => ({
      slug: `library-${index}`, title, caption: '', date: '', imageCount: 3, retention: 'retained',
      expiresAt: null, sourceUrl: null, createdAt: null, pinnedAt: index === 0 ? '2026-11-16T00:00:00Z' : null,
      images: photos.slice(index, index + 3),
    }))
    await page.addInitScript((layout) => {
      Object.assign(window, { __MANORAMA_IOS_LAYOUT__: layout, __demoBilling: { tier: 'free', isPro: false } })
      localStorage.setItem('capacitor-storage_manorama.session-token', JSON.stringify('duo-fixture-token'))
      localStorage.setItem('capacitor-storage_manorama.owner-slug', JSON.stringify('fixture'))
    }, snapshot(951, 669, 'flat'))
    await page.route('**/api/**', (route) => {
      if (route.request().url().endsWith('/api/galleries')) return route.fulfill({ json: { galleries } })
      return route.fulfill({ json: { galleries: [], devices: [], identities: [], suppressions: [], show: true } })
    })
    await page.goto(`${nativeUrl}/`, { waitUntil: 'domcontentloaded' })
    const library = page.locator('.native-library-layout')
    await expect(library.locator('.lib-rail')).toHaveCount(1)
    await expect(library.locator('.native-library-cover')).toHaveCount(4)
    for (const [state, width, height] of [
      ['flat', 951, 669], ['book', 951, 669], ['laptop', 951, 669],
      ['closed', 382, 580], ['closed', 320, 568], ['closed', 678, 466],
    ] as const) {
      await pose(page, snapshot(width, height, state))
      for (const button of await library.locator('.native-library-actions button').all()) {
        const box = (await button.boundingBox())!
        expect(box.width).toBeGreaterThanOrEqual(44)
        expect(box.height).toBeGreaterThanOrEqual(44)
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
        if (state === 'book') expect(box.x).toBeGreaterThanOrEqual(width * .48 + 18)
        if (state === 'laptop') expect(box.y).toBeGreaterThanOrEqual(height * .46 + 26)
      }
      for (const toggle of await library.locator('.native-library-actions .m-iconbtn').all()) {
        await expect(toggle).toHaveCSS('border-radius', '50%')
        await expect(toggle).toHaveCSS('border-top-style', 'solid')
        await expect(toggle).toHaveCSS('border-top-width', '1px')
      }
      const ad = library.locator('[data-account-ad]')
      const artwork = ad.locator('img')
      await expect.poll(() => artwork.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      const adBox = (await ad.boundingBox())!
      const slotBox = (await ad.locator('.native-account-ad-slot').boundingBox())!
      const imageBox = (await artwork.boundingBox())!
      const badgeBox = (await ad.locator('.native-account-ad-badge').boundingBox())!
      const copyBox = (await ad.locator('.native-account-ad-copy').boundingBox())!
      const pixels = await artwork.evaluate((node) => ({ width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight, dpr: window.devicePixelRatio }))
      expect(slotBox.width).toBeCloseTo(adBox.width, 0)
      expect(imageBox.width).toBeCloseTo(Math.min(slotBox.width, pixels.width / pixels.dpr), 0)
      expect(imageBox.width / imageBox.height).toBeCloseTo(pixels.width / pixels.height, 2)
      expect(badgeBox.y + badgeBox.height).toBeLessThanOrEqual(imageBox.y)
      expect(copyBox.y).toBeGreaterThanOrEqual(imageBox.y + imageBox.height)
      await expect(ad.locator('.native-account-ad-sub')).toBeVisible()
      await expect(library.locator('.native-library-footer')).toContainText('© 2026 Mahesh Shantaram')
      const actionBoxes = await library.locator('.native-library-actions button').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()))
      expect(Math.max(...actionBoxes.map((box) => box.y)) - Math.min(...actionBoxes.map((box) => box.y))).toBeLessThan(1)
      const galleryBox = (await library.locator('.native-list-card').boundingBox())!
      if (state === 'flat') {
        expect(galleryBox.y).toBeCloseTo(24, 0)
        const controlsBox = (await library.locator('.native-library-rail').boundingBox())!
        expect(controlsBox.y).toBeCloseTo(24, 0)
      }
      const first = library.locator('.lib-rail img').first()
      await expect.poll(() => first.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      const firstBox = (await first.boundingBox())!
      expect(firstBox.y).toBeLessThan(height)
      expect(firstBox.x).toBeGreaterThanOrEqual(galleryBox.x)
      expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(galleryBox.x + galleryBox.width)
      expect(await library.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
      const screenshot = testInfo.outputPath(`library-browser-injected-${state}-${width}x${height}.png`)
      await page.screenshot({ path: screenshot })
      await testInfo.attach(`library-browser-injected-${state}-${width}x${height}`, { path: screenshot, contentType: 'image/png' })
      await library.locator('.native-library-footer').scrollIntoViewIfNeeded()
      const footerScreenshot = testInfo.outputPath(`library-footer-browser-injected-${state}-${width}x${height}.png`)
      await page.screenshot({ path: footerScreenshot })
      await testInfo.attach(`library-footer-browser-injected-${state}-${width}x${height}`, { path: footerScreenshot, contentType: 'image/png' })
      await library.evaluate((node) => {
        node.scrollTop = 0
        node.querySelector('.native-library-rail')!.scrollTop = 0
      })
    }
    await library.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Back to the library', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Back to the library', exact: true }).click()
    await expect(library.getByRole('button', { name: 'Add Gallery', exact: true })).toBeVisible()
    await library.getByRole('button', { name: 'Quiet view — hide the words', exact: true }).click()
    await expect(library.getByRole('button', { name: 'Show the words', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await library.getByRole('button', { name: 'Show the words', exact: true }).click()
    await library.getByRole('button', { name: 'Privacy Policy', exact: true }).click()
    await expect(page.locator('[data-screen="privacy"]')).toBeVisible()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(library.getByRole('button', { name: 'Add Gallery', exact: true })).toBeVisible()
  })

  test('rail shows the range without changing image geometry and sheets avoid a laptop division', async ({ page }) => {
    await openGallery(page)
    const before = await photoBoxes(page)
    const skip = page.getByRole('button', { name: 'Show controls', exact: true })
    await expect(skip).toHaveCSS('opacity', '0')
    await expect(skip).toHaveCSS('pointer-events', 'none')
    await page.keyboard.press('Tab')
    await skip.focus()
    await expect(skip).toHaveCSS('opacity', '1')
    await page.keyboard.press('Enter')
    await expect(skip).toHaveCSS('opacity', '0')
    const rail = page.locator('nav.m-chrome--side.is-visible')
    await expect(rail).toBeVisible()
    await expect(rail.locator('[data-chrome-position]')).toHaveText(/1–2\s*of 7/)
    const railBox = (await rail.boundingBox())!
    expect(railBox.width).toBeLessThanOrEqual(72)
    expect(await photoBoxes(page)).toEqual(before)
    for (const button of await rail.locator('button').all()) {
      const box = (await button.boundingBox())!
      expect(box.width).toBeGreaterThanOrEqual(44)
      expect(box.height).toBeGreaterThanOrEqual(44)
    }
    await rail.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
    await pose(page, snapshot(951, 669, 'laptop'))
    const sheet = page.getByRole('dialog', { name: 'Gallery Settings', exact: true })
    await expect(sheet).toBeVisible()
    expect((await sheet.boundingBox())!.y).toBeGreaterThanOrEqual(669 * .46 + 26)
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })
})

const webUrl = process.env.GALLERY_URL
const webTest = test.extend({ browserName: 'webkit' })
const describeWeb = webUrl ? webTest.describe : webTest.describe.skip

describeWeb('Duo Safari viewport coverage without fold APIs', () => {
  webTest.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 3 })
  webTest.beforeEach(async ({ request }) => {
    const reset = await request.post(`${webUrl}/.dev-seed/reset`)
    expect(reset.status()).toBe(204)
  })

  for (const [width, height] of [[382, 580], [594, 368], [669, 867], [951, 585], [385, 571], [951, 543], [669, 902], [951, 669]]) {
    webTest(`homepage and portable viewer remain usable at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      await page.goto(webUrl!, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('.home-demo')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
      await page.goto(`${webUrl}/${process.env.GALLERY_OWNER ?? 'thecontrarian'}/${process.env.GALLERY_SLUG ?? 'dev-dropbox'}`, { waitUntil: 'domcontentloaded' })
      const curtain = page.locator('[data-curtain]')
      await expect(curtain).toBeVisible()
      await curtain.click()
      await expect(curtain).toBeHidden()
      const stage = page.locator('[data-stage]')
      await expect(stage).toHaveClass(/mode-strip/)
      const box = (await stage.boundingBox())!
      expect(box.width).toBeLessThanOrEqual(width)
      expect(box.height).toBeLessThanOrEqual(height)
      const photo = page.locator('img.frame-img').first()
      await expect.poll(() => photo.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      expect((await photo.boundingBox())!.height).toBeLessThanOrEqual(height)
      await page.getByRole('button', { name: 'Show controls', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Gallery Settings', exact: true })
      await expect(settings).toBeVisible()
      expect(await settings.getByRole('radio', { name: 'Spread', exact: true }).count()).toBe(0)
      const panel = (await settings.boundingBox())!
      expect(panel.x).toBeGreaterThanOrEqual(0)
      expect(panel.y).toBeGreaterThanOrEqual(0)
      expect(panel.x + panel.width).toBeLessThanOrEqual(width + 1)
      expect(panel.y + panel.height).toBeLessThanOrEqual(height + 1)
      await settings.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(settings).toBeHidden()
    })
  }
})
