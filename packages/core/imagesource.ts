/**
 * The most media items one gallery may hold. Chosen for the two real
 * costs of a scan: per-item probes (Dropbox and MEGA fetch dimensions
 * for every accepted file, iCloud probes video candidates) and the
 * rendered DOM (the viewer mounts one frame per item — there is no
 * virtualization). 1000 keeps a scan's probe work bounded and a gallery
 * page loadable, while covering real albums many times over. Scanners
 * slice their filtered list to this BEFORE any per-item work and report
 * the uncapped count via `truncated`.
 */
export const MAX_GALLERY_ITEMS = 1000

export type ExifData = {
  dateOriginal?: string
  camera?: string
  lens?: string
  aperture?: string
  shutter?: string
  iso?: number
  focalLength?: string
  description?: string
}

export type ImageVariant = {
  width: number
  src: string
  format: string
}

export type GalleryImage = {
  /** Absent on every manifest written before video support — an item with
   *  no `type` IS an image. Never write `type: 'image'` into stored JSON:
   *  all-photo manifests must stay byte-identical (zero migration). */
  type?: 'image'
  id: string
  /** Provider-stable item key (Drive file ID, iCloud photo GUID). Ordering
   *  and refresh dedupe use `ref ?? filename` — Dropbox filenames are unique
   *  per folder so it stays unset there, but Drive allows duplicate names
   *  and iCloud shared albums have no filenames at all. */
  ref?: string
  filename: string
  src: string
  width: number
  height: number
  alt: string
  caption?: string
  exif?: ExifData
  c2pa: boolean
  placeholder: string
  variants?: readonly ImageVariant[]
  /** Owner-set concealment: kept in the manifest so a source refresh cannot
   *  resurrect it, filtered out of every public surface. Only ever written
   *  true — an absent flag means visible, keeping older manifests
   *  byte-identical (the same zero-migration rule as `type`). */
  hidden?: boolean
}

/** A still frame standing in for a video before it decodes. Always a real
 *  provider derivative (iCloud ships one per video) — never generated. */
export type VideoPoster = {
  src: string
  width: number
  height: number
}

/** A WebVTT track. Unpopulated in v1 — iCloud shared albums carry no
 *  caption assets — but the viewer renders <track> when one appears. */
export type VideoCaptionTrack = {
  src: string
  srclang: string
  label: string
  kind?: 'captions' | 'subtitles'
  default?: boolean
}

/**
 * A video slide. Ambient muted-loop is the universal playback model in v1:
 * there is deliberately no per-item `playback.mode`. `variants` carries the
 * poster thumbnail so every `variants?.[0]?.src` consumer (the admin rail,
 * strip previews) keeps working without knowing videos exist.
 */
export type VideoItem = {
  type: 'video'
  id: string
  ref?: string
  filename: string
  /** Proxy URL for the H.264 MP4 derivative — Range-capable. */
  src: string
  mimeType: 'video/mp4'
  width: number
  height: number
  /** Best-effort from the provider record; the viewer falls back to
   *  `loadedmetadata` when absent. */
  durationSeconds?: number
  poster: VideoPoster
  alt: string
  caption?: string
  /** Shared-album derivatives are transcodes; provenance never survives. */
  c2pa: false
  placeholder: string
  variants?: readonly ImageVariant[]
  // Forward-compatible, unpopulated in v1:
  sources?: readonly { src: string; mimeType: string }[]
  captions?: readonly VideoCaptionTrack[]
  transcript?: string
  credit?: string
  hidden?: boolean
}

/** The ordered sequence a gallery actually is: images and videos, mixed. */
export type GalleryMediaItem = GalleryImage | VideoItem

/** The one discriminant check. An absent `type` means image, so this is
 *  the only safe way to narrow a stored manifest entry. */
export const isVideoItem = (item: GalleryMediaItem): item is VideoItem =>
  (item as VideoItem).type === 'video'

/** Poster for videos, the image itself otherwise — the still every
 *  non-playing surface (OG card, magnifier clone, rail thumb) wants. */
export const stillSourceOf = (item: GalleryMediaItem): string =>
  isVideoItem(item) ? item.poster.src : item.src

