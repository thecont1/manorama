import build from '@hono/vite-build/cloudflare-workers'
import adapter from '@hono/vite-dev-server/node'
import honox from 'honox/vite'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'

/**
 * Dev-only gallery fixtures for `bun run dev`.
 *
 * With no D1 binding the user/gallery repositories fall back to in-memory
 * Maps that boot empty, and Dropbox OAuth is the only in-band way to mint
 * a user — so the Playwright suite (and manual QA) has nothing to run
 * against. This plugin seeds that store through `server.ssrLoadModule`,
 * which resolves the SAME module instances the dev server's SSR graph
 * uses. It also serves `test/fixtures/` at `/.dev-fixture/` so the seeded
 * gallery loads real bytes.
 *
 * `apply: 'serve'` means the production Worker bundle never sees any of
 * this — the fixture URL space and seeded data exist only in vite dev.
 *
 * Seeds:
 *  - user `dbid:AAATESTowner1` → owner slug `thecontrarian` (the spec's
 *    default GALLERY_OWNER), plus `dbid:AAATOTHERuser` → `another-dev`
 *  - gallery `kashmir`: the restored 9-image Italy manifest the
 *    acceptance suite was authored against (credentialed JPEG at index 1)
 *  - gallery `mixed-album`: a LIVE scan of MANORAMA_DEV_VIDEO_URL (set in
 *    .env.local), reordered so a video slide sits at index 0
 */
const manoramaDevSeed = (): Plugin => {
  const fixtureRoot = fileURLToPath(new URL('./test/fixtures/', import.meta.url))
  const fixtureTypes: Record<string, string> = {
    '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml',
  }

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
    await users.upsertUser({
      dropboxAccountId: 'dbid:AAATOTHERuser',
      displayName: 'Another Dev',
      email: 'another@manorama.xyz',
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

    // The live album is seeded first (older createdAt) so the fixture
    // stays the newest — and therefore the first — admin card.
    const videoSource = process.env.MANORAMA_DEV_VIDEO_URL?.trim()
    if (videoSource) {
      try {
        const sources = await server.ssrLoadModule('/app/lib/sources.ts') as unknown as Sources
        const scan = await sources.scanSource(videoSource, process.env)
        const firstVideo = scan.images.findIndex((item) => item.type === 'video')
        const images = firstVideo > 0
          ? [scan.images[firstVideo], ...scan.images.filter((_, index) => index !== firstVideo)]
          : scan.images
        seededGalleries.push({
          ownerId,
          gallery: {
            slug: 'mixed-album',
            title: scan.title,
            caption: '',
            date: '',
            sourceUrl: scan.sourceUrl,
            createdAt: new Date(Date.now() - 60_000).toISOString(),
            images,
          } as GalleryRecord,
        })
        const videos = scan.images.filter((item) => item.type === 'video').length
        console.log(`[dev-seed] live scan: ${scan.images.length} items (${videos} video) → mixed-album`)
      } catch (error) {
        console.warn('[dev-seed] MANORAMA_DEV_VIDEO_URL scan failed; video gallery not seeded:', error instanceof Error ? error.message : error)
      }
    }

    const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'italy-2018/manifest.json'), 'utf8')) as {
      title: string; caption: string; date: string
      images: { src: string; variants?: { src: string }[] }[]
    }
    const images = manifest.images.map((image) => ({
      ...image,
      src: image.src.replace('/images/', '/.dev-fixture/'),
      variants: image.variants?.map((variant) => ({ ...variant, src: variant.src.replace('/images/', '/.dev-fixture/') })),
    }))
    seededGalleries.push({
      ownerId,
      gallery: {
        slug: 'kashmir',
        title: manifest.title,
        caption: manifest.caption,
        date: manifest.date,
        createdAt: new Date().toISOString(),
        images: images as never,
      } as GalleryRecord,
    })

    pristine = seededGalleries.map((entry) => structuredClone(entry))
    const owner = await applySeed()
    console.log(`[dev-seed] owner '${owner.ownerSlug}' seeded: ${pristine.map(({ gallery }) => gallery.slug).join(', ')}`)
  }

  return {
    name: 'manorama-dev-seed',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/.dev-fixture', (req, res) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        const file = normalize(join(fixtureRoot, name))
        const ext = name.slice(name.lastIndexOf('.'))
        if (!name || name.includes('..') || !file.startsWith(fixtureRoot) || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        res.setHeader('Content-Type', fixtureTypes[ext] ?? 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-cache')
        createReadStream(file).pipe(res)
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
        applySeed()
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
        seed(server).catch((error) => console.warn('[dev-seed] seeding failed:', error))
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
