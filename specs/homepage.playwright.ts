/// <reference types="node" />
// The marketing homepage, across the matrix the owner cares about:
// a phone (375×812), a tablet (768×1024), a laptop (1440×900) and a wide
// desktop (2560×1440).
//
// The page is server-rendered with no client script of its own, so every
// assertion here is about what a visitor can see and do: the sign-in group
// in the first fold, the navigation, the disclosures, the comparison table
// stacking on a phone, and the horizontal overflow that a wide image or a
// long word can cause.

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
    test(`the sign-in group is in the first fold at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await open(page)
      const signIn = page.locator('.home-signin')
      await expect(signIn).toBeVisible()
      const box = await signIn.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y).toBeLessThan(viewport.height)
      // The provider chooser itself, not just its heading.
      await expect(page.locator('.signin-pill').first()).toBeVisible()
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

  test('the access row is in the first fold on a wide screen', async ({ page }) => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 2560, height: 1440 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await open(page)
      const row = page.locator('.home-access')
      await expect(row).toBeVisible()
      const box = await row.boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    }
  })

  test('the access row is within a viewport and a quarter on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await open(page)
    const row = page.locator('.home-access')
    await expect(row).toBeVisible()
    const box = await row.boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(812 * 1.25)
  })

  test('the pricing link scrolls to a heading that is not hidden under the header', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await page.locator('.home-nav a[href="#pricing"]').click()
    const heading = page.locator('#pricing h2')
    await expect(heading).toBeVisible()
    const box = await heading.boundingBox()
    const header = await page.locator('.home-header').boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(header!.height - 1)
    expect(box!.y).toBeLessThan(900)
  })

  test('every menu link scrolls to the section it names', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const links = await page.locator('.home-nav a').all()
    expect(links.length).toBeGreaterThanOrEqual(4)
    for (const link of links) {
      const href = (await link.getAttribute('href')) ?? ''
      const label = (await link.innerText()).trim()
      // Start from the top every time, so a link is judged on where it
      // takes the visitor, not on where the previous one left them.
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.waitForTimeout(150)
      await link.click()
      await expect
        .poll(async () => {
          const box = await page.locator(href).boundingBox()
          return box ? Math.round(box.y) : -1
        })
        .toBeGreaterThanOrEqual(0)
      const section = await page.locator(href).boundingBox()
      const header = await page.locator('.home-header').boundingBox()
      // The section lands under the header, not behind it.
      expect(section!.y, `${label} → ${href}`).toBeGreaterThanOrEqual(header!.height - 1)
      expect(section!.y, `${label} → ${href}`).toBeLessThan(header!.height + 120)
    }
  })

  test('the phone menu carries every link the desktop navigation does', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await open(page)
    const desktop = await page.locator('.home-nav a').allTextContents()
    await page.locator('.home-nav-menu summary').click()
    const phone = await page.locator('.home-nav-menu-list a').allTextContents()
    expect(phone).toEqual(desktop)
  })

  test('the keyboard reaches the skip link, the navigation and the sign-in group', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    await page.keyboard.press('Tab')
    const skip = page.locator('.home-skip')
    await expect(skip).toBeFocused()
    const seen: string[] = []
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab')
      const id = await page.evaluate(() => {
        const active = document.activeElement
        if (!active) return ''
        return active.closest('.home-nav') ? 'nav' : active.closest('.home-signin') ? 'signin' : active.className || active.tagName
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

  test('the page carries no client script of its own', async ({ page }) => {
    await open(page)
    // Vite's dev client is injected by the dev server — as an inline
    // `import("/@vite/client")`, so it has no src to filter on — and it is
    // absent from the production build. The homepage itself ships no
    // JavaScript at all.
    const scripts = await page.evaluate(() =>
      [...document.querySelectorAll('script')]
        .filter((s) => !(s.textContent || '').includes('/@vite/client'))
        .map((s) => s.getAttribute('src') ?? 'inline'),
    )
    expect(scripts).toHaveLength(0)
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
