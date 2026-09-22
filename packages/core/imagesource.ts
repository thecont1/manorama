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

export type GalleryManifest = {
  slug: string
  title: string
  caption: string
  date: string
  images: readonly GalleryMediaItem[]
}

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
