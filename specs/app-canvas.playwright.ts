import { expect, test } from '@playwright/test'

const base = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'

test('marketing homepage and its embedded viewer never acquire the app canvas', async ({ page }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('html')).toHaveClass(/home-page/)
  await expect(page.locator('link[href*="canvas.css"]')).toHaveCount(0)
  for (const surface of ['body', '.landing-page']) {
    const elements = page.locator(surface)
    for (let i = 0; i < await elements.count(); i++) {
      expect(await elements.nth(i).evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('app-canvas-')
    }
  }
})

test('flat-authored pages — ops console, 404, policy — never acquire the app canvas', async ({ page }) => {
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  for (const pageClass of ['ops-page', 'not-found', 'policy-page']) {
    await page.setContent(`<html class="app-page"><head><link rel="stylesheet" href="${base}/app/styles.css"><link rel="stylesheet" href="${base}/app/styles/canvas.css"></head><body><main class="${pageClass}"></main></body></html>`)
    expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundImage), pageClass).not.toContain('app-canvas-')
  }
})

/* CSS integration fixtures, not actual native UI or shell screenshots. Each
   shell loads its real stylesheet so later shorthand/theme rules are covered. */
for (const shell of ['native', 'desktop'] as const) {
  test(`${shell} app walls and sheets share fixed themed vectors without painting photo/control surfaces`, async ({ page }) => {
    const surfaces = shell === 'native'
      ? ['native-welcome m-owner', 'native-list-shell m-owner', 'native-settings m-owner', 'native-global-view', 'native-editor', 'm-screen m-owner']
      : ['desktop-welcome landing-page', 'desktop-shell', 'admin-page', 'admin-drawer-panel']
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.setContent(`<html><head><link rel="stylesheet" href="${base}/${shell}/styles.css"><link rel="stylesheet" href="${base}/app/styles/canvas.css"></head><body class="manorama-${shell}">${surfaces.map((surface, i) => `<section class="${surface}" data-wall="${i}"></section>`).join('')}<section class="m-sheet m-owner m-dark" data-sheet><button class="m-btn m-btn--primary">Action</button></section><section class="viewer-stage bg-none"><div class="viewer-frame"><img width="1" height="1"></div><div class="viewer-ad-frame"></div></section></body></html>`)
    await expect(page.locator('[data-wall]').first()).toHaveCSS('background-image', /app-canvas-dark\.svg/)
    for (const palette of ['dark', 'light'] as const) {
      await page.evaluate(value => document.documentElement.classList.toggle('light', value === 'light'), palette)
      for (const wall of await page.locator('[data-wall]').all()) {
        /* The Library wall is the exception: the tile lives on the
           propagated root background — viewport-locked by construction —
           and the page paints transparent so nothing repaints behind the
           scroller or flashes the canvas colour at the edges. Every other
           wall carries the artwork directly. */
        if (await wall.evaluate(el => el.classList.contains('admin-page'))) {
          await expect(wall).toHaveCSS('background-image', 'none')
          const root = page.locator('html')
          await expect(root).toHaveCSS('background-image', new RegExp(`app-canvas-${palette}\\.svg`))
          await expect(root).toHaveCSS('background-size', '256px 256px')
          await expect(root).toHaveCSS('background-attachment', 'fixed')
          continue
        }
        await expect(wall).toHaveCSS('background-image', new RegExp(`app-canvas-${palette}\\.svg`))
        await expect(wall).toHaveCSS('background-size', '256px 256px')
      }
      await expect(page.locator('[data-sheet]')).toHaveCSS('background-image', /app-canvas-dark\.svg/)
      for (const selector of ['.viewer-stage', '.viewer-frame', '.viewer-ad-frame', 'img', 'button']) {
        expect(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('app-canvas-')
      }
    }
    const svg = await page.request.get(`${base}/app-canvas-light.svg`)
    expect(svg.ok()).toBe(true)
    expect(svg.headers()['content-type']).toContain('image/svg+xml')
    expect(await svg.text()).toContain('color="#aaa59b"')
  })
}
