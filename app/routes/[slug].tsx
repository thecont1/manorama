import { createRoute } from 'honox/factory'
import Viewer from '../islands/Viewer'
import manifest from '../lib/gallery-manifest'
import { BundledSource } from '../lib/imagesource'

const source = new BundledSource(manifest)

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
          <p class="curtain-kicker">A single album</p>
          <h1>{manifest.title}</h1>
          <p class="curtain-caption">{manifest.caption}</p>
          <p class="curtain-date">{manifest.date}</p>
          <p class="curtain-prompt">Tap, click, or press Enter to enter</p>
        </div>
      </section>
      <Viewer slug={manifest.slug} images={source.list()} />
    </main>,
    { title: `${manifest.title} — manorama` },
  )
})
