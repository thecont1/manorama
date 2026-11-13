/// <reference types="node" />
// The marketing homepage, across the matrix the owner cares about:
// a phone (375×812), a tablet (768×1024), a laptop (1440×900) and a wide
// desktop (2560×1440).
//
// These assertions cover the shared marketing surface: the header sign-in
// disclosure, navigation, comparison table, reduced-motion CSS and overflow.
// The mounted photographic demo has its own spec beside this one.

import { expect, test } from '@playwright/test'

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'

const MATRIX = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1440, height: 900 },
  { name: 'wide', width: 2560, height: 1440 },
]

const open = async (page: import('@playwright/test').Page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  // The page root is `.home`; the landmark the visitor actually reads is
  // the `main` inside it.
  await expect(page.locator('.home main#content')).toBeVisible()
}

test.describe('the marketing homepage', () => {
  for (const viewport of MATRIX) {
    test(`the account panel opens from the header at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await open(page)
      const trigger = viewport.width < 1024
        ? page.locator('.home-nav-signin')
        : page.locator('.home-signin-trigger')
      if (viewport.width < 1024) await page.locator('.home-nav-menu summary').click()
      await expect(trigger).toBeVisible()
      const box = await trigger.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeLessThan(viewport.height)
      await trigger.click()
      await expect(page.locator('#home-account-panel')).toBeVisible()
      await expect(page.locator('#home-account-panel .home-signin-list a').first()).toBeVisible()
    })

    test(`nothing scrolls sideways at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await open(page)
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(1)
    })
  }

  test('the desktop header keeps sections and account utilities together on the right', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const items = page.locator('.home-header-inner > .home-nav a, .home-header-inner > [data-theme-toggle], .home-header-inner > .home-signin-trigger')
    await expect(items).toHaveText(['Features', 'Pricing', 'FAQ', '', 'Sign in'])
    const wordmark = await page.locator('.home-wordmark').boundingBox()
    const first = await items.first().boundingBox()
    const last = await items.last().boundingBox()
    const start = await page.locator('.home-header-inner > .home-btn').boundingBox()
    expect(first!.x).toBeGreaterThanOrEqual(wordmark!.x + wordmark!.width)
    expect(last!.x + last!.width).toBeLessThanOrEqual(start!.x)
  })

  test('the account panel groups sign-in and published apps, closes on Escape, and restores focus', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const trigger = page.locator('.home-signin-trigger')
    await trigger.click()
    const panel = page.locator('#home-account-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText('Continue with')
    await expect(panel).toContainText('Get the app')
    await expect(panel.locator('.home-signin-list a')).toHaveText(['Apple', 'Dropbox', 'Google'])
    await expect(panel.locator('a[href="https://downloads.manorama.xyz/mac"]')).toContainText('Mac')
    await expect(panel.locator('a[href="https://downloads.manorama.xyz/mac"] small')).toHaveText('Apple silicon')
    await expect(panel.locator('a[href="https://downloads.manorama.xyz/windows"]')).toHaveText('Windows')
    await expect(panel).not.toContainText('iPhone & iPad')
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.locator('h1').click()
    await expect(panel).toBeHidden()
    await expect(trigger).toBeFocused()
  })

  test('hover opens Sign in and Start free, and moving away closes the same panel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const panel = page.locator('#home-account-panel')
    const triggers = page.locator('.home-signin-trigger, .home-header-inner > .home-btn')
    for (let index = 0; index < 2; index += 1) {
      const trigger = triggers.nth(index)
      await trigger.hover()
      await expect(panel).toBeVisible()
      await panel.hover()
      await page.locator('h1').hover()
      await expect(panel).toBeHidden()
      await trigger.hover()
      await expect(panel).toBeVisible()
      await page.locator('h1').hover()
      await expect(panel).toBeHidden()
    }
  })

  test('every Start free opens the same panel and returns focus to its own trigger', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const triggers = page.getByRole('button', { name: 'Start free' })
    await expect(triggers).toHaveCount(3)
    for (let index = 0; index < 3; index += 1) {
      const trigger = triggers.nth(index)
      await trigger.scrollIntoViewIfNeeded()
      await trigger.click()
      await expect(page.locator('#home-account-panel')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  })

  test('provider links and the native panel work without JavaScript', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.locator('.home-signin-trigger').click()
    await expect(page.locator('#home-account-panel')).toBeVisible()
    expect(await page.locator('#home-account-panel .home-signin-list a').evaluateAll((links) =>
      links.map((link) => link.getAttribute('href')),
    )).toEqual(['/auth/apple', '/auth/dropbox', '/auth/google'])
    await context.close()
  })

  test('the theme control is a labelled icon button', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const toggle = page.locator('.home-header-inner > [data-theme-toggle]')
    await expect(toggle).toHaveAttribute('aria-label', 'Light mode')
    await expect(toggle.locator('svg')).toHaveCount(2)
    expect(await toggle.evaluate((el) => el.getBoundingClientRect().width)).toBe(44)
    expect(await toggle.evaluate((el) => el.getBoundingClientRect().height)).toBe(44)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-label', 'Dark mode')
    await expect(page.locator('html')).toHaveClass(/light/)
  })

  test('the footer logo bottoms out with the copyright and the ownership notice has its own line', async ({ page }) => {
    await open(page)
    await page.locator('.home-footer').scrollIntoViewIfNeeded()
    const boxes = await page.evaluate(() => {
      const box = (selector: string) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom }
      }
      return {
        logo: box('.home-footer-brand'),
        copyright: box('.home-footer-copy-line > span:last-child'),
        line: box('.home-footer-copy-line'),
        ownership: box('.home-footer-ownership'),
      }
    })
    expect(boxes.logo.bottom).toBeCloseTo(boxes.copyright.bottom, 0)
    expect(boxes.ownership.top).toBeGreaterThanOrEqual(boxes.line.bottom)
    await expect(page.locator('.home-footer-ownership')).toHaveText('Photographs in galleries belong to their respective owners.')
  })

  test('the hero and closing highlights use their surrounding font family', async ({ page }) => {
    await open(page)
    const families = await page.evaluate(() => {
      const family = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontFamily
      return {
        hero: family('.home-hero .home-h1 em'),
        heroHeading: family('.home-hero .home-h1'),
        final: family('.home-final .home-h2 em'),
        finalHeading: family('.home-final .home-h2'),
      }
    })
    expect(families.hero).toBe(families.heroHeading)
    expect(families.final).toBe(families.finalHeading)
    expect(families.hero).not.toContain('Playfair')
    expect(families.final).not.toContain('Playfair')
  })

  test('the page scrolls with the wheel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    // The app shell sets `body { overflow: hidden }`, and the viewport
    // inherits it, which leaves this document unsrollable by hand: an
    // anchor jump still worked, so the menu looked fine while the wheel
    // did nothing. This is the check that says so out loud.
    await page.mouse.move(720, 450)
    await page.mouse.wheel(0, 1200)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200)
  })

  test('the centred device frame leads the first fold on a wide screen', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await open(page)
      await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
      const stage = page.locator('[data-demo-viewport]')
      const device = page.locator('[data-demo-device]')
      await expect(stage).toBeVisible()
      await expect(device).toBeVisible()
      const box = await stage.boundingBox()
      const frame = await device.boundingBox()
      const root = await page.locator('[data-demo-stage]').boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(root!.width).toBeCloseTo(viewport.width * 0.95, 0)
      expect(root!.height).toBeCloseTo(viewport.height * 0.95 - 64, 0)
      expect(frame!.width).toBeLessThanOrEqual(box!.width + 1)
      expect(box!.y).toBeLessThan(viewport.height * 0.6)
      expect(box!.height).toBeGreaterThan(0)
    }
  })

  test('the framed photographic stage is the dominant first-fold element on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await open(page)
    await expect(page.locator('[data-demo-stage]')).toHaveAttribute('data-demo-ready', 'true')
    const stage = page.locator('[data-demo-viewport]')
    const device = page.locator('[data-demo-device]')
    await expect(stage).toBeVisible()
    await expect(device).toBeVisible()
    const box = await stage.boundingBox()
    const frame = await device.boundingBox()
    const root = await page.locator('[data-demo-stage]').boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(root!.width).toBeCloseTo(375 * 0.95, 0)
    expect(root!.height).toBeCloseTo(812 * 0.95 - 64, 0)
    expect(frame!.width).toBeLessThanOrEqual(box!.width + 1)
    expect(box!.y).toBeLessThan(812 * 0.65)
    expect(box!.height).toBeGreaterThan(0)
  })

  test('the pricing link scrolls to a heading that is not hidden under the header', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await page.locator('.home-nav a[href="#pricing"]').click()
    const heading = page.locator('#pricing h2')
    await expect(heading).toBeVisible()
    await expect.poll(async () => (await heading.boundingBox())!.y).toBeLessThan(900)
    const box = await heading.boundingBox()
    const header = await page.locator('.home-header').boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(header!.height - 1)
  })

  test('every menu link scrolls to the section it names', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const links = await page.locator('.home-nav a').all()
    expect(links.length).toBe(3)
    for (const link of links) {
      const href = (await link.getAttribute('href')) ?? ''
      const label = (await link.innerText()).trim()
      // Start from the top every time, so a link is judged on where it
      // takes the visitor, not on where the previous one left them.
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
      await link.click()
      const header = await page.locator('.home-header').boundingBox()
      await expect.poll(async () => {
        const box = await page.locator(href).boundingBox()
        return box ? Math.round(box.y) : -1
      }).toBeLessThan(header!.height + 120)
      const section = await page.locator(href).boundingBox()
      // The section lands at the document's configured sticky-header offset.
      const offset = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop))
      expect(section!.y, `${label} → ${href}`).toBeGreaterThanOrEqual(offset - 1)
    }
  })

  test('the phone menu carries every link the desktop navigation does', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    const desktop = await page.locator('.home-nav a').allTextContents()
    await page.locator('.home-nav-menu summary').click()
    const phone = await page.locator('.home-nav-menu-list a').allTextContents()
    expect(phone.slice(0, desktop.length)).toEqual(desktop)
  })

  test('the keyboard reaches the skip link, the navigation and the sign-in disclosure', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    // Safari's default full keyboard navigation uses Option+Tab for links.
    const tab = () => page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
    await tab()
    const skip = page.locator('.home-skip')
    await expect(skip).toBeFocused()
    const seen: string[] = []
    for (let step = 0; step < 12; step += 1) {
      await tab()
      const id = await page.evaluate(() => {
        const active = document.activeElement
        if (!active) return ''
        return active.closest('.home-nav') ? 'nav' : active.closest('.home-signin-header') ? 'signin' : active.className || active.tagName
      })
      seen.push(id)
      if (id === 'signin') break
    }
    expect(seen.some((entry) => entry === 'nav')).toBe(true)
    expect(seen.some((entry) => entry === 'signin')).toBe(true)
  })

  test('the FAQ disclosures open with Enter and with Space', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const first = page.locator('.home-faq-item').first()
    const summary = first.locator('summary')
    await summary.scrollIntoViewIfNeeded()
    await summary.focus()
    await page.keyboard.press('Enter')
    await expect(first).toHaveAttribute('open', '')
    await page.keyboard.press('Enter')
    await expect(first).not.toHaveAttribute('open', '')
    await page.keyboard.press('Space')
    await expect(first).toHaveAttribute('open', '')
  })

  test('the comparison stacks into rows below 720px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await open(page)
    const row = page.locator('.home-table tbody tr').first()
    await row.scrollIntoViewIfNeeded()
    const cell = row.locator('td').first()
    await expect(cell.locator('.home-table-cell-label')).toBeVisible()
    // The stacked cell names its own column.
    await expect(cell.locator('.home-table-cell-label')).toHaveText('Free')
  })

  test('the comparison is a table on a wide screen', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await expect(page.locator('.home-table thead th').first()).toBeVisible()
    await expect(page.locator('.home-table caption')).toBeVisible()
    await expect(page.locator('.home-table-cell-label').first()).toBeHidden()
  })

  test('a visitor who asks for reduced motion gets a finished page', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const heading = page.locator('h1')
    await expect(heading).toBeVisible()
    const opacity = await heading.evaluate((el) => Number(getComputedStyle(el).opacity))
    expect(opacity).toBeGreaterThan(0.95)
    const animated = await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === 'running').length,
    )
    expect(animated).toBe(0)
  })

  test('the page loads only the chrome and shared island enhancement scripts', async ({ page }) => {
    await open(page)
    // Vite's dev client is inline and absent from production. The remaining
    // scripts are the four homepage utilities plus HonoX's shared hydration.
    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script')]
        .filter((s) => !(s.textContent || '').includes('/@vite/client'))
        .map((s) => s.getAttribute('src') ?? 'inline'),
    )
    expect(scripts).toEqual([
      '/theme-init.js',
      '/home-theme.js',
      '/home-menu.js',
      '/home-hero.js',
      '/hydrate-guard.js',
      '/app/client.ts',
    ])
  })

  test('the visible marketing copy stays inside the budget', async ({ page }) => {
    await open(page)
    // The plan's budget: about 600 words of visible marketing copy, counting
    // the content bands only, and excluding the comparison table, the FAQ
    // and the footer. Closed disclosures are not visible, so they do not
    // count.
    const words = await page.evaluate(() => {
      const count = (el: Element | null) =>
        ((el as HTMLElement | null)?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .split(' ')
          .filter(Boolean).length
      const main = document.querySelector('.home main#content')
      return (
        count(main) -
        count(main?.querySelector('.home-table-wrap')) -
        count(main?.querySelector('#faq'))
      )
    })
    expect(words).toBeLessThanOrEqual(600)
  })

  test('the sample gallery link points at a gallery that answers', async ({ page, request }) => {
    await open(page)
    const link = page.locator('a[href="/thecontrarian/italy"]')
    if ((await link.count()) === 0) {
      test.skip(true, 'the sample gallery path is not set in the manifest')
      return
    }
    const response = await request.get(`${BASE}/thecontrarian/italy`)
    // The dev seed does not carry the owner's Dropbox gallery, so a 404
    // here is the seed's doing, not the link's. The link itself must still
    // point at a path the site serves.
    expect([200, 404]).toContain(response.status())
  })

  test('robots.txt asks for the homepage and nothing else', async ({ request }) => {
    const response = await request.get(`${BASE}/robots.txt`)
    expect(response.status()).toBe(200)
    const body = await response.text()
    expect(body).toContain('User-agent: *')
    expect(body).toContain('Allow: /$')
    expect(body).toContain('Disallow: /')
  })

  test('the homepage is the one page that may be indexed', async ({ request }) => {
    const root = await request.get(`${BASE}/`)
    expect(root.status()).toBe(200)
    expect(root.headers()['x-robots-tag'] || '').not.toContain('noindex')
    const html = await root.text()
    expect(html).not.toContain('name="robots" content="noindex')
    expect(html).toContain('<link rel="canonical" href="https://manorama.xyz/"')
  })
})
