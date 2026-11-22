import { expect, test, type Page } from '@playwright/test'
import { showChrome } from './playwright-helpers'
import { readFileSync } from 'node:fs'
import { SignJWT } from 'jose'

/**
 * End-to-end proof for the approved optical-marginalia gallery ground. Dark
 * is the gallery default — the Blank canvas was retired by the owner, so
 * every gallery paints the fixed 256px pattern behind the photo margins,
 * and strip neighbours sit a gutter apart over the artwork. Light selects
 * the same field in the warm-paper pairing. The old URL-seeded, viewport-rebuilt
 * sprite contract is intentionally not tested: it was superseded by one
 * baked 80-placement artwork, uniformly quarter-scaled at the owner's request.
 *
 * Run with: bunx playwright test doodle-background.playwright.ts
 * Set DOODLE_BASE_URL if the dev server is not on :5173.
 */

const BASE = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'
const ALBUM_A = `${BASE}/thecontrarian/mixed-album`
// The keyless MEGA route correctly locks after hydration. Use a second
// already-viewable gallery here; key recovery is not a background fixture.
const ALBUM_B = `${BASE}/thecontrarian/dev-dropbox`
const DEV_ACCOUNT = 'dbid:AAATESTowner1'
const devEnv = (() => {
  const env: Record<string, string> = {}
  try {
    for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, '$1')
    }
  } catch {
    // .env.local exists only in a dev checkout.
  }
  return env
})()

// Each case loads a real gallery (and the first one pays for Vite's
// cold on-demand transform), so the default 30s is too tight.
test.setTimeout(90_000)

/** The dev server seeds its demo galleries asynchronously at boot, so a
 *  suite that starts too early gets "There is no gallery here". Retry
 *  navigation until the viewer island is actually served. */
const gotoGallery = async (page: Page, url: string) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (await page.locator('[data-chrome-position]').count()) return
    await page.waitForTimeout(1000)
  }
  throw new Error(`gallery never became available at ${url} — is the dev server seeded?`)
}

/** Lifts the entry curtain and opens the display-settings panel. The
 *  curtain animates out over ~900ms and swallows pointer events until it
 *  does, so wait for it to actually go rather than for a timer. */
const openSettings = async (page: Page) => {
  await page.locator('[data-chrome-position]').waitFor({ state: 'attached', timeout: 60000 })
  if (await page.locator('.m-sheet-host').count()) await page.keyboard.press('Escape')
  const curtain = page.locator('[data-curtain]')
  if (await curtain.count()) {
    await curtain.first().click({ force: true }).catch(() => {})
    await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      await curtain.first().click({ force: true }).catch(() => {})
      await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
    })
  }
  await page.locator('[data-chrome-position]').waitFor({ state: 'attached', timeout: 30000 })
  await showChrome(page)
  await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Gallery Settings' })).toBeVisible()
}

const sessionCookie = async () => {
  const secret = process.env.HOST_API_JWT_SECRET ?? devEnv.HOST_API_JWT_SECRET ?? ''
  if (!secret) throw new Error('HOST_API_JWT_SECRET is required for dashboard doodle tests')
  const token = await new SignJWT({ sub: DEV_ACCOUNT })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('2h')
    .sign(new TextEncoder().encode(secret))
  return `manorama_session=${token}`
}

