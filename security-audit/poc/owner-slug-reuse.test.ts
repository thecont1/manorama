import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { createGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore, upsertUser } from '../../app/lib/user-repository'
import { SESSION_COOKIE } from '../../app/lib/session'
import { seedTestUser, sessionCookieFor, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

/**
 * FINDING F-04 — an owner slug is released the moment its account renames or
 * is deleted, and nothing reserves it.
 *
 * Public gallery addresses are `/<owner_slug>/<gallery_slug>` and the owner
 * slug is the only thing naming the account, so every previously shared link
 * depends on it. Two accounts can never hold the same slug at the same time,
 * but the *history* is not kept: the next account to ask for a freed slug gets
 * it, and can pick the same gallery slug. From then on an old link resolves to
 * someone else's photographs with no signal that it changed.
 *
 * Runs entirely on the in-memory repositories, so no D1 and no network.
 */

const env = { HOST_API_JWT_SECRET: TEST_SESSION_SECRET }
const api = createManoramaApi()

const cookieFor = (accountId: string) => sessionCookieFor(accountId)

const gallery = (slug: string, title: string) => ({
  slug,
  title,
  caption: '',
  date: '',
  images: [{ id: `${slug}-1`, filename: `${slug}-1.jpg`, src: '/images/x.jpg', width: 1200, height: 800, alt: title, c2pa: false, placeholder: '' }],
})

const patchAccount = (currentOwner: string, nextSlug: string) =>
  api.request('/api/account', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: currentOwner },
    body: JSON.stringify({ ownerSlug: nextSlug }),
  }, env)

beforeEach(() => {
  resetUserStore()
  resetGalleryStore()
})

describe('F-04 a released owner slug is free for anyone to claim', () => {
  test('a shared gallery link silently starts serving a different account after a rename', async () => {
    // The real owner publishes /alice/field-notes and shares it.
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    await createGallery(alice.accountId, gallery('field-notes', 'Alice in the field'))

    const before = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect(before.status).toBe(200)
    expect((await before.json() as { manifest: { title: string } }).manifest.title).toBe('Alice in the field')

    // Alice renames her address. The old slug is now unowned.
    const renamed = await patchAccount(await cookieFor(alice.accountId), 'alice-photographs')
    expect(renamed.status).toBe(200)

    // A stranger signs in and asks for the released slug — nothing reserves it.
    const bob = await upsertUser({ accountId: 'dbid:audit-bob', displayName: 'Bob' })
    const claimed = await patchAccount(await cookieFor(bob.accountId), 'alice')
    expect(claimed.status).toBe(200)
    await createGallery(bob.accountId, gallery('field-notes', 'Bob, somewhere else'))

    // The link Alice shared before the rename now serves Bob's gallery.
    const after = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect(after.status).toBe(200)
    expect((await after.json() as { manifest: { title: string } }).manifest.title).toBe('Bob, somewhere else')

    // Alice's own gallery is intact — just somewhere else.
    const moved = await api.request('/api/gallery/alice-photographs/field-notes', {}, env)
    expect((await moved.json() as { manifest: { title: string } }).manifest.title).toBe('Alice in the field')
  })

  test('deleting an account frees its slug immediately, with all galleries gone', async () => {
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    await createGallery(alice.accountId, gallery('field-notes', 'Alice in the field'))

    const deleted = await api.request('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(alice.accountId) },
      body: JSON.stringify({ confirm: 'alice' }),
    }, env)
    expect(deleted.status).toBe(200)

    // Same slug, different account: the old link is claimable.
    const bob = await upsertUser({ accountId: 'dbid:audit-bob', displayName: 'Bob' })
    expect((await patchAccount(await cookieFor(bob.accountId), 'alice')).status).toBe(200)
    await createGallery(bob.accountId, gallery('field-notes', 'Bob, somewhere else'))

    const after = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect((await after.json() as { manifest: { title: string } }).manifest.title).toBe('Bob, somewhere else')
  })

  test('two accounts may hold the same gallery slug; only the owner segment separates them', async () => {
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    const bob = await upsertUser({ accountId: 'dbid:audit-bob', displayName: 'Bob' })
    await createGallery(alice.accountId, gallery('same', 'Alice copy'))
    await createGallery(bob.accountId, gallery('same', 'Bob copy'))

    const aliceView = await api.request('/api/gallery/alice/same', {}, env)
    const bobView = await api.request('/api/gallery/bob/same', {}, env)
    expect((await aliceView.json() as { manifest: { title: string } }).manifest.title).toBe('Alice copy')
    expect((await bobView.json() as { manifest: { title: string } }).manifest.title).toBe('Bob copy')

    // The session-scoped detail route resolves within the caller's own account.
    const aliceAuthed = await api.request('/api/galleries/same', { headers: { Cookie: await cookieFor(alice.accountId) } }, env)
    expect(aliceAuthed.status).toBe(200)
    expect((await aliceAuthed.json() as { gallery: { title: string } }).gallery.title).toBe('Alice copy')
  })
})
