import type { GalleryManifest, GalleryMediaItem, ImageVariant, VideoCaptionTrack } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import { getSessionToken } from './session'

export type NativeGalleryResponse = {
  manifest: GalleryManifest
  settings: GallerySettings
}

export class NativeGalleryHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'NativeGalleryHttpError'
  }
}

export const normalizeApiBase = (value: string): string => value.replace(/\/+$/, '')

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

const rewriteItem = (item: GalleryMediaItem, apiBase: string): GalleryMediaItem => {
  const rewritten = {
    ...item,
    src: absoluteUrl(item.src, apiBase),
    variants: item.variants?.map((variant) => rewriteVariant(variant, apiBase)),
  }
  if (item.type !== 'video') return rewritten
  return {
    ...rewritten,
    poster: { ...item.poster, src: absoluteUrl(item.poster.src, apiBase) },
    sources: item.sources?.map((source) => ({ ...source, src: absoluteUrl(source.src, apiBase) })),
    captions: item.captions?.map((track: VideoCaptionTrack) => ({ ...track, src: absoluteUrl(track.src, apiBase) })),
  } as GalleryMediaItem
}

export const nativeManifest = (manifest: GalleryManifest, apiBase: string): GalleryManifest => ({
  ...manifest,
  images: manifest.images.map((item) => rewriteItem(item, apiBase)),
})

const bearerHeaders = async (): Promise<{ Authorization: string } | undefined> => {
  const token = await getSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

export const fetchGallery = async (
  apiBase: string,
  owner: string,
  slug: string,
  signal?: AbortSignal,
): Promise<NativeGalleryResponse> => {
  const response = await fetch(
    `${normalizeApiBase(apiBase)}/api/gallery/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    { headers: await bearerHeaders(), signal },
  )
  const payload = await response.json().catch(() => ({})) as Partial<NativeGalleryResponse> & { error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Gallery request failed (${response.status})`)
  if (!payload.manifest || !payload.settings) throw new Error('Gallery response was incomplete')
  return {
    manifest: nativeManifest(payload.manifest, apiBase),
    settings: payload.settings,
  }
}

/** The signed-in account's own gallery summaries — the same rows the web
 *  dashboard lists, so the phone can offer them without a typed slug. */
export const fetchAccountGalleries = async (
  apiBase: string,
  signal?: AbortSignal,
): Promise<GallerySummary[]> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/galleries`, {
    headers: await bearerHeaders(),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { galleries?: GallerySummary[]; error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Gallery list request failed (${response.status})`)
  if (!Array.isArray(payload.galleries)) throw new Error('Gallery list response was incomplete')
  return payload.galleries
}

/** The private device catalogue the Mac publishes: metadata only, no paths
 *  or file lists, so it is safe to show on a signed-in phone. */
export const fetchDeviceGalleries = async (
  apiBase: string,
  signal?: AbortSignal,
): Promise<DeviceGallery[]> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/device-galleries`, {
    headers: await bearerHeaders(),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { galleries?: DeviceGallery[]; error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Device gallery list request failed (${response.status})`)
  if (!Array.isArray(payload.galleries)) throw new Error('Device gallery list response was incomplete')
  return payload.galleries
}

/** Deletes the signed-in account and every Manorama row it owns. `confirm`
 *  must repeat the account's URL name — the same gate the web dashboard
 *  shows — so the app sends the slug it already holds rather than asking
 *  the owner to type it again. Local session state is the caller's job:
 *  this only reports that the D1 rows are gone. */
export const deleteAccount = async (apiBase: string, confirm: string): Promise<void> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/account`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(await bearerHeaders()) },
    body: JSON.stringify({ confirm }),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Account deletion failed (${response.status})`)
}

export type AccountIdentity = { provider: string; displayName?: string; email?: string }

/** The account's sign-in methods — the same list the web dashboard shows.
 *  The greeting needs only a first name, so the caller picks a displayName. */
export const fetchAccountIdentities = async (
  apiBase: string,
  signal?: AbortSignal,
): Promise<AccountIdentity[]> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/account/identities`, {
    headers: await bearerHeaders(),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { identities?: AccountIdentity[]; error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Identity list request failed (${response.status})`)
  return Array.isArray(payload.identities) ? payload.identities : []
}

/** The dashboard's custom-URL edit: PATCHes the owner slug and answers the
 *  slug the server actually stored, lowercased and normalised. */
export const renameOwnerSlug = async (apiBase: string, ownerSlug: string): Promise<string> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/account`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(await bearerHeaders()) },
    body: JSON.stringify({ ownerSlug }),
  })
  const payload = await response.json().catch(() => ({})) as { ownerSlug?: string; error?: string }
  if (!response.ok || !payload.ownerSlug) throw new NativeGalleryHttpError(response.status, payload.error || 'That URL could not be saved')
  return payload.ownerSlug
}

/** Recovers the account's URL name when secure storage lost it — the
 *  delete flow needs it as the server-side confirmation. */
export const fetchAccountOwnerSlug = async (apiBase: string): Promise<string | undefined> => {
  const response = await fetch(`${normalizeApiBase(apiBase)}/api/account`, {
    headers: await bearerHeaders(),
  })
  const payload = await response.json().catch(() => ({})) as { ownerSlug?: unknown }
  const slug = response.ok && typeof payload.ownerSlug === 'string' ? payload.ownerSlug.trim() : ''
  return slug || undefined
}
