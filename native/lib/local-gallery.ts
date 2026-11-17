import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import {
  deserializeLocalCatalogue,
  newCatalogue,
  serializeLocalCatalogue,
  visibleItemsFor,
  type LocalCatalogue,
  type LocalGalleryRecord,
} from '../../desktop/lib/catalogue'
import {
  DESKTOP_IMAGE_EXTENSIONS,
  galleryTitleForRoot,
  toGalleryMediaItem,
  type LocalGalleryItem,
} from '../../desktop/lib/local-scan'
import { removeDeviceGallery, syncDeviceGalleries } from '../../desktop/lib/sync'
import { MAX_GALLERY_TITLE_LENGTH } from '../../packages/core/device-gallery'
import { MAX_GALLERY_ITEMS, type GalleryManifest } from '../../packages/core/imagesource'
import { nativeDeviceId } from './device-identity'
import { nativeDeviceLabel } from './device-label'
import { getSessionToken } from './session'

/**
 * Local galleries on the phone: a picked folder's photographs are copied
 * into the app container (bytes verbatim — never re-encoded, invariant 2)
 * and catalogued exactly like the desktop model. The record's paths are
 * device-only by contract; the sync payload is `deviceGalleryInput`'s
 * shape — title, kind, count, deviceId — so no filename or path can leak.
 */

export type LocalFolderImportResult = {
  cancelled?: boolean
  galleryId?: string
  title?: string
  rootPath?: string
  sourceKind?: 'folder' | 'card'
  items?: Array<{ id: string; name: string; path: string; width?: number; height?: number }>
  truncated?: number
}

/** The plugin seam — the Swift side owns the picker and the copy; tests
 *  inject a stub. */
export type LocalGalleryBridge = {
  importFolder(options: { extensions: string[]; maxItems: number }): Promise<LocalFolderImportResult>
  removeGallery(options: { path: string }): Promise<void>
  exists(options: { path: string }): Promise<{ exists: boolean }>
}

export type LocalCatalogueStore = {
  load(): Promise<string | null>
  save(contents: string): Promise<void>
}

const CATALOGUE_FILE = 'local-catalogue.json'

const filesystemStore: LocalCatalogueStore = {
  async load() {
    const read = await Filesystem.readFile({ path: CATALOGUE_FILE, directory: Directory.Data, encoding: Encoding.UTF8 })
    const data = read.data
    return typeof data === 'string' ? data : await data.text()
  },
  async save(contents) {
    await Filesystem.writeFile({ path: CATALOGUE_FILE, directory: Directory.Data, encoding: Encoding.UTF8, recursive: true, data: contents })
  },
}

/** The shared extension list — the same formats the first desktop build
 *  displays; passed into the plugin so the filter's source of truth stays
 *  here, not duplicated in Swift. */
const pickExtensions = [...DESKTOP_IMAGE_EXTENSIONS]

const productionBridge = (): LocalGalleryBridge => registerPlugin<LocalGalleryBridge>('LocalGallery')

/** Loads the persisted catalogue, or a fresh one stamped with this phone's
 *  device id — the same id `registerDevice` publishes, so synced rows map
 *  onto the right pill. A corrupt file degrades to empty rather than
 *  breaking the Library. */
export const loadLocalCatalogue = async (store: LocalCatalogueStore = filesystemStore): Promise<LocalCatalogue> => {
  const stored = await store.load().catch(() => null)
  const parsed = deserializeLocalCatalogue(stored)
  if (parsed) return parsed
  return newCatalogue(await nativeDeviceId(), nativeDeviceLabel())
}

export const saveLocalCatalogue = async (catalogue: LocalCatalogue, store: LocalCatalogueStore = filesystemStore): Promise<void> => {
  await store.save(serializeLocalCatalogue(catalogue))
}

export type LocalGalleryAdd =
  | { kind: 'added'; record: LocalGalleryRecord }
  | { kind: 'cancelled' }
  | { kind: 'empty' }

/** Pick → copy → catalogue → sync. The catalogue write lands even when the
 *  sync fails — the mirror is best-effort like the desktop's; the next sync
 *  window reconciles. */
export const addLocalGallery = async (
  apiBase: string,
  deps: {
    bridge?: LocalGalleryBridge
    store?: LocalCatalogueStore
    fetcher?: typeof fetch
  } = {},
): Promise<LocalGalleryAdd> => {
  const bridge = deps.bridge ?? productionBridge()
  const store = deps.store ?? filesystemStore
  const imported = await bridge.importFolder({ extensions: pickExtensions, maxItems: MAX_GALLERY_ITEMS })
  if (imported.cancelled || !imported.galleryId || !imported.rootPath || !imported.title) return { kind: 'cancelled' }
  const items = (imported.items ?? []).map((item): LocalGalleryItem => ({
    id: item.id,
    name: item.name,
    path: item.path,
    ...(item.width && item.width > 0 ? { width: item.width } : {}),
    ...(item.height && item.height > 0 ? { height: item.height } : {}),
  }))
  if (!items.length) return { kind: 'empty' }

  const now = new Date().toISOString()
  const record: LocalGalleryRecord = {
    id: imported.galleryId,
    title: imported.title.trim().slice(0, MAX_GALLERY_TITLE_LENGTH).trim() || galleryTitleForRoot(imported.rootPath),
    rootPath: imported.rootPath,
    sourceKind: imported.sourceKind ?? 'folder',
    itemCount: imported.truncated ?? items.length,
    items,
    addedAt: now,
    lastSeenAt: now,
  }

  const catalogue = await loadLocalCatalogue(store)
  catalogue.galleries = [...catalogue.galleries.filter((gallery) => gallery.id !== record.id), record]
  await saveLocalCatalogue(catalogue, store)

  const token = await getSessionToken()
  if (token) {
    await syncDeviceGalleries(apiBase, token, { ...catalogue, galleries: [record] }, deps.fetcher).catch(() => {})
  }
  return { kind: 'added', record }
}

/** Removes the copied originals, the catalogue record, and — best-effort —
 *  the synced mirror row. The local record is final either way; the mirror
 *  reconciles on the next sync. */
export const removeLocalGallery = async (
  apiBase: string,
  record: LocalGalleryRecord,
  deps: {
    bridge?: LocalGalleryBridge
    store?: LocalCatalogueStore
    fetcher?: typeof fetch
  } = {},
): Promise<void> => {
  const bridge = deps.bridge ?? productionBridge()
  const store = deps.store ?? filesystemStore
  await bridge.removeGallery({ path: record.rootPath }).catch(() => {})
  const catalogue = await loadLocalCatalogue(store)
  catalogue.galleries = catalogue.galleries.filter((gallery) => gallery.id !== record.id)
  await saveLocalCatalogue(catalogue, store)
  const token = await getSessionToken()
  if (token) await removeDeviceGallery(apiBase, token, record, deps.fetcher).catch(() => {})
}

/** The manifest the shared Viewer consumes — originals addressed through
 *  the app's file scheme so bytes never leave the device. */
export const localGalleryManifest = (record: LocalGalleryRecord): GalleryManifest => ({
  slug: record.id,
  title: record.title,
  caption: '',
  date: '',
  images: visibleItemsFor(record).map((item) => toGalleryMediaItem(item, (path) => Capacitor.convertFileSrc(path))),
})
