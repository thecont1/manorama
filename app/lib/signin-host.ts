import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { accessEnvOf, resolveManoramaSession, RETURNING_COOKIE } from './session'

/**
 * `signin.manorama.xyz` — the dedicated sign-in host.
 *
 * The marketing homepage on the apex stays public for everyone, signed in
 * or not. Every authentication surface lives on the subdomain instead:
 *
 * - `signin.manorama.xyz/` is a small chooser page — the provider buttons,
 *   the retry note, and a signed-in state that links back to the app.
 * - `signin.manorama.xyz/auth/*` is the whole OAuth surface — start,
 *   callback, confirm, logout — the same routes the apex used to serve.
 * - Every other path on the subdomain redirects to the app host, and every
 *   `/auth/*` request on the app host redirects here, so sign-in can never
 *   happen anywhere else. `/auth/logout` is exempt on the apex: the
 *   dashboard's sign-out must land back on the homepage, not the chooser.
 *
 * The session and returning cookies become `Domain=<apex>` cookies when
 * the subdomain is configured: the OAuth callback sets them on the sign-in
 * host, the dashboard and APIs read them on the apex, and deletions must
 * carry the same `Domain` or the shared cookie survives the sign-out.
 *
 * The feature is off unless `SIGNIN_HOST` is configured — dev, staging
 * and tests keep auth on the request host exactly as before.
 */

type SigninHostEnv = { SIGNIN_HOST?: unknown; PUBLIC_HOST?: unknown }

/** Env bags arrive typed differently per call site — Hono's `object`,
 *  SessionEnv, plain test records — and the helpers only read two keys. */
const envBag = (env: unknown): SigninHostEnv =>
  env && typeof env === 'object' ? env as SigninHostEnv : {}

const hostText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const signinHostOf = (env: unknown): string | undefined => {
  const host = hostText(envBag(env).SIGNIN_HOST).toLowerCase()
  return host || undefined
}

export const isSigninHost = (hostname: string, env: unknown): boolean => {
  const host = signinHostOf(env)
  return Boolean(host) && hostname.toLowerCase() === host
}

/** `https://signin.manorama.xyz` — where sign-in links point. Undefined
 *  while the feature is off, so callers fall back to relative `/auth/*`. */
export const signinOriginOf = (env: unknown): string | undefined => {
  const host = signinHostOf(env)
  return host ? `https://${host}` : undefined
}

/** The app host an auth flow lands on once a session exists. */
export const appOriginOf = (env: unknown): string =>
  `https://${hostText(envBag(env).PUBLIC_HOST) || 'manorama.xyz'}`

/** The `Domain` attribute the session cookies carry when the sign-in host
 *  is configured — the apex both hosts share. Without `SIGNIN_HOST` the
 *  cookies stay host-only, exactly as before. */
export const sessionCookieDomain = (env: unknown): string | undefined => {
  const bag = envBag(env)
  const host = hostText(bag.SIGNIN_HOST).toLowerCase()
  if (!host) return undefined
  return hostText(bag.PUBLIC_HOST) || host.replace(/^signin\./, '')
}

/** GET/HEAD keep the familiar 302; anything else needs 307 so a POST
 *  (Apple's form_post, the pending-account confirm) survives the hop. */
const redirectStatus = (method: string) => (method === 'GET' || method === 'HEAD' ? 302 : 307)

/** The worker-level host gate. Mounted once in server.ts after the dev-D1
 *  injector so the chooser can resolve sessions the same way routes do. */
export const signinHostGate = (): MiddlewareHandler =>
  async (c, next) => {
    const signinHost = signinHostOf(c.env)
    if (!signinHost) return next()
    const url = new URL(c.req.url)
    if (isSigninHost(url.hostname, c.env)) {
      if (url.pathname === '/') return signinPage(c)
      // /auth/* is the sign-in surface itself; everything else lives on
      // the app host.
      if (url.pathname.startsWith('/auth/')) return next()
      return c.redirect(`${appOriginOf(c.env)}${url.pathname}${url.search}`, redirectStatus(c.req.method))
    }
    if (url.pathname.startsWith('/auth/') && url.pathname !== '/auth/logout') {
      return c.redirect(`https://${signinHost}${url.pathname}${url.search}`, redirectStatus(c.req.method))
    }
    await next()
  }

