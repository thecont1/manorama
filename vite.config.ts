import build from '@hono/vite-build/cloudflare-workers'
import adapter from '@hono/vite-dev-server/node'
import honox from 'honox/vite'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

/** Default manifest item for spawn-seeded galleries: a 1×1 PNG data URI. */
const DEV_SPAWN_IMAGE = {
  id: 'dev-spawn-pixel',
  filename: 'dev-spawn-pixel.png',
  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  width: 1,
  height: 1,
  alt: 'dev seed pixel',
  c2pa: false,
  placeholder: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
}

/** Env-var name → seeded slug for live-scanned dev galleries. */
const DEV_SEED_SOURCES: { env: string; slug: string }[] = [
  { env: 'MANORAMA_DEV_SOURCE_ICLOUD', slug: 'mixed-album' },
  { env: 'MANORAMA_DEV_SOURCE_MEGA', slug: 'dev-mega' },
  { env: 'MANORAMA_DEV_SOURCE_DROPBOX', slug: 'dev-dropbox' },
  { env: 'MANORAMA_DEV_SOURCE_GDRIVE', slug: 'dev-gdrive' },
]

/**
 * Provides dev-only gallery fixtures and retention actions for `bun run dev`.
 *
 * With no D1 binding the user/gallery repositories fall back to in-memory
 * Maps that boot empty, and Dropbox OAuth is the only in-band way to mint
 * a user. This plugin seeds the same module instances used by the dev server's
 * SSR graph and exposes reset, tier, spawn, and expiry endpoints for QA.
 *
 * `apply: 'serve'` keeps the plugin and its data out of production builds.
 * It seeds the pro `thecontrarian` owner, an isolated free `retention-qa`
 * owner, and one live-scanned gallery for each configured
 * MANORAMA_DEV_SOURCE_<PROVIDER> value. With no source variables, it seeds
 * only the two owners and no galleries.
 */
