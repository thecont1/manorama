import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { RETURNING_COOKIE } from '../lib/session'
import { signinOriginOf } from '../lib/signin-host'
import HomePage from '../components/home/HomePage'
import { HOME_DEMO_ENABLED } from '../components/home/home-manifest'

export default createRoute(async (c) => {
  // The homepage is the marketing page for everyone — a session used to
  // bounce editors straight to their dashboard, which made it unreachable
  // while signed in. Sign-in itself lives on signin.manorama.xyz; the
  // chooser's provider links point there whenever the deployment
  // configures the subdomain.
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
  // The demo is on by default (owner-cleared photographs); a Worker var turns
  // it off and leaves the static hero, with no demo code or assets loaded.
  const demo = HOME_DEMO_ENABLED && (c.env as Record<string, unknown>).MANORAMA_HOME_DEMO !== 'off'
  return c.render(
    <HomePage returning={returning} failed={failed} next={next} demo={demo} signInOrigin={signinOriginOf(c.env)} />,
    {
      title: 'Manorama: your photographs, together in one beautiful view',
      description:
        'Bring your local folders and supported cloud galleries together in one beautiful Library. Keep your photographs where they are. Enjoy them together in Manorama.',
      // The homepage is the one page the world may find. Every other route
      // keeps its noindex meta and header.
      indexable: true,
      home: true,
    },
  )
})
