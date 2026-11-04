import { test, expect } from '@playwright/test'

// #128 — kill the app, drop the network, relaunch: saved galleries must still
// be listed and openable. The harness answers the session-gated calls in-page,
// so "unreachable" is a state: /state/9 keeps the seeding but rejects every
// non-__capture fetch. The vault fill is opted into per take via
// __captureVaultPolicy, since captures default the device policy to 'stream'.
const base = process.env.CAPTURE_URL ?? 'http://localhost:4181'

test('saved galleries survive an unreachable API', async ({ browser, request }) => {
  test.setTimeout(120000)
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  await context.addInitScript(() => { (window as { __captureVaultPolicy?: string }).__captureVaultPolicy = 'download' })
  await request.get(`${base}/state/3`)
  const page = await context.newPage()
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.lib-card').first()).toBeVisible({ timeout: 30000 })

  // Opening the gallery starts the encrypted fill once the policy is download.
  await page.locator('.lib-card-title').first().click()
  await expect(page.locator('[data-stage]')).toBeVisible({ timeout: 30000 })

  // While the gallery is in the account list its saved copy is deduplicated
  // out of "Saved on this device" — the fill's own commit is the signal.
  // The metadata entry is written last, so its presence in the vault's
  // FileStorage store (the web Filesystem impl backs onto IndexedDB 'Disc')
  // means every image landed.
  await expect.poll(() => page.evaluate(async () => {
    const req = indexedDB.open('Disc')
    const db = await new Promise<IDBDatabase>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
    const tx = db.transaction('FileStorage', 'readonly')
    const keys = await new Promise<IDBValidKey[]>((resolve) => { const all = tx.objectStore('FileStorage').getAllKeys(); all.onsuccess = () => resolve(all.result) })
    return keys.some((key) => String(key).includes('b2ZmbGluZS1nYWxsZXJ5Om1ldGFkYXRhOnYx'))
  }), { timeout: 90000 }).toBe(true)

  // The network dies. Same seeding as state 3, but every API answer fails.
  await request.get(`${base}/state/9`)
  await page.reload({ waitUntil: 'domcontentloaded' })

  const account = page.locator('[data-account]')
  await expect(account).toContainText('could not be loaded', { timeout: 30000 })
  const card = page.locator('[data-cached-gallery="italy"]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Saved on this device')
  await expect(card).toContainText('account list unavailable')

  // The saved copy opens to real photographs — blob: URLs minted from the
  // vault, not a retry notice or an empty frame.
  await card.locator('.lib-card-title').click()
  await expect(page.locator('[data-stage]')).toBeVisible({ timeout: 30000 })
  await expect.poll(() =>
    page.locator('img[src^="blob:"]').count(), { timeout: 30000 }).toBeGreaterThan(0)
  await context.close()
})