const manoramaDevSeed = (): Plugin => {
  type UserRepo = typeof import('./app/lib/user-repository')
  type GalleryRepo = typeof import('./app/lib/gallery-repository')
  type Sources = typeof import('./app/lib/sources')
  type GalleryRecord = Parameters<GalleryRepo['createGallery']>[1]

  let users: UserRepo | null = null
  let galleries: GalleryRepo | null = null
  // Pristine copies of every seeded gallery — resets re-insert clones of
  // these instead of re-scanning the live source (network) or reading the
  // manifest again, so a reset is a same-tick operation a test can afford
  // to run before every case.
  let pristine: { ownerId: string; gallery: GalleryRecord }[] = []

  const applySeed = async () => {
    if (!users || !galleries) throw new Error('dev-seed modules not loaded')
    users.resetUserStore()
    galleries.resetGalleryStore()
    const owner = await users.upsertUser({
      dropboxAccountId: 'dbid:AAATESTowner1',
      displayName: 'thecontrarian',
      email: 'mahesh@manorama.xyz',
    })
    // Pro: the admin page mounts the real Vendo surface only for pro tier,
    // and the vendo-surface spec drives that launcher.
    await users.setUserTier(owner.dropboxAccountId, 'pro')
    // A second free-tier owner (slug `retention-qa`, no galleries) gives
    // the retention/density specs an isolated account whose gallery count
    // never depends on which provider vars happen to be set.
    await users.upsertUser({
      dropboxAccountId: 'dbid:AAATESTretention',
      displayName: 'Retention QA',
      email: 'retention-qa@manorama.xyz',
    })
    for (const { ownerId, gallery } of pristine) {
      await galleries.createGallery(ownerId, structuredClone(gallery))
    }
    return owner
  }

  const seed = async (server: ViteDevServer) => {
    users = await server.ssrLoadModule('/app/lib/user-repository.ts') as unknown as UserRepo
    galleries = await server.ssrLoadModule('/app/lib/gallery-repository.ts') as unknown as GalleryRepo
    const seededGalleries: { ownerId: string; gallery: GalleryRecord }[] = []
    const ownerId = 'dbid:AAATESTowner1'

    // Live albums are seeded first (older createdAt) so the fixture
    // stays the newest — and therefore the first — admin card. Only the
    // vars that are set get scanned; identical URLs seed once.
    const sourceSeeds = DEV_SEED_SOURCES
      .map(({ env, slug }) => ({ slug, url: process.env[env]?.trim() }))
      .filter((entry): entry is { slug: string; url: string } => Boolean(entry.url))
    const videoAlias = process.env.MANORAMA_DEV_VIDEO_URL?.trim()
    if (videoAlias && !sourceSeeds.some((entry) => entry.slug === 'mixed-album')) {
      sourceSeeds.unshift({ slug: 'mixed-album', url: videoAlias })
    }
    const sources = sourceSeeds.length
      ? await server.ssrLoadModule('/app/lib/sources.ts') as unknown as Sources
      : null
    const seenUrls = new Set<string>()
    const scans = await Promise.all(sourceSeeds.map(async ({ slug, url }) => {
      if (seenUrls.has(url)) return null
      seenUrls.add(url)
      try {
        return { slug, scan: await sources!.scanSource(url, process.env) }
      } catch (error) {
        console.warn(`[dev-seed] ${slug} scan failed; gallery not seeded:`, error instanceof Error ? error.message : error)
        return null
      }
    }))
    let sourceIndex = 0
    for (const result of scans) {
      if (!result) continue
      const { slug, scan } = result
      const firstVideo = scan.images.findIndex((item) => item.type === 'video')
      const images = firstVideo > 0
        ? [scan.images[firstVideo], ...scan.images.filter((_, index) => index !== firstVideo)]
        : scan.images
      seededGalleries.push({
        ownerId,
        gallery: {
          slug,
          title: scan.title,
          caption: '',
          date: '',
          sourceUrl: scan.sourceUrl,
          createdAt: new Date(Date.now() - 60_000 * (sourceIndex + 1)).toISOString(),
          images,
        } as GalleryRecord,
      })
      sourceIndex += 1
      const videos = scan.images.filter((item) => item.type === 'video').length
      console.log(`[dev-seed] live scan: ${scan.images.length} items (${videos} video) → ${slug}`)
    }

    pristine = seededGalleries.map((entry) => structuredClone(entry))
    const owner = await applySeed()
    const slugs = pristine.map(({ gallery }) => gallery.slug).join(', ')
    console.log(slugs
      ? `[dev-seed] owner '${owner.ownerSlug}' seeded: ${slugs}`
      : `[dev-seed] owner '${owner.ownerSlug}' seeded with no galleries — set MANORAMA_DEV_SOURCE_<PROVIDER> in .env.local to seed real albums`)
  }

  // The server accepts connections before the seed finishes (seed() awaits
  // ssrLoadModule). Handlers await this so a reset never races the initial
  // seed and returns a 500 from null repositories.
  let seeded: Promise<void> = Promise.resolve()

  return {
    name: 'manorama-dev-seed',
    apply: 'serve',
    configureServer(server) {
      // Turns on the local-folder source (app/lib/local-source.ts): quick-add
      // `localhost:5173//Users/…/album`, `file://` and absolute-path pastes in
      // the dashboard, and the /api/local/file media route. The flag lives on
      // the globalThis the SSR graph shares; `apply: 'serve'` means no build
      // can ever see it set.
      ;(globalThis as { __manoramaLocalSources?: boolean }).__manoramaLocalSources = true

      // Dev sign-in for the seeded owner — the quick-add interstitial points
      // here for local folders, so a folder path becomes a gallery without a
      // Dropbox round-trip. Mints the same manorama_session cookie OAuth
      // would, then returns to `next`.
      server.middlewares.use('/.dev-seed/login', (req, res) => {
        seeded
          .then(async () => {
            const secret = process.env.HOST_API_JWT_SECRET?.trim()
            if (!secret) throw new Error('HOST_API_JWT_SECRET is not set')
            const session = await server.ssrLoadModule('/app/lib/dropbox-session.ts') as unknown as typeof import('./app/lib/dropbox-session')
            const token = await session.createSessionToken('dbid:AAATESTowner1', secret)
            const query = req.url?.split('?')[1] ?? ''
            const next = new URLSearchParams(query).get('next')
            // Return to same-origin paths only; a full quick-add URL
            // (location.href) parses to localhost and is accepted.
            let target = '/thecontrarian'
            if (next) {
              try {
                const parsed = new URL(next, 'http://localhost')
                if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
                  // Absolute form: a quick-add `next` carries the folder path
                  // verbatim, so its pathname may begin with `//` — a bare
                  // path Location would read as a network-path reference and
                  // send the browser to a foreign host.
                  target = parsed.href
                }
              } catch {
                if (next.startsWith('/') && !next.startsWith('//')) target = next
              }
            }
            res.statusCode = 302
            res.setHeader('Set-Cookie', `manorama_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`)
            res.setHeader('Location', target)
            res.end()
          })
          .catch((error) => {
            res.statusCode = 500
            res.end(String(error))
          })
      })

      // Test seam mirroring resetUserStore/resetGalleryStore: the specs
      // mutate the in-memory repos (slug edits, reorders, creates), so each
      // case restores canonical state instead of depending on run order.
      server.middlewares.use('/.dev-seed/reset', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        seeded
          .then(() => applySeed())
          .then(() => {
            res.statusCode = 204
            res.end()
          })
          .catch((error) => {
            res.statusCode = 500
            res.end(String(error))
          })
      })

      const readJson = (req: import('node:http').IncomingMessage) => new Promise<Record<string, unknown>>((resolve, reject) => {
        let data = ''
        req.on('data', (chunk) => { data += chunk })
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) as Record<string, unknown> : {}) }
          catch (error) { reject(error) }
        })
        req.on('error', reject)
      })
      const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }
      const devAction = (handler: (body: Record<string, unknown>) => Promise<unknown>) =>
        (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end()
            return
          }
          seeded
            .then(() => readJson(req))
            .then(handler)
            .then((body) => sendJson(res, 200, body))
            .catch((error) => sendJson(res, 500, { error: String(error) }))
        }

      // Retention spec seams: flip a seeded account's tier through the real
      // setUserTier upgrade path, create manifest-only galleries through the
      // shared createGalleryWithinLimit policy (no provider scan), and run
      // the real expiry service — all against the in-memory repositories.
      server.middlewares.use('/.dev-seed/tier', devAction(async (body) => {
        if (!users) throw new Error('dev-seed modules not loaded')
        const accountId = typeof body.accountId === 'string' ? body.accountId : 'dbid:AAATESTowner1'
        const tier = body.tier === 'pro' ? 'pro' : 'free'
        const user = await users.setUserTier(accountId, tier)
        return { tier: user?.tier ?? null }
      }))
      server.middlewares.use('/.dev-seed/spawn', devAction(async (body) => {
        if (!galleries) throw new Error('dev-seed modules not loaded')
        const accountId = typeof body.accountId === 'string' ? body.accountId : 'dbid:AAATESTowner1'
        const items = Array.isArray(body.galleries) ? body.galleries : []
        const results: Record<string, unknown>[] = []
        for (const item of items) {
          const entry = item as { slug?: unknown; createdAt?: unknown; images?: unknown }
          if (typeof entry?.slug !== 'string' || !entry.slug) {
            results.push({ ok: false, reason: 'invalid' })
            continue
          }
          const result = await galleries.createGalleryWithinLimit(accountId, {
            slug: entry.slug,
            title: entry.slug,
            caption: '',
            date: '',
            sourceUrl: `dev-seed://spawn/${entry.slug}`,
            createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
            images: (Array.isArray(entry.images) ? entry.images : [DEV_SPAWN_IMAGE]) as GalleryRecord['images'],
          } as GalleryRecord)
          results.push(result.ok
            ? { ok: true, slug: entry.slug, retention: result.gallery.retention ?? 'retained', expiresAt: result.gallery.expiresAt ?? null }
            : { ok: false, slug: entry.slug, reason: result.reason })
        }
        return { results }
      }))
      server.middlewares.use('/.dev-seed/expire', devAction(async (body) => {
        const repo = galleries
        if (!repo) throw new Error('dev-seed modules not loaded')
        const expiry = await server.ssrLoadModule('/app/lib/gallery-expiry.ts') as unknown as typeof import('./app/lib/gallery-expiry')
        const now = typeof body.now === 'string' ? body.now : new Date().toISOString()
        return expiry.expirePipelineGalleries({
          list: (at, after, limit) => repo.listExpiredPipelineGalleries(at, undefined, after, limit),
          remove: (key, at) => repo.deleteExpiredPipelineGallery(key, at),
        }, now)
      }))
      server.httpServer?.once('listening', () => {
        seeded = seed(server).catch((error) => {
          console.warn('[dev-seed] seeding failed:', error)
        })
      })
    },
  }
}