const openDashboard = async (page: Page) => {
  await page.context().setExtraHTTPHeaders({ Cookie: await sessionCookie() })
  await page.goto(`${BASE}/thecontrarian`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.admin-page')).toBeVisible()
  // `.admin-page` is server-rendered, so its presence proves nothing about
  // the island being live — the island sets data-admin-ready once mounted.
  // Deliberately no `networkidle` here — the dashboard polls on an interval,
  // so it never goes idle and the wait would eat the whole test budget.
  await page.locator('[data-admin-ready="true"]').waitFor({ state: 'visible', timeout: 30000 })
}

/** Clicks an island control that may still be hydrating: a click landing on
 *  pre-hydration markup is silently dropped, so retry until the expected
 *  state actually lands rather than asserting once against a lost event. */
const clickUntil = async (page: Page, click: () => Promise<void>, expected: string) => {
  await expect(async () => {
    if (await page.locator(expected).count() === 0) await click()
    await expect(page.locator(expected)).toHaveCount(1, { timeout: 2000 })
  }).toPass({ timeout: 30000 })
}

/** Specs that need a specific pairing seed the preference before navigation
 *  so the gallery boots straight into it. The unseeded default is Dark; the
 *  legacy 'none' value is exercised explicitly in its own migration case. */
const seedBackground = (page: Page, value: 'light' | 'dark' = 'dark', slugs: string[] = ['mixed-album']) =>
  page.addInitScript(({ v, keys }) => {
    try { for (const key of keys) window.localStorage.setItem(key, JSON.stringify({ background: v })) } catch { /* private mode */ }
  }, { v: value, keys: slugs.map((slug) => `manorama:view:${slug}`) })

const selectBackground = async (page: Page, value: 'light' | 'dark') => {
  const group = page.getByRole('radiogroup', { name: 'Canvas' })
  if (await group.count() === 0 || !(await group.isVisible().catch(() => false))) await openSettings(page)
  await page.getByRole('radio', { name: { light: 'Light', dark: 'Dark' }[value] }).click()
  await page.waitForTimeout(350)
}

const layerSignature = async (page: Page) => {
  const svg = page.locator('[data-doodle-bg]')
  await expect(svg).toHaveCount(1)
  return svg.evaluate((el) => {
    const pattern = el.querySelector('pattern')
    const groups = Array.from(el.querySelectorAll<SVGGElement>('[data-gallery-ground-motif]'))
      .map((group) => ({
        motifId: group.getAttribute('data-gallery-ground-motif'),
        placementId: group.getAttribute('data-gallery-ground-placement'),
        paths: Array.from(group.querySelectorAll('path')).map((path) => path.getAttribute('d')),
      }))
      .sort((a, b) => `${a.placementId}:${a.motifId}`.localeCompare(`${b.placementId}:${b.motifId}`))
    const box = el.getBoundingClientRect()
    return {
      seed: el.getAttribute('data-doodle-seed'),
      count: el.getAttribute('data-doodle-count'),
      artwork: el.getAttribute('data-doodle-artwork'),
      viewBox: el.getAttribute('viewBox'),
      patternWidth: pattern?.getAttribute('width'),
      patternHeight: pattern?.getAttribute('height'),
      patternUnits: pattern?.getAttribute('patternUnits'),
      artworkScale: pattern?.querySelector('[data-gallery-ground-scale]')?.getAttribute('transform'),
      geometry: groups,
      width: el.getAttribute('width'),
      height: el.getAttribute('height'),
      cssWidth: box.width,
      cssHeight: box.height,
    }
  })
}

const parseRgb = (value: string) => value.match(/\d+/g)?.slice(0, 3).map(Number) ?? []

const readPairing = (page: Page) => page.locator('[data-doodle-bg]').evaluate((svg) => {
  const stage = svg.closest('.viewer-stage')
  return {
    ink: getComputedStyle(svg).color,
    canvas: stage ? getComputedStyle(stage).backgroundColor : '',
  }
})

test('Canvas offers Dark/Light only — Dark is default, the field paints and strip neighbours sit apart', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)

  /* Dark by default: the field is mounted and the canvas stays charcoal.
     The choice lands in the mount reconciliation, so poll rather than
     assert once against pre-hydration markup. */
  await expect(async () => {
    await expect(page.locator('.viewer-stage.bg-dark')).toHaveCount(1)
    await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  }).toPass({ timeout: 30000 })

  // Strip neighbours are separated — the 10px gutter reveals the artwork.
  const gutter = await page.locator('[data-stage]').evaluate(() => {
    const frames = Array.from(document.querySelectorAll('.viewer-frame'))
    const a = frames[0].getBoundingClientRect()
    const b = frames[1].getBoundingClientRect()
    return Math.min(Math.abs(b.left - a.right), Math.abs(b.top - a.bottom))
  })
  expect(Math.abs(gutter - 10)).toBeLessThan(2)

  await openSettings(page)
  const group = page.getByRole('radiogroup', { name: 'Canvas' })
  const radios = group.getByRole('radio')
  await expect(radios).toHaveCount(2)
  await expect(radios.nth(0)).toHaveText('Dark')
  await expect(radios.nth(1)).toHaveText('Light')
  await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'Blank' })).toHaveCount(0)
  await expect(page.locator('[data-doodle-toggle]')).toHaveCount(0)

  const dark = await layerSignature(page)
  await expect(page.locator('.viewer-stage.bg-dark')).toHaveCount(1)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  expect(dark.seed).toBe('1843')
  expect(dark.count).toBe('80')
  expect(dark.artwork).toBe('optical-marginalia-v1')
  expect(dark.viewBox).toBeNull()
  expect(dark.patternWidth).toBe('256')
  expect(dark.patternHeight).toBe('256')
  expect(dark.patternUnits).toBe('userSpaceOnUse')
  expect(dark.artworkScale).toBe('scale(0.25)')
  expect(dark.geometry).toHaveLength(92)
  expect(new Set(dark.geometry.map((record) => record.placementId)).size).toBe(80)
  expect(new Set(dark.geometry.map((record) => record.motifId)).size).toBe(24)

  // Light changes only the pairing, never the approved path geometry.
  await selectBackground(page, 'light')
  await expect(page.locator('.viewer-stage.bg-light')).toHaveCount(1)
  const light = await layerSignature(page)
  expect(light.geometry).toEqual(dark.geometry)

  // Back to Dark — the field never leaves the gallery surfaces.
  await selectBackground(page, 'dark')
  await expect(page.locator('.viewer-stage.bg-dark')).toHaveCount(1)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
})

