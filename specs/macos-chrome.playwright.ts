import { expect, test as base, type BrowserType, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { blockProductionApi, bridgePayload, catalogue, GALLERY_ID, installBridge, PIXEL } from './desktop-admin-fixture'

const test = base.extend<{ engine: 'chromium' | 'webkit'; signedIn: boolean }>({
  engine: ['chromium', { option: true }],
  signedIn: [true, { option: true }],
  page: async ({ playwright, engine }, use) => {
    const browser = await (playwright[engine] as BrowserType).launch()
    const context = await browser.newContext({ viewport: { width: 1280, height: 840 } })
    try { await use(await context.newPage()) } finally { await browser.close() }
  },
})

const BASE = process.env.GALLERY_URL ?? 'http://localhost:8787'
const swift = readFileSync(new URL('../macos/ManoramaMac/ViewerWebView.swift', import.meta.url), 'utf8')
const observer = swift.match(/document\.documentElement\.dataset\.macosGlass = '1';[\s\S]*?\}\)\(\);/)?.[0]
if (!observer) throw new Error('Missing native chrome observer')

const cloudGallery = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  slug: 'cloud-album', title: 'Cloud Album', caption: 'A quiet set', date: '',
  sourceUrl: 'https://www.dropbox.com/sh/fixture/gallery',
  imageCount: 2, mediaCount: { stills: 2, videos: 0, hidden: 0 },
  retention: 'retained', manifestVersion: 1, pinnedAt: null,
  lastSourceCheckAt: new Date().toISOString(),
  images: [1, 2].map((id) => ({ id: `cloud-${id}`, orderKey: `cloud-${id}`, src: PIXEL, width: 1, height: 1 })),
}

test.beforeEach(async ({ page, signedIn }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await blockProductionApi(page)
  await page.route('https://manorama.xyz/api/account', (route) => route.fulfill({ json: { ownerSlug: 'thecontrarian', tier: 'pro' } }))
  await page.route('https://manorama.xyz/api/galleries', (route) => route.fulfill({ json: { galleries: [cloudGallery] } }))
  await page.route('https://manorama.xyz/api/device-galleries', (route) => route.fulfill({ json: { galleries: [] } }))
  await page.route('https://manorama.xyz/api/devices', (route) => route.fulfill({ json: { devices: [] } }))
  await page.route('https://manorama.xyz/api/account/identities', (route) => route.fulfill({ json: { identities: [{ provider: 'dropbox' }] } }))
  await page.addInitScript(() => {
    const copied: string[] = []
    Object.assign(window, { __copied: copied })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  })
  await page.addInitScript(installBridge, { ...bridgePayload, session: signedIn ? bridgePayload.session : 'null' })
  await page.route(`${BASE}/.macos-chrome-fixture`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html data-macos-shell="1"><head></head><body class="manorama-desktop"><div id="app"></div><script type="module" src="/desktop/main.tsx"></script></body></html>',
  }))
  await page.addInitScript((script) => {
    const messages: Record<string, unknown>[] = []
    Object.assign(window, {
      __chromeMessages: messages,
      __MANORAMA_SHELL__: { post: (message: Record<string, unknown>) => messages.push(message) },
      webkit: { messageHandlers: { manorama: { postMessage: (message: Record<string, unknown>) => messages.push(message) } } },
    })
    const start = () => {
      if (!document.documentElement) return false
      window.eval(script)
      return true
    }
    if (!start()) {
      const ready = new MutationObserver(() => { if (start()) ready.disconnect() })
      ready.observe(document, { childList: true })
    }
  }, observer)
})

