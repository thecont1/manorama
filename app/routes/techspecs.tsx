import { createRoute } from 'honox/factory'
import { getCookie } from 'hono/cookie'
import { RETURNING_COOKIE } from '../lib/session'
import { signinOriginOf } from '../lib/signin-host'
import { TECH_SPECS_DOC_HTML } from '../lib/site-docs'
import DocShell from '../components/DocShell'

export default createRoute((c) =>
  c.render(
    <DocShell returning={!!getCookie(c, RETURNING_COOKIE)} next={c.req.path} signInOrigin={signinOriginOf(c.env)} html={TECH_SPECS_DOC_HTML} />,
    { home: true, title: 'Tech Specs — manorama', description: 'The manorama engineering reference — architecture, the media model, the viewer contract, provider ingestion, and the native and desktop shells.' },
  ),
)
