import { createRoute } from 'honox/factory'
import Admin from '../islands/Admin'
import { listGalleries, toSummary } from '../lib/gallery-repository'

type RuntimeEnv = {
  PUBLIC_HOST?: string
  OWNER_SLUG?: string
}

export default createRoute(async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')
  const env = c.env as RuntimeEnv
  const owner = c.req.param('owner')
  if (owner !== (env.OWNER_SLUG || 'thecontrarian')) return c.notFound()
  // Fail closed: the admin application renders only behind a verified
  // Cloudflare Access session, even if mounted without the gate middleware.
  if (!c.get('manoramaSession')) return c.json({ error: 'Authentication required' }, 401)
  const galleries = await listGalleries(c.env)
  return c.render(
    <Admin
      galleries={galleries.map(toSummary)}
      owner={owner}
      publicHost={env.PUBLIC_HOST || new URL(c.req.url).host}
    />,
    { title: 'manorama' },
  )
})
