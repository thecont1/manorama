import type { GalleryManifest, ImageVariant } from '../../app/lib/imagesource'
import type { GallerySummary } from '../../app/lib/gallery-repository'
import { defaultGallerySettings, type GallerySettings } from '../../app/lib/gallery-settings'
import type { DeviceGallery } from '../../packages/core/device-gallery'
import { normalizeApiBase } from './session'
import type { AuthProvider } from '../../app/lib/identity-repository'

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

/** GET {apiBase}/api/gallery/{owner}/{slug} — the public manifest the
 *  gallery route serves to every viewer, fetched so a cloud gallery can
 *  open inside the app's own Viewer instead of the system browser. Item
 *  URLs arrive server-relative and are rewritten like the list's previews.
 *  The bearer is optional: the route is public, but a session lets the
 *  owner's own delivery capabilities through unchanged. */
export const fetchAccountGallery = async (
  apiBase: string,
  ownerSlug: string,
  slug: string,
  token?: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ manifest: GalleryManifest; settings: GallerySettings }> => {
  const response = await fetcher(
    `${normalizeApiBase(apiBase)}/api/gallery/${encodeURIComponent(ownerSlug)}/${encodeURIComponent(slug)}`,
    { headers: token ? bearer(token) : undefined, signal },
  )
  const payload = await response.json().catch(() => ({})) as {
    manifest?: GalleryManifest
    settings?: GallerySettings
    error?: string
  }
  if (!response.ok || !payload.manifest) {
    throw new AccountApiError(response.status, payload.error || `Gallery request failed (${response.status})`)
  }
  const manifest = {
    ...payload.manifest,
    images: payload.manifest.images.map((image) => ({
      ...image,
      src: absoluteUrl(image.src, apiBase),
      variants: image.variants?.map((variant) => rewriteVariant(variant, apiBase)),
      ...('type' in image && image.type === 'video' && image.poster
        ? { poster: { ...image.poster, src: absoluteUrl(image.poster.src, apiBase) } }
        : {}),
    })),
  }
  return { manifest, settings: payload.settings ?? defaultGallerySettings(manifest) }
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

/** The account fields the app refreshes on every sync tick. `tier` is
 *  optional in the wire shape — an older server only ever sent the slug —
 *  so callers apply it only when present. */
export type AccountProfile = { ownerSlug: string; tier?: 'free' | 'pro' }

/** GET {apiBase}/api/account — the current owner slug and tier, resolved
 *  from the account row on every call. session.json keeps both from
 *  sign-in, so a rename or a downgrade on the web leaves the stored copy
 *  dead; the fresh read keeps Open pointing at the real address and keeps
 *  Visionary features honest. */
export const fetchAccountProfile = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AccountProfile> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account`, {
    headers: bearer(token),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { ownerSlug?: string; tier?: unknown; error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || `Account request failed (${response.status})`)
  if (typeof payload.ownerSlug !== 'string' || !payload.ownerSlug) throw new Error('Account response was incomplete')
  return {
    ownerSlug: payload.ownerSlug,
    ...(payload.tier === 'free' || payload.tier === 'pro' ? { tier: payload.tier } : {}),
  }
}

/** POST {apiBase}/api/galleries/scan — the same dry run the web dashboard
 *  uses to check a shared link before creating anything. The HTTP status and
 *  payload both pass through so the caller can tell "provider refused the
 *  link" apart from "the network did". */
export const scanGalleryLink = async (
  apiBase: string,
  token: string,
  url: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ status: number; scan?: { title?: string }; error?: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries/scan`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { scan?: { title?: string }; error?: string }
  return { status: response.status, ...payload }
}

/** POST {apiBase}/api/galleries — the create the web dashboard submits after
 *  a clean scan (or a client-side encrypted listing). A 409 "already exists"
 *  still carries the gallery — a successful reopen, not a failure. */
