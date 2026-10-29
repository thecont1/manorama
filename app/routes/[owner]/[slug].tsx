import { createRoute } from 'honox/factory'
import Viewer from '../../islands/Viewer'
import GalleryShell from '../../components/GalleryShell'
import { BundledSource, mediaCountOf } from '../../lib/imagesource'
import { defaultGallerySettings } from '../../lib/gallery-settings'
import {
  getGallery,
  type GalleryEnv,
  type GalleryRecord,
} from '../../lib/gallery-repository'
import { getUserByOwnerSlug } from '../../lib/user-repository'
import { accessEnvOf, resolveManoramaSession } from '../../lib/session'
import { webAdFrameForRequest } from '../../lib/ads-visibility'
import { ogItemKey } from '../../lib/og-card'

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
  const source = new BundledSource(gallery as GalleryRecord)
  const photoIndex = photoParam ? source.list().findIndex((item) => item.id === photoParam) : -1

  const plate = await webAdFrameForRequest(c.req.raw, accessEnvOf(c))

  const settings = defaultGallerySettings(gallery)
  // Per-gallery social card: the first frame with the wordmark over it.
  // `?i=` is the first item's stable key, so reordering the gallery
  // changes the URL and busts the edge cache without a purge.
  const firstKey = ogItemKey(gallery.images[0])
  const ogImage = `/api/og/${encodeURIComponent(owner)}/${encodeURIComponent(
    gallery.slug,
  )}${firstKey ? `?i=${encodeURIComponent(firstKey)}` : ''}`
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'private, no-store')

  return c.render(
    <GalleryShell settings={settings} viewerRole={viewerRole} libraryHref={libraryHref} mediaCount={mediaCountOf(source.list())}>
      <Viewer
        slug={gallery.slug}
        galleryTitle={gallery.title}
        images={source.list()}
        settings={settings}
        plate={plate}
        viewerRole={viewerRole}
        libraryHref={libraryHref}
        initialIndex={photoIndex > 0 ? photoIndex : 0}
      />
    </GalleryShell>,
    {
      title: `${gallery.title} — manorama`,
      description:
        gallery.caption || `${gallery.title} — a photo gallery on manorama`,
      ogImage,
    },
  )
})
