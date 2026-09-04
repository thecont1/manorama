import { createApp } from 'honox/server'
import { createManoramaApi, type RuntimeEnv } from './api'
import { ownerAdminGate } from './lib/admin-gate'
import { handleVendoRequest } from '../vendo/server'

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv

const init = (app: ReturnType<typeof createApp>) => {
  // Management APIs behind the Cloudflare Access session, at one boundary.
  app.route('/', createManoramaApi())
  // The owner administration page behind the same session gate.
  app.use('/:owner', ownerAdminGate())

  // Route Vendo API requests to the EDGE ESM handler — the same module in
  // the Vite dev server and in the Cloudflare Workers bundle. The old
  // Node-only CJS/PGlite adapter is retired: one composition, every
  // runtime, no CommonJS require seam.
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
