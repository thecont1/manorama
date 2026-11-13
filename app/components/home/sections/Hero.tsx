import HomeDemo from '../../../islands/HomeDemo'
import Figure from '../Figure'
import { ASSETS, SAMPLE_GALLERY_PATH } from '../home-manifest'

export default function Hero({
  samplePath = SAMPLE_GALLERY_PATH,
  demo = false,
}: {
  samplePath?: string | null
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
          Bring your local folders and shared cloud galleries together, without moving a single
          original.
        </p>

        {hero ? (
          <div class={`home-hero-stage home-rise home-rise-2${demo ? ' home-hero-stage-demo' : ''}`}>
            {demo ? <HomeDemo /> : <Figure asset={hero} eager sizes="100vw" />}
          </div>
        ) : null}

        <div class="home-hero-after">
          {samplePath ? (
            <p class="home-hero-cta home-rise home-rise-3">
              <a class="home-btn home-btn-quiet" href={samplePath}>
                View a sample gallery
              </a>
              <span class="home-hero-cta-note">No account needed to look.</span>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
