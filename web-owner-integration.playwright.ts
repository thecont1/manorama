import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * P10 web owner integration — the shared admin surfaces (AddGallerySheet,
 * WebSettings, GalleryDetailsView platform=web, GalleryShareSheet,
 * GalleryEditSheet), browser-history state across Details/Settings, the
 * owner viewer chrome's Details handoff into the dashboard, and the web
 * storage contract (invariant 7: no persistence beyond preference keys).
 *
 * Everything here is read-only against the seeded repos: no gallery
 * creates/edits/deletes/reorders, no provider writes, no sign-out, no
 * account deletion. Each test rides its own browser context, so theme and
 * viewer preferences stay isolated per test.
 */

const base = process.env.GALLERY_URL ?? 'http://localhost:5190'
const owner = process.env.GALLERY_OWNER ?? 'thecontrarian'

/** The HTTP door mints a test session. Wait for it to answer rather than
 *  for the dashboard's provider polling to settle. */
const signIn = async (context: BrowserContext) => {
  await expect.poll(async () => {
    const login = await context.request.get(`${base}/.dev-seed/login`, {
      maxRedirects: 0,
      timeout: 15_000,
    })
    return login.status()
  }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
}

const openDashboard = async (browser: Browser, prepare?: (page: Page) => Promise<void>) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await signIn(context)
  const page = await context.newPage()
  await prepare?.(page)
  await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
  const card = page.locator('[data-gallery-card]').first()
  await expect(card).toBeVisible()
  const slug = (await card.getAttribute('data-gallery-card'))!
  const title = (await card.locator('.lib-card-title').innerText()).trim()
  return { context, page, card, slug, title }
}

/** Dismiss the viewer curtain; re-click because a pre-hydration click is lost. */
const dismissCurtain = async (page: Page) => {
  const curtain = page.locator('[data-curtain]')
  if (!(await curtain.isVisible().catch(() => false))) return
  await expect.poll(async () => {
    if (await curtain.isHidden().catch(() => true)) return true
    await curtain.click({ timeout: 2_000 }).catch(() => {})
    return curtain.isHidden().catch(() => true)
  }, { timeout: 30_000, intervals: [500] }).toBe(true)
}

test('add-gallery CTA opens the shared sheet with URL and optional Name and closes without network', async ({ browser }) => {
  const { context, page } = await openDashboard(browser)
  try {
    const mutations: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' || request.method() === 'PATCH') {
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })

    const cta = page.locator('.admin-library-heading button')
    await expect(cta).toHaveText('Add')
    await cta.click()

    const dialog = page.getByRole('dialog', { name: 'Add a gallery', exact: true })
    await expect(dialog).toBeVisible()
    const urlInput = dialog.locator('input[aria-label="Shared folder or album link — Dropbox, Google Drive, iCloud or MEGA"]')
    await expect(urlInput).toBeVisible()
    await urlInput.fill('https://www.dropbox.com/scl/fo/demo-integration?rlkey=abcd1234&dl=0')
    await dialog.locator('input[type="text"]').fill('Owner integration demo')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Opening, typing and closing must never reach the API.
    expect(mutations).toEqual([])
  } finally {
    await context.close()
  }
})

