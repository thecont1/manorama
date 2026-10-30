import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import AdminOps from '../islands/AdminOps'
import OpsDoor from '../components/OpsDoor'
import { accessEnvOf, isMasterAccount, resolveManoramaSession, RETURNING_COOKIE } from '../lib/session'

export default createRoute(async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'private, no-store')
  const env = accessEnvOf(c)
  const session = await resolveManoramaSession(c.req.raw, env)
  // No shortcut to a provider: the door is the standard manorama chooser,
  // and each provider link carries next=/opman through the auth flow.
  if (!session) {
    return c.render(
      <OpsDoor returning={!!getCookie(c, RETURNING_COOKIE)} />,
      { title: 'Operations sign-in — manorama', description: 'Private manorama operations console' },
    )
  }
  if (!(await isMasterAccount(session, env))) {
    return c.render(
      <OpsDoor deniedName={session.name} />,
      { title: 'Operations — manorama', description: 'Private manorama operations console' },
    )
  }
  return c.render(
    <AdminOps ownerName={session.name} accountId={session.accountId} />,
    { title: 'Operations — manorama', description: 'Private manorama operations console' },
  )
})
