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

export type GalleryManifest = {
  slug: string
  title: string
  caption: string
  date: string
  images: readonly GalleryImage[]
}

export interface ImageSource {
  list(): readonly GalleryImage[]
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
