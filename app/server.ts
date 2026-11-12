import { createApp } from 'honox/server'
import { createManoramaApi } from './api'
import openapiDocument from '../openapi.json'
import type { HonoSessionEnv, SessionEnv } from './lib/session'
import type { RuntimeEnv } from './api'
import { expirePipelineGalleries } from './lib/gallery-expiry'
import { deleteExpiredPipelineGallery, listExpiredPipelineGalleries } from './lib/gallery-repository'
import { injectDevD1 } from './lib/dev-d1'
import { handleDownloads, isDownloadHost } from './lib/downloads'

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
  // downloads.manorama.xyz is a public installer host on the same Worker —
  // it short-circuits before the app sees the request.
  app.use('*', async (c, next) => {
    if (isDownloadHost(new URL(c.req.url).hostname)) {
      return handleDownloads(c.req.raw, c.env)
    }
    await next()
  })

  // Dev-only: when MANORAMA_DEV_D1 parked a local D1 on globalThis, expose
  // it as env.DB before any handler reads c.env. No-op in production.
  app.use('*', injectDevD1)

  // Management APIs behind the Dropbox session, at one boundary. The
  // owner dashboard (/[owner]) gates itself inside the route handler.
  app.route('/', createManoramaApi())

  // The published API contract — the same document the contract tests pin.
  // Bundled by the build; no filesystem read at request time.
  app.get('/openapi.json', (c) => c.json(openapiDocument))

  app.use('*', async (c, next) => {
    await next()
    // Only add the X-Robots-Tag header to HTML responses. Static assets
    // (fonts, modules, JSON) are served by the dev server and must not have
    // their content-type or content-length altered.
    const ct = c.res.headers.get('content-type')
    if (ct && ct.includes('text/html')) {
      // The homepage is the one page the world may find, so it carries no
      // noindex header. A signed-in visitor is redirected before any HTML
      // exists, and a redirect is not a page to index.
      if (!(c.req.path === '/' && c.res.status < 300)) {
        c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
      }
    }
  })
}

const app = createApp({ init })

export default Object.assign(app, {
  /** Runs the bounded gallery-expiry job and logs its counters. Throws when the
   *  database binding is absent, listing fails, or any removal throws. */
  async scheduled(controller: ScheduledController, env: AppEnv['Bindings']) {
    const now = new Date(controller.scheduledTime).toISOString()
    if (!env?.DB) throw new Error('Gallery expiry requires the D1 database binding')
    let counters: { scanned: number; deleted: number; skipped: number; failed: number; truncated: boolean }
    try {
      counters = await expirePipelineGalleries({
        list: (at, after, limit) => listExpiredPipelineGalleries(at, env, after, limit),
        remove: (key, at) => deleteExpiredPipelineGallery(key, at, env),
      }, now)
    } catch {
      console.log(JSON.stringify({ event: 'gallery_expiry', at: now, failed: -1 }))
      throw new Error('Gallery expiry failed')
    }
    console.log(JSON.stringify({ event: 'gallery_expiry', at: now, ...counters }))
    if (counters.failed || counters.truncated) throw new Error('Gallery expiry incomplete')
  },
})
