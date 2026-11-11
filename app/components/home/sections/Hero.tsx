import { SignInLinks } from '../../../lib/signin'
import Figure from '../Figure'
import { ASSETS, SAMPLE_GALLERY_PATH } from '../home-manifest'
import AccessRow from './AccessRow'

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
          Your photographs. Different places. One beautiful view.
        </h1>

        <div class="home-hero-grid">
          <div class="home-hero-copy">
            <p class="home-lede home-rise home-rise-2">
              Bring your local folders and supported cloud galleries together in one beautiful
              Library. Keep your photographs where they are. Enjoy them together in Manorama.
            </p>

            <div class="home-signin home-rise home-rise-3">
              <h2 class="home-signin-title">Start free or sign in</h2>
              <SignInLinks returning={returning} next={next} />
              <p class="home-note home-signin-note">
                The same sign-in creates your account or welcomes you back.
              </p>
              {failed ? (
                <p class="home-note home-signin-note">
                  Sign-in didn’t complete. Please try again.
                </p>
              ) : null}
            </div>

            {samplePath ? (
              <p class="home-hero-cta home-rise home-rise-4">
                <a class="home-btn home-btn-quiet" href={samplePath}>
                  View a sample gallery
                </a>
              </p>
            ) : null}

            <p class="home-note home-rise home-rise-4">
              Anyone with a gallery link can look, with no account. An account keeps your own
              Library.
            </p>

            <div class="home-rise home-rise-4">
              <AccessRow />
            </div>

            <p class="home-sources home-rise home-rise-5">
              iCloud Shared Albums · Google Drive · Dropbox · MEGA · Ente · Proton Drive · Local
              folders
            </p>
            <p class="home-sources-foot home-rise home-rise-5">
              Local folders need Visionary and the Mac or Windows app. Proton Drive opens in the
              apps.
            </p>
          </div>

          {hero ? (
            <div class="home-hero-media home-rise home-rise-2">
              <Figure asset={hero} eager sizes="(min-width: 1024px) 48vw, 100vw" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
