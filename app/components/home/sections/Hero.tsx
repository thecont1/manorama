import HomeDemo from '../../../islands/HomeDemo'
import Figure from '../Figure'
import { ASSETS, SAMPLE_GALLERY_PATH, SURFACES } from '../home-manifest'

/**
 * The first fold, in the order a visitor meets it: the headline and lede, then
 * the live photograph demo as the centrepiece directly beneath the words, then
 * the sample gallery and the platforms. Sign-in lives in the header's own
 * disclosure now, so the fold is left to the photographs.
 */
export default function Hero({
  samplePath = SAMPLE_GALLERY_PATH,
  demo = false,
}: {
  /** The owner-cleared sample gallery. `null` renders no sample CTA. */
  samplePath?: string | null
  /** True to enhance the hero with the live photo demo under the headline. */
  demo?: boolean
}) {
  const hero = ASSETS.find((asset) => asset.id === 'H1')

  return (
    <section class="home-band home-hero" id="start">
      <div class="home-wrap">
        <h1 class="home-h1 home-rise home-rise-1">
          <span class="home-h1-line">Your <em>photographic</em> life.</span>
          <span class="home-h1-line">One beautiful <em>Library</em>.</span>
        </h1>

        <p class="home-lede home-rise home-rise-2">
          Bring your local folders and shared cloud galleries together — without moving your
          originals.
        </p>

        {hero ? (
          <div class="home-hero-stage home-rise home-rise-2">
            {demo ? (
              <>
                <HomeDemo />
                <p class="home-figure-caption">{hero.caption}</p>
              </>
            ) : (
              <Figure asset={hero} eager sizes="(min-width: 1024px) 720px, 92vw" />
            )}
          </div>
        ) : null}

        <div class="home-hero-after">
          {samplePath ? (
            <p class="home-hero-cta home-rise home-rise-3">
              <a class="home-btn home-btn-quiet" href={samplePath}>
                View a sample gallery
              </a>
              <span class="home-hero-cta-note">No account needed to view.</span>
            </p>
          ) : null}

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
      </div>
    </section>
  )
}
