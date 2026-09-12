import { createRoute } from 'honox/factory'
import { accessEnvOf, resolveManoramaSession } from '../lib/dropbox-session'

const DropboxGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z"
      fill="currentColor"
    />
  </svg>
)

export default createRoute(async (c) => {
  // The landing page doubles as the sign-in door: editors arriving with a
  // session go straight to their dashboard.
  const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
  if (session) return c.redirect(`/${session.ownerSlug}`)

  const failed = c.req.query('error') === '1'
  return c.render(
    <main class="landing-page">
      <div class="landing-brand">
        <span class="brand-mark-wrap"><img src="/manorama-merged-logo.png" alt="manorama" class="landing-brand-mark" /><span class="brand-tld" aria-hidden="true">.xyz</span></span>
        <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
        <a class="landing-signin" href="/auth/dropbox">
          <DropboxGlyph />
          Continue with Dropbox
        </a>
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
