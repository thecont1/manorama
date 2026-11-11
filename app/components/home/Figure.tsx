import type { Asset } from './home-manifest'

/**
 * A picture on the page.
 *
 * The box is reserved from the asset's intrinsic size, so nothing shifts
 * while the file arrives and the picture is never stretched: the served
 * file is the capture, at the capture's own size (AGENTS invariant 13).
 *
 * A slot with no capture yet holds its exact ratio as a quiet surface. In
 * development it says what it is waiting for; in production it is simply
 * a surface with the caption under it.
 */
export default function Figure({
  asset,
  eager,
  sizes,
  missingLabel,
}: {
  asset: Asset
  /** True for the first picture on the page: it is loaded at once. */
  eager?: boolean
  /** How wide the picture is drawn, so the browser can pick its file. */
  sizes?: string
  /** The development-only label for a slot with no capture. */
  missingLabel?: string
}) {
  // Interim captures stay out of the release build until the owner clears
  // them: production shows the reserved box; development and tests still
  // see the picture (import.meta.env is undefined under bun test, which
  // follows the non-release path — the strict one is what ships).
  const publishable = asset.src && (asset.status === 'approved' || import.meta.env?.PROD !== true)
  if (!publishable) {
    return (
      <figure class="home-figure">
        <div
          class="home-figure-missing"
          style={{ aspectRatio: `${asset.width} / ${asset.height}` }}
        >
          {missingLabel ?? `${asset.id}: ${asset.intended}`}
        </div>
        <figcaption class="home-figure-caption">{asset.caption}</figcaption>
      </figure>
    )
  }

  const small = asset.small ? `${asset.src}-sm` : null
  const srcSet = (extension: string) =>
    small ? `/home/${small}.${extension} ${Math.round(asset.width / 2)}w, /home/${asset.src}.${extension} ${asset.width}w` : `/home/${asset.src}.${extension}`

  return (
    <figure class="home-figure">
      <picture>
        <source type="image/avif" srcSet={srcSet('avif')} sizes={sizes} />
        <source type="image/webp" srcSet={srcSet('webp')} sizes={sizes} />
        <img
          src={`/home/${asset.src}.jpg`}
          alt={asset.alt}
          width={asset.width}
          height={asset.height}
          loading={eager ? 'eager' : 'lazy'}
          decoding={eager ? 'sync' : 'async'}
          fetchpriority={eager ? 'high' : 'auto'}
          sizes={sizes}
        />
      </picture>
      <figcaption class="home-figure-caption">{asset.caption}</figcaption>
    </figure>
  )
}
