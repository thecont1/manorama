import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { RETURNING_COOKIE } from '../lib/session'
import { signinOriginOf } from '../lib/signin-host'
import { ABOUT_DOC_HTML, ABOUT_UPDATED } from '../lib/site-docs'
import DocShell from '../components/DocShell'

export default createRoute((c) =>
  c.render(
    <DocShell returning={!!getCookie(c, RETURNING_COOKIE)} next={c.req.path} signInOrigin={signinOriginOf(c.env)} html={ABOUT_DOC_HTML} updated={ABOUT_UPDATED} />,
    { home: true, title: 'About — manorama', description: 'What manorama is — photography-first gallery publishing for the web, iOS, macOS, Windows, Linux and Android.' },
  ),
)
