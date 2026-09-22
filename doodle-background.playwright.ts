import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { SignJWT } from 'jose'
import { seedFromUrl } from './app/lib/doodle-background'

/**
 * End-to-end proof for the seeded doodle background, against the real
 * dev server. Covers each acceptance criterion: the toggle shows and
 * hides the field, one URL always reproduces one pattern, a different
 * album produces a different one, and the layer never intercepts a tap.
 *
 * Run with: bunx playwright test doodle-background.playwright.ts
 * Set DOODLE_BASE_URL if the dev server is not on :5175.
 */

const BASE = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'
const ALBUM_A = `${BASE}/thecontrarian/mixed-album`
const ALBUM_B = `${BASE}/thecontrarian/dev-mega`
const DEV_ACCOUNT = 'dbid:AAATESTowner1'
const devEnv = (() => {
  const env: Record<string, string> = {}
  try {
    for (const line of readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n')) {
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
 *  the navigation until the viewer island is actually served. */
const gotoGallery = async (page: Page, url: string) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.goto(url)
    if (await page.locator('.control-logo').count()) return
    await page.waitForTimeout(1000)
  }
  throw new Error(`gallery never became available at ${url} — is the dev server seeded?`)
}

/** Lifts the entry curtain and opens the display-settings panel. The
 *  curtain animates out over ~900ms and swallows pointer events until
 *  it does, so wait for it to actually go rather than for a timer. */
const openSettings = async (page: Page) => {
  // The first test against a cold dev server waits on Vite's on-demand
  // transform, so give hydration room before touching the chrome.
  await page.locator('.control-logo').waitFor({ state: 'attached', timeout: 60000 })
  const curtain = page.locator('[data-curtain]')
  if (await curtain.count()) {
    await curtain.first().click({ force: true }).catch(() => {})
    await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(async () => {
      // Belt and braces: some runs need a second nudge before the lift
      // starts (the island may still have been hydrating on the first).
      await curtain.first().click({ force: true }).catch(() => {})
      await curtain.first().waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {})
    })
  }
  const logo = page.locator('.control-logo')
  await logo.waitFor({ state: 'visible', timeout: 30000 })
  await logo.click()
  await expect(page.locator('[data-doodle-toggle]')).toBeVisible()
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
  await page.goto(`${BASE}/thecontrarian`)
  await expect(page.locator('.admin-page')).toBeVisible()
  // `.admin-page` is server-rendered, so its presence proves nothing about
  // the island being live. The background toggle used to be our hydration
  // beacon; it is gone now, so wait on the theme control instead.
  // Deliberately no `networkidle` here — the dashboard polls on an interval,
  // so it never goes idle and the wait would eat the whole test budget.
  await page.locator('.admin-theme-toggle').waitFor({ state: 'visible', timeout: 30000 })
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

const toggleDoodle = async (page: Page) => {
  await page.locator('[data-doodle-toggle]').click()
  await page.waitForTimeout(350)
}

const layerSignature = async (page: Page) => {
  const svg = page.locator('[data-doodle-bg]')
  await expect(svg).toHaveCount(1)
  return {
    seed: await svg.getAttribute('data-doodle-seed'),
    count: await svg.getAttribute('data-doodle-count'),
    // The full geometry of every glyph — the screenshot-diff equivalent.
    geometry: await svg.evaluate((el) =>
      Array.from(el.querySelectorAll('use'))
        .map((u) => `${u.getAttribute('href')}|${u.getAttribute('transform')}|${u.getAttribute('opacity')}|${u.getAttribute('width')}`)
        .join(';')),
  }
}

test('the toggle shows the doodle field and hides it again', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)

  // Off by default: the flat background is untouched.
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(0)
  await expect(page.locator('[data-doodle-toggle]')).toHaveAttribute('aria-pressed', 'false')

  await toggleDoodle(page)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
  await expect(page.locator('[data-doodle-toggle]')).toHaveAttribute('aria-pressed', 'true')
  const count = Number((await page.locator('[data-doodle-bg]').getAttribute('data-doodle-count')) ?? '0')
  expect(count).toBeGreaterThan(20)
  expect(count).toBeLessThanOrEqual(420)

  await toggleDoodle(page)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(0)
  await expect(page.locator('.viewer-stage.has-doodle')).toHaveCount(0)
})

test('reloading the same url reproduces an identical pattern', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)
  const first = await layerSignature(page)

  // The preference persists, so the field must return identically.
  await page.reload()
  await page.waitForTimeout(1200)
  const second = await layerSignature(page)

  expect(second.seed).toBe(first.seed)
  expect(second.count).toBe(first.count)
  expect(second.geometry).toBe(first.geometry)
  expect(first.geometry.length).toBeGreaterThan(100)
})

test('a different album produces a visibly different pattern', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)
  const a = await layerSignature(page)

  await gotoGallery(page, ALBUM_B)
  await page.waitForTimeout(1200)
  const b = await layerSignature(page)

  expect(b.seed).not.toBe(a.seed)
  expect(b.geometry).not.toBe(a.geometry)
})

