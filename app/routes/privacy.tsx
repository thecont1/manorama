import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { RETURNING_COOKIE } from '../lib/session'
import { signinOriginOf } from '../lib/signin-host'
import PrivacyPolicy from '../components/PrivacyPolicy'
import DocShell from '../components/DocShell'

export default createRoute((c) =>
  c.render(
    <DocShell returning={!!getCookie(c, RETURNING_COOKIE)} next={c.req.path} signInOrigin={signinOriginOf(c.env)}>
      <PrivacyPolicy />
    </DocShell>,
    { home: true, title: 'Privacy Policy — manorama', description: 'What Manorama keeps about gallery viewers, owners, and paid plans — on the web at manorama.xyz and in the mobile and desktop apps.' },
  ),
)