test('card Details is web-only (no vault/offline) and browser Back/Forward round-trips', async ({ browser }) => {
  const { context, page, card, slug } = await openDashboard(browser)
  try {
    await card.getByRole('button', { name: /actions$/i }).click()
    await page.getByRole('menuitem', { name: 'Gallery details', exact: true }).click()
    const details = page.locator('[data-screen="details"]')
    await expect(details).toBeVisible()
    await expect(page).toHaveURL(`${base}/${owner}?details=${slug}`)
    await expect(details.locator('.d-name')).toBeVisible()

    // platform="web": no device/vault/offline controls; the Source group
    // replaces the native "This device" group entirely.
    await expect(details.getByText('Keep a copy', { exact: true })).toHaveCount(0)
    await expect(details.getByText(/vault/i)).toHaveCount(0)
    await expect(details.getByText(/offline/i)).toHaveCount(0)
    await expect(page.getByRole('switch')).toHaveCount(0)
    await expect(details.getByRole('button', { name: 'Read the folder again', exact: true })).toBeVisible()

    // History Back pops the pushed entry. Schedule navigation so Playwright
    // does not wait on a same-document navigation that has no load.
    await page.evaluate(() => { setTimeout(() => window.history.back(), 0) })
    await expect(details).toHaveCount(0)
    await expect(page).toHaveURL(`${base}/${owner}`)

    // Browser Back/Forward across the Details entry.
    await card.getByRole('button', { name: /actions$/i }).click()
    await page.getByRole('menuitem', { name: 'Gallery details', exact: true }).click()
    await expect(details).toBeVisible()
    await page.evaluate(() => { setTimeout(() => window.history.back(), 0) })
    await expect(details).toHaveCount(0)
    await expect(page).toHaveURL(`${base}/${owner}`)
    await page.evaluate(() => { setTimeout(() => window.history.forward(), 0) })
    await expect(details).toBeVisible()
    await expect(page).toHaveURL(`${base}/${owner}?details=${slug}`)
    await page.evaluate(() => { setTimeout(() => window.history.back(), 0) })
    await expect(details).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('Details Share opens the shared sheet with the correct public URL', async ({ browser }) => {
  const { context, page, card, title } = await openDashboard(browser)
  try {
    await card.getByRole('button', { name: /actions$/i }).click()
    await page.getByRole('menuitem', { name: 'Gallery details', exact: true }).click()
    const details = page.locator('[data-screen="details"]')
    await expect(details).toBeVisible()

    const addressRow = details.locator('.m-actionrow').filter({ hasText: /^Address/ })
    const address = (await addressRow.locator('.m-actionrow-value').innerText()).trim()
    expect(address).toMatch(new RegExp(`^localhost:\\d+/${owner}/`))

    await details.getByRole('button', { name: /Share link/ }).click()
    const sheet = page.getByRole('dialog', { name: `Share ${title}`, exact: true })
    await expect(sheet).toBeVisible()
    await expect(sheet.locator('.m-share-address')).toHaveText(`https://${address}`)
    await expect(sheet.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(sheet).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('owner viewer chrome Details navigates to dashboard Details with details/photo query and Back returns to the viewer', async ({ browser }) => {
  test.setTimeout(30_000)
  const { context, page, slug, title } = await openDashboard(browser)
  try {
    const firstPhotoId = await page
      .locator(`[data-gallery-card="${slug}"] .admin-gallery-strip-item`)
      .first()
      .getAttribute('data-image-id')
    expect(firstPhotoId).toBeTruthy()

    await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
    await dismissCurtain(page)
    await expect(page.locator('[data-viewer-role="owner"]')).toHaveCount(1)
    await expect(page.locator('.stage-seq')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /show controls/i }).dispatchEvent('click')
    const detailsButton = page.locator('nav[aria-label="Viewer controls"] button', { hasText: 'Details' })
    await expect(detailsButton).toBeVisible()
    await detailsButton.click({ noWaitAfter: true })

    await page.waitForURL((url) => {
      return url.pathname === `/${owner}` && url.searchParams.get('details') === slug
        && url.searchParams.get('photo') === firstPhotoId
    }, { timeout: 25_000 })

    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    const details = page.locator('[data-screen="details"]')
    await expect(details).toBeVisible()
    await expect(details.locator('.d-name')).toHaveText(title)

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 25_000 })
    await expect(page).toHaveURL(new RegExp(`/${owner}/${slug}$`), { timeout: 25_000 })
    await dismissCurtain(page)
    await expect(page.locator('.stage-seq')).toBeVisible({ timeout: 15_000 })
  } finally {
    await context.close()
  }
})

test('Account → Settings shows identities/plan/typed-delete; Light persists after reload and Back works', async ({ browser }) => {
  const { context, page } = await openDashboard(browser, async page => {
    // The lightweight dev seed has no identity table and answers 503. Keep
    // this UI test deterministic; the API's status/identity contract has its
    // own route tests.
    await page.route('**/api/account/identities', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ identities: [{ provider: 'dropbox', displayName: 'Test Owner' }] }),
    }))
  })
  try {
    const tab = page.getByRole('button', { name: 'Account menu', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Account', exact: true })
    await tab.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Settings', exact: true }).click()

    const settings = page.locator('.web-settings')
    await expect(settings).toBeVisible()

    // Identities: the seeded Dropbox identity with Unlink, plus connect links
    // for the providers that are not linked.
    const identities = settings.locator('h3.m-actiongroup-label', { hasText: /^Sign-in methods$/ })
      .locator('..').locator('.m-actiongroup')
    await expect(identities).toBeVisible()
    await expect(identities.getByText('Dropbox', { exact: true })).toBeVisible()
    await expect(identities.getByRole('button', { name: 'Unlink', exact: true })).toBeVisible()
    await expect(identities.getByRole('link', { name: /^Connect / })).toHaveCount(2)

    // Plan: seeded account is pro → Visionary.
    const plan = settings.locator('h3.m-actiongroup-label', { hasText: /^Plan$/ })
      .locator('..').locator('.m-actiongroup')
    await expect(plan.getByText('Visionary', { exact: true })).toBeVisible()
    await expect(plan.getByText(/Editable galleries/)).toBeVisible()
    await expect(plan.locator('.m-actionrow-value').nth(1)).toHaveText(/\d+ of \d+/)

    // Typed-delete: armed only by typing the exact owner slug. Never submit.
    const deletePanel = settings.locator('.m-settings-delete')
    await expect(deletePanel.getByText(`Type your URL name (${owner}) to confirm`, { exact: true })).toBeVisible()
    const confirm = deletePanel.locator('input')
    const deleteButton = deletePanel.getByRole('button', { name: 'Delete my account', exact: true })
    await expect(deleteButton).toBeDisabled()
    await confirm.fill('not-the-slug')
    await expect(deleteButton).toBeDisabled()
    await confirm.fill(owner)
    await expect(deleteButton).toBeEnabled()
    await confirm.fill('')

    // Light theme persists across a reload; the reloaded page reopens on the
    // settings surface because its history entry carries ?settings=1.
    await settings.getByRole('radio', { name: 'Light', exact: true }).click()
    await expect(page.locator('html')).toHaveClass(/light/)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('manorama:theme'))).toBe('light')

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.web-settings')).toBeVisible()
    await expect(page.locator('.web-settings').getByRole('radio', { name: 'Light', exact: true })).toBeChecked()
    await expect(page.locator('html')).toHaveClass(/light/)

    // Back closes settings and returns to the clean library URL.
    await page.locator('.web-settings').getByRole('button', { name: 'Back', exact: true }).dispatchEvent('click')
    await expect(page.locator('.web-settings')).toHaveCount(0)
    await expect(page).toHaveURL(`${base}/${owner}`)
    await expect(page.locator('[data-gallery-card]').first()).toBeVisible()
  } finally {
    await context.close()
  }
})

