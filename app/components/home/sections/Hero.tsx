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
  const live = demo && Boolean(hero)

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
          <div class={`home-hero-stage home-rise home-rise-2${live ? ' home-hero-stage-demo' : ''}`}>
            {live ? <HomeDemo samplePath={samplePath} /> : <Figure asset={hero} eager sizes="100vw" />}
          </div>
        ) : null}

        {/* The demo is the real viewer, not a recording of one — say so, or a
            visitor watches it once and never learns it is theirs to drive.
            It sits below the stage so the frame keeps the first fold. */}
        {live ? (
          <p class="home-hero-note home-rise home-rise-3">
            That is the real gallery viewer, running here in your browser — the same one the apps
            use. Switch the device, pause it, or open the gallery full-size.
          </p>
        ) : null}

        {/* The live demo carries this link in its own control bar, directly
            under the device it invites you to leave. */}
        {!live && samplePath ? (
          <p class="home-hero-cta home-rise home-rise-3">
            <a class="home-btn home-btn-quiet" href={samplePath} target="_blank" rel="noopener">
              View a sample gallery
            </a>
          </p>
        ) : null}
      </div>
    </section>
  )
}
