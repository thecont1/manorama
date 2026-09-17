import { createApp } from 'honox/server'
import { createManoramaApi } from './api'
import { handleVendoRequest } from '../vendo/server'
import openapiDocument from '../openapi.json'
import type { HonoSessionEnv, SessionEnv } from './lib/dropbox-session'
import type { RuntimeEnv } from './api'

type AppEnv = HonoSessionEnv & { Bindings: SessionEnv & RuntimeEnv }

const envOf = (c: { env: unknown }) => c.env as RuntimeEnv

const init = (app: ReturnType<typeof createApp<AppEnv>>) => {
  // Management APIs behind the Dropbox session, at one boundary. The
  // owner dashboard (/[owner]) gates itself inside the route handler.
  app.route('/', createManoramaApi())

  // The published API contract — the same document the tests pin and Vendo
  // syncs from. Bundled by the build; no filesystem read at request time.
  app.get('/openapi.json', (c) => c.json(openapiDocument))

  // Route Vendo API requests to the EDGE ESM handler — the same module in
  // the Vite dev server and in the Cloudflare Workers bundle. The old
  // Node-only CJS/PGlite adapter is retired: one composition, every
  // runtime, no CommonJS require seam.
  app.all('/api/vendo/*', async (c) => {
    try {
      return await handleVendoRequest(c.req.raw, envOf(c))
    } catch (error) {
      // Lazy Vendo init or a handler fault must surface as a controlled
      // 5xx, not an escaped exception that can take the process down.
      // The cause is logged server-side; the client gets no internals.
      console.error('vendo request failed:', error instanceof Error ? error.message : String(error))
      return c.json({ error: 'vendo_unavailable' }, 503)
    }
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