test('a legacy stored Blank preference migrates onto the Dark default', async ({ page }) => {
  /* Pre-retirement visitors stored background:'none'. The value is no
     longer selectable, so the preference read must drop it and the
     gallery must land on Dark — never a canvas-less stage. */
  await page.addInitScript(() => {
    try { window.localStorage.setItem('manorama:view:mixed-album', JSON.stringify({ background: 'none' })) } catch { /* private mode */ }
  })
  await gotoGallery(page, ALBUM_A)
  await expect(async () => {
    await expect(page.locator('.viewer-stage.bg-dark')).toHaveCount(1)
    await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  }).toPass({ timeout: 30000 })
  const gutter = await page.locator('[data-stage]').evaluate(() => {
    const frames = Array.from(document.querySelectorAll('.viewer-frame'))
    const a = frames[0].getBoundingClientRect()
    const b = frames[1].getBoundingClientRect()
    return Math.abs(b.left - a.right)
  })
  expect(Math.abs(gutter - 10)).toBeLessThan(2)
})

test('Light and Dark give every image a 10px margin in both layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedBackground(page, 'dark')
  await gotoGallery(page, ALBUM_A)
  await page.locator('[data-stage]').waitFor()
  await expect(page.locator('.viewer-stage.bg-dark')).toHaveCount(1)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  await page.waitForTimeout(800)

  // Strip: bounding boxes exclude margins, so the frame gap IS the margin.
  const strip = await page.locator('[data-stage]').evaluate((stage) => {
    const stageBox = stage.getBoundingClientRect()
    const frames = Array.from(stage.querySelectorAll('.viewer-frame'))
    const boxes = frames.map((f) => f.getBoundingClientRect())
    return {
      top: Math.min(...boxes.map((b) => b.top - stageBox.top)),
      bottom: Math.min(...boxes.map((b) => stageBox.bottom - b.bottom)),
      gutter: boxes[1].left - boxes[0].right,
      left: boxes[0].left - stageBox.left,
    }
  })
  expect(Math.abs(strip.top - 10)).toBeLessThan(2)
  expect(Math.abs(strip.bottom - 10)).toBeLessThan(2)
  expect(Math.abs(strip.gutter - 10)).toBeLessThan(2)
  expect(Math.abs(strip.left)).toBeLessThan(2)

  await openSettings(page)
  await page.getByRole('radio', { name: 'Scroll' }).click()
  await expect(page.locator('[data-stage]')).toHaveClass(/mode-vertical/)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const vertical = await page.locator('[data-stage]').evaluate((stage) => {
    const stageBox = stage.getBoundingClientRect()
    const frames = Array.from(stage.querySelectorAll('.viewer-frame'))
    const a = frames[0].getBoundingClientRect()
    const b = frames[1].getBoundingClientRect()
    return { left: a.left - stageBox.left, right: stageBox.right - a.right, foot: b.top - a.bottom, top: a.top - stageBox.top }
  })
  expect(Math.abs(vertical.left - 10)).toBeLessThan(2)
  expect(Math.abs(vertical.right - 10)).toBeLessThan(2)
  expect(Math.abs(vertical.foot - 10)).toBeLessThan(2)
  expect(Math.abs(vertical.top)).toBeLessThan(2)

  /* The same rails hold under Light — margin belongs to the spaced
     canvas rule, not to one pairing. */
  await selectBackground(page, 'light')
  await expect(page.locator('.viewer-stage.bg-light')).toHaveCount(1)
  const lit = await page.locator('[data-stage]').evaluate((stage) => {
    const stageBox = stage.getBoundingClientRect()
    const frames = Array.from(stage.querySelectorAll('.viewer-frame'))
    const a = frames[0].getBoundingClientRect()
    const b = frames[1].getBoundingClientRect()
    return { left: a.left - stageBox.left, right: stageBox.right - a.right, foot: b.top - a.bottom }
  })
  expect(Math.abs(lit.left - 10)).toBeLessThan(2)
  expect(Math.abs(lit.right - 10)).toBeLessThan(2)
  expect(Math.abs(lit.foot - 10)).toBeLessThan(2)
})