const esc = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

// The same monochrome marks the chooser components draw — inlined because
// this page is a bare HTML response, not JSX.
const GLYPHS = {
  apple: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.702" fill="currentColor"/></svg>',
  dropbox: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z" fill="currentColor"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.828 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" fill="currentColor"/></svg>',
} as const

// Apple leads the row everywhere — App Review 4.8 requires it given no
// less prominence than the other providers.
const CHOOSER_PROVIDERS = [
  { id: 'apple', name: 'Apple' },
  { id: 'dropbox', name: 'Dropbox' },
  { id: 'google', name: 'Google' },
] as const

/** The chooser the sign-in host serves at `/`. Self-contained HTML — it
 *  renders in the host gate, before any route renderer is involved. */
const signinPage = async (c: Context): Promise<Response> => {
  const env = accessEnvOf(c)
  const url = new URL(c.req.url)
  const session = await resolveManoramaSession(c.req.raw, env).catch(() => null)
  const failed = url.searchParams.get('error') === '1'
  // Path-relative only — the same rule the homepage door applies. The
  // OAuth callback re-validates against the app origin before it lands.
  const rawNext = url.searchParams.get('next') ?? ''
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : undefined
  const returning = Boolean(getCookie(c, RETURNING_COOKIE))
  const appOrigin = appOriginOf(env)
  const verb = returning ? 'Sign in' : 'Continue'
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : ''

  const inner = session
    ? `<h1>You&rsquo;re signed in</h1>
<p>Signed in as ${esc(session.name)}.</p>
<div class="actions">
<a class="btn create" href="${esc(next ? `${appOrigin}${next}` : `${appOrigin}/${session.ownerSlug}`)}">${next ? 'Continue' : 'Open your galleries'}</a>
<form method="post" action="/auth/logout"><button class="btn back" type="submit">Sign out</button></form>
</div>`
    : `<h1>${verb} to manorama</h1>
<p>Choose a provider to continue to your galleries.</p>
${failed ? '<p class="note">Sign-in didn&rsquo;t complete. Please try again.</p>' : ''}
<div class="providers">${CHOOSER_PROVIDERS.map((provider) =>
      `<a class="provider" href="/auth/${provider.id}${nextQuery}">${GLYPHS[provider.id]}<span>${verb} with ${provider.name}</span></a>`,
    ).join('')}</div>`

  c.header('Cache-Control', 'no-store')
  return c.html(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>manorama — sign in</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#111312;color:#e8e6e3;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif}
.card{max-width:30rem;padding:2.5rem 2rem;text-align:center}
.card img{width:15rem;height:auto;margin-bottom:1.75rem;transform:translateX(-9.2%)}
h1{font-size:1.5rem;font-weight:600;margin:0 0 1rem}
p{color:#b9b5ae;line-height:1.55;margin:0 0 1rem;font-size:.95rem}
p.note{color:#8a867e;font-size:.85rem}
.providers{display:flex;flex-direction:column;gap:.6rem;margin-top:1.75rem}
.provider{display:flex;align-items:center;justify-content:center;gap:.6rem;min-height:52px;
padding:0 1.25rem;border-radius:999px;border:1px solid #3a3d3b;background:transparent;
color:#e8e6e3;font-size:1rem;font-weight:600;text-decoration:none;
transition:border-color 120ms ease-out,color 120ms ease-out}
.provider:hover{border-color:#8a867e;color:#fff}
.provider svg{width:20px;height:20px;flex:none}
.actions{display:flex;flex-direction:column;gap:.75rem;margin-top:1.75rem}
.btn{display:block;border-radius:999px;min-height:52px;line-height:52px;text-align:center;
font-size:1rem;font-weight:600;text-decoration:none;cursor:pointer;border:none;width:100%;box-sizing:border-box}
.create{background:#e8e6e3;color:#111312}
.back{background:transparent;color:#b9b5ae;border:1px solid #3a3d3b}
.foot{margin-top:1.75rem;font-size:.85rem}
.foot a{color:#8a867e}
</style></head><body><main class="card">
<img src="${esc(appOrigin)}/manorama-merged-logo.png" alt="manorama">
${inner}
<p class="foot"><a href="${esc(appOrigin)}/">Back to manorama</a></p>
</main></body></html>`)
}
