import { createRoute } from 'honox/factory'
import AdminOps from '../islands/AdminOps'
import { accessEnvOf, isMasterAccount, resolveManoramaSession } from '../lib/session'

export default createRoute(async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'private, no-store')
  const env = accessEnvOf(c)
  const session = await resolveManoramaSession(c.req.raw, env)
  if (!session) return c.redirect('/auth/dropbox?next=%2Fopman')
  if (!(await isMasterAccount(session, env))) return c.redirect('/')
  return c.render(
    <AdminOps ownerName={session.name} accountId={session.accountId} />,
    { title: 'Operations — manorama', description: 'Private manorama operations console' },
  )
})
