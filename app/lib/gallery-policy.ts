export type GalleryRetention = 'retained' | 'pipeline'
export const FREE_RETAINED_LIMIT = 3
export const PAID_RETAINED_LIMIT = 99
// A Free account's 3 permanent + 96 temporary galleries total exactly the
// paid 99 — an upgrade converts the whole set to permanent in place.
export const FREE_PIPELINE_LIMIT = PAID_RETAINED_LIMIT - FREE_RETAINED_LIMIT
export const PIPELINE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const PIPELINE_LOCK_MESSAGE = 'This temporary gallery cannot be edited on the free plan. Upgrade to keep it and make changes.'
export const FREE_RETENTION_DISCLOSURE = 'Free accounts retain up to 3 permanent galleries plus 96 temporary galleries — a temporary is removed after 30 days unless you upgrade, which makes the whole set permanent.'
export class GalleryPolicyError extends Error {
  constructor(public readonly code: 'GALLERY_LIMIT' | 'GALLERY_READ_ONLY' | 'PIN_LIMIT' | 'MANIFEST_TOO_LARGE', message: string) { super(message); this.name = 'GalleryPolicyError' }
}
/** A Free owner's permanent set is full — keeping another temporary
 *  gallery means swapping one of the permanent three out, or choosing a plan. */
export const pinLimitError = () => new GalleryPolicyError('PIN_LIMIT', `All ${FREE_RETAINED_LIMIT} permanent galleries are spoken for — swap one out or upgrade to Visionary for unlimited.`)
export const paidGalleryLimitError = () => new GalleryPolicyError('GALLERY_LIMIT', 'Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.')
export const pipelineGalleryLimitError = () => new GalleryPolicyError('GALLERY_LIMIT', `Free accounts can hold up to ${FREE_PIPELINE_LIMIT} temporary galleries alongside the ${FREE_RETAINED_LIMIT} permanent ones — let one expire, remove it, or upgrade to Visionary.`)
/** Throws a typed read-only error when a pipeline gallery is edited. */
export const assertGalleryEditable = (gallery: { retention?: GalleryRetention }) => {
  if (gallery.retention === 'pipeline') throw new GalleryPolicyError('GALLERY_READ_ONLY', PIPELINE_LOCK_MESSAGE)
}
/** Reports whether a pipeline gallery has reached its expiration instant. */
export const isGalleryExpired = (gallery: { retention?: GalleryRetention; expiresAt?: string | null }, now = new Date().toISOString()) => gallery.retention === 'pipeline' && Boolean(gallery.expiresAt && gallery.expiresAt <= now)

/** The countdown every temporary-gallery surface shows in place of a bare
 *  expiry date: whole days then leftover hours ("28 days 6 hours"), falling
 *  back to "under an hour" inside the final hour or when a stale render
 *  outlives the expiry sweep. Returns null when the gallery has no expiry. */
export const expiryCountdownText = (expiresAt: string | null | undefined, now: number): string | null => {
  if (!expiresAt) return null
  const ms = Date.parse(expiresAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'under an hour'
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  const rest = hours - days * 24
  if (days === 0 && rest === 0) return 'under an hour'
  const dayPart = days === 0 ? '' : `${days} day${days === 1 ? '' : 's'}`
  const hourPart = rest === 0 ? '' : `${rest} hour${rest === 1 ? '' : 's'}`
  return [dayPart, hourPart].filter(Boolean).join(' ')
}