export default defineConfig(() => ({
  plugins: [
    manoramaDevSeed(),
    honox({
      devServer: {
        adapter,
        // Vite must handle source assets and Vendo config files. When these
        // are passed to Hono, they 404 because there is no matching route.
        // This list mirrors HonoX's defaults plus / .vendo/*.
        exclude: [
          /.*\.css$/,
          /.*\.ts$/,
          /.*\.tsx$/,
          /.*\.mdx?$/,
          /^\/\@.+$/,
          /\?t\=\d+$/,
          /^\/favicon\.ico$/,
          /^\/static\/.+/,
          /^\/node_modules\/.*/,
          /^\/\.vite\/.*/,
          /.*\.svelte$/,
          /.*\.vue$/,
          /.*\.js$/,
          /.*\.jsx$/,
          /.*\.mjs$/,
          /^\/app\/.+\.tsx?/,
          /^\/\.vendo\/.*/,
        ],
      },
      client: { input: ['/app/client.ts', '/app/quickadd.ts', '/app/styles.css'] },
    }),
    build(),
  ],
  ssr: {
    external: [
      // The OG card compositor loads both lazily inside SSR: jimp's graph
      // has CJS deps and sharp is a native binding — neither can be
      // evaluated by the ESM module runner.
      'jimp',
      'sharp',
    ],
  },
  server: {
    watch: {
      // HonoX's restartOnAddUnlink calls server.restart() on chokidar
      // add/unlink events — and those events fire for every watched path,
      // i.e. the whole project root, not just app/**. Any file created or
      // deleted here bounces the dev server and wipes the seeded in-memory
      // galleries for the ~40s live rescan. These tool-managed dirs write
      // files on their own schedule (vendo's embedded Postgres keeps its
      // data + WAL under .vendo/data), so keep them out of the watch set.
      ignored: ['**/.vendo/**', '**/.playwright-mcp/**', '**/.wrangler/**'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}))
