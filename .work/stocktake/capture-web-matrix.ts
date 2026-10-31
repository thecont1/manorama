/**
 * The web evidence matrix: the six surfaces the native shells are photographed
 * on, at three viewports.
 *
 * Hard-won rules, all of them paid for:
 *
 * 1. Every await is bounded. A bare `waitUntil: 'load'` against the dev-seed
 *    door and `document.fonts.ready` both hung a run for eighty minutes.
 * 2. The report is rewritten after every state, so a stall still leaves an
 *    account of what was reached.
 * 3. Server-rendered markup exists before the island hydrates, so a click can
 *    land on nothing. Every interaction here retries until it can see its own
 *    effect.
 * 4. The curtain is a `role="button"` — pressing Enter on it is more reliable
 *    than clicking, because the curtain's own content intercepts pointers.
 */
import { chromium, webkit } from 'playwright'
import type { Browser, BrowserType, Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const base = process.env.WEB_CAPTURE_URL ?? 'http://localhost:5175'
const galleryPath = process.env.WEB_CAPTURE_GALLERY ?? '/thecontrarian/mixed-album'
const out = resolve(root, 'demo-captures/web')
const reportPath = resolve(out, 'matrix-report.json')
await mkdir(out, { recursive: true })

const engineNames = (process.env.WEB_CAPTURE_ENGINES ?? 'chromium').split(',').map(s => s.trim()).filter(Boolean)
const engines: BrowserType[] = engineNames.map(name => (name === 'webkit' ? webkit : chromium))

// macOS has no `timeout(1)`, so the budget lives in the process. The per-await
// bounds should make this unreachable; the previous version proved otherwise.
const budgetMs = Number(process.env.WEB_CAPTURE_BUDGET_MS ?? 900_000)
const watchdog = setTimeout(() => {
  console.error(`capture budget of ${budgetMs}ms exhausted; exiting`)
  process.exit(2)
}, budgetMs)
watchdog.unref?.()

type Report = { engine: string; viewport: string; state: string; file: string | null; ok: boolean; note?: string }
const reports: Report[] = []
const record = async (entry: Report) => {
  reports.push(entry)
  await writeFile(reportPath, JSON.stringify(reports, null, 2))
  console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.engine}/${entry.viewport}/${entry.state}${entry.note ? ` — ${entry.note}` : ''}`)
}

const bounded = <T,>(work: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ])

const viewports = [
  { name: 'iphone', width: 428, height: 926, dpr: 3, touch: true },
  { name: 'ipad', width: 1376, height: 1032, dpr: 2, touch: true },
  { name: 'desktop', width: 1440, height: 900, dpr: 1, touch: false },
]

/** Retry an interaction until its effect is visible. A click before hydration
 *  is a no-op, so "did it work?" is the only question worth asking. */
const until = async (
  page: Page,
  label: string,
  act: () => Promise<void>,
  done: () => Promise<boolean>,
  tries = 10,
) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await act().catch(() => undefined)
    if (await done()) return
    await page.waitForTimeout(600)
  }
  throw new Error(label)
}

const signIn = async (page: Page) => {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.goto(`${base}/.dev-seed/login`, { waitUntil: 'commit', timeout: 20_000 })
      await page.waitForURL(url => !url.pathname.startsWith('/.dev-seed'), { timeout: 25_000 })
      await page.waitForLoadState('domcontentloaded', { timeout: 20_000 })
      return
    } catch (error) {
      lastError = error
      await page.waitForTimeout(1_500)
    }
  }
  throw new Error(`dev-seed sign-in failed: ${(lastError as Error)?.message ?? lastError}`)
}

for (const engine of engines) {
  const engineName = engine.name()
  let browser: Browser | null = null
  try {
    browser = await bounded(engine.launch({ headless: true }), 60_000, `${engineName} launch`)
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.dpr,
        hasTouch: viewport.touch,
      })
      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      page.setDefaultNavigationTimeout(30_000)

      const shoot = async (state: string, run: () => Promise<void>) => {
        const file = `${engineName}-${viewport.name}-${state}.png`
        try {
          await bounded(run(), 90_000, state)
          await bounded(page.evaluate(() => document.fonts.ready), 3_000, 'fonts.ready').catch(() => undefined)
          await bounded(page.screenshot({ path: resolve(out, file), scale: 'device' }), 30_000, `${state} screenshot`)
          await record({ engine: engineName, viewport: viewport.name, state, file, ok: true })
        } catch (error) {
          const note = error instanceof Error ? error.message : String(error)
          await record({ engine: engineName, viewport: viewport.name, state, file: null, ok: false, note: `${note} (at ${page.url()})` })
        }
      }

      const controls = () => page.locator('[data-chrome-bottom].is-visible').count()
      const paneOpen = async () => page.locator('.web-settings').count()

      // Vite compiles a route's SSR graph on first request, and a cold compile
      // can answer with an empty response. Warm the routes once per engine, and
      // retry a gallery navigation that comes back empty-handed.
      if (viewport.name === 'iphone') {
        for (const path of ['/', galleryPath, '/thecontrarian']) {
          await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined)
        }
      }

      const openGallery = async () => {
        let lastError: unknown = null
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            await page.goto(`${base}${galleryPath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            await page.waitForSelector('[aria-label="Enter gallery"]', { timeout: 12_000 })
            return
          } catch (error) {
            lastError = error
            await page.waitForTimeout(1_500)
          }
        }
        throw new Error(`the gallery never rendered: ${(lastError as Error)?.message ?? lastError}`)
      }

      const liftCurtain = async () => {
        // A click is what the app's own handler wants. Pressing Enter on the
        // curtain does flip it away, but the body never gains
        // `gallery-entered`, and the `g` shortcut checks exactly that class —
        // which is why the picker opened for the click and not for the key.
        // `force` skips the actionability probe the curtain's content fails.
        await until(
          page,
          'the curtain never dissolved',
          () => page.locator('[aria-label="Enter gallery"]').click({ position: { x: 6, y: 6 }, timeout: 5_000, force: true }),
          async () => (await controls()) > 0 && await page.evaluate(() => document.body.classList.contains('gallery-entered')),
          12,
        )
        // The 1.1s dissolve must land before the shutter fires — the veil
        // is what this evidence is about.
        await page.waitForTimeout(1_300)
      }

      await shoot('01-landing', async () => {
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForSelector('body', { timeout: 15_000 })
      })

      // Sign in before the gallery states so the chrome shows the owner's
      // full row — Library up top, Details when it ships.
      await signIn(page)

      await shoot('02-gallery-curtain', async () => { await openGallery() })

      await shoot('03-first-image', async () => {
        await openGallery()
        await liftCurtain()
      })

      await shoot('04-controls', async () => {
        await until(
          page,
          'the display sheet never opened',
          async () => {
            await page.locator('.m-chrome-skip').evaluate((el: HTMLElement) => el.click()).catch(() => undefined)
            await page.getByRole('button', { name: 'Display', exact: true }).click({ timeout: 3_000 }).catch(() => undefined)
          },
          async () => (await page.getByRole('dialog', { name: 'Display' }).count()) > 0,
        )
        await page.waitForTimeout(700)
      })
      // The account states live on the dashboard — the gallery states
      // left the page inside a gallery.
      await page.goto(`${base}/thecontrarian`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await shoot('05-account-admin', async () => {
        // The edge-tab drawer retired with the top bar: the dashboard's account
        // surface sits behind the shared Settings gear now. Waiting for it —
        // then watching the gear's click land — is the hydration probe.
        await page.waitForSelector('[aria-label="Settings"]', { timeout: 25_000 })
      })

      await shoot('05-account-pane', async () => {
        await until(
          page,
          'the settings surface never opened',
          () => page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 5_000 }),
          async () => (await paneOpen()) > 0,
        )
        await page.waitForTimeout(500)
      })

      await shoot('05-editor-row', async () => {
        await until(
          page,
          'the settings surface never closed',
          () => page.getByRole('button', { name: 'Back', exact: true }).click({ timeout: 5_000 }),
          async () => (await paneOpen()) === 0,
        )
        await page.waitForTimeout(400)
      })

      await shoot('06-selector', async () => {
        await openGallery()
        await liftCurtain()
        await until(
          page,
          'the photo picker never appeared',
          () => page.keyboard.press('g'),
          async () => (await page.locator('.viewer-picker-header').count()) > 0,
          6,
        )
        await page.waitForTimeout(1_000)
      })

      await context.close()
    }
  } catch (error) {
    await record({
      engine: engineName,
      viewport: 'all',
      state: 'run',
      file: null,
      ok: false,
      note: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

const failed = reports.filter(report => !report.ok)
console.log(`\ncaptured ${reports.filter(r => r.ok).length} shots, ${failed.length} failed`)
console.log(`report: ${reportPath}`)