test('Dark and Light use the exact paired colors independently of html.light', async ({ page }) => {
  await seedBackground(page, 'dark')
  await gotoGallery(page, ALBUM_A)
  const darkPair = await readPairing(page)
  expect(parseRgb(darkPair.canvas)).toEqual([16, 16, 16])
  expect(parseRgb(darkPair.ink)).toEqual([72, 72, 72])

  await page.evaluate(() => document.documentElement.classList.add('light'))
  expect(await readPairing(page)).toEqual(darkPair)
  await page.evaluate(() => document.documentElement.classList.remove('light'))

  await selectBackground(page, 'light')
  const lightPair = await readPairing(page)
  expect(parseRgb(lightPair.canvas)).toEqual([233, 229, 220])
  expect(parseRgb(lightPair.ink)).toEqual([170, 165, 155])
})

test('reloading the same url reproduces the identical approved path geometry', async ({ page }) => {
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)
  const first = await layerSignature(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-chrome-position]').waitFor({ state: 'attached', timeout: 60000 })
  await page.waitForTimeout(1200)
  const second = await layerSignature(page)

  expect(second.seed).toBe('1843')
  expect(second.count).toBe('80')
  expect(second.geometry).toEqual(first.geometry)
  expect(second.patternWidth).toBe(first.patternWidth)
  expect(second.patternHeight).toBe(first.patternHeight)
  expect(second.artworkScale).toBe(first.artworkScale)
})

test('every album and URL/history state uses the same approved geometry', async ({ page }) => {
  await seedBackground(page, 'dark', ['mixed-album', 'dev-dropbox'])
  await gotoGallery(page, ALBUM_A)
  const first = await layerSignature(page)

  await page.evaluate(() => history.pushState({}, '', `${location.pathname}?mode=single`))
  await page.waitForTimeout(250)
  const query = await layerSignature(page)
  expect(query.geometry).toEqual(first.geometry)
  expect(query.seed).toBe('1843')

  await page.evaluate(() => history.replaceState({}, '', `${location.pathname}?mode=single&t=123&scroll=900`))
  await page.waitForTimeout(250)
  expect((await layerSignature(page)).geometry).toEqual(first.geometry)

  await gotoGallery(page, ALBUM_B)
  const otherAlbum = await layerSignature(page)
  expect(otherAlbum.seed).toBe(first.seed)
  expect(otherAlbum.geometry).toEqual(first.geometry)
})

