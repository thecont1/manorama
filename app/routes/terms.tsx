import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { RETURNING_COOKIE } from '../lib/session'
import { signinOriginOf } from '../lib/signin-host'
import { TERMS_DOC_HTML } from '../lib/site-docs'
import DocShell from '../components/DocShell'

export default createRoute((c) =>
  c.render(
    <DocShell returning={!!getCookie(c, RETURNING_COOKIE)} next={c.req.path} signInOrigin={signinOriginOf(c.env)} html={TERMS_DOC_HTML} />,
    { home: true, title: 'Terms — manorama', description: 'The terms that govern use of manorama — accounts, subscriptions and billing, content, acceptable use, and liability.' },
  ),
)
