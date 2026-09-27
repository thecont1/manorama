import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { accessEnvOf, resolveManoramaSession, RETURNING_COOKIE } from '../lib/session'
import { SignInLinks } from '../lib/signin'

export default createRoute(async (c) => {
  // The landing page doubles as the sign-in door: editors arriving with a
  // session go straight to their dashboard.
  const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
  if (session) return c.redirect(`/${session.ownerSlug}`)

  const failed = c.req.query('error') === '1'
  // We can't know whether the Dropbox account has a manorama record until
  // OAuth completes — but a marker cookie tells us this browser has been here.
  const returning = !!getCookie(c, RETURNING_COOKIE)
  return c.render(
    <main class="landing-page">
      <div class="landing-brand">
        <span class="brand-mark-wrap"><img src="/manorama-merged-logo.png" alt="manorama" class="landing-brand-mark" /><span class="brand-tld" aria-hidden="true">.xyz</span></span>
        <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
        <SignInLinks returning={returning} />
        {failed ? <p class="landing-note">Sign-in didn&rsquo;t complete. Please try again.</p> : null}
      </div>
      <footer class="site-footer">
        <a class="site-footer-link" href="/privacy">Privacy Policy</a>
        <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href="https://thecontrarian.in">thecontrarian.in</a></p>
      </footer>
    </main>,
    { title: 'manorama', description: 'A view that is delightful to the mind. The WOW-est way to enjoy a photo gallery with anyone!' },
  )
})
