import { createRoute } from 'honox/factory'
import { embeddedSourceCandidate } from '../lib/sources'
import { localFolderCandidate } from '../lib/local-source'
import { accessEnvOf, resolveManoramaSession } from '../lib/dropbox-session'

/**
 * The quick-add script URL, resolved for both dev and production.
 *
 * We cannot use honox's `<Script>` here: in production it wraps the tag in
 * `<HasIslands>`, which emits children only when the rendered page contains
 * an island component. This page is pure SSR with no islands, so the tag
 * was silently dropped — the interstitial rendered "Manorama-fying…" and
 * the client never loaded, leaving the page stuck forever (dev was fine
 * because dev-mode Script skips the island gate).
 *
 * Instead we resolve the hashed asset from the same client manifest glob
 * `<Script>` uses, and emit a plain `<script>` unconditionally.
 */
const quickaddScriptSrc = (() => {
  if (!import.meta.env.PROD) return '/app/quickadd.ts'
  const globbed = import.meta.glob<{ default: Record<string, { file: string }> }>(
    '/dist/.vite/manifest.json',
    { eager: true },
  )
  const manifest = Object.values(globbed)[0]?.default
  const file = manifest?.['app/quickadd.ts']?.file
  return file ? `/${file}` : '/app/quickadd.ts'
})()

/**
 * Quick-add: `manorama.xyz/<a supported share URL>` creates the gallery
 * and opens it.
 *
 * ORDERING WARNING — this is a catch-all (`:src{.+}`) and honox sorts
 * bracketed filenames after plain ones and by directory depth. It must
 * always `await next()` for anything that is not provider-shaped, or it
 * will swallow `/[owner]`, `/auth/*` and every other route. The default
 * export is therefore an ARRAY: honox registers array handlers in order
 * and composes them as middleware, so falling through is `next()`.
 *
 * CRITICAL — MEGA and iCloud links carry their decryption key in the URL
 * **fragment**, which a browser never sends to a server. The server can
 * only see enough of the path to know this is a provider link; the real
 * URL is reassembled client-side from `pathname` + `search` + `hash` by
 * app/quickadd.ts. That is also why the sign-in detour round-trips the
 * whole `location.href` through `?next=`.
 */

const PROVIDER_LABEL: Record<string, string> = {
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  icloud: 'iCloud',
  mega: 'MEGA',
  local: 'local folder',
}

// createRoute IS the handler array honox expects (factory.createHandlers),
// so this export is already the `[handler]` shape — do not wrap it again.
export default createRoute(async (c, next) => {
    // c.req.path is already decoded and starts with '/'. Pass the query
    // too: `drive.google.com/open?id=…` carries its folder ID in the query,
    // and the ID is the whole share — dropping it makes a valid folder link
    // fall through to a 404. The fragment is still absent by definition;
    // the client reconstructs that.
    const detected = embeddedSourceCandidate(c.req.path + new URL(c.req.url).search)
      // Dev-only: an absolute path on this machine (`localhost:5173//Users/…`)
      // claims the interstitial when it resolves to a real directory. The flag
      // behind localFolderCandidate exists only under `bun run dev`.
      ?? await localFolderCandidate(c.req.path)
    // Not a share link: hand the request to the real routes. Gallery and
    // owner slugs are [a-z0-9-] with no dot, so they can never match a
    // provider host.
    if (!detected) return next()

    const session = await resolveManoramaSession(c.req.raw, accessEnvOf(c))
    const provider = PROVIDER_LABEL[detected.provider] ?? 'that service'
    // Never indexable, never cached: this page is a one-shot action.
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('Cache-Control', 'no-store')

    return c.render(
      <main class="quickadd-page" data-quickadd data-mode={session ? 'create' : 'signin'} data-provider={detected.provider}>
        <div class="quickadd-card">
          <span class="brand-mark-wrap quickadd-logo-wrap">
            <img src="/manorama-merged-logo.png" alt="manorama" class="quickadd-logo" />
            <span class="brand-tld" aria-hidden="true">.xyz</span>
          </span>

          {session ? (
            <div class="quickadd-panel" data-panel="working">
              <h1 class="quickadd-title">Manorama-fying your<br />{provider} link…</h1>
              <p class="quickadd-copy" data-quickadd-status role="status" aria-live="polite">Reading the album and building your gallery.</p>
              <p class="quickadd-spinner" aria-hidden="true">◍</p>
            </div>
          ) : (
            <div class="quickadd-panel" data-panel="signin">
              <h1 class="quickadd-title">Open this {provider} album as a gallery</h1>
              <p class="quickadd-copy">
                Sign in and Manorama will turn that link into a gallery you can share.
                We only ever read public links.
              </p>
              <a class="landing-signin quickadd-signin" data-quickadd-signin href={detected.provider === 'local' ? '/.dev-seed/login' : '/auth/dropbox'}>
                {detected.provider === 'local' ? (
                  'Sign in (dev)'
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 1.807L0 5.629l6 3.822 6.001-3.822L6 1.807zM18 1.807l-6 3.822 6 3.822 6-3.822-6-3.822zM0 13.274l6 3.822 6.001-3.822L6 9.452l-6 3.822zM18 9.452l-6 3.822 6 3.822 6-3.822-6-3.822zM6 18.371l6.001 3.822 6-3.822-6-3.822L6 18.371z" fill="currentColor" />
                    </svg>
                    Continue with Dropbox
                  </>
                )}
              </a>
              <p class="quickadd-copy quickadd-note" data-quickadd-status role="status" aria-live="polite"></p>
            </div>
          )}
        </div>
        <script type="module" async src={quickaddScriptSrc} />
      </main>,
    { title: 'manorama', description: 'Turn a shared album link into a Manorama gallery.' },
  )
})