export const createAccountGallery = async (
  apiBase: string,
  token: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; gallery?: GallerySummary; error?: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries`, {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as { gallery?: GallerySummary; error?: string }
  return { status: response.status, ...payload }
}

/** GET {apiBase}/api/account/identities — the account's sign-in methods,
 *  the same list the web Settings surfaces. Provider subjects never cross
 *  the wire, only what the UI shows. */
export const fetchAccountIdentities = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ provider: AuthProvider; displayName?: string; email?: string }[]> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account/identities`, {
    headers: bearer(token),
    signal,
  })
  const payload = await response.json().catch(() => ({})) as { identities?: { provider: AuthProvider; displayName?: string; email?: string }[]; error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || `Sign-in methods request failed (${response.status})`)
  return payload.identities ?? []
}

/** POST {apiBase}/api/account/link-handoff — mints the one-minute token a
 *  cookieless browser needs to open `/auth/{provider}?link={token}`. The
 *  system browser holds no manorama session, so the link intent binds to
 *  this account through the token instead of a cookie. */
export const mintLinkHandoff = async (
  apiBase: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account/link-handoff`, {
    method: 'POST',
    headers: bearer(token),
  })
  const payload = await response.json().catch(() => ({})) as { linkToken?: string; error?: string }
  if (!response.ok || !payload.linkToken) throw new AccountApiError(response.status, payload.error || 'That sign-in method could not be connected.')
  return payload.linkToken
}

/** DELETE {apiBase}/api/account/identities/{provider} — status and payload
 *  pass through so a 'last-identity' refusal reads as policy, not failure. */
export const unlinkAccountIdentity = async (
  apiBase: string,
  token: string,
  provider: AuthProvider,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; error?: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account/identities/${provider}`, {
    method: 'DELETE',
    headers: bearer(token),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  return { status: response.status, ...payload }
}

/** PATCH {apiBase}/api/account — rename the owner's public URL slug, the
 *  same call the web Settings' address field makes. */
export const patchAccountOwnerSlug = async (
  apiBase: string,
  token: string,
  ownerSlug: string,
  fetcher: typeof fetch = fetch,
): Promise<{ ownerSlug: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account`, {
    method: 'PATCH',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerSlug }),
  })
  const payload = await response.json().catch(() => ({})) as { ownerSlug?: string; error?: string }
  if (!response.ok || !payload.ownerSlug) throw new AccountApiError(response.status, payload.error || 'That URL could not be saved')
  return { ownerSlug: payload.ownerSlug }
}

/** DELETE {apiBase}/api/account — the typed-confirm close. Status and
 *  payload pass through like the unlink helper. */
export const deleteAccount = async (
  apiBase: string,
  token: string,
  confirm: string,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number; error?: string }> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/account`, {
    method: 'DELETE',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm }),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  return { status: response.status, ...payload }
}

/** PATCH {apiBase}/api/galleries/{slug}/pin — the same pin toggle the web
 *  card menu sends; pin limits arrive as typed errors, not refusals. */
export const setAccountGalleryPin = async (
  apiBase: string,
  token: string,
  slug: string,
  pinned: boolean,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries/${encodeURIComponent(slug)}/pin`, {
    method: 'PATCH',
    headers: { ...bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || 'That gallery could not be pinned')
}

/** POST {apiBase}/api/galleries/{slug}/refresh — the rescan the web card
 *  menu runs. The init comes from refreshRequestInit so encrypted sources
 *  scan on-device and only the keyless listing crosses the wire. */
export const refreshAccountGallery = async (
  apiBase: string,
  token: string,
  slug: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries/${encodeURIComponent(slug)}/refresh`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...bearer(token) },
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || 'That folder could not be read again')
}

/** DELETE {apiBase}/api/galleries/{slug} — removes the D1 row only; the
 *  provider's originals are never touched (invariant 9). */
export const deleteAccountGallery = async (
  apiBase: string,
  token: string,
  slug: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/galleries/${encodeURIComponent(slug)}`, {
    method: 'DELETE',
    headers: bearer(token),
  })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || 'That gallery could not be removed')
}

/** DELETE {apiBase}/api/device-galleries/{id} — removes a synced device
 *  gallery row from the account feed; a 404 means the row is already gone. */
export const deleteDeviceGalleryRecord = async (
  apiBase: string,
  token: string,
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const response = await fetcher(`${normalizeApiBase(apiBase)}/api/device-galleries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: bearer(token),
  })
  if (response.status === 404) return
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new AccountApiError(response.status, payload.error || 'That gallery could not be removed')
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