test('the layer never intercepts a click meant for the gallery', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Whatever sits under the centre of the viewport, it must not be the
  // background layer: pointer-events:none has to hold.
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return { tag: el?.tagName ?? '', isDoodle: !!el?.closest('[data-doodle-bg]') }
  })
  expect(hit.isDoodle).toBe(false)

  // And the controls still respond after the layer is painted.
  await page.locator('.control-logo').click()
  await expect(page.locator('[data-doodle-toggle]')).toBeVisible()
})

test('the layer is inert and hidden from assistive tech', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)

  const svg = page.locator('[data-doodle-bg]')
  await expect(svg).toHaveAttribute('aria-hidden', 'true')
  const styles = await svg.evaluate((el) => {
    const s = getComputedStyle(el)
    return { pointerEvents: s.pointerEvents, position: s.position, zIndex: s.zIndex }
  })
  expect(styles.pointerEvents).toBe('none')
  expect(styles.position).toBe('fixed')
})

test('the field paints visible glyphs and yields a screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)

  // Capture the same viewport with the pattern off, then on, so the
  // pixel comparison isolates exactly what the layer contributes.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/doodle-off.png' })

  await openSettings(page)
  await toggleDoodle(page)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  const report = await page.evaluate(() => {
    const svg = document.querySelector('[data-doodle-bg]')
    if (!svg) return null
    const uses = Array.from(svg.querySelectorAll('use'))
    const cs = getComputedStyle(svg)
    const onScreenRects = uses
      .map((u) => (u as unknown as SVGGraphicsElement).getBoundingClientRect())
      .filter((r) => r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth)
    return {
      total: uses.length,
      onScreen: onScreenRects.length,
      leftmost: Math.min(...onScreenRects.map((r) => r.left)),
      rightmost: Math.max(...onScreenRects.map((r) => r.right)),
      symbols: svg.querySelectorAll('symbol').length,
      distinctIcons: new Set(uses.map((u) => u.getAttribute('href'))).size,
      color: cs.color,
      pointerEvents: cs.pointerEvents,
    }
  })

  expect(report).not.toBeNull()
  // Real geometry, not just markup: glyphs must actually land on screen.
  expect(report!.onScreen).toBeGreaterThan(15)
  // …and reach both edges. A letter-boxed SVG would leave bare gutters.
  expect(report!.leftmost).toBeLessThan(160)
  expect(report!.rightmost).toBeGreaterThan(1440 - 160)
  expect(report!.distinctIcons).toBeGreaterThan(5)
  expect(report!.symbols).toBeGreaterThanOrEqual(8)
  expect(report!.pointerEvents).toBe('none')

  // The gallery canvas is near-black, so the ink must be LIGHT or the
  // pattern is invisible. Regression guard for tying the tint to
  // prefers-color-scheme instead of the app's own html.light switch.
  const rgb = report!.color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]
  const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
  expect(luminance).toBeGreaterThan(120)

  // eslint-disable-next-line no-console
  console.log('doodle visual report:', JSON.stringify(report))

  await page.screenshot({ path: 'test-results/doodle-on.png' })

  // Pixel proof, isolated: hide the photo track so only the background
  // layer paints, then capture. Comparing full frames instead would be
  // confounded by the strip drifting a few px between shots.
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

test('the dashboard never paints a doodle field, even when the gallery preference is on', async ({ page }) => {
  // Doodles are gallery-only. Turn the shared preference ON, then prove the
  // account page still renders no layer and offers no background control,
  // while a public album with the same flag does paint one.
  await page.goto(BASE)
  await page.evaluate(() => localStorage.setItem('manorama:background', 'doodle'))
  await openDashboard(page)

  await expect(page.getByRole('button', { name: 'Use doodle background' })).toHaveCount(0)
  await expect(page.locator('.admin-background-toggle')).toHaveCount(0)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(0)
  await expect(page.locator('.admin-page.has-doodle')).toHaveCount(0)

  await gotoGallery(page, ALBUM_A)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
})

test('history navigation changes the seed while transient query changes do not', async ({ page }) => {
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)
  const firstSeed = await page.locator('[data-doodle-bg]').getAttribute('data-doodle-seed')

  const modeSeed = seedFromUrl('/thecontrarian/mixed-album?mode=single')
  await page.evaluate(() => history.pushState({}, '', '/thecontrarian/mixed-album?mode=single'))
  await expect(page.locator('[data-doodle-bg]')).toHaveAttribute('data-doodle-seed', String(modeSeed))
  expect(String(modeSeed)).not.toBe(firstSeed)

  await page.evaluate(() => history.replaceState({}, '', '/thecontrarian/mixed-album?mode=single&t=123&scroll=900'))
  await expect(page.locator('[data-doodle-bg]')).toHaveAttribute('data-doodle-seed', String(modeSeed))
})

test('the field survives a resize without a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await gotoGallery(page, ALBUM_A)
  await openSettings(page)
  await toggleDoodle(page)
  const before = await layerSignature(page)

  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(700)
  const after = await layerSignature(page)

  // Same view, so the seed is untouched; the grid refits the new width.
  expect(after.seed).toBe(before.seed)
  await expect(page.locator('[data-doodle-bg]')).toHaveCount(1)
})
