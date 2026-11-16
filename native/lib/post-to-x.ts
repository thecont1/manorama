import type { GalleryMediaItem } from '../../app/lib/imagesource'
import { isVideoItem } from '../../app/lib/imagesource'

/**
 * The "Post to X" policy.
 *
 * X stores a post's media at no more than 2048px on the LONG edge — a 2:3
 * portrait is kept at 1365×2048, a 16:9 frame at 2048×1152. The bound is
 * therefore a long-edge rule, not a box, and it is what the on-device program
 * targets so the export lands exactly on what X would have stored.
 *
 * The bytes come from the ORIGINAL, never from a provider's rendition. A
 * provider thumbnail is a BOX: Dropbox's largest, `w2048h1536`, returns a
 * portrait at 1152×1536 because the box is 4:3, and Google's `w2048` is
 * letterboxed the same way. Feeding one of those to X would post a photograph
 * smaller than X is willing to keep, and no resize may enlarge it back. The
 * original is the only source that can land on the ceiling exactly.
 */

/** X's per-post media ceiling. */
export const POST_TO_X_MAX_MEDIA = 20

/** The long edge X keeps. */
export const POST_TO_X_MAX_EDGE = 2048

/** The only format the export emits. */
export const POST_TO_X_FORMAT = 'jpeg' as const

/** What the picker and the export both talk about. */
export type PostToXPhoto = {
  id: string
  filename: string
  /** Intrinsic size the manifest reports, in source pixels. */
  width: number
  height: number
  alt: string
  /**
   * Where the original bytes are fetched from. Empty for an encrypted source:
   * those bytes never have an address, they come off the device's vault.
   */
  src: string
  /** The display rendition the picker shows. */
  preview: string
  /** True when the source is encrypted and the bytes are local. */
  encrypted: boolean
}

/**
 * The photographs a gallery can offer: the stills, in the gallery's own
 * order, which is the order they are posted in.
 *
 * Video is left out on purpose. X accepts video in the same post, but the
 * program that resizes a photograph is not the program that transcodes a
 * film, and a half-supported second format is worse than none.
 */
export const postToXPhotos = (images: readonly GalleryMediaItem[]): PostToXPhoto[] =>
  images.filter((item): item is Exclude<GalleryMediaItem, { type: 'video' }> => !isVideoItem(item)).map((item) => ({
    id: item.id,
    filename: item.filename,
    width: item.width,
    height: item.height,
    alt: item.alt,
    src: item.src,
    preview: item.variants?.[0]?.src ?? item.src,
    encrypted: item.media?.kind === 'encrypted',
  }))

/**
 * Adds or removes one photograph from the selection.
 *
 * The selection is a set of ids, not a list: the order is the gallery's, so
 * tapping photographs in any order still posts them in the sequence the
 * photographer arranged. The cap is X's, and it is silent — a twenty-first
 * tap changes nothing.
 */
export const togglePostSelection = (selected: readonly string[], id: string): readonly string[] => {
  if (selected.includes(id)) return selected.filter((each) => each !== id)
  if (selected.length >= POST_TO_X_MAX_MEDIA) return selected
  return [...selected, id]
}

/** The selected photographs, in the gallery's order. */
export const orderedSelection = (
  photos: readonly PostToXPhoto[],
  selected: readonly string[],
): PostToXPhoto[] => photos.filter((photo) => selected.includes(photo.id))

/** A filename safe for the share sheet, numbered so the order is visible. */
export const exportFileName = (index: number, filename: string): string => {
  const base = filename.replace(/\.[^.]+$/, '')
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 40) || 'photograph'
  const number = String(index + 1).padStart(2, '0')
  return `${number}-${safe}.jpg`
}

/**
 * The text handed to X: what the photographer typed, and the gallery's own
 * address so the post carries the way back to the full set.
 */
export const postToXText = (caption: string, galleryUrl: string): string => {
  const typed = caption.trim()
  return typed ? `${typed}\n${galleryUrl}` : galleryUrl
}

/** The note under the picker: what X will do with what it is given. */
export const POST_TO_X_LIMIT_NOTE = `X takes up to ${POST_TO_X_MAX_MEDIA} photographs in one post. They are resized to ${POST_TO_X_MAX_EDGE}px on the long edge, and X re-encodes them.`

/** The note shown when the selection has reached the ceiling. */
export const POST_TO_X_FULL_NOTE = `That is ${POST_TO_X_MAX_MEDIA} photographs — the most X takes in one post.`
