import {
  exportFileName,
  photoMimeType,
  postToXText,
  POST_TO_X_MAX_EDGE,
  type PostToXPhoto,
} from '../../native/lib/post-to-x'
import {
  browserImageProgramRuntime,
  fitJpegPayload,
  runImageProgram,
  type ImageProgramRuntime,
} from '../../native/lib/image-program'
import { visibleItemsFor, type LocalGalleryRecord } from './catalogue'

/**
 * The desktop's half of "Post to X".
 *
 * The policy — which photographs can post, what the post text reads, the
 * 2048px long-edge ceiling X keeps — is the shared `native/lib/post-to-x`,
 * and the JPEG program is the shared `native/lib/image-program`. What is
 * different here is the hand-off: there is no phone share sheet, so the
 * prepared files go to the shell in one `share_post` call, which stages
 * them for the OS (clipboard + the X composer) instead of an activity
 * picker. `post-export.ts` itself is not reused because it imports the
 * Capacitor plugins at module scope, and this bundle never ships them.
 */

export type { PostToXPhoto }

/** One prepared photograph, base64 so the shell channel can carry it. */
export type PostShareFile = { name: string; data: string }

/**
 * The shell-side hand-off: the prepared photographs and the post text.
 * Implemented by the native shell (pasteboard + X composer) and by the
 * Tauri backend (a staged folder + the composer); a shell that does not
 * answer `share_post` rejects, which the export reports as 'failed'.
 */
export type PostShareBridge = (
  files: readonly PostShareFile[],
  text: string,
  url: string,
  title: string,
) => Promise<string | void>

export type PostExportOutcome = 'shared' | 'cancelled' | 'failed'

export type PostExportReport = {
  outcome: PostExportOutcome
  posted: number
  skipped: number
  note: string
}

export type PostPhotoBytes = { bytes: Uint8Array; mimeType: string }

/** Reads the bytes of one photograph — the provider's original for a cloud
 *  photograph, the on-disk file for a local one, a decrypted original for
 *  an encrypted source. */
export type PostPhotoReader = (photo: PostToXPhoto) => Promise<PostPhotoBytes | undefined>

/** Base64 for the share call. Chunked, so a large photograph does not blow
 *  the argument limit of String.fromCharCode. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

/**
 * A local gallery's postable photographs, straight from the catalogue
 * record — the files are already on this Mac, so a Local gallery posts
 * even when it has never been published. Concealed items stay concealed;
 * the post carries the visible set only.
 */
export const localPostPhotos = (
  record: LocalGalleryRecord,
  previewFor: (path: string) => string,
): PostToXPhoto[] =>
  visibleItemsFor(record).map((item) => ({
    id: item.id,
    filename: item.name,
    width: item.width ?? 0,
    height: item.height ?? 0,
    alt: item.name,
    src: item.path,
    preview: previewFor(item.path),
    encrypted: false,
  }))

/** The reader for a local photograph: the file itself, inside the picked
 *  root's grant — the same read the publish flow already performs. */
export const localPhotoReader = (readFile: (path: string) => Promise<Uint8Array>): PostPhotoReader =>
  async (photo) => {
    if (!photo.src) return undefined
    try {
      const bytes = await readFile(photo.src)
      if (bytes.length === 0) return undefined
      return { bytes, mimeType: photoMimeType(photo) }
    } catch {
      return undefined
    }
  }

/** The reader for a cloud photograph: the provider's original, fetched with
 *  the session's bearer — the same delivery the viewer uses. A photograph
 *  with no address (an encrypted source's) is skipped unless the caller
 *  wraps this with a `materialize`. */
export const cloudPhotoReader = (base: string, token?: string): PostPhotoReader =>
  async (photo) => {
    if (photo.encrypted || !photo.src) return undefined
    try {
      const src = new URL(photo.src, base)
      // The session bearer belongs to our own API: a photograph whose
      // address resolves anywhere else is fetched without credentials,
      // never with the owner's token across origins.
      const authorized = src.origin === new URL(base).origin ? token : undefined
      const response = await fetch(src.href, authorized ? { headers: { Authorization: `Bearer ${authorized}` } } : undefined)
      if (!response.ok) return undefined
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length === 0) return undefined
      return {
        bytes,
        mimeType: response.headers.get('Content-Type')?.split(';')[0] ?? photoMimeType(photo),
      }
    } catch {
      return undefined
    }
  }

/** Wraps a base reader with an encrypted-source fallback: photographs with
 *  no address are decrypted on this device instead of skipped. */
export const withEncryptedMaterialize = (
  base: PostPhotoReader,
  materialize?: PostPhotoReader,
): PostPhotoReader =>
  async (photo) => {
    if (photo.encrypted && materialize) return materialize(photo).catch(() => undefined)
    return base(photo)
  }

export type PostExportOptions = {
  /** The photographs to post, already in the order they are posted in. */
  photos: readonly PostToXPhoto[]
  /** The text the photographer typed; the gallery's address is appended. */
  caption: string
  title: string
  /** The gallery's own address — empty for a local gallery not yet published. */
  url: string
  read: PostPhotoReader
  share: PostShareBridge
  runtime?: ImageProgramRuntime
}

/**
 * Prepares the photographs and hands them to the shell in one call.
 *
 * The files exist only for the post — the shell stages them where the OS
 * can reach them, and they are never a saved copy. A photograph that
 * cannot be prepared is left out and counted rather than failing the
 * whole post.
 */
export const exportPostToX = async (options: PostExportOptions): Promise<PostExportReport> => {
  const runtime = options.runtime ?? browserImageProgramRuntime

  const files: PostShareFile[] = []
  let skipped = 0
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
        // The catalogue's dimensions are deliberately not supplied — they
        // are metadata, not measurement. The program decodes the bytes and
        // decides the pass-through on what the photograph actually is.
        { bytes: source.bytes, mimeType: source.mimeType },
        runtime,
      )
    } catch {
      skipped += 1
      continue
    }
    files.push({ name: exportFileName(index, photo.filename), data: toBase64(output.bytes) })
  }

  if (files.length === 0) {
    return {
      outcome: 'failed',
      posted: 0,
      skipped,
      note: 'Those photographs could not be prepared for sharing.',
    }
  }

  let tail: string | void
  try {
    tail = await options.share(files, postToXText(options.caption, options.url), options.url, options.title)
  } catch {
    return { outcome: 'failed', posted: 0, skipped, note: 'The photographs could not be handed to the system.' }
  }

  return {
    outcome: 'shared',
    posted: files.length,
    skipped,
    note: typeof tail === 'string' && tail ? tail : (skipped > 0
      ? `${files.length} photographs are ready to post. ${skipped} could not be prepared.`
      : `${files.length} photographs are ready to post.`),
  }
}
