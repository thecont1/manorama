import { createRoute } from 'honox/factory'
import Viewer from '../../islands/Viewer'
import { BundledSource } from '../../lib/imagesource'
import { defaultGallerySettings } from '../../lib/gallery-settings'
import { getGallery, type GalleryRecord } from '../../lib/gallery-repository'

type RuntimeEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
  OWNER_SLUG?: string
}

export default createRoute(async (c) => {
  const env = c.env as RuntimeEnv
  const owner = c.req.param('owner')
  if (owner !== (env.OWNER_SLUG || 'thecontrarian')) return c.notFound()

  const slug = c.req.param('slug')
  const gallery = await getGallery(slug, env)
  if (!gallery) return c.notFound()

  const source = new BundledSource(gallery as GalleryRecord)
  const settings = defaultGallerySettings(gallery)
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')

  return c.render(
    <main class="gallery-shell">
      <h1 class="sr-only">{gallery.title}</h1>
      <section
        class="curtain"
        data-curtain
        role="button"
        tabIndex={0}
        aria-label="Enter gallery"
      >
        <div class="curtain-content">
          <img src="/manorama-logo-upright-test.png" alt="" aria-hidden="true" class="curtain-logo" />
          <h1 data-curtain-title>{settings.title.replace(/\b\w/g, (c) => c.toUpperCase())}</h1>
          <p class="curtain-caption" data-curtain-caption>{settings.caption}</p>
        </div>
      </section>
      <Viewer slug={gallery.slug} images={source.list()} settings={settings} />
    </main>,
    { title: `${gallery.title} — manorama` },
  )
})
