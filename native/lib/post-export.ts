import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { isShareCancellation } from '../../app/lib/gallery-share'
import {
  browserImageProgramRuntime,
  fitJpegPayload,
  runImageProgram,
  type ImageProgramRuntime,
} from './image-program'
import { exportFileName, photoMimeType, POST_TO_X_MAX_EDGE, type PostToXPhoto } from './post-to-x'

/**
 * The export.
 *
 * The photographs are prepared on the device, written to a private cache
 * folder, and handed to the operating system's share sheet as files. X is
 * then one target among the ones the phone already offers — which is what
 * makes this cost nothing: there is no X account, no API key, and no charge
 * per post.
 *
 * The files exist only for the share. The OS share sheet needs a real file on
 * disk, so there is a window in which the photographs are plain bytes in the
 * app's cache; the folder is removed as soon as the sheet closes, and it is
 * never the vault, never the Library, and never a saved copy.
 */

export type PostExportOutcome = 'shared' | 'cancelled' | 'failed'

export type PostExportReport = {
  outcome: PostExportOutcome
  /** How many photographs went into the post. */
  posted: number
  /** How many could not be prepared and were left out. */
  skipped: number
  /** What to tell the photographer. Empty when there is nothing to say. */
  note: string
}

export type PostPhotoBytes = { bytes: Uint8Array; mimeType: string }

/** Reads the bytes of one photograph. */
export type PostPhotoReader = (photo: PostToXPhoto) => Promise<PostPhotoBytes | undefined>

/**
 * The device's own copies of a gallery's photographs.
 *
 * An encrypted source has no addresses: its bytes live in the device's vault,
 * keyed by the gallery's own identity. Nothing here reaches the network.
 */
export type PostSavedPhotos = {
  /** The device's vault identity for the gallery. */
  galleryId: string
  /** The vault entry that holds one photograph's own bytes. */
  entryIdFor: (photoId: string) => string
  /** The decrypted bytes the device holds for that entry. */
  read: (entryId: string) => Promise<Uint8Array | undefined>
}

/**
 * Reads a photograph's original bytes for the post.
 *
 * A cloud photograph is fetched from the provider's own address. A photograph
 * from an encrypted source has no address at all, so its bytes come from this
 * device: the saved copy first — local, and it works with no network and no
 * key — and a live decryption only when the device holds no copy of it.
 */
export const postPhotoReader = (options: {
  /** Fetches a cloud photograph from the provider's address. */
  fetch?: (photo: PostToXPhoto) => Promise<PostPhotoBytes | undefined>
  /** This device's own copies, when the gallery has any. */
  saved?: PostSavedPhotos
  /** Decrypts one photograph from an encrypted source. */
  materialize?: (photo: PostToXPhoto) => Promise<PostPhotoBytes | undefined>
}): PostPhotoReader => async (photo) => {
  if (photo.encrypted) {
    const saved = await options.saved?.read(options.saved.entryIdFor(photo.id)).catch(() => undefined)
    if (saved && saved.length > 0) return { bytes: saved, mimeType: photoMimeType(photo) }
    if (!options.materialize) return undefined
    return options.materialize(photo).catch(() => undefined)
  }
  if (!photo.src) return undefined
  if (!options.fetch) return undefined
  return options.fetch(photo).catch(() => undefined)
}

/** The share sheet the prepared files are handed to. */
export interface PostShareSheet {
  share(options: { title?: string; text?: string; url?: string; files?: string[]; dialogTitle?: string }): Promise<unknown>
}

/** Where the prepared photographs are written, and where they are taken from. */
export interface PostFileStore {
  /** Writes the file and answers the address the share sheet can read. */
  write(path: string, base64: string): Promise<string>
  /** Removes the folder the export wrote into. */
  remove(path: string): Promise<void>
}

/** Base64 for the file store. Chunked, so a large photograph does not blow
 *  the argument limit of String.fromCharCode. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export const capacitorShareSheet: PostShareSheet = {
  share: (options) => Share.share(options),
}

export const capacitorFileStore: PostFileStore = {
  write: async (path, base64) => {
    const folder = path.split('/')[0]
    await Filesystem.mkdir({ path: folder, directory: Directory.Cache, recursive: true })
    const result = await Filesystem.writeFile({ path, data: base64, directory: Directory.Cache })
    return result.uri
  },
  remove: async (path) => {
    await Filesystem.rmdir({ path, directory: Directory.Cache })
  },
}

export type PostExportOptions = {
  /** The photographs to post, already in the order they are posted in. */
  photos: readonly PostToXPhoto[]
  /** The text the photographer typed, with the gallery's address. */
  text: string
  /** The gallery's title — the share sheet's subject. */
  title: string
  /** The gallery's address, offered to the target. */
  url: string
  read: PostPhotoReader
  runtime?: ImageProgramRuntime
  sheet?: PostShareSheet
  store?: PostFileStore
}

/**
 * Prepares the photographs and hands them to the share sheet.
 *
 * A photograph that cannot be prepared — an unreadable file, a format the
 * device cannot decode — is left out and counted, rather than failing the
 * whole post or, worse, being sent at the wrong size.
 */
export const exportPhotosForShare = async (options: PostExportOptions): Promise<PostExportReport> => {
  const runtime = options.runtime ?? browserImageProgramRuntime
  const sheet = options.sheet ?? capacitorShareSheet
  const store = options.store ?? capacitorFileStore
  const folder = `post-to-x-${Date.now().toString(36)}`

  const prepared: string[] = []
  let skipped = 0
  try {
    for (const [index, photo] of options.photos.entries()) {
      let source: PostPhotoBytes | undefined
      try {
        source = await options.read(photo)
      } catch {
        source = undefined
      }
      if (!source || source.bytes.length === 0) {
        skipped += 1
        continue
      }
      let output
      try {
        output = await runImageProgram(
          fitJpegPayload(POST_TO_X_MAX_EDGE),
          { bytes: source.bytes, mimeType: source.mimeType, width: photo.width, height: photo.height },
          runtime,
        )
      } catch {
        skipped += 1
        continue
      }
      const uri = await store.write(`${folder}/${exportFileName(index, photo.filename)}`, toBase64(output.bytes))
      prepared.push(uri)
    }

    if (prepared.length === 0) {
      return {
        outcome: 'failed',
        posted: 0,
        skipped,
        note: 'Those photographs could not be prepared for sharing.',
      }
    }

    try {
      await sheet.share({
        title: options.title,
        text: options.text,
        url: options.url,
        files: prepared,
        dialogTitle: 'Post to X',
      })
    } catch (reason) {
      if (isShareCancellation(reason)) {
        return { outcome: 'cancelled', posted: 0, skipped, note: '' }
      }
      return { outcome: 'failed', posted: 0, skipped, note: 'The share sheet could not be opened.' }
    }

    return {
      outcome: 'shared',
      posted: prepared.length,
      skipped,
      note: skipped > 0
        ? `${prepared.length} photographs are ready to post. ${skipped} could not be prepared.`
        : `${prepared.length} photographs are ready to post.`,
    }
  } finally {
    // The photographs were never a saved copy: they exist only for the share.
    await store.remove(folder).catch(() => undefined)
  }
}
