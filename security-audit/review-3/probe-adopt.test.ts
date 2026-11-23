/**
 * Adopting somebody else's encrypted gallery.
 *
 * The route's promise: "the stored manifest is copied (not re-scanned) … the
 * copy is exactly what the member saw". For an encrypted source the stored
 * images carry keyless `media` references and an empty `src`, and the render
 * path chosen for a visitor is decided by `encryptedGalleryGate` from the new
 * row's `manifestVersion` / `keyRetiredAt`. This asserts the copy keeps what
 * the gate needs.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { contextStorage } from 'honox/server/context-storage'
import viewerPage from '../../app/routes/[owner]/[slug]'
import renderer from '../../app/routes/_renderer'
import { createManoramaApi } from '../../app/api'
import { getStoredGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore } from '../../app/lib/user-repository'
import { seedTestUser, sessionCookieFor, TEST_OWNER, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'
import { encryptedGalleryGate } from '../../packages/core/encrypted-source'

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const MEMBER = { accountId: 'dbid:AAAauditmember', displayName: 'Audit Member' }

const manifest = {
  provider: 'mega',
  sourceUrl: 'https://mega.nz/folder/AbC123',
  title: 'Secret Album',
  images: [{
    id: 'mega-nodeABC',
    ref: 'nodeABC',
    filename: 'frame.jpg',
    src: '',
    width: 1600,
    height: 1200,
    alt: 'frame',
    c2pa: false,
    placeholder: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 1200'%3E%3C/svg%3E",
    contentVersion: 'a'.repeat(64),
    media: { kind: 'encrypted', provider: 'mega', sourceKind: 'folder', sourceId: 'AbC123', nodeId: 'nodeABC' },
  }],
}

const api = createManoramaApi()
let ownerCookie = ''
let memberCookie = ''

beforeAll(async () => {
  resetUserStore()
  resetGalleryStore()
  await seedTestUser()
  await seedTestUser(MEMBER)
  ownerCookie = await sessionCookieFor(TEST_OWNER.accountId)
  memberCookie = await sessionCookieFor(MEMBER.accountId)

  const created = await api.request('/api/galleries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ manifest, quick: false }),
  }, env)
  if (created.status !== 201) console.log('CREATE FAILED', created.status, await created.clone().text())
  expect(created.status).toBe(201)
})

describe('adopt copies the manifest faithfully', () => {
  test('the source really is a client-gated encrypted gallery', async () => {
    const source = await getStoredGallery(TEST_OWNER.accountId, 'secret-album')
    expect(source?.manifestVersion).toBe(2)
    const gate = encryptedGalleryGate({
      sourceUrl: source!.sourceUrl!,
      viewerOwner: false,
      keyRetiredAt: source!.keyRetiredAt,
      manifestVersion: source!.manifestVersion,
    })
    expect(gate.client).toBe(true)
  })

  test('the adopted copy keeps the encrypted manifest\'s version and key facts', async () => {
    const adopted = await api.request('/api/galleries/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
      body: JSON.stringify({ owner: 'test-owner', slug: 'secret-album' }),
    }, env)
    expect(adopted.status).toBe(201)
    const payload = await adopted.json() as { gallery: { slug: string; manifestVersion: number } }
    expect(payload.gallery.slug).toBe('secret-album')

    const copy = await getStoredGallery(MEMBER.accountId, 'secret-album')
    expect(copy).not.toBeNull()
    // The copied items are keyless refs — they can only be rendered by the
    // client gate, which the visitor's render chooses from these fields.
    expect(copy!.images[0]?.src).toBe('')
    expect(copy!.images[0]?.media?.kind).toBe('encrypted')

    const gate = encryptedGalleryGate({
      sourceUrl: copy!.sourceUrl!,
      viewerOwner: false,
      keyRetiredAt: copy!.keyRetiredAt,
      manifestVersion: copy!.manifestVersion,
    })
    // The copy was advertised with manifestVersion 2 and a retired key, so a
    // visitor must take the client gate. If this is false the visitor render
    // falls to the legacy viewer and every frame has src="".
    expect({ version: copy!.manifestVersion, client: gate.client }).toEqual({ version: 2, client: true })
  })

  test('what a visitor to the adopted copy is served', async () => {
    const honoxContext = async (c: Context, next: Next) => { await contextStorage.run(c, () => next()) }
    const hono = new Hono()
    hono.use('*', honoxContext)
    hono.use('*', renderer as unknown as never)
    ;(hono.get.bind(hono) as (p: string, ...h: unknown[]) => void)('/:owner/:slug', ...(viewerPage as unknown as unknown[]))
    const response = await hono.request('/audit-member/secret-album', {}, env)
    expect(response.status).toBe(200)
    const html = await response.text()
    const frame = /<img[^>]*class="frame-img"[^>]*src="([^"]*)"/.exec(html)
    console.log(`ADOPTED-COPY visitor frame-img src=${JSON.stringify(frame?.[1] ?? null)}`)
    // The copy now takes the client gate: EncryptedGallery SSRs the Viewer
    // shell with an encryptedResolver, so the visitor gets placeholders at
    // SSR and the resolver fills them after hydration — no frame-img yet.
    expect(frame).toBeNull()
    expect(html).toContain('<img class="frame-ph" src="data:image/svg+xml')
  })
})
