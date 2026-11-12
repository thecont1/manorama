import { beforeEach, describe, expect, test } from 'bun:test'
import { createManoramaApi } from '../../app/api'
import { createGallery, resetGalleryStore } from '../../app/lib/gallery-repository'
import { resetUserStore, upsertUser } from '../../app/lib/user-repository'
import { SESSION_COOKIE } from '../../app/lib/session'
import { seedTestUser, sessionCookieFor, TEST_SESSION_SECRET } from '../../app/lib/test-fixtures'

/**
 * FINDING F-04 — a released owner slug could be claimed by a stranger.
 * FIXED.
 *
 * Renaming or deleting an account now writes the outgoing slug into
 * owner_slug_reservations, bound to the releasing account forever. Another
 * account asking for a reserved slug gets the same 'in use' refusal as a
 * live collision; only the original owner may take the name back, so an
 * old shared link either keeps working (owner reclaimed it) or 404s —
 * never serves someone else's photographs.
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

describe('F-04 a released owner slug stays reserved for its account', () => {
  test('a stranger cannot claim the slug a rename just freed', async () => {
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    await createGallery(alice.accountId, gallery('field-notes', 'Alice in the field'))

    const renamed = await patchAccount(await cookieFor(alice.accountId), 'alice-photographs')
    expect(renamed.status).toBe(200)

    // A stranger asks for the released slug — refused like a live collision.
    const bob = await upsertUser({ accountId: 'dbid:audit-bob', displayName: 'Bob' })
    const claimed = await patchAccount(await cookieFor(bob.accountId), 'alice')
    expect(claimed.status).toBe(422)
    expect((await claimed.json() as { error: string }).error).toBe('That URL is already in use')

    // The old link now 404s — it can never resolve to Bob's photographs.
    await createGallery(bob.accountId, gallery('field-notes', 'Bob, somewhere else'))
    const oldLink = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect(oldLink.status).toBe(404)

    // Alice's gallery is intact at the new address.
    const moved = await api.request('/api/gallery/alice-photographs/field-notes', {}, env)
    expect((await moved.json() as { manifest: { title: string } }).manifest.title).toBe('Alice in the field')
  })

  test('deleting an account reserves its slug permanently', async () => {
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    await createGallery(alice.accountId, gallery('field-notes', 'Alice in the field'))

    const deleted = await api.request('/api/account', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: await cookieFor(alice.accountId) },
      body: JSON.stringify({ confirm: 'alice' }),
    }, env)
    expect(deleted.status).toBe(200)

    // Same slug, different account: still refused, and the link 404s.
    const bob = await upsertUser({ accountId: 'dbid:audit-bob', displayName: 'Bob' })
    expect((await patchAccount(await cookieFor(bob.accountId), 'alice')).status).toBe(422)
    await createGallery(bob.accountId, gallery('field-notes', 'Bob, somewhere else'))

    const after = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect(after.status).toBe(404)
  })

  test('the original owner may reclaim the slug it released', async () => {
    const alice = await seedTestUser({ accountId: 'dbid:audit-alice', displayName: 'Alice' })
    await createGallery(alice.accountId, gallery('field-notes', 'Alice in the field'))
    const cookie = await cookieFor(alice.accountId)

    expect((await patchAccount(cookie, 'alice-photographs')).status).toBe(200)
    // Renaming back is the account's own choice — the old link revives.
    const back = await patchAccount(cookie, 'alice')
    expect(back.status).toBe(200)
    const revived = await api.request('/api/gallery/alice/field-notes', {}, env)
    expect(revived.status).toBe(200)
  })

  test('a new account is never derived onto a released slug', async () => {
    // 'carol' is released by a rename, then a Carol signs up — the derived
    // slug must skip the reserved name entirely.
    const carol = await seedTestUser({ accountId: 'dbid:audit-carol', displayName: 'Carol' })
    await patchAccount(await cookieFor(carol.accountId), 'carol-elsewhere')
    const newcomer = await upsertUser({ accountId: 'dbid:audit-carol2', displayName: 'Carol' })
    expect(newcomer.ownerSlug).not.toBe('carol')
    expect(newcomer.ownerSlug.startsWith('carol-')).toBe(true)
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