test('the fixed 256px pattern and quarter-scaled geometry survive resize without further scaling or rebuilding', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)
  const before = await layerSignature(page)

  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(700)
  const after = await layerSignature(page)

  expect(after.seed).toBe('1843')
  expect(after.count).toBe('80')
  expect(after.viewBox).toBe(before.viewBox)
  expect(after.patternWidth).toBe('256')
  expect(after.patternHeight).toBe('256')
  expect(after.patternUnits).toBe('userSpaceOnUse')
  expect(before.artworkScale).toBe('scale(0.25)')
  expect(after.artworkScale).toBe(before.artworkScale)
  expect(after.geometry).toEqual(before.geometry)
  expect(after.cssWidth).not.toBe(before.cssWidth)
  expect(after.cssHeight).not.toBe(before.cssHeight)
})

test('the layer never intercepts a click meant for the gallery', async ({ page }) => {
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)
  const curtain = page.locator('[data-curtain]')
  if (await curtain.count()) {
    await curtain.first().click({ force: true }).catch(() => {})
    await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
  }
  await page.waitForTimeout(300)

  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return { tag: el?.tagName ?? '', isDoodle: !!el?.closest('[data-doodle-bg]') }
  })
  expect(hit.isDoodle).toBe(false)

  await showChrome(page)
  await page.getByRole('button', { name: 'Gallery Settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Gallery Settings' })).toBeVisible()
})

test('the layer is inert and hidden from assistive tech', async ({ page }) => {
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)

  const svg = page.locator('[data-doodle-bg]')
  await expect(svg).toHaveAttribute('aria-hidden', 'true')
  await expect(svg).toHaveAttribute('role', 'presentation')
  const styles = await svg.evaluate((el) => {
    const s = getComputedStyle(el)
    return { pointerEvents: s.pointerEvents, position: s.position, zIndex: s.zIndex }
  })
  expect(styles.pointerEvents).toBe('none')
  expect(styles.position).toBe('absolute')
  expect(styles.zIndex).toBe('0')
  await expect(svg.locator('[data-gallery-ground-motif]')).toHaveCount(92)
})