test('web storage audit: only known preference keys, no gallery manifests/image bytes or offline/vault keys', async ({ browser }) => {
  const { context, page, slug } = await openDashboard(browser)
  try {
    // Visit the viewer too: it is the only other surface allowed to touch
    // storage (per-slug viewer prefs).
    await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
    await dismissCurtain(page)
    await expect(page.locator('.stage-seq')).toBeVisible({ timeout: 15_000 })

    const keys = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }))

    const allowedPreference = (key: string) => {
      if (key === 'manorama:theme') return true
      if (key === 'manorama:background') return true
      if (key === 'manorama:pending-source' || key === 'manorama:quickadd-attempt') return true
      return /^manorama:view:[a-z0-9][a-z0-9-]*$/.test(key)
    }
    for (const key of keys.local) {
      expect(allowedPreference(key), `unexpected localStorage key: ${key}`).toBe(true)
      const lowered = key.toLowerCase()
      for (const forbidden of ['manifest', 'vault', 'offline', 'image', 'photo', 'bytes']) {
        expect(lowered.includes(forbidden), `forbidden localStorage key: ${key}`).toBe(false)
      }
    }
    for (const key of keys.session) {
      expect(key === 'manorama-toast', `unexpected sessionStorage key: ${key}`).toBe(true)
    }

    // Preference values are tiny; gallery manifests/image bytes would not be.
    const localBytes = await page.evaluate(() => {
      let total = 0
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)!
        total += key.length + (localStorage.getItem(key) ?? '').length
      }
      return total
    })
    expect(localBytes).toBeLessThan(2_048)
  } finally {
    await context.close()
  }
})

test('a signed-out visitor is refused the owner dashboard', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const unauthenticated = await context.request.get(`${base}/${owner}`, { maxRedirects: 0 })
    expect(unauthenticated.status()).toBe(302)
    const location = unauthenticated.headers()['location'] ?? ''
    expect(location).toBe('/')

    const page = await context.newPage()
    await page.goto(`${base}/${owner}`, { waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.evaluate(() => new URL(window.location.href).pathname), { timeout: 20_000 }).toBe('/')
    await expect(page.locator('main.landing-page')).toBeVisible()
    await expect(page.locator('[data-admin-ready="true"]')).toHaveCount(0)
    await expect(page.locator('[data-gallery-card]')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
