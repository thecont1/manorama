export type GalleryRetention = 'retained' | 'pipeline'
export const FREE_RETAINED_LIMIT = 3
export const PAID_RETAINED_LIMIT = 99
export const PIPELINE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const PIPELINE_LOCK_MESSAGE = 'This temporary gallery cannot be edited on the free plan. Upgrade to keep it and make changes.'
export const FREE_RETENTION_DISCLOSURE = 'Free accounts retain up to 3 editable galleries. Additional galleries are temporary and are removed after 30 days unless you upgrade.'
export class GalleryPolicyError extends Error {
  constructor(public readonly code: 'GALLERY_LIMIT' | 'GALLERY_READ_ONLY', message: string) { super(message); this.name = 'GalleryPolicyError' }
}
export const paidGalleryLimitError = () => new GalleryPolicyError('GALLERY_LIMIT', 'Paid accounts can retain up to 99 galleries. Delete a gallery before adding another.')
export const assertGalleryEditable = (gallery: { retention?: GalleryRetention }) => {
  if (gallery.retention === 'pipeline') throw new GalleryPolicyError('GALLERY_READ_ONLY', PIPELINE_LOCK_MESSAGE)
}
export const isGalleryExpired = (gallery: { retention?: GalleryRetention; expiresAt?: string | null }, now = new Date().toISOString()) => gallery.retention === 'pipeline' && Boolean(gallery.expiresAt && gallery.expiresAt <= now)
