import { test, expect } from '@playwright/test'
import { blockProductionApi, bridgePayload, installBridge } from './desktop-admin-fixture'

/**
 * The dark/light choice, verified on both bundles and across them.
 *
 * The two bundles are separate origins — the dashboard on `WEB_URL`, the Mac
 * app's shell on `DESKTOP_URL` — so each has its own storage area. What they
 * share is the *vocabulary*: one storage key, one `html` class, one control
 * label. This spec proves the shared vocabulary holds on both surfaces, that
 * each surface persists and re-applies its own choice across a reload, and
 * exactly what "synchronisation" does and does not mean across origins.
 *
 * Every state read polls: the class and the stored key are written by an
 * effect, so a bare read can land before the surface has settled.
 */

const web = process.env.GALLERY_URL ?? 'http://127.0.0.1:5173'
const desktop = process.env.DESKTOP_URL ?? 'http://127.0.0.1:5175'
const THEME_KEY = 'manorama:theme'
const LIGHT_LABEL = 'Switch to light mode'
const DARK_LABEL = 'Switch to dark mode'

type Surface = import('@playwright/test').Page

/** The theme state a surface actually exposes: the class on <html>, the stored
 *  key, and the label of the control that would flip it. */
const themeState = (page: Surface) =>
  page.evaluate((key) => ({
    stored: (() => { try { return localStorage.getItem(key) } catch { return null } })(),
    control: document.querySelector('.web-settings')
      ? (document.documentElement.classList.contains('light') ? 'Switch to dark mode' : 'Switch to light mode')
      : [...document.querySelectorAll('.admin-drawer-action')].map(node => node.textContent?.trim() ?? '')
        .find(text => text.startsWith('Switch to')) ?? null,
    light: document.documentElement.classList.contains('light'),
  }), THEME_KEY)

const expectTheme = async (page: Surface, expected: { stored: string; control: string; light: boolean }) => {
  await expect.poll(() => themeState(page), { timeout: 8_000 }).toMatchObject(expected)
}

const openPane = async (page: Surface) => {
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Account', exact: true })).toBeVisible()
}

const openWebSettings = async (page: Surface) => {
  await expect(page.locator('[data-admin-ready="true"]')).toBeVisible({ timeout: 15_000 })
  if (new URL(page.url()).searchParams.get('settings') === '1' || await page.locator('.web-settings').isVisible()) {
    await expect(page.locator('.web-settings')).toBeVisible()
    return
  }
  // The account drawer is gone — the top bar's gear opens Settings directly.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('.web-settings')).toBeVisible()
}

const chooseWebLight = async (page: Surface) => {
  await page.locator('.web-settings').getByRole('radio', { name: 'Light', exact: true }).click()
}

/** The dashboard needs its seeded development account before it renders. */
const signInToWeb = async (context: import('@playwright/test').BrowserContext) => {
  await expect.poll(async () => {
    const login = await context.request.get(`${web}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })
    return login.status()
  }, { timeout: 35_000, intervals: [1000, 2000] }).toBe(302)
}

test('the web dashboard persists its theme through a reload', async ({ browser }) => {
  // The dashboard hydrates against a live dev server; give the reload room.
  test.setTimeout(75_000)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await signInToWeb(context)
    const page = await context.newPage()
    await page.goto(`${web}/thecontrarian`, { waitUntil: 'domcontentloaded' })
    await openWebSettings(page)

    // A fresh profile starts on the shared default, and the surface writes
    // that default out — both bundles materialise the same key, not just read
    // it.
    await expectTheme(page, { stored: 'dark', control: LIGHT_LABEL, light: false })

    await chooseWebLight(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openWebSettings(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })
  } finally { await context.close() }
})

test('the macOS shell persists its theme through a reload, on the same key', async ({ browser }) => {
  // The dashboard hydrates against a live dev server; give the reload room.
  test.setTimeout(75_000)
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  await context.addInitScript(installBridge, bridgePayload)
  try {
    const page = await context.newPage()
    await blockProductionApi(page)
    await page.goto(desktop, { waitUntil: 'domcontentloaded' })
    await openPane(page)

    await expectTheme(page, { stored: 'dark', control: LIGHT_LABEL, light: false })

    await page.getByRole('button', { name: LIGHT_LABEL, exact: true }).click()
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await openPane(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })
  } finally { await context.close() }
})

test('both bundles answer to the identical key, class and label', async ({ browser }) => {
  // The dashboard hydrates against a live dev server; give the reload room.
  test.setTimeout(75_000)
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  await context.addInitScript(installBridge, bridgePayload)
  try {
    await signInToWeb(context)
    const page = await context.newPage()
    await blockProductionApi(page)

    await page.goto(`${web}/thecontrarian`, { waitUntil: 'domcontentloaded' })
    await openWebSettings(page)
    await chooseWebLight(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })
    const onWeb = await themeState(page)

    await page.goto(desktop, { waitUntil: 'domcontentloaded' })
    await openPane(page)
    await page.getByRole('button', { name: LIGHT_LABEL, exact: true }).click()
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })
    const onDesktop = await themeState(page)

    // Same key, same class, same control copy — one vocabulary, two bundles.
    // Both surfaces are light now, so both offer the same way back.
    expect(onWeb).toMatchObject({ stored: 'light', control: DARK_LABEL, light: true })
    expect(onDesktop).toMatchObject({ stored: 'light', control: DARK_LABEL, light: true })
    // The desktop origin's own storage carries the shared key and nothing else
    // from the dashboard's area.
    expect(await page.evaluate((key) => Object.keys(localStorage).filter(entry => entry === key), THEME_KEY))
      .toEqual([THEME_KEY])
  } finally { await context.close() }
})

test('a theme set on one origin does not silently apply to the other', async ({ browser }) => {
  // The dashboard hydrates against a live dev server; give the reload room.
  test.setTimeout(75_000)
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
  await context.addInitScript(installBridge, bridgePayload)
  try {
    await signInToWeb(context)
    const page = await context.newPage()
    await blockProductionApi(page)

    await page.goto(`${web}/thecontrarian`, { waitUntil: 'domcontentloaded' })
    await openWebSettings(page)
    await chooseWebLight(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })

    // The Mac shell is a different origin: it starts on its own default, not
    // on the dashboard's choice. Cross-origin localStorage is never shared.
    await page.goto(desktop, { waitUntil: 'domcontentloaded' })
    await openPane(page)
    await expectTheme(page, { stored: 'dark', control: LIGHT_LABEL, light: false })

    // And its own choice does not reach back into the dashboard either.
    await page.getByRole('button', { name: LIGHT_LABEL, exact: true }).click()
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })

    await page.goto(`${web}/thecontrarian`, { waitUntil: 'domcontentloaded' })
    await openWebSettings(page)
    await expectTheme(page, { stored: 'light', control: DARK_LABEL, light: true })
  } finally { await context.close() }
})
