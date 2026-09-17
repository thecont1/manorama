import build from '@hono/vite-build/cloudflare-workers'
import adapter from '@hono/vite-dev-server/node'
import honox from 'honox/vite'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

/**
 * Dev-only gallery seeding for `bun run dev`.
 *
 * With no D1 binding the user/gallery repositories fall back to in-memory
 * Maps that boot empty, and Dropbox OAuth is the only in-band way to mint
 * a user — so the Playwright suite (and manual QA) has nothing to run
 * against. This plugin seeds that store through `server.ssrLoadModule`,
 * which resolves the SAME module instances the dev server's SSR graph
 * uses.
 *
 * `apply: 'serve'` means the production Worker bundle never sees any of
 * this — the seeded data exists only in vite dev.
 *
 * Seeds:
 *  - user `dbid:AAATESTowner1` → owner slug `thecontrarian` (the spec's
 *    default GALLERY_OWNER)
 *  - one gallery per MANORAMA_DEV_SOURCE_<PROVIDER> var set in
 *    .env.local, live-scanned at boot: ICLOUD → mixed-album (the video
 *    gallery GALLERY_VIDEO_SLUG points at), MEGA → dev-mega, DROPBOX →
 *    dev-dropbox, GDRIVE → dev-gdrive. MANORAMA_DEV_VIDEO_URL predates
 *    the per-provider names and still fills the iCloud slot.
 *
 * There is no bundled sample data: a checkout with no source vars seeds
 * an owner and nothing else, so anything the suite runs against is a real
 * album fetched from a real provider.
 */

/** Env-var name → seeded slug for live-scanned dev galleries. */
const DEV_SEED_SOURCES: { env: string; slug: string }[] = [
  { env: 'MANORAMA_DEV_SOURCE_ICLOUD', slug: 'mixed-album' },
  { env: 'MANORAMA_DEV_SOURCE_MEGA', slug: 'dev-mega' },
  { env: 'MANORAMA_DEV_SOURCE_DROPBOX', slug: 'dev-dropbox' },
  { env: 'MANORAMA_DEV_SOURCE_GDRIVE', slug: 'dev-gdrive' },
]
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
      client: { input: ['/app/client.ts', '/app/vendo-client.tsx', '/app/quickadd.ts', '/app/styles.css'] },
    }),
    build(),
  ],
  ssr: {
    // These dependencies (pulled in through @vendoai/vendo's graph) ship
    // CommonJS builds that Vite's ESM module runner cannot evaluate
    // ("module is not defined" / "require is not defined"). Node's native
    // import handles them via the require condition, and the Cloudflare
    // Workers build handles CJS fine — only the dev-server SSR path needs
    // the externalization. Subpath entries also cover nested copies under
    // other packages' node_modules.
    external: [
      '@vercel/oidc',
      '@vercel/oidc/*',
      'pg',
      'pg/*',
      'yaml',
      'yaml/*',
      'ajv',
      'ajv/*',
      'ajv-formats',
      'ajv-formats/*',
      '@modelcontextprotocol/sdk',
      '@modelcontextprotocol/sdk/*',
      // The OG card compositor loads both lazily inside SSR: jimp's graph
      // has CJS deps and sharp is a native binding — neither can be
      // evaluated by the ESM module runner.
      'jimp',
      'sharp',
    ],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}))
