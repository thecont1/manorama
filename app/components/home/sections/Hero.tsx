import { SignInLinks } from '../../../lib/signin'
import Figure from '../Figure'
import { ASSETS, LIMITS, SAMPLE_GALLERY_PATH, SURFACES } from '../home-manifest'

/**
 * The first fold, in the order a visitor needs it: what manorama is, how to
 * start, and where to get it.
 *
 * The headline runs the width of the page so it holds to two lines; the
 * picture stands beside the words on a wide screen and under them on a
 * narrow one.
 */
export default function Hero({
  returning,
  failed,
  next,
  samplePath = SAMPLE_GALLERY_PATH,
}: {
  /** True when the browser has the returning-visitor hint cookie. */
  returning?: boolean
  /** True when an OAuth round-trip ended in `?error=1`. */
  failed?: boolean
  /** Same-origin path the OAuth callback lands on instead of the dashboard. */
  next?: string
  /** The owner-cleared sample gallery. `null` renders no sample CTA. */
  samplePath?: string | null
}) {
  const hero = ASSETS.find((asset) => asset.id === 'H1')

  return (
    <section class="home-band home-hero" id="start">
      <div class="home-wrap">
        <h1 class="home-h1 home-rise home-rise-1">
          <span class="home-h1-line">Your <em>photographic</em> life.</span>
          <span class="home-h1-line">One beautiful <em>Library</em>.</span>
        </h1>

        <div class="home-hero-grid">
          <div class="home-hero-copy">
            <p class="home-lede home-rise home-rise-2">
              Bring your local folders and shared cloud galleries together — without moving your
              originals.
            </p>

            <div class="home-signin home-rise home-rise-3">
              <h2 class="home-signin-title">Start free or sign in</h2>
              <SignInLinks returning={returning} next={next} />
              <p class="home-note home-signin-note">
                The same button creates your account the first time and signs you in after.
              </p>
              <p class="home-note home-signin-note">
                Free includes {LIMITS.freePermanent} permanent cloud galleries.
              </p>
              {failed ? (
                <p class="home-note home-signin-note">
                  Sign-in didn’t complete. Please try again.
                </p>
              ) : null}
            </div>

            <p class="home-hero-links home-rise home-rise-4">
              {'Manorama runs on '}
              {SURFACES.map((surface, index) => [
                index > 0 ? (index === SURFACES.length - 1 ? ' or ' : ', ') : null,
                surface.url ? (
                  <a key={surface.id} href={surface.href ?? surface.url}>
                    {surface.label}
                  </a>
                ) : (
                  <span key={surface.id} class="home-hero-links-soon">
                    {surface.label}
                  </span>
                ),
              ])}
              .
            </p>

            <p class="home-note home-rise home-rise-4">
              Anyone with a gallery link can view it — no account needed. An account is for your
              own Library.
            </p>

            <p class="home-sources home-rise home-rise-5">
              Works with iCloud Shared Albums · Google Drive · Dropbox · MEGA · Ente · Proton
              Drive
            </p>
            <p class="home-sources-foot home-rise home-rise-5">
              Local folders need Visionary and the Apple Silicon or Windows app. Proton Drive opens
              in the apps, not the browser.
            </p>
          </div>

          {hero ? (
            <div class="home-hero-media home-rise home-rise-2">
              <Figure asset={hero} eager sizes="(min-width: 1024px) 48vw, 100vw" />
              {samplePath ? (
                <p class="home-hero-cta home-rise home-rise-4">
                  <a class="home-btn home-btn-quiet" href={samplePath}>
                    View a sample gallery
                  </a>
                  <span class="home-hero-cta-note">No account needed to view.</span>
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