test('the field paints visible approved paths and yields dark/light screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/doodle-dark.png' })

  const report = await page.evaluate(() => {
    const svg = document.querySelector('[data-doodle-bg]')
    if (!svg) return null
    const paths = Array.from(svg.querySelectorAll('path'))
    // Pattern definitions have no CSS layout boxes. Their SVG-space bounds
    // remain meaningful; the raster assertion below separately proves paint.
    const tilePaths = paths
      .map((path) => path.getBBox())
      .filter((r) => r.width > 0 && r.y + r.height > 0 && r.y < 1024 && r.x + r.width > 0 && r.x < 1024)
    return {
      totalGroups: svg.querySelectorAll('[data-gallery-ground-motif]').length,
      placements: new Set(Array.from(svg.querySelectorAll('[data-gallery-ground-placement]')).map((group) => group.getAttribute('data-gallery-ground-placement'))).size,
      totalPaths: paths.length,
      tilePaths: tilePaths.length,
      motifs: new Set(Array.from(svg.querySelectorAll('[data-gallery-ground-motif]')).map((group) => group.getAttribute('data-gallery-ground-motif'))).size,
      color: getComputedStyle(svg).color,
      pointerEvents: getComputedStyle(svg).pointerEvents,
      pattern: svg.querySelector('pattern')?.getAttribute('patternUnits'),
    }
  })

  expect(report).not.toBeNull()
  expect(report!.totalGroups).toBe(92)
  expect(report!.placements).toBe(80)
  expect(report!.totalPaths).toBeGreaterThan(80)
  expect(report!.tilePaths).toBeGreaterThan(15)
  expect(report!.motifs).toBe(24)
  expect(parseRgb(report!.color)).toEqual([72, 72, 72])
  expect(report!.pointerEvents).toBe('none')
  expect(report!.pattern).toBe('userSpaceOnUse')

  // A 1024px square must now paint sixteen identical 256px repeats. The source
  // 3-unit strokes are 0.75 CSS pixels, so opaque-pixel counts from the old
  // full-size presentation no longer measure this fine, antialiased texture.
  // Render only decorative vectors; no provider image is read or transformed.
  const pixels = await page.locator('[data-doodle-bg]').evaluate(async (svg) => {
    const copy = svg.cloneNode(true) as SVGSVGElement
    copy.setAttribute('width', '1024')
    copy.setAttribute('height', '1024')
    copy.setAttribute('style', `color:${getComputedStyle(svg).color}`)
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1024
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const data = context.getImageData(0, 0, 1024, 1024).data
    let tilePainted = 0
    let tileStrongInk = 0
    let differingChannels = 0
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const index = (y * 1024 + x) * 4
      if (data[index + 3] > 0) tilePainted++
      if (data[index + 3] >= 128) tileStrongInk++
      for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
        const repeated = ((y + row * 256) * 1024 + x + column * 256) * 4
        for (let channel = 0; channel < 4; channel++) {
          if (data[index + channel] !== data[repeated + channel]) differingChannels++
        }
      }
    }
    return { tilePainted, tileStrongInk, differingChannels }
  })
  expect(pixels.tilePainted).toBeGreaterThan(500)
  expect(pixels.tilePainted).toBeLessThan(32_768)
  expect(pixels.tileStrongInk).toBeGreaterThan(500)
  expect(pixels.differingChannels).toBe(0)

  // eslint-disable-next-line no-console
  console.log('doodle visual report (dark pairing):', JSON.stringify(report))

  await openSettings(page)
  await selectBackground(page, 'light')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const lightReport = await page.evaluate(() => {
    const svg = document.querySelector('[data-doodle-bg]')
    return svg ? { color: getComputedStyle(svg).color, canvas: getComputedStyle(svg.closest('.viewer-stage')!).backgroundColor } : null
  })
  expect(lightReport).not.toBeNull()
  expect(parseRgb(lightReport!.color)).toEqual([170, 165, 155])
  expect(parseRgb(lightReport!.canvas)).toEqual([233, 229, 220])
  await page.screenshot({ path: 'test-results/doodle-light.png' })

  await openSettings(page)
  await selectBackground(page, 'dark')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    document.querySelectorAll('.viewer-track').forEach((el) => { (el as HTMLElement).style.visibility = 'hidden' })
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/doodle-layer-only.png' })
  await page.evaluate(() => {
    const svg = document.querySelector('[data-doodle-bg]')
    if (svg) (svg as HTMLElement).style.display = 'none'
  })
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/doodle-layer-blank.png' })
})

test('the dashboard has its own themed app canvas, independent of gallery preferences', async ({ page }) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem('manorama:background', 'light')
    localStorage.setItem('manorama:view:mixed-album', JSON.stringify({ background: 'light' }))
  })
  await openDashboard(page)

  await expect(page.getByRole('button', { name: 'Use doodle background' })).toHaveCount(0)
  await expect(page.locator('.admin-background-toggle')).toHaveCount(0)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(0)
  await expect(page.locator('.admin-page.has-doodle')).toHaveCount(0)
  await page.evaluate(() => document.documentElement.classList.remove('light'))
  await expect(page.locator('.admin-page')).toHaveCSS('background-image', /app-canvas-dark\.svg/)
  await expect(page.locator('.admin-page')).toHaveCSS('background-size', '256px 256px')
  await page.evaluate(() => document.documentElement.classList.add('light'))
  await expect(page.locator('.admin-page')).toHaveCSS('background-image', /app-canvas-light\.svg/)

  await gotoGallery(page, ALBUM_A)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
})

/* Control-path assertion after the Blank retirement: the sheet hydrates,
   the two surviving pairings switch live, and the field never leaves —
   the stage itself still paints a flat colour, not a tiled background
   image, with the SVG layer doing the pattern work. */
