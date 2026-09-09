import { Fragment } from 'hono/jsx'
import { createRoute } from 'honox/factory'
import { Script } from 'honox/server'
import Admin from '../islands/Admin'
import { listGalleries, toSummary, type GalleryEnv } from '../lib/gallery-repository'
import { getUserByOwnerSlug } from '../lib/user-repository'
import { accessEnvOf, resolveManoramaSession } from '../lib/dropbox-session'

type RuntimeEnv = {
  PUBLIC_HOST?: string
}

export default createRoute(async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')
  const env = c.env as RuntimeEnv
  const owner = c.req.param('owner') ?? ''
  const user = await getUserByOwnerSlug(owner, c.env as GalleryEnv)
  if (!user) return c.notFound()

  // Fail closed: the dashboard renders only for the signed-in owner of
  // this URL. Anyone else — anonymous or a different owner — is turned
  // away before any gallery data is read.
  const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
  if (!session) return c.redirect('/login')
  if (session.id !== `dropbox:${user.dropboxAccountId}`) return c.notFound()

  const galleries = await listGalleries(user.dropboxAccountId, c.env as GalleryEnv)
  return c.render(
    <Fragment>
      <Admin
        galleries={galleries.map(toSummary)}
        owner={owner}
        ownerName={user.displayName}
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
