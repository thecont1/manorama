import { test, expect } from '@playwright/test'
import { generateCodeVerifier, pkceChallenge, exchangeDesktopHandoff, buildDesktopAuthUrl } from './desktop/lib/session'
const base = 'http://localhost:5173'
test('local browser door returns a verifier-bound handoff redeemable only at the local server', async ({ page, request }) => {
  test.setTimeout(40_000)
  const verifier = generateCodeVerifier()
  const url = buildDesktopAuthUrl('dropbox', base, await pkceChallenge(verifier))
  await expect.poll(async () => (await request.get(`${base}/.dev-seed/login`, { maxRedirects: 0, timeout: 15_000 })).status(), { timeout: 30_000, intervals: [1000, 2000] }).toBe(302)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Local development account' })).toBeVisible()
  const callback = await page.getByRole('link', { name: 'Return to manorama' }).getAttribute('href')
  expect(callback).toMatch(/^in\.thecontrarian\.manorama\.desktop:\/\/auth\/callback\?/)
  const token = new URL(callback!).searchParams.get('handoff')!
  const wrong = await request.post(`${base}/api/auth/desktop/exchange`, { data: { handoffToken: token, codeVerifier: generateCodeVerifier() } })
  expect(wrong.status()).toBe(401)
  const fetcher = (async (url: string, init?: RequestInit) => {
    const response = await request.post(url, { data: JSON.parse(String(init?.body)) })
    return new Response(await response.text(), { status: response.status() })
  }) as typeof fetch
  const session = await exchangeDesktopHandoff(token, verifier, base, fetcher)
  expect(session.ownerSlug).toBe('thecontrarian')
  const account = await request.get(`${base}/api/account`, { headers: { Authorization: `Bearer ${session.token}` } })
  expect(account.status()).toBe(200)
  expect((await account.json()).ownerSlug).toBe('thecontrarian')
})
test('local door rejects malformed and missing PKCE challenges', async ({ request }) => {
  expect((await request.get(`${base}/.dev-seed/desktop-login`)).status()).toBe(400)
  expect((await request.get(`${base}/.dev-seed/desktop-login?code_challenge=bad`)).status()).toBe(400)
})
