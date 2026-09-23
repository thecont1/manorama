import { createRoute } from 'honox/factory'
import Viewer from '../../islands/Viewer'
import GalleryShell from '../../components/GalleryShell'
import { BundledSource } from '../../lib/imagesource'
import { defaultGallerySettings } from '../../lib/gallery-settings'
import {
  getGallery,
  type GalleryEnv,
  type GalleryRecord,
} from '../../lib/gallery-repository'
import { getUserByOwnerSlug } from '../../lib/user-repository'
import { ogItemKey } from '../../lib/og-card'

export default createRoute(async (c) => {
  const owner = c.req.param('owner') ?? ''
  const user = await getUserByOwnerSlug(owner, c.env as GalleryEnv)
  if (!user) return c.notFound()

  const slug = c.req.param('slug') ?? ''
  const gallery = await getGallery(
    user.dropboxAccountId,
    slug,
    c.env as GalleryEnv,
  )
  if (!gallery) return c.notFound()

  const source = new BundledSource(gallery as GalleryRecord)
  const settings = defaultGallerySettings(gallery)
  // Per-gallery social card: the first frame with the wordmark over it.
  // `?i=` is the first item's stable key, so reordering the gallery
  // changes the URL and busts the edge cache without a purge.
  const firstKey = ogItemKey(gallery.images[0])
  const ogImage = `/api/og/${encodeURIComponent(owner)}/${encodeURIComponent(
    gallery.slug,
  )}${firstKey ? `?i=${encodeURIComponent(firstKey)}` : ''}`
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')

  return c.render(
    <GalleryShell settings={settings}>
      <Viewer
        slug={gallery.slug}
        images={source.list()}
        settings={settings}
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
