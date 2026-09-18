import { createApp } from 'honox/server'
import { createManoramaApi } from './api'
import openapiDocument from '../openapi.json'
import type { HonoSessionEnv, SessionEnv } from './lib/dropbox-session'
import type { RuntimeEnv } from './api'

type AppEnv = HonoSessionEnv & { Bindings: SessionEnv & RuntimeEnv }

// Process-level containment: a rejection that escapes on a floating
// promise would kill the Bun/Node dev process (and is undefined
// behaviour elsewhere). Log it and keep serving — availability beats a
// restart. workerd's nodejs_compat exposes process.on too; where it
// doesn't exist this is a no-op.
const runtimeProcess = (globalThis as typeof globalThis & {
  process?: { on?: (event: string, listener: (reason: unknown) => void) => void }
}).process
runtimeProcess?.on?.('unhandledRejection', (reason) => {
  console.error('unhandled rejection contained:', reason instanceof Error ? reason.message : String(reason))
})
runtimeProcess?.on?.('uncaughtException', (error) => {
  console.error('uncaught exception contained:', error instanceof Error ? error.message : String(error))
})

const init = (app: ReturnType<typeof createApp<AppEnv>>) => {
  // Management APIs behind the Dropbox session, at one boundary. The
  // owner dashboard (/[owner]) gates itself inside the route handler.
  app.route('/', createManoramaApi())

  // The published API contract — the same document the tests pin and Vendo
  // syncs from. Bundled by the build; no filesystem read at request time.
  app.get('/openapi.json', (c) => c.json(openapiDocument))

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
