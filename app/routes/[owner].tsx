import { Fragment } from 'hono/jsx'
import { createRoute } from 'honox/factory'
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
  if (!session) return c.redirect('/')
  if (session.id !== `dropbox:${user.dropboxAccountId}`) return c.notFound()

  const galleries = await listGalleries(user.dropboxAccountId, c.env as GalleryEnv)
  return c.render(
    <Fragment>
      <Admin
        galleries={galleries.map(toSummary)}
        owner={owner}
        ownerName={user.displayName}
        publicHost={env.PUBLIC_HOST || new URL(c.req.url).host}
        tier={user.tier}
      />
      {/* Vendo is disabled platform-wide for now: no surface mounts here
          and no agent API is routed. Re-enable by reverting this change —
          the vendo modules and deps remain. */}
    </Fragment>,
    { title: 'manorama' },
  )
})
