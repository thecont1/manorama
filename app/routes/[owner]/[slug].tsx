import { createRoute } from 'honox/factory'
import Viewer from '../../islands/Viewer'
import EncryptedGallery from '../../islands/EncryptedGallery'
import GalleryShell from '../../components/GalleryShell'
import { BundledSource, mediaCountOf } from '../../lib/imagesource'
import { defaultGallerySettings } from '../../lib/gallery-settings'
import {
  getGallery,
  retentionOf,
  type GalleryEnv,
  type GalleryRecord,
} from '../../lib/gallery-repository'
import { sourceLabelFor } from '../../lib/source-label'
import { getUserByOwnerSlug } from '../../lib/user-repository'
import { accessEnvOf, resolveManoramaSession } from '../../lib/session'
import { webAdFrameForRequest } from '../../lib/ads-visibility'
import { ogItemKey } from '../../lib/og-card'
import { encryptedGalleryGate, isEncryptedSourceUrl, keylessSourceUrl } from '../../../packages/core/encrypted-source'
import { stripLegacyDeliveryCapabilities } from '../../lib/encrypted-public'
import { encryptedGalleryDescription } from '../../lib/og-metadata'
import type { GalleryMediaItem } from '../../lib/imagesource'

export default createRoute(async (c) => {
  const owner = c.req.param('owner') ?? ''
  const user = await getUserByOwnerSlug(owner, c.env as GalleryEnv)
  if (!user) return c.notFound()

  const slug = c.req.param('slug') ?? ''
  const gallery = await getGallery(
    user.accountId,
    slug,
    c.env as GalleryEnv,
  )
  if (!gallery) return c.notFound()

  // Who is looking — owner, signed-in member, or anonymous visitor — and
  // where their library lives. A session lookup failure degrades to
  // visitor; it must never 500 the gallery.
  let viewerRole: 'owner' | 'member' | 'visitor' = 'visitor'
  let libraryHref: string | undefined
  try {
    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
    if (session) {
      viewerRole = session.accountId === user.accountId ? 'owner' : 'member'
      if (session.ownerSlug) libraryHref = `/${session.ownerSlug}`
    }
  } catch {
    viewerRole = 'visitor'
    libraryHref = undefined
  }

  // `?photo=<id>` opens on that photograph — a transient intent stripped by
  // the client so a reload starts at the first photograph. Only manifest
  // item ids count (ad plates never do).
  const photoParam = c.req.query('photo')
  // `?edit=1` is the owner's picker's Edit mode deep-link — it also counts
  // as entered (no curtain); for anyone else it is ignored entirely.
  const ownerEdit = viewerRole === 'owner' && c.req.query('edit') === '1'
  // Hidden items are kept in the stored manifest (so a source refresh can
  // merge around them) but never reach a public surface — not even for the
  // owner, whose view must match what the gallery publishes.
  const visible = gallery.images.filter((image) => !image.hidden)
  const source = new BundledSource({ ...gallery, images: visible } as GalleryRecord)
  const photoIndex = photoParam ? source.list().findIndex((item) => item.id === photoParam) : -1

  const plate = await webAdFrameForRequest(c.req.raw, accessEnvOf(c), undefined, gallery.slug)
  const media = mediaCountOf(source.list())

  const settings = defaultGallerySettings(gallery)
  // Per-gallery social card: the first frame with the wordmark over it.
  // `?i=` is the first item's stable key, so reordering the gallery
  // changes the URL and busts the edge cache without a purge.
  const encrypted = Boolean(gallery.sourceUrl && isEncryptedSourceUrl(gallery.sourceUrl))
  const firstKey = encrypted ? '' : ogItemKey(visible[0])
  const ogImage = encrypted ? '/og-image.png' : `/api/og/${encodeURIComponent(owner)}/${encodeURIComponent(
    gallery.slug,
  )}${firstKey ? `?i=${encodeURIComponent(firstKey)}` : ''}`
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'private, no-store')

  const viewerProps = {
    slug: gallery.slug,
    galleryTitle: gallery.title,
    images: source.list(),
    settings,
    plate,
    viewerRole,
    galleryOwner: owner,
    libraryHref,
    ownerGallery: viewerRole === 'owner' ? {
      title: gallery.title,
      caption: gallery.caption,
      sourceLabel: sourceLabelFor(gallery.sourceUrl),
      sourceUrl: gallery.sourceUrl,
      temporary: retentionOf(gallery) === 'pipeline',
      expiresAt: gallery.expiresAt,
      mediaCount: { ...media, hidden: gallery.images.length - visible.length },
    } : undefined,
    initialEdit: ownerEdit,
    initialIndex: photoIndex > 0 ? photoIndex : 0,
  }

  const gate = encryptedGalleryGate({
    sourceUrl: gallery.sourceUrl ?? '', viewerOwner: viewerRole === 'owner', keyRetiredAt: gallery.keyRetiredAt,
    manifestVersion: gallery.manifestVersion,
  })
  const clientGate = encrypted && gallery.id && gate.client
  const legacySourceUrl = gate.legacySourceUrl

  // A visitor-facing render must not inherit the stored capability:
  // legacy item srcs still carry `k=` keys and sourceUrl can hold the
  // fragment. Only the owner receives keyed props, for the migration call —
  // so the strip applies to every encrypted render that is not that case.
  const gatedImages = (items: readonly GalleryMediaItem[]): GalleryMediaItem[] =>
    legacySourceUrl ? [...items] : items.map(stripLegacyDeliveryCapabilities)
  const ssrProps = encrypted ? { ...viewerProps, images: gatedImages(viewerProps.images) } : viewerProps

  return c.render(
    <GalleryShell settings={settings} viewerRole={viewerRole} libraryHref={libraryHref} mediaCount={media} entered={photoIndex >= 0 || ownerEdit}>
      {clientGate && gallery.id
        ? <EncryptedGallery {...ssrProps} galleryId={gallery.id} sourceUrl={keylessSourceUrl(gallery.sourceUrl!)} legacySourceUrl={legacySourceUrl} />
        : <Viewer {...ssrProps} />}
    </GalleryShell>,
    {
      title: `${gallery.title} — manorama`,
      description: encrypted
        ? encryptedGalleryDescription({ count: source.list().length, provider: sourceLabelFor(gallery.sourceUrl), date: gallery.date })
        : gallery.caption || `${gallery.title} — a photo gallery on manorama`,
      ogImage,
    },
  )
})
