import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

/**
 * P10 web owner integration — the shared admin surfaces (AddGallerySheet,
 * WebSettings, the Gallery settings sheet, GalleryShareSheet), browser-
 * history state across Settings, the owner viewer chrome's Settings
 * drill-in, and the web storage contract (invariant 7: no persistence
 * beyond preference keys).
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

    const cta = page.getByRole('button', { name: 'Add Gallery', exact: true })
    await expect(cta).toBeVisible()
    await cta.click()

    const dialog = page.getByRole('dialog', { name: 'Add a gallery', exact: true })
    await expect(dialog).toBeVisible()
    const urlInput = dialog.locator('input[aria-label="Shared folder or album link — Dropbox, Google Drive, iCloud, MEGA, Ente or Proton Drive"]')
    await expect(urlInput).toBeVisible()
    // Name and Caption stay hidden until the link verifies — an unverified
    // dialog is the URL field alone.
    await expect(dialog.locator('input[type="text"]')).toHaveCount(0)
    await urlInput.fill('https://www.dropbox.com/scl/fo/demo-integration?rlkey=abcd1234&dl=0')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // Opening, typing and closing must never create or mutate a gallery —
    // the dry-run scan is allowed, but the create call is not.
    expect(mutations).not.toContain('POST /api/galleries')
    expect(mutations.filter((m) => m.startsWith('PATCH'))).toEqual([])
  } finally {
    await context.close()
  }
})

test('?details=<slug> opens the Gallery settings sheet — web-only, no vault/offline', async ({ browser }) => {
  const { context, page, slug, title } = await openDashboard(browser)
  try {
    // The deep link opens the same sheet the ⋯ menu's Gallery settings row
    // does — the full-page Details surface is gone.
    await page.goto(`${base}/${owner}?details=${slug}`, { waitUntil: 'domcontentloaded' })
    // SSR paints the sheet before the island hydrates — the Close button
    // has no handler until then, so wait for the app's ready marker first.
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()
    const sheet = page.getByRole('dialog', { name: 'Gallery settings' })
    await expect(sheet).toBeVisible()
    await expect(page).toHaveURL(`${base}/${owner}?details=${slug}`)
    await expect(sheet.locator('.m-owner-panel-title')).toHaveText(title)

    // No device/vault/offline controls on web — the sheet is the account
    // panel alone.
    await expect(sheet.getByText('Keep a copy', { exact: true })).toHaveCount(0)
    await expect(sheet.getByText(/vault/i)).toHaveCount(0)
    await expect(sheet.getByText(/offline/i)).toHaveCount(0)
    await expect(page.getByRole('switch')).toHaveCount(0)
    for (const label of ['Open gallery', 'Share link', 'Name', 'Caption', 'Address', 'Reorder photographs', 'Refresh gallery contents', 'Open source', 'Remove from Library']) {
      await expect(sheet.getByRole('button', { name: label }), label).toBeVisible()
    }

    // The sheet is transient — it holds no history entry. Closing returns
    // to the library; the deep link itself stays addressable.
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await expect(page.locator('[data-admin-ready="true"]')).toBeVisible()
  } finally {
    await context.close()
  }
})

test('the ⋯ menu opens the gallery’s own Settings sheet — the same panel the viewer hosts', async ({ browser }) => {
  const { context, page, card, title } = await openDashboard(browser)
  try {
    await card.getByRole('button', { name: /actions$/i }).click()
    await page.getByRole('button', { name: 'Gallery settings', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Gallery settings' })
    await expect(sheet).toBeVisible()
    // The library keeps its URL — the sheet is a panel, not a surface.
    await expect(page).toHaveURL(`${base}/${owner}`)
    await expect(sheet.locator('.m-owner-panel-title')).toHaveText(title)
    // From the Library the panel earns an Open row the viewer never needs;
    // Open source rides along because the host wires it.
    for (const label of ['Open gallery', 'Share link', 'Name', 'Caption', 'Address', 'Reorder photographs', 'Refresh gallery contents', 'Open source', 'Remove from Library']) {
      await expect(sheet.getByRole('button', { name: label }), label).toBeVisible()
    }
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(sheet).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('the ⋯ menu’s Share link opens the shared sheet with the correct public URL', async ({ browser }) => {
  const { context, page, card, slug, title } = await openDashboard(browser)
  try {
    await card.getByRole('button', { name: /actions$/i }).click()
    await page.getByRole('button', { name: 'Share link', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: `Share ${title}`, exact: true })
    await expect(sheet).toBeVisible()
    // The address is this gallery's public path on the configured host.
    await expect(sheet.locator('.m-share-address')).toContainText(`/${owner}/${slug}`)
    await expect(sheet.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible()
    await sheet.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(sheet).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('owner viewer Settings carries gallery management inline — no Details navigation on web', async ({ browser }) => {
  test.setTimeout(30_000)
  const { context, page, slug, title } = await openDashboard(browser)
  try {
    await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
    await dismissCurtain(page)
    await expect(page.locator('[data-viewer-role="owner"]')).toHaveCount(1)
    await expect(page.locator('[data-chrome-position]')).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /show controls/i }).dispatchEvent('click')
    const settingsPill = page.locator('nav[aria-label="Viewer controls"] button', { hasText: 'Settings' })
    await expect(settingsPill).toBeVisible()
    await settingsPill.click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    // The view page's role slot is a single Gallery settings row; it drills
    // into the gallery page — heading, hoisted head, and the same panel the
    // Library's settings sheet hosts.
    await dialog.getByRole('button', { name: 'Gallery settings', exact: true }).click()
    await expect(dialog.getByRole('heading', { name: 'Gallery settings' })).toBeVisible()
    await expect(dialog.locator('.m-owner-panel-title')).toHaveText(title)
    // No "Manage gallery" handoff to the dashboard anywhere on web.
    await expect(dialog.getByRole('button', { name: 'Manage gallery' })).toHaveCount(0)
    // The rows' accessible names carry their values ("Name Mixed album"),
    // so match on the label itself. The viewer wires no Open/Open source —
    // it is already inside the gallery.
    for (const label of ['Share link', 'Name', 'Caption', 'Address', 'Reorder photographs', 'Refresh gallery contents', 'Remove from Library']) {
      await expect(dialog.getByRole('button', { name: label }), label).toBeVisible()
    }
    await expect(page).toHaveURL(new RegExp(`/${owner}/${slug}$`))
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
    // The top bar's gear opens Settings as a pushed full-screen surface.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()

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

    // Allowance: seeded account is pro → Visionary, and pro galleries are
    // cloud-hosted so the row reads "Cloud galleries" (d737f03).
    const plan = settings.locator('h3.m-actiongroup-label', { hasText: /^Allowance$/ })
      .locator('..').locator('.m-actiongroup')
    await expect(plan.getByText('Visionary', { exact: true })).toBeVisible()
    await expect(plan.getByText(/Cloud galleries/)).toBeVisible()
    await expect(plan.locator('.m-actionrow-value').nth(1)).toHaveText(/\d+ of \d+/)

    // Typed-delete: the panel stays behind its destructive row until the
    // owner asks, and arms only on the exact owner slug. Never submit.
    await settings.getByRole('button', { name: 'Delete my account', exact: true }).click()
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
    await expect(page.locator('[data-chrome-position]')).toBeVisible({ timeout: 15_000 })

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
    await expect(page.locator('.home main#content')).toBeVisible()
    await expect(page.locator('[data-admin-ready="true"]')).toHaveCount(0)
    await expect(page.locator('[data-gallery-card]')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
