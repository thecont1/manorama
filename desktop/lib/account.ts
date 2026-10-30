import type { ImageVariant } from '../../app/lib/imagesource'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import { normalizeApiBase } from './session'

/**
 * The account's remote galleries as the Mac reads them. Mirrors
 * native/lib/api.ts's fetches, but takes the bearer token explicitly — the
 * desktop session lives in the private store, not in Capacitor SecureStorage.
 * Everything here is pure fetch + parse so `bun test` needs no Tauri seam.
 */

export class AccountApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AccountApiError'
  }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

const absoluteUrl = (value: string, apiBase: string): string => {
  try {
    return new URL(value, `${normalizeApiBase(apiBase)}/`).toString()
  } catch {
    return value
  }
}

const rewriteVariant = (variant: ImageVariant, apiBase: string): ImageVariant => ({
  ...variant,
  src: absoluteUrl(variant.src, apiBase),
})

/** GET {apiBase}/api/galleries — the same summaries the web dashboard and the
 *  iOS library list. Image URLs arrive server-relative, so every preview is
 *  rewritten against the API origin before it reaches an <img>. */
export const fetchAccountGalleries = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<GallerySummary[]> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries`, {
    headers: bearer(token),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { galleries?: GallerySummary[]; error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || `Gallery list request failed (${response.status})`)
  if (!Array.isArray(payload.galleries)) throw new Error('Gallery list response was incomplete')
  return payload.galleries.map((gallery) => ({
    ...gallery,
    ...(gallery.images ? { images: gallery.images.map((image) => ({
      ...image,
      src: absoluteUrl(image.src, apiBase),
      variants: image.variants?.map((variant) => rewriteVariant(variant, apiBase)),
      ...('type' in image && image.type === 'video' ? { poster: { ...image.poster, src: absoluteUrl(image.poster.src, apiBase) } } : {}),
    })) } : {}),
  }))
}

/** GET {apiBase}/api/device-galleries — the synced records every device
 *  publishes: metadata only, never paths or file lists. */
export const fetchDeviceGalleries = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<DeviceGallery[]> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/device-galleries`, {
    headers: bearer(token),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { galleries?: DeviceGallery[]; error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || `Device gallery list request failed (${response.status})`)
  if (!Array.isArray(payload.galleries)) throw new Error('Device gallery list response was incomplete')
  return payload.galleries
}

/** GET {apiBase}/api/account — the current owner slug, resolved from the
 *  account row on every call. session.json keeps the slug from sign-in, so a
 *  rename on the web leaves the stored copy (and every link built from it)
 *  dead; the fresh read keeps Open pointing at the real address. */
export const fetchAccountOwnerSlug = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account`, {
    headers: bearer(token),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { ownerSlug?: string; error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || `Account request failed (${response.status})`)
  if (typeof payload.ownerSlug !== 'string' || !payload.ownerSlug) throw new Error('Account response was incomplete')
  return payload.ownerSlug
}

/** A synced record earns its own card only while nothing else already
 *  represents it: this Mac's catalogue renders its own records as local
 *  galleries, and a folder published as a cloud gallery collapses into that
 *  gallery's card — the same dedupe the iOS library applies. */
export const standaloneDeviceGalleries = (
  deviceGalleries: readonly DeviceGallery[],
  accountGalleries: readonly GallerySummary[],
  ownDeviceId: string | undefined,
): DeviceGallery[] =>
  deviceGalleries.filter((gallery) =>
    gallery.deviceId !== ownDeviceId &&
    (!gallery.publicGallerySlug || !accountGalleries.some((published) => published.slug === gallery.publicGallerySlug)),
  )
