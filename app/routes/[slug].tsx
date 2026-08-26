import { createRoute } from 'honox/factory'
import Viewer from '../islands/Viewer'
import manifest from '../lib/gallery-manifest'
import { BundledSource } from '../lib/imagesource'
import { defaultGallerySettings } from '../lib/gallery-settings'

const source = new BundledSource(manifest)
const settings = defaultGallerySettings(manifest)

export default createRoute((c) => {
  const slug = c.req.param('slug')
  if (slug !== manifest.slug) return c.notFound()
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')

  return c.render(
    <main class="gallery-shell">
      <h1 class="sr-only">{manifest.title}</h1>
      <section
        class="curtain"
        data-curtain
        role="button"
        tabIndex={0}
        aria-label="Enter gallery"
      >
        <div class="curtain-content">
          <p class="curtain-kicker" data-curtain-kicker>{settings.curtainKicker}</p>
          <h1 data-curtain-title>{settings.title}</h1>
          <p class="curtain-caption" data-curtain-caption>{settings.caption}</p>
          <p class="curtain-date" data-curtain-date>{settings.date}</p>
          <p class="curtain-prompt" data-curtain-prompt>{settings.curtainPrompt}</p>
        </div>
      </section>
      <Viewer slug={manifest.slug} images={source.list()} settings={settings} />
    </main>,
    { title: `${manifest.title} — manorama` },
  )
})
