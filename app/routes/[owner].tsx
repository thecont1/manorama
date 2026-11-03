import { createRoute } from 'honox/factory'
import Admin from '../islands/Admin'
import { listGalleries, toLibrarySummaries, type GalleryEnv } from '../lib/gallery-repository'
import { getUserByOwnerSlug } from '../lib/user-repository'
import { accessEnvOf, resolveManoramaSession } from '../lib/session'

type RuntimeEnv = {
  PUBLIC_HOST?: string
  STRIPE_PRO_PAYMENT_LINK?: string
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
  if (session.id !== `account:${user.accountId}`) return c.notFound()

  const galleries = await listGalleries(user.accountId, c.env as GalleryEnv)
  const requestHost = new URL(c.req.url).host
  const paymentLink = env.STRIPE_PRO_PAYMENT_LINK ?? ''
  // A test-mode Payment Link must never reach the public host — if the
  // launch-day swap is forgotten, Upgrade degrades to the mailto path
  // instead of a checkout that cannot charge.
  const upgradeUrl =
    paymentLink.includes('buy.stripe.com/test_') && requestHost === env.PUBLIC_HOST
      ? undefined
      : paymentLink || undefined
  return c.render(
    <Admin
      galleries={toLibrarySummaries(galleries, user.tier)}
      owner={owner}
      ownerName={user.displayName}
      publicHost={env.PUBLIC_HOST || requestHost}
      tier={user.tier}
      accountId={user.accountId}
      upgradeUrl={upgradeUrl}
      initialDetails={c.req.query('details')}
    />,
    { title: 'manorama', ownerTheme: true },
  )
})
