import { describe, expect, test } from 'bun:test'
import type { GalleryImage, GalleryManifest } from '../../app/lib/imagesource'
import { defaultGallerySettings } from '../../app/lib/gallery-settings'
import { EncryptedOfflineGalleryStore } from './offline-gallery'
import type { NativeTier } from './billing'
import {
  applyVaultCap,
  assertCapAllowed,
  createVaultSettingsController,
  FREE_VAULT_CAP_BYTES,
  loadVaultCapPreference,
  resolveVaultCap,
  saveVaultCapPreference,
  VAULT_CAP_PREFERENCE_KEY,
  type VaultCapPersistence,
} from './vault-settings'
import { EncryptedVault, webCryptoProvider } from './vault'
import type { VaultKeyProvider, VaultStorageProvider } from './vault'

class MemoryStorage implements VaultStorageProvider {
  readonly files = new Map<string, Uint8Array>()
  async read(path: string) { return this.files.get(path)?.slice() ?? null }
  async write(path: string, bytes: Uint8Array) { this.files.set(path, bytes.slice()) }
  async remove(path: string) { this.files.delete(path) }
  async list(root: string) {
    return [...this.files.entries()]
      .filter(([path]) => path === root || path.startsWith(`${root}/`))
      .map(([path, bytes]) => ({ path, bytes: bytes.length }))
  }
  async move(from: string, to: string) {
    const bytes = this.files.get(from)
    if (!bytes) throw new Error(`Missing temporary file: ${from}`)
    this.files.set(to, bytes)
    this.files.delete(from)
  }
}

class MemoryKeys implements VaultKeyProvider {
  readonly values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
  async remove(key: string) { this.values.delete(key) }
}

class MemoryPersistence implements VaultCapPersistence {
  readonly values = new Map<string, string>()
  async get(key: string) { return this.values.get(key) ?? null }
  async set(key: string, value: string) { this.values.set(key, value) }
}

const makeVault = () => new EncryptedVault({
  storage: new MemoryStorage(),
  keys: new MemoryKeys(),
  crypto: { ...webCryptoProvider, randomBytes: (length) => new Uint8Array(length).fill(7) },
})

const makeStore = (vault: EncryptedVault) => new EncryptedOfflineGalleryStore({
  vault,
  fetchImage: async () => new Response(new TextEncoder().encode('pixels'), { headers: { 'content-type': 'image/jpeg' } }),
})

const makeController = (options: {
  tier?: () => NativeTier | undefined
  persistence?: MemoryPersistence
  vault?: EncryptedVault
} = {}) => {
  const vault = options.vault ?? makeVault()
  const store = makeStore(vault)
  const persistence = options.persistence ?? new MemoryPersistence()
  const controller = createVaultSettingsController({
    vault,
    store,
    tier: options.tier ?? (() => 'free'),
    persistence,
  })
  return { controller, vault, store, persistence }
}

const manifest: GalleryManifest = {
  slug: 'quiet-light',
  title: 'Quiet light',
  caption: 'A cached gallery',
  date: '2026-09-24',
  images: [
    {
      id: 'stable-one', filename: 'one.jpg', src: 'https://provider.test/one.jpg',
      width: 2400, height: 1600, alt: 'one', c2pa: false, placeholder: 'data:image/svg+xml,one',
    } satisfies GalleryImage,
  ],
}

describe('vault cap policy', () => {
  test('defaults to the 256 MiB Free ceiling with no stored preference', () => {
    expect(resolveVaultCap('free', undefined)).toBe(FREE_VAULT_CAP_BYTES)
    expect(resolveVaultCap('pro', undefined)).toBe(FREE_VAULT_CAP_BYTES)
    expect(resolveVaultCap(undefined, undefined)).toBe(FREE_VAULT_CAP_BYTES)
  })

  test('clamps stored caps to the Free ceiling and leaves Pro untouched', () => {
    expect(resolveVaultCap('free', 128 * 1024 * 1024)).toBe(128 * 1024 * 1024)
    expect(resolveVaultCap('free', 1024 * 1024 * 1024)).toBe(FREE_VAULT_CAP_BYTES)
    expect(resolveVaultCap('pro', 1024 * 1024 * 1024)).toBe(1024 * 1024 * 1024)
    expect(resolveVaultCap('pro', null)).toBeNull()
    // Unlimited stored under Pro collapses to the Free ceiling on downgrade;
    // the stored choice itself is untouched, so re-upgrade restores it.
    expect(resolveVaultCap('free', null)).toBe(FREE_VAULT_CAP_BYTES)
    expect(resolveVaultCap(undefined, 1024 * 1024 * 1024)).toBe(FREE_VAULT_CAP_BYTES)
  })

  test('rejects over-ceiling choices for non-Pro callers', () => {
    expect(() => assertCapAllowed('free', FREE_VAULT_CAP_BYTES)).not.toThrow()
    expect(() => assertCapAllowed('free', null)).toThrow('requires manorama Pro')
    expect(() => assertCapAllowed('free', FREE_VAULT_CAP_BYTES + 1)).toThrow('requires manorama Pro')
    expect(() => assertCapAllowed(undefined, FREE_VAULT_CAP_BYTES + 1)).toThrow('requires manorama Pro')
    expect(() => assertCapAllowed('pro', null)).not.toThrow()
    expect(() => assertCapAllowed('pro', 8 * 1024 * 1024 * 1024)).not.toThrow()
  })

  test('persists and validates the stored preference', async () => {
    const persistence = new MemoryPersistence()
    expect(await loadVaultCapPreference(persistence)).toBeUndefined()

    await saveVaultCapPreference(64 * 1024 * 1024, persistence)
    expect(await loadVaultCapPreference(persistence)).toBe(64 * 1024 * 1024)

    await saveVaultCapPreference(null, persistence)
    expect(persistence.values.get(VAULT_CAP_PREFERENCE_KEY)).toBe('unlimited')
    expect(await loadVaultCapPreference(persistence)).toBeNull()

    persistence.values.set(VAULT_CAP_PREFERENCE_KEY, 'not-a-number')
    expect(await loadVaultCapPreference(persistence)).toBeUndefined()
    persistence.values.set(VAULT_CAP_PREFERENCE_KEY, '-5')
    expect(await loadVaultCapPreference(persistence)).toBeUndefined()
  })
})