for (const engine of ['chromium', 'webkit'] as const) {
  test.describe(engine, () => {
    test.use({ engine })

    test.describe('welcome', () => {
      test.use({ signedIn: false })
      test('hero emphasis matches the homepage pink and type', async ({ page }, testInfo) => {
        await page.goto(BASE)
        const homeWords = page.locator('.home-hero .home-h1 em')
        await expect(homeWords).toHaveText(['photographic', 'Library'])
        const readType = (elements: Element[]) => elements.map((element) => {
          const style = getComputedStyle(element)
          return { color: style.color, family: style.fontFamily, weight: style.fontWeight, style: style.fontStyle }
        })
        const expected = await homeWords.evaluateAll(readType)
        await page.goto(`${BASE}/.macos-chrome-fixture`)
        const emphasis = page.locator('.desktop-welcome h1 em')
        await expect(emphasis).toHaveText(['photographic', 'Library'])
        await expect.poll(() => emphasis.evaluateAll(readType)).toEqual(expected)
        for (const width of [760, 1280]) {
          await page.setViewportSize({ width, height: 840 })
          await page.evaluate(() => document.fonts.ready)
          expect(await page.locator('.desktop-welcome h1').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
          await page.screenshot({ path: testInfo.outputPath(`welcome-${width}.png`) })
        }
      })
    })

    test('Settings content stays inset at every pane width and in both themes', async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const pane = page.locator('.web-settings--pane')
      await expect(pane).toBeVisible()
      for (const theme of ['Dark', 'Light']) {
        await pane.getByRole('radio', { name: theme, exact: true }).click()
        for (const width of [760, 900, 1024, 1280, 1440]) {
          await page.setViewportSize({ width, height: 900 })
          await page.evaluate(() => document.fonts.ready)
          await expect.poll(() => pane.evaluate((element) => {
            const box = element.getBoundingClientRect()
            const heading = element.querySelector('.lib-settings-head')!.getBoundingClientRect()
            const sections = [...element.querySelectorAll('.m-owner-content > section')]
            return heading.left - box.left >= 23 && heading.top - box.top >= 23
              && box.right - heading.right >= 23
              && sections.every((section) => {
                const rect = section.getBoundingClientRect()
                return rect.left - box.left >= 23 && box.right - rect.right >= 23
                  && section.scrollWidth <= section.clientWidth + 1
              })
              && element.scrollWidth <= element.clientWidth + 1
          })).toBe(true)
          await pane.locator('.lib-settings-head').scrollIntoViewIfNeeded()
          await page.screenshot({ path: testInfo.outputPath(`settings-${theme}-${width}.png`) })
        }
      }
      await pane.getByRole('button', { name: 'Back to the library' }).click()
      await expect(pane).toBeHidden()
      expect(errors).toEqual([])
    })

    test('cloud conveniences live at Level 0 and Gallery Settings is the final screen', async ({ page }, testInfo) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      const trigger = page.getByRole('button', { name: 'Cloud Album actions', exact: true })
      await trigger.click()
      const menu = page.getByRole('dialog', { name: 'Cloud Album', exact: true })
      for (const name of ['Copy link', 'Reorder photos', 'Refresh gallery', 'Post to X', 'More settings…']) {
        await expect(menu.getByRole('button', { name, exact: true })).toBeEnabled()
      }
      await expect(menu.getByRole('button', { name: 'Share link', exact: true })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('cloud-quick-actions.png') })
      await menu.getByRole('button', { name: 'Copy link', exact: true }).click()
      await expect(menu).toBeHidden()
      await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['https://manorama.xyz/thecontrarian/cloud-album'])
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu.getByRole('heading')).toBeFocused()
      await menu.getByRole('button', { name: 'More settings…', exact: true }).focus()
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Gallery Settings', exact: true })
      await expect(settings).toBeVisible()
      await expect(settings.getByRole('heading', { name: 'Gallery Settings', exact: true })).toBeFocused()
      for (const name of ['Name', 'Caption', 'Address', 'Remove from Library']) {
        await expect(settings.locator('.m-actionrow-label').filter({ hasText: new RegExp(`^${name}$`) })).toBeVisible()
      }
      for (const name of ['Copy link', 'Reorder photos', 'Refresh gallery', 'More Settings']) {
        await expect(settings.getByRole('button', { name, exact: true })).toHaveCount(0)
      }
      await expect(settings.getByRole('switch', { name: 'Keep a copy on this Mac' })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(settings).toHaveCSS('opacity', '1')
      await page.screenshot({ path: testInfo.outputPath('cloud-final-settings.png') })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(trigger).toBeFocused()

      await page.route('https://manorama.xyz/api/gallery/thecontrarian/cloud-album', (route) => route.fulfill({ json: { manifest: cloudGallery } }))
      await page.route('https://manorama.xyz/api/galleries/cloud-album', (route) => route.fulfill({ json: { gallery: cloudGallery } }))
      await trigger.click()
      await menu.getByRole('button', { name: 'Reorder photos', exact: true }).click()
      await expect(page.locator('.viewer-filmstrip')).toBeVisible()
      await expect(page.locator('.viewer-edit-cell')).toHaveCount(2)
      await expect(page.locator('.viewer-picker-mode')).toHaveText('Reorder Photos')
      expect(errors).toEqual([])
    })

    test('cloud refresh keeps its busy gate and reports success and failure', async ({ page }) => {
      let pending: Route | null = null
      const requests: string[] = []
      await page.route('https://manorama.xyz/api/galleries/cloud-album/refresh', (route) => {
        requests.push(route.request().method())
        pending = route
      })
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      const trigger = page.getByRole('button', { name: 'Cloud Album actions', exact: true })
      const menu = page.getByRole('dialog', { name: 'Cloud Album', exact: true })
      for (const fail of [false, true]) {
        await trigger.click()
        await menu.getByRole('button', { name: 'Refresh gallery', exact: true }).click()
        await expect(menu).toBeHidden()
        await expect.poll(() => pending !== null).toBe(true)
        await trigger.click()
        await expect(menu.getByRole('button', { name: 'Refresh gallery', exact: true })).toBeDisabled()
        await expect(menu.getByRole('button', { name: 'Reorder photos', exact: true })).toBeDisabled()
        await pending!.fulfill({ status: fail ? 502 : 200, json: fail ? { error: 'The source could not be reached' } : { ok: true } })
        pending = null
        await expect(menu.getByRole('button', { name: 'Refresh gallery', exact: true })).toBeEnabled()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('status').filter({ hasText: fail ? 'The source could not be reached' : '“Cloud Album” refreshed' })).toBeVisible()
      }
      expect(requests).toEqual(['POST', 'POST'])
    })

    test('temporary and keyless cloud galleries retain their safeguards', async ({ page }) => {
      await page.route('https://manorama.xyz/api/galleries', (route) => route.fulfill({ json: { galleries: [
        { ...cloudGallery, retention: 'pipeline' },
        { ...cloudGallery, id: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd', title: 'Locked Album', slug: 'locked-album', manifestVersion: 2, sourceUrl: 'https://mega.nz/folder/fixture1' },
      ] } }))
      const refreshes: string[] = []
      page.on('request', (request) => { if (request.url().endsWith('/refresh')) refreshes.push(request.url()) })
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      await page.getByRole('button', { name: 'Cloud Album actions', exact: true }).click()
      let menu = page.getByRole('dialog', { name: 'Cloud Album', exact: true })
      await expect(menu.getByRole('button', { name: 'Reorder photos', exact: true })).toBeDisabled()
      await expect(menu.getByRole('button', { name: 'Refresh gallery', exact: true })).toBeDisabled()
      await expect(menu.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Locked Album actions', exact: true }).click()
      menu = page.getByRole('dialog', { name: 'Locked Album', exact: true })
      await expect(menu.getByRole('button', { name: 'Copy link', exact: true })).toBeDisabled()
      await menu.getByRole('button', { name: 'Refresh gallery', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'This device does not hold the key. Open the full gallery link before refreshing.' })).toBeVisible()
      expect(refreshes).toEqual([])
    })

    test('local menus copy published links and open the same reorder picker directly', async ({ page }, testInfo) => {
      await page.route('https://manorama.xyz/api/device-galleries', (route) => route.fulfill({ json: { galleries: [{
        id: GALLERY_ID, deviceId: catalogue.deviceId, title: 'Bangkok Rain', sourceKind: 'folder', itemCount: 2,
        publicGallerySlug: 'bangkok-rain', updatedAt: new Date().toISOString(),
      }] } }))
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      const trigger = page.getByRole('button', { name: 'Bangkok Rain actions', exact: true })
      const menu = page.getByRole('dialog', { name: 'Bangkok Rain', exact: true })
      await trigger.click()
      await expect(menu.getByRole('button', { name: 'Publish this gallery', exact: true })).toHaveCount(0)
      await menu.getByRole('button', { name: 'Copy link', exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(['https://manorama.xyz/thecontrarian/bangkok-rain'])
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(menu.getByRole('heading')).toBeFocused()
      await menu.getByRole('button', { name: 'More settings…', exact: true }).focus()
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Gallery Settings', exact: true })
      await expect(settings.locator('.m-actionrow-label')).toHaveText([
        'Open gallery', 'View source',
        'Name', 'Caption', 'Address',
        'Reorder photographs', 'Refresh gallery contents',
        'Remove from Library',
      ])
      await expect(settings.getByRole('heading', { name: 'Gallery Settings', exact: true })).toBeFocused()
      await expect(page.getByRole('dialog')).toHaveCount(1)
      await expect(settings).toHaveCSS('opacity', '1')
      await page.screenshot({ path: testInfo.outputPath('local-final-settings.png') })
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await trigger.click()
      await menu.getByRole('button', { name: 'Reorder photos', exact: true }).click()
      await expect(page.locator('.viewer-edit-cell')).toHaveCount(2)
      await expect(page.locator('.viewer-picker-mode')).toHaveText('Reorder Photos')
    })

    test('unpublished local menus publish explicitly and refresh can recover a missing source', async ({ page }) => {
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      const trigger = page.getByRole('button', { name: 'Bangkok Rain actions', exact: true })
      const menu = page.getByRole('dialog', { name: 'Bangkok Rain', exact: true })
      await trigger.click()
      await expect(menu.getByRole('button', { name: 'Copy link', exact: true })).toHaveCount(0)
      await menu.getByRole('button', { name: 'Publish this gallery', exact: true }).click()
      const publish = page.getByRole('dialog', { name: 'Publish “Bangkok Rain”', exact: true })
      await expect(publish).toBeVisible()
      await expect(publish).toContainText('nothing uploads until you confirm')
      await page.keyboard.press('Escape')
      await expect(publish).toBeHidden()
      await page.evaluate(() => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
        const original = bridge.invoke
        bridge.invoke = async (cmd, args) => cmd === 'plugin:fs|exists' ? false : original(cmd, args)
      })
      await trigger.click()
      await menu.getByRole('button', { name: 'Refresh gallery', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'The source is unavailable — reconnect it, then rescan.' })).toBeVisible()
      await trigger.click()
      await expect(menu.getByRole('button', { name: 'Reorder photos', exact: true })).toBeDisabled()
      await expect(menu.getByRole('button', { name: 'Publish this gallery', exact: true })).toBeDisabled()
      await expect(menu.getByRole('button', { name: 'Refresh gallery', exact: true })).toBeEnabled()
      await page.evaluate(() => {
        const bridge = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__
        const original = bridge.invoke
        bridge.invoke = async (cmd, args) => cmd === 'plugin:fs|exists' ? true : original(cmd, args)
      })
      await menu.getByRole('button', { name: 'Refresh gallery', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'That source has no photos Manorama can display' })).toBeVisible()
      await trigger.click()
      await expect(menu.getByRole('button', { name: 'Reorder photos', exact: true })).toBeEnabled()
    })

    test('native handle owns sheet focus, picker return and resized dock geometry', async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${BASE}/.macos-chrome-fixture`)
      await page.getByRole('button', { name: 'Bangkok Rain', exact: true }).click()
      const curtain = page.locator('[data-curtain]')
      await expect(curtain).toBeVisible()
      await curtain.click()
      await expect(curtain).toBeHidden()
      await expect(page.locator('[data-chrome-bottom]')).toBeAttached()
      await page.evaluate(() => window.__manoramaChrome!.focusStage())
      await page.keyboard.press('Tab')
      const focusedControl = () => page.evaluate(() => {
        const messages = (window as unknown as { __chromeMessages: Record<string, unknown>[] }).__chromeMessages
        return messages.filter((message) => message.type === 'focus').at(-1)?.control
      })
      await expect.poll(focusedControl).toBe('settings')
      await expect(page.getByRole('button', { name: 'Gallery Settings', exact: true })).toBeHidden()

      for (const control of ['settings', 'info', 'position'] as const) {
        await page.evaluate((name) => window.__manoramaChrome!.activate(name), control)
        const panel = page.locator(control === 'position' ? '.viewer-filmstrip' : '.m-sheet')
        await expect(panel).toBeVisible()
        await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true)
        await page.evaluate(() => window.__manoramaChrome!.activate('library'))
        await expect(panel).toBeVisible()
        if (control === 'settings') {
          await page.setViewportSize({ width: 760, height: 620 })
          await expect.poll(() => panel.evaluate((element) => {
            const panelRect = element.getBoundingClientRect()
            const dockRect = document.querySelector('[data-chrome-bottom]')!.getBoundingClientRect()
            return Math.abs(panelRect.bottom - (dockRect.top - 10)) < 2
              && panelRect.left >= 14 && panelRect.right <= innerWidth - 14
          })).toBe(true)
        }
        await page.keyboard.press('Escape')
        await expect(panel).toBeHidden()
        await expect.poll(focusedControl).toBe(control)
      }

      await page.evaluate(() => window.__manoramaChrome!.activate('position'))
      await expect(page.locator('.viewer-filmstrip')).toBeVisible()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await expect(page.locator('.viewer-filmstrip')).toBeHidden()
      await expect(page.locator('[data-chrome-position]')).toHaveText('2 of 2')
      await expect.poll(focusedControl).toBe('position')
      await expect.poll(() => page.evaluate(() => {
        const messages = (window as unknown as { __chromeMessages: Record<string, unknown>[] }).__chromeMessages
        const reported = messages.filter((message) => message.type === 'chrome-layout').at(-1)?.rect as { x: number; y: number; w: number; h: number } | null
        const rect = document.querySelector('[data-chrome-bottom]')!.getBoundingClientRect()
        return reported !== null && reported !== undefined && Math.abs(reported.x - rect.x) < 1
          && Math.abs(reported.y - rect.y) < 1 && Math.abs(reported.w - rect.width) < 1
          && Math.abs(reported.h - rect.height) < 1
      })).toBe(true)
      await page.evaluate(() => window.__manoramaChrome!.activate('library'))
      await expect(page.locator('.desktop-catalogue')).toBeVisible()
      expect(errors).toEqual([])
    })
  })
}
