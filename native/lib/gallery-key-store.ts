import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'
import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl } from '../../packages/core/encrypted-source'

/**
 * Native persistent custody for encrypted-source keys. The only storage is
 * the platform secure-store abstraction (Keychain on iOS, Keystore on
 * Android) via the first-party Capacitor plugin — never AsyncStorage, never
 * Preferences, never the plain filesystem. This is the native counterpart of
 * the web `WebGalleryKeyStore`, whose sessionStorage custody is correct for
 * the web because the web app is deliberately forgetful.
 *
 * The registry is a single JSON document inside the same secure store, so
 * logout/account deletion can enumerate and purge every gallery key even
 * though the keychain has no listing API. The registry holds only gallery
 * ids — never keys, never source URLs.
 */

export interface NativeKeyStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

const GALLERY_KEY_PREFIX = 'manorama.gallery-key.v1.'
const REGISTRY_KEY = 'manorama.gallery-key-registry.v1'
const GALLERY_ID_PATTERN = /^[0-9A-Za-z-]{16,64}$/

/** SecureStorage-backed adapter — the Keychain/Keystore abstraction. */
export const secureNativeKeyStorage: NativeKeyStorage = {
  async getItem(key) {
    return SecureStorage.getItem(key)
  },
  async setItem(key, value) {
    await SecureStorage.setSynchronize(false)
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
    await SecureStorage.setItem(key, value)
  },
  async removeItem(key) {
    try {
      await SecureStorage.removeItem(key)
    } catch (error) {
      // Absorb only "already absent"; a key that survives must fail loudly.
      try {
        if ((await SecureStorage.getItem(key)) === null) return
      } catch {
        /* Unverifiable: report the original failure. */
      }
      throw error
    }
  },
}

export const isGalleryIdValid = (galleryId: string): boolean => GALLERY_ID_PATTERN.test(galleryId)

const completeEncryptedSource = (sourceUrl: string): boolean => {
  try {
    const parsed = new URL(sourceUrl)
    return isEncryptedSourceUrl(sourceUrl) && Boolean(encryptedSourceFromGalleryHash(galleryHashForSource(sourceUrl))) && Boolean(parsed.hash)
  } catch {
    return false
  }
}

export class NativeGalleryKeyStore {
  constructor(private readonly storage: NativeKeyStorage = secureNativeKeyStorage) {}

  /** Registry updates are read-modify-write on one JSON document — without
   *  serialization, concurrent puts/removes/purges overwrite each other's
   *  ids. Every mutating op queues behind the last so a completed op is
   *  always fully visible to the next. */
  private registryQueue: Promise<void> = Promise.resolve()
  private enqueueRegistry<T>(op: () => Promise<T>): Promise<T> {
    const run = this.registryQueue.then(op)
    this.registryQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async readRegistry(): Promise<string[]> {
    const raw = await this.storage.getItem(REGISTRY_KEY)
    if (!raw) return []
    try {
      const value: unknown = JSON.parse(raw)
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
    } catch {
      return []
    }
  }

  private async writeRegistry(ids: string[]): Promise<void> {
    await this.storage.setItem(REGISTRY_KEY, JSON.stringify(ids))
  }

  private async register(galleryId: string): Promise<void> {
    const ids = await this.readRegistry()
    if (!ids.includes(galleryId)) await this.writeRegistry([...ids, galleryId])
  }

  private async unregister(galleryId: string): Promise<void> {
    const ids = await this.readRegistry()
    const next = ids.filter((id) => id !== galleryId)
    if (next.length !== ids.length) await this.writeRegistry(next)
  }

  /** Stores the complete keyed source URL for a gallery id. Rejects without
   * touching storage unless the id is well-formed and the URL is a complete
   * encrypted source link (keyed fragment included). */
  async put(galleryId: string, sourceUrl: string): Promise<void> {
    if (!isGalleryIdValid(galleryId)) throw new Error('Gallery id is invalid')
    if (!completeEncryptedSource(sourceUrl)) throw new Error('A complete encrypted source link is required')
    await this.enqueueRegistry(async () => {
      // Register before the key lands: an id must never exist without its
      // purge entry — the reverse could strand a written key on a failed
      // or lost registration.
      await this.register(galleryId)
      await this.storage.setItem(`${GALLERY_KEY_PREFIX}${galleryId}`, sourceUrl)
    })
  }

  /** Returns the stored keyed source URL only when it still validates as a
   * complete encrypted source link; anything else reads as absent. */
  async get(galleryId: string): Promise<string | null> {
    if (!isGalleryIdValid(galleryId)) return null
    const value = await this.storage.getItem(`${GALLERY_KEY_PREFIX}${galleryId}`)
    if (!value) return null
    if (!completeEncryptedSource(value)) {
      await this.remove(galleryId)
      return null
    }
    return value
  }

  /** Deletion must clear the key so a reused slug can never inherit it. */
  async remove(galleryId: string): Promise<void> {
    if (!isGalleryIdValid(galleryId)) return
    await this.enqueueRegistry(async () => {
      await this.storage.removeItem(`${GALLERY_KEY_PREFIX}${galleryId}`)
      if ((await this.storage.getItem(`${GALLERY_KEY_PREFIX}${galleryId}`)) !== null) {
        throw new Error(`Gallery key survived removal for ${galleryId}`)
      }
      await this.unregister(galleryId)
    })
  }

  /** Every registered gallery id currently holding a key. */
  async list(): Promise<string[]> {
    const ids = await this.readRegistry()
    const present: string[] = []
    for (const id of ids) {
      if (await this.storage.getItem(`${GALLERY_KEY_PREFIX}${id}`)) present.push(id)
    }
    return present
  }

  /** Cryptographic erasure of every persisted gallery key, for sign-out and
   * account deletion. Keys are removed one by one and each removal is
   * verified before the registry is cleared. */
  async purgeAll(): Promise<void> {
    await this.enqueueRegistry(async () => {
      const ids = await this.readRegistry()
      for (const id of ids) {
        await this.storage.removeItem(`${GALLERY_KEY_PREFIX}${id}`)
        if ((await this.storage.getItem(`${GALLERY_KEY_PREFIX}${id}`)) !== null) {
          throw new Error(`Gallery key survived purge for ${id}`)
        }
      }
      await this.storage.removeItem(REGISTRY_KEY)
    })
  }
}

let productionStore: NativeGalleryKeyStore | undefined
export const nativeGalleryKeyStore = (): NativeGalleryKeyStore => {
  if (!productionStore) productionStore = new NativeGalleryKeyStore()
  return productionStore
}