describe('vault settings controller', () => {
  test('snapshot applies the resolved cap and reports the vault cap in force', async () => {
    const { controller, vault, store, persistence } = makeController({ tier: () => 'pro' })
    await saveVaultCapPreference(512 * 1024 * 1024, persistence)
    await store.cache({ owner: 'photographer', slug: 'quiet-light' }, {
      manifest,
      settings: defaultGallerySettings(manifest),
    })

    const snapshot = await controller.snapshot()
    expect(snapshot.cap).toBe(512 * 1024 * 1024)
    expect(snapshot.preference).toBe(512 * 1024 * 1024)
    expect(snapshot.galleries).toHaveLength(1)
    expect(snapshot.usage.measuredBytes).toBeGreaterThan(0)
    // The stored Pro cap is applied on read: writes after this point evict
    // under 512 MiB, not the stale default.
    expect(vault.cap).toBe(512 * 1024 * 1024)
  })

  test('a later snapshot re-applies the cap when the entitlement changes', async () => {
    let tier: NativeTier | undefined = 'pro'
    const { controller, vault, persistence } = makeController({ tier: () => tier })
    await saveVaultCapPreference(512 * 1024 * 1024, persistence)
    await controller.snapshot()
    expect(vault.cap).toBe(512 * 1024 * 1024)

    // Downgrade to free: the next read narrows the applied cap to the Free
    // ceiling without evicting existing copies.
    tier = 'free'
    const snapshot = await controller.snapshot()
    expect(snapshot.cap).toBe(FREE_VAULT_CAP_BYTES)
    expect(vault.cap).toBe(FREE_VAULT_CAP_BYTES)
  })

  test('selectCap persists the choice, applies it and evicts immediately', async () => {
    const { controller, vault, persistence } = makeController()
    const big = new TextEncoder().encode('x'.repeat(64))
    await vault.write('gallery-a', 'one', big)
    await vault.write('gallery-a', 'two', big)

    const before = (await vault.usage()).indexedBytes
    const result = await controller.selectCap(before - 1)

    expect(result.evictedBytes).toBeGreaterThan(0)
    expect((await vault.usage()).indexedBytes).toBeLessThanOrEqual(before - 1)
    expect(await loadVaultCapPreference(persistence)).toBe(before - 1)
    expect(vault.cap).toBe(before - 1)
  })

  test('selectCap refuses a Pro-only cap while Free without persisting it', async () => {
    const { controller, vault, persistence } = makeController({ tier: () => 'free' })

    await expect(controller.selectCap(null)).rejects.toThrow('requires manorama Pro')
    expect(persistence.values.has(VAULT_CAP_PREFERENCE_KEY)).toBe(false)
    expect(vault.cap).toBe(FREE_VAULT_CAP_BYTES)
  })

  test('purgeGallery and forgetEverything delegate to the store boundary', async () => {
    const { controller, store } = makeController()
    const selection = { owner: 'photographer', slug: 'quiet-light' }
    await store.cache(selection, { manifest, settings: defaultGallerySettings(manifest) })
    const [summary] = await store.listGalleries()
    expect(summary?.status).toBe('cached')

    await controller.purgeGallery(summary!.galleryId)
    expect(await store.listGalleries()).toEqual([])

    await store.cache(selection, { manifest, settings: defaultGallerySettings(manifest) })
    await controller.forgetEverything()
    expect(await store.listGalleries()).toEqual([])
  })

  test('applyVaultCap narrows the cap on downgrade without evicting', async () => {
    const vault = makeVault()
    const big = new TextEncoder().encode('x'.repeat(64))
    await vault.write('gallery-a', 'one', big)
    const before = (await vault.usage()).indexedBytes

    const applied = applyVaultCap(vault, 'free', 1024 * 1024 * 1024)
    expect(applied).toBe(FREE_VAULT_CAP_BYTES)
    // Tier-driven application never evicts: the stored bytes survive until a
    // write or an explicit eviction decides otherwise.
    expect((await vault.usage()).indexedBytes).toBe(before)
  })
})
