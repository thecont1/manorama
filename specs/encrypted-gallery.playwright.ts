import { expect, test, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'

const base = 'http://localhost:5173'
const owner = 'thecontrarian'
const ownerId = 'dbid:AAATESTowner1'

// The keyed-open case needs a real share; playwright does not auto-load
// .env.local, so read it as a fallback and skip when no share is configured.
const devMegaSource = (): string | undefined => {
  if (process.env.MANORAMA_DEV_SOURCE_MEGA) return process.env.MANORAMA_DEV_SOURCE_MEGA
  try {
    const line = readFileSync('.env.local', 'utf8').split('\n').find((row) => row.startsWith('MANORAMA_DEV_SOURCE_MEGA='))
    return line?.slice('MANORAMA_DEV_SOURCE_MEGA='.length).trim().replace(/^["']|["']$/g, '') || undefined
  } catch {
    return undefined
  }
}

const spawn = async (request: APIRequestContext, slug: string) => {
  const response = await request.post(`${base}/.dev-seed/spawn`, {
    data: { accountId: ownerId, galleries: [{ slug, createdAt: new Date().toISOString(), encrypted: true }] },
  })
  // Surface seeding failures (e.g. duplicate-source rejection) instead of
  // discovering them as a missing gallery at the route.
  const body = (await response.json()) as { results?: { ok: boolean; slug?: string; reason?: string }[] }
  expect(body.results?.[0]?.ok, `spawn ${slug} failed: ${JSON.stringify(body)}`).toBe(true)
}

// The three matrix viewports — the locked path is the same SSR + island at
// every size, but the matrix must stay green after viewer/route changes.
for (const viewport of [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
]) {
  test.describe(`the locked encrypted gallery at ${viewport.width}×${viewport.height}`, () => {
    test('publishes static OG metadata and no key material, then unlocks from a pasted link', async ({ browser }) => {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      const slug = `enc-${viewport.width}`
      const megaCalls: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('/api/mega/')) megaCalls.push(request.url())
      })

      // Specs run in parallel against one in-memory store: a neighbouring
      // spec's reset can wipe the spawn mid-navigation, so the whole
      // seed-and-load retries until the locked panel stays.
      await expect(async () => {
        await context.request.post(`${base}/.dev-seed/reset`)
        await spawn(context.request, slug)
        await page.goto(`${base}/${owner}/${slug}`, { waitUntil: 'domcontentloaded' })
        await expect(page.locator('.encrypted-locked')).toBeVisible({ timeout: 20_000 })
      }).toPass({ timeout: 60_000 })

      // Locked state is announced, not just visible.
      const locked = page.getByRole('alert')
      await expect(locked).toBeVisible()
      await expect(locked).toContainText('locked on this device')
      await expect(page.locator('#encrypted-unlock-url')).toBeVisible()

      // Server-side metadata is the static card — no provider data, no query.
      const html = await (await context.request.get(`${base}/${owner}/${slug}`)).text()
      const meta = (property: string) => html.match(new RegExp(`<meta property="${property}" content="([^"]*)"`))?.[1] ?? ''
      expect(meta('og:image')).toMatch(/\/og-image\.png$/)
      expect(meta('og:image:type')).toBe('image/png')
      expect(meta('og:url')).not.toContain('?')
      expect(meta('og:url')).toContain(`/${owner}/${slug}`)

      // No key material anywhere in the document — no k= params, no source
      // fragment, and the gated manifest ships keyless srcs only.
      expect(html).not.toMatch(/[#?&]k=/)
      expect(html).not.toContain('#source=')
      expect(html).not.toContain('mega.nz/file')
      expect(html).not.toContain(`mega.nz/folder/DevSeed-${slug}#`)

      // v2 SSR keeps the stored aspect ratio on the frame so the locked
      // panel can replace the shell without a layout shift.
      expect(html).toMatch(/aspect-ratio:\s*1\s*\/\s*1/)

      // The client never calls the retired server decryptor.
      expect(megaCalls).toHaveLength(0)

      // A full provider link becomes the document fragment — the key stays
      // in fragment custody and never reaches the query string or server.
      // The curtain is dismissed for the locked state: the panel it would
      // cover is the only content this gallery can offer a keyless visitor.
      // The pasted folder must match the gallery's source — a mismatch would
      // fail the identity check instead of proving the rewrite.
      await expect(page.locator('.curtain')).toBeHidden()
      await page.locator('#encrypted-unlock-url').fill(`https://mega.nz/folder/DevSeed-${slug}#NotARealKey0123`)
      await page.locator('.encrypted-locked button[type="submit"]').click()
      await page.waitForFunction(() => window.location.hash.startsWith('#source='))
      expect(page.url()).toContain('#source=')
      expect(page.url()).toContain(encodeURIComponent(`DevSeed-${slug}`))

      await context.close()
    })
  })
}

// The seeded live share proves the other half: a keyed open lists, fetches,
// and decrypts on the device — blob: sources, zero /api/mega/* calls, and
// the fragment stays put for the duration.
test('a keyed open decrypts on the device', async ({ browser }) => {
  const keyed = devMegaSource()
  test.skip(!keyed, 'MANORAMA_DEV_SOURCE_MEGA not configured — no live share to decrypt')
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const megaCalls: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/mega/')) megaCalls.push(request.url())
  })
  await expect(async () => {
    await context.request.post(`${base}/.dev-seed/reset`)
    await page.goto(`${base}/${owner}/dev-mega#source=${encodeURIComponent(keyed!)}`, { waitUntil: 'domcontentloaded' })
    // The curtain is up until entry; the island decrypts behind it — first
    // blob frame on a ~70-item share lands well inside a minute.
    await expect(page.locator('img[src^="blob:"]').first()).toBeVisible({ timeout: 60_000 })
  }).toPass({ timeout: 90_000 })
  await page.locator('.curtain').click()
  expect(megaCalls).toHaveLength(0)
  expect(page.url()).toContain('#source=')
  await expect(page.locator('.encrypted-locked')).toHaveCount(0)
  await context.close()
})
