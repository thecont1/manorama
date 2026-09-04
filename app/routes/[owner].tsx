import { Fragment } from 'hono/jsx'
import { createRoute } from 'honox/factory'
import { Script } from 'honox/server'
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
    <Fragment>
      <Admin
        galleries={galleries.map(toSummary)}
        owner={owner}
        publicHost={env.PUBLIC_HOST || new URL(c.req.url).host}
      />
      {/* The Vendo surface mounts only on this authenticated page, after the
          admin content: the root element first, then the client script. */}
      <div id="vendo-root" />
      <Script src="/app/vendo-client.tsx" />
    </Fragment>,
    { title: 'manorama' },
  )
})
