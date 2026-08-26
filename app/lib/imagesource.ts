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