/** The count split every surface shares: videos counted in one pass,
 *  stills derived from the total. Items only need a `type` field —
 *  manifest entries and trimmed summary previews both qualify, and an
 *  absent `type` is an image exactly as in the stored manifest. */
export const mediaCountOf = (items: readonly { type?: string }[]): { stills: number; videos: number } => {
  let videos = 0
  for (const item of items) if (item.type === 'video') videos += 1
  return { stills: items.length - videos, videos }
}

/** The still/video/hidden split a count line speaks. `hidden` counts
 *  owner-concealed items and appears only on owner surfaces. */
export type MediaCount = { stills: number; videos: number; hidden?: number }

/** One count line for every surface that reports what a gallery holds:
 *  "24 photographs · 1 video · 2 hidden". Each part appears only when its
 *  count is nonzero; an empty gallery reads "0 photographs" because the
 *  still count is what a visitor came for. */
export const formatMediaCount = (count: MediaCount): string => {
  const parts: string[] = []
  if (count.stills > 0) parts.push(`${count.stills} photograph${count.stills === 1 ? '' : 's'}`)
  if (count.videos > 0) parts.push(`${count.videos} video${count.videos === 1 ? '' : 's'}`)
  if (parts.length === 0) parts.push('0 photographs')
  if (count.hidden && count.hidden > 0) parts.push(`${count.hidden} hidden`)
  return parts.join(' · ')
}

/** Summaries written before `mediaCount` existed carry one total — older
 *  payloads degrade to all-stills rather than undercounting. */
export const summaryMediaCount = (summary: {
  imageCount: number
  mediaCount?: MediaCount
}): Required<MediaCount> => summary.mediaCount
  ? { stills: summary.mediaCount.stills, videos: summary.mediaCount.videos, hidden: summary.mediaCount.hidden ?? 0 }
  : { stills: summary.imageCount, videos: 0, hidden: 0 }

export type GalleryManifest = {
  slug: string
  title: string
  caption: string
  date: string
  images: readonly GalleryMediaItem[]
}

import type { AdFrame, RuntimeGalleryItem } from './adframe'
import { composePlate, platePositionsFor } from './adframe'

export interface ImageSource {
  list(): readonly GalleryMediaItem[]
  url(id: string, variant?: number | 'original'): string
}

/** A provider fetch that failed upstream. `status` carries the upstream
 *  HTTP status when one exists so the proxy routes can distinguish a
 *  confirmed miss (404) from retryable failures (5xx, network, config). */
export class SourceFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SourceFetchError'
  }
}

export class BundledSource implements ImageSource {
  constructor(private readonly manifest: GalleryManifest) {}

  list() {
    return this.manifest.images
  }

  /** Runtime-only native sequence; the web-facing list remains photographs.
   *  `seedKey` decides where the cadence lands (callers pass gallery+day so a
   *  re-opened gallery keeps yesterday's layout). */
  listWithPlate(adFrame: AdFrame | null | undefined, seedKey = ''): readonly RuntimeGalleryItem[] {
    return composePlate(this.manifest.images, adFrame, platePositionsFor(this.manifest.images.length, seedKey))
  }

  url(id: string, variant: number | 'original' = 'original') {
    const image = this.manifest.images.find((item) => item.id === id)
    if (!image) return ''
    if (variant !== 'original') {
      return image.variants?.find((item) => item.width === variant)?.src ?? image.src
    }
    return image.src
  }
}

/**
 * Future R2 adapter. The gallery route only depends on ImageSource, so adding
 * an R2 binding is a config-level choice rather than a viewer rewrite.
 */
export class R2Source implements ImageSource {
  constructor(
    private readonly manifest: GalleryManifest,
    private readonly publicBaseUrl: string,
  ) {}

  list() {
    return this.manifest.images
  }

  url(id: string, variant: number | 'original' = 'original') {
    const image = this.manifest.images.find((item) => item.id === id)
    if (!image) return ''
    const path = variant === 'original'
      ? image.src.split('/').pop()
      : image.variants?.find((item) => item.width === variant)?.src.split('/').pop() ?? image.src.split('/').pop()
    return `${this.publicBaseUrl.replace(/\/$/, '')}/${path}`
  }
}
