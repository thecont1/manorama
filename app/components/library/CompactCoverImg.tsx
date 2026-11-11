import { useState } from 'hono/jsx'
import { HeicImg } from '../ui/HeicImg'
import type { MediaReference } from '../../../packages/core/encrypted-source'

type Props = {
  src: string
  preview?: string | null
  media?: MediaReference
  previewMedia?: MediaReference
  galleryId?: string
  /** Manifest filename; the .heic/.heif suffix selects HeicImg's decode path. */
  filename?: string | null
  /** Stored dims seed the img's aspect-ratio until the frame reports its own. */
  storedWidth?: number | null
  storedHeight?: number | null
  onError?: (event: Event) => void
  onNaturalSize?: (width: number, height: number) => void
}

/**
 * The <img> inside a .lib-compact-cover. The decoded frame's pixel size
 * lives in state — not an onLoad style poke — because hono/jsx rewrites an
 * element's `style` on every render and would wipe imperative maxWidth /
 * aspectRatio before the next paint. Once loaded, the img caps at its own
 * pixels (invariant 13): a large rendition fills the column, a small one
 * floats centred at honest size inside the slot's aspect-ratio.
 */
export function CompactCoverImg({
  src,
  preview,
  media,
  previewMedia,
  galleryId,
  filename,
  storedWidth,
  storedHeight,
  onError,
  onNaturalSize,
}: Props) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const handleLoad = (event: Event) => {
    const img = event.currentTarget as HTMLImageElement
    img.classList.add('is-loaded')
    if (!img.naturalWidth || !img.naturalHeight) return
    setNatural({ width: img.naturalWidth, height: img.naturalHeight })
    onNaturalSize?.(img.naturalWidth, img.naturalHeight)
  }
  const style = {
    aspectRatio: natural
      ? `${natural.width} / ${natural.height}`
      : storedWidth && storedHeight
        ? `${Math.max(1, storedWidth)} / ${Math.max(1, storedHeight)}`
        : undefined,
    maxWidth: natural ? `${natural.width}px` : undefined,
  }
  return (
    <HeicImg
      src={src}
      preview={preview}
      media={media}
      previewMedia={previewMedia}
      galleryId={galleryId}
      filename={filename}
      alt=""
      loading="lazy"
      draggable="false"
      style={style}
      onLoad={handleLoad}
      onError={onError}
    />
  )
}
