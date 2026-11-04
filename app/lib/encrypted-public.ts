import { isVideoItem, type GalleryMediaItem } from '../../packages/core/imagesource'

/** Removes the keyed delivery URLs a viewer must never receive: legacy
 *  item srcs embed per-node `k=` keys. Identity, keyless `media`
 *  references, content versions, and metadata survive — v2 clients
 *  decrypt through `media`, never through these URLs. A variant with a
 *  media reference is keyless-capable (the Viewer thumbnails through
 *  `variant.media`), so it stays with its src blanked; a media-less
 *  variant is nothing but its URL, so it goes. Shared by the public
 *  JSON manifest and the SSR gate so both surfaces sanitize to one
 *  definition. */
export const stripLegacyDeliveryCapabilities = <T extends GalleryMediaItem>(item: T): T => {
  const variants = item.variants
    ?.filter((variant) => variant.media !== undefined)
    .map((variant) => ({ ...variant, src: '' })) ?? []
  return (isVideoItem(item)
    ? { ...item, src: '', variants, sources: [], captions: [], poster: { ...item.poster, src: '' } }
    : { ...item, src: '', variants }) as T
}
