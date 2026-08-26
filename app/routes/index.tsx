import { createRoute } from 'honox/factory'
import Admin from '../islands/Admin'
import manifest from '../lib/gallery-manifest'

export default createRoute((c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')
  return c.render(
    <Admin manifest={manifest} />,
    { title: `Admin — ${manifest.title} — manorama` },
  )
})
