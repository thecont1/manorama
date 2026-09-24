import type { GalleryManifest, GalleryMediaItem, ImageVariant, VideoCaptionTrack } from '../../app/lib/imagesource'
import type { GallerySettings } from '../../app/lib/gallery-settings'
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

export const fetchGallery = async (
  apiBase: string,
  owner: string,
  slug: string,
  signal?: AbortSignal,
): Promise<NativeGalleryResponse> => {
  const token = await getSessionToken()
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const response = await fetch(
    `${normalizeApiBase(apiBase)}/api/gallery/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
    { headers, signal },
  )
  const payload = await response.json().catch(() => ({})) as Partial<NativeGalleryResponse> & { error?: string }
  if (!response.ok) throw new NativeGalleryHttpError(response.status, payload.error || `Gallery request failed (${response.status})`)
  if (!payload.manifest || !payload.settings) throw new Error('Gallery response was incomplete')
  return {
    manifest: nativeManifest(payload.manifest, apiBase),
    settings: payload.settings,
  }
}
