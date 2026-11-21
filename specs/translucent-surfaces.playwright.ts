import { expect, test } from '@playwright/test'

const base = process.env.DOODLE_BASE_URL ?? 'http://127.0.0.1:5173'

/* Real stylesheets in isolated DOM fixtures: this is CSS integration evidence,
   not native-shell captures. No media bytes or geometry are changed by a fill. */
for (const shell of ['web', 'native', 'desktop'] as const) {
  test(`${shell} translucent backings preserve photos, hit boxes and selected states`, async ({ page }) => {
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    const stylesheet = shell === 'web' ? 'app/styles.css' : `${shell}/styles.css`
    await page.setContent(`<html class="${shell === 'web' ? 'app-page' : ''}"><head>
      <link rel="stylesheet" href="${base}/${stylesheet}">
      <link data-canvas rel="stylesheet" href="${base}/app/styles/canvas.css">
      </head><body class="m-owner ${shell === 'web' ? '' : `manorama-${shell}`}">
      <main class="admin-page">
        <button class="text-button" data-backing>Cancel</button>
        <button class="admin-button admin-settings-pill" data-backing aria-label="Settings">Settings</button>
        <button class="m-btn m-btn--quiet" data-backing>Back</button>
        <button class="m-btn m-btn--destructive" data-backing>Remove</button>
        <button class="lib-card-menu" data-backing>…</button>
        <button class="m-actionrow" data-backing>Account</button>
        <button class="lib-hidden-toggle" data-backing>Hidden galleries</button>
        <button class="native-global-close" data-backing>Close</button>
        <aside class="account-ad" data-backing>Advertisement</aside>
        <aside class="native-account-ad" data-account-ad data-backing>Native advertisement</aside>
        <div class="admin-gallery-strip-frame" data-backing><span>Gallery strip</span></div>
        <div class="lib-rail" data-backing>Native gallery strip</div>
        <article class="lib-card" data-backing>Gallery</article>
        <article class="lib-compact-card" data-backing>Compact gallery</article>
        <button class="admin-button admin-button--solid" data-primary>Primary</button>
        <button class="admin-button lib-quiet-toggle" aria-pressed="true" data-selected>Quiet view</button>
        <div class="m-segmented"><button class="m-segmented-option" aria-checked="true" data-selected>Selected</button><button class="m-segmented-option" aria-checked="false" data-backing>Other</button></div>
        <button class="m-btn m-btn--quiet" disabled data-disabled>Unavailable</button>
      </main>
      <section class="m-sheet m-owner m-dark"><button class="m-btn m-btn--quiet" data-dark>Cancel</button></section>
      <section class="viewer-stage bg-none"><div class="viewer-frame"><img data-photo width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div><div class="viewer-ad-frame"></div><div class="viewer-endcap"></div></section>
      <button class="viewer-filmstrip-item" data-photo-box><img width="1" height="1"></button>
      <div class="native-list-card"><button class="lib-th" data-photo-box><img width="1" height="1"></button></div>
      </body></html>`)
    await page.locator('[data-backing]').first().evaluate(el => getComputedStyle(el).backgroundColor)
    await page.evaluate(async () => { await document.fonts.ready })
    const metrics = () => page.locator('[data-backing], [data-photo], [data-photo-box]').evaluateAll(elements => elements.map(el => {
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
      return { width: rect.width, height: rect.height, opacity: style.opacity, filter: style.filter, pointerEvents: style.pointerEvents }
    }))
    const canvas = page.locator('[data-canvas]')
    await canvas.evaluate(el => { (el as HTMLLinkElement).disabled = true })
    const before = await metrics()
    const disabledOpacity = await page.locator('[data-disabled]').evaluate(el => getComputedStyle(el).opacity)
    await canvas.evaluate(el => { (el as HTMLLinkElement).disabled = false })
    expect(await metrics()).toEqual(before)
    await expect(page.locator('[data-disabled]')).toHaveCSS('opacity', disabledOpacity)

    for (const light of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('light', value), light)
      const rgb = light ? '233, 229, 220' : '22, 22, 22'
      await canvas.evaluate(el => { (el as HTMLLinkElement).disabled = true })
      const originalStates = await page.locator('[data-primary], [data-selected]').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor))
      await canvas.evaluate(el => { (el as HTMLLinkElement).disabled = false })
      for (const backing of await page.locator('[data-backing]').all()) {
        await expect(backing).toHaveCSS('background-color', `rgba(${rgb}, 0.82)`)
      }
      await expect(page.locator('[data-dark]')).toHaveCSS('background-color', 'rgba(22, 22, 22, 0.82)')
      expect(await page.locator('[data-primary], [data-selected]').evaluateAll(elements => elements.map(el => getComputedStyle(el).backgroundColor))).toEqual(originalStates)
      for (const selector of ['[data-photo]', '[data-photo-box]', '.viewer-frame', '.viewer-ad-frame', '.viewer-endcap']) {
        for (const el of await page.locator(selector).all()) {
          expect(await el.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(`rgba(${rgb}, 0.82)`)
          await expect(el).toHaveCSS('opacity', '1')
        }
      }
      await page.evaluate(() => document.documentElement.setAttribute('data-reduced-transparency', ''))
      for (const backing of await page.locator('[data-backing]').all()) {
        await expect(backing).toHaveCSS('background-color', `rgb(${rgb})`)
      }
      await expect(page.locator('[data-dark]')).toHaveCSS('background-color', 'rgb(22, 22, 22)')
      await page.evaluate(() => document.documentElement.removeAttribute('data-reduced-transparency'))
    }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] })
    await expect(page.locator('[data-backing]').first()).toHaveCSS('background-color', 'rgb(233, 229, 220)')
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] })
    await expect(page.locator('[data-backing]').first()).toHaveCSS('background-color', 'rgb(233, 229, 220)')
  })
}