test('canvas controls remain available and the field never leaves the gallery', async ({ page }) => {
  await seedBackground(page)
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await clickUntil(page, () => page.getByRole('radio', { name: 'Light' }).click(), '.viewer-stage.bg-light')
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  await expect(page.getByRole('dialog', { name: 'Gallery Settings' })).toBeVisible()
  await expect(page.locator('.viewer-stage')).toHaveCSS('background-image', 'none')
  await expect(page.getByRole('dialog', { name: 'Gallery Settings' })).not.toHaveCSS('background-image', /app-canvas/)
  await clickUntil(page, () => page.getByRole('radio', { name: 'Dark' }).click(), '.viewer-stage.bg-dark')
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
})

/* Owner polish round (2026-11-21): the artwork is the gallery's first
   reveal, not the wait for it; the bottom controls rest as one blob and
   only separate under the pointer; no photograph box or end card carries
   a film of its own over the field; and every image wears a hair of
   corner rounding (a display mask only — source bytes are untouched). */
test('the curtain opens on a bare veil and the gallery keeps the field clear', async ({ page }) => {
  await seedBackground(page)
  await page.goto(ALBUM_A, { waitUntil: 'domcontentloaded' })
  const curtain = page.locator('[data-curtain]')
  await curtain.first().waitFor({ state: 'attached', timeout: 60000 })
  await expect(curtain.first()).not.toHaveCSS('background-image', /app-canvas/)
  await expect(curtain.first()).toHaveCSS('background-image', /linear-gradient/)
  await curtain.first().click({ force: true }).catch(() => {})
  await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
  await page.locator('.viewer-frame img').first().waitFor({ state: 'attached', timeout: 30000 })
  await page.waitForTimeout(600)

  await expect(page.locator('.viewer-frame').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(page.locator('.viewer-frame img').first()).toHaveCSS('border-radius', '4px')
  await expect(page.locator('.viewer-endcap').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

  /* The chrome blob: flush pills at rest, ten pixels apart once the
     pointer (or focus) is on the bar. Junction corners square off at
     rest so the flush pills silhouette as one mass; they round back as
     the gap opens. */
  await showChrome(page)
  const bar = page.locator('.m-chrome--bottom')
  await expect(bar).toHaveCSS('gap', '0px')
  const cornerRadii = () =>
    bar.locator('.m-chrome-pill').evaluateAll((pills) =>
      pills.map((pill) => {
        const cs = getComputedStyle(pill)
        return [
          cs.borderTopLeftRadius,
          cs.borderTopRightRadius,
          cs.borderBottomRightRadius,
          cs.borderBottomLeftRadius,
        ]
      }),
    )
  const restRadii = await cornerRadii()
  expect(restRadii[0][1]).toBe('0px')
  expect(restRadii[0][2]).toBe('0px')
  expect(restRadii[1].every((r) => r === '0px')).toBe(true)
  expect(restRadii[2][0]).toBe('0px')
  expect(restRadii[2][3]).toBe('0px')
  await bar.locator('.m-chrome-pill').first().hover()
  await expect(bar).toHaveCSS('gap', '10px')
  const openRadii = await cornerRadii()
  expect(openRadii.every((radii) => radii.every((r) => r !== '0px'))).toBe(true)

  /* The one-by-one end card: no background of its own, and the last
     photograph fades out beneath it so "The End." lands on the artwork.
     The classes are driven directly here — the CSS contract is the unit
     under test, not the step-past-the-end gesture, which qa owns. */
  const single = await page.evaluate(async () => {
    const track = document.querySelector('.viewer-track')
    const cap = document.querySelector('.viewer-endcap')
    const frame = document.querySelector('.viewer-frame')
    if (!track || !cap || !frame) return null
    track.classList.add('viewer-track--single')
    cap.classList.add('viewer-endcap--single', 'is-open')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const report = {
      capBg: getComputedStyle(cap).backgroundColor,
      capOpacity: getComputedStyle(cap).opacity,
      frameOpacity: getComputedStyle(frame).opacity,
    }
    track.classList.remove('viewer-track--single')
    cap.classList.remove('viewer-endcap--single', 'is-open')
    return report
  })
  expect(single).not.toBeNull()
  expect(single!.capBg).toBe('rgba(0, 0, 0, 0)')
  expect(single!.capOpacity).toBe('1')
  expect(single!.frameOpacity).toBe('0')
})
