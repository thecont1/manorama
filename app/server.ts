import { createApp } from 'honox/server'
import { createRequire } from 'node:module'
import { createManoramaApi, type RuntimeEnv } from './api'
import { ownerAdminGate } from './lib/admin-gate'

// Load the Vendo CJS handler at module scope. This is fine in the dev-server
// (Node) and in a Cloudflare Workers build the vendo/ route would be handled
// by a separate module if necessary.
const vendoRequire = createRequire(import.meta.url)
const { handleVendoRequest } = vendoRequire('../vendo/handler.cjs')

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv

const init = (app: ReturnType<typeof createApp>) => {
  // Management APIs behind the Cloudflare Access session, at one boundary.
  app.route('/', createManoramaApi())
  // The owner administration page behind the same session gate.
  app.use('/:owner', ownerAdminGate())

  // Route Vendo API requests to the Vendo server.
  // Uses createRequire to load the CJS handler, bypassing Vite's ESM
  // module runner which can't handle CJS-heavy deps (@vercel/oidc, pg,
  // yaml, ajv, @modelcontextprotocol/sdk).
  app.all('/api/vendo/*', async (c) => {
    const response = await handleVendoRequest(c.req.raw, envOf(c))
    return response
  })

  app.use('*', async (c, next) => {
    await next()
    // Only add the X-Robots-Tag header to HTML responses. Static assets
    // (fonts, modules, JSON) are served by the dev server and must not have
    // their content-type or content-length altered.
    const ct = c.res.headers.get('content-type')
    if (ct && ct.includes('text/html')) {
      c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    }
  })
}

const app = createApp({ init })

export default app
