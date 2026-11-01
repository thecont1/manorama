import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { accessEnvOf, resolveManoramaSession, RETURNING_COOKIE } from '../lib/session'
import PublicWelcome from '../components/PublicWelcome'

export default createRoute(async (c) => {
  // The landing page doubles as the sign-in door: editors arriving with a
  // session go straight to their dashboard.
  const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
  if (session) return c.redirect(`/${session.ownerSlug}`)

  const failed = c.req.query('error') === '1'
  // We can't know whether the Dropbox account has a manorama record until
  // OAuth completes — but a marker cookie tells us this browser has been here.
  const returning = !!getCookie(c, RETURNING_COOKIE)
  // `?next=` arrives from a gallery's Sign in pill: after OAuth the member
  // lands back on the gallery, now with "Add to Library" in the chrome.
  // Path-relative only — the callback re-checks origin anyway, but the
  // door should not carry absolute URLs around at all.
  const rawNext = c.req.query('next') ?? ''
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : undefined
  return c.render(
    <PublicWelcome returning={returning} failed={failed} next={next} />,
    { title: 'manorama', description: 'manorama turns a folder of images (either on this device or in the cloud) into a beautiful full-screen hi-res gallery with a custom link of your own' },
  )
})
