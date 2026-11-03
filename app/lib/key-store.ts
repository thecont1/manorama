import { encryptedSourceFromGalleryHash, galleryHashForSource, isEncryptedSourceUrl } from '../../packages/core/encrypted-source'

export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type GalleryKeyExport = {
  version: 1
  warning: string
  entries: Record<string, string>
}

const PREFIX = 'manorama.gallery-key.v1.'
const PREFIX_LENGTH = PREFIX.length

/** Tab-scoped web custody. No key is written to localStorage, D1, logs, or
 * server requests; closing the tab session drops the browser's copy. */
export class WebGalleryKeyStore {
  constructor(private readonly storage: KeyStorage) {}

  async put(galleryId: string, sourceUrl: string): Promise<void> {
    if (!/^[0-9A-Za-z-]{16,64}$/.test(galleryId)) throw new Error('Gallery id is invalid')
    const parsed = new URL(sourceUrl)
    if (!isEncryptedSourceUrl(sourceUrl) || !encryptedSourceFromGalleryHash(galleryHashForSource(sourceUrl)) || !parsed.hash) {
      throw new Error('A complete encrypted source link is required')
    }
    this.storage.setItem(`${PREFIX}${galleryId}`, sourceUrl)
  }

  async get(galleryId: string): Promise<string | null> {
    const value = this.storage.getItem(`${PREFIX}${galleryId}`)
    if (!value) return null
    try {
      return encryptedSourceFromGalleryHash(galleryHashForSource(value))
    } catch {
      return null
    }
  }

  async remove(galleryId: string): Promise<void> {
    this.storage.removeItem(`${PREFIX}${galleryId}`)
  }

  async export(): Promise<GalleryKeyExport> {
    const entries: Record<string, string> = {}
    const storage = this.storage as Storage
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (!key?.startsWith(PREFIX)) continue
        const galleryId = key.slice(PREFIX_LENGTH)
        const source = await this.get(galleryId)
        if (source) entries[galleryId] = source
      }
    }
    return {
      version: 1,
      warning: 'Keep this file private. A lost key cannot be recovered by Manorama.',
      entries,
    }
  }
}

let fallback: WebGalleryKeyStore | undefined
export const webGalleryKeyStore = (): WebGalleryKeyStore => {
  if (typeof sessionStorage !== 'undefined') return new WebGalleryKeyStore(sessionStorage)
  if (!fallback) {
    const values = new Map<string, string>()
    fallback = new WebGalleryKeyStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value) },
      removeItem: (key) => { values.delete(key) },
    })
  }
  return fallback
}
