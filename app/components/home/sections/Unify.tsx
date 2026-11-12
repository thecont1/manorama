import Figure from '../Figure'
import SourceMark from '../SourceMark'
import { ASSETS, SOURCES } from '../home-manifest'

/**
 * The idea in one band: the photographs are scattered, the Library gathers
 * them. The diagram says it in words, the picture says it in photographs.
 */
export default function Unify() {
  const matrix = ASSETS.find((asset) => asset.id === 'H2')

  return (
    <section class="home-band" id="unify">
      <div class="home-wrap">
        <div class="home-split home-split-unify">
          <div>
            <h2 class="home-h2 home-rise home-rise-1">
              Scattered photographs. A Library that brings them together.
            </h2>
            <p class="home-body home-rise home-rise-2">
              Meaningful galleries live across services and devices: a shared album, a friend’s
              folder, a trip’s photographs still sitting on your own disk. Bring the galleries
              you care about into one Library.
            </p>
            <p class="home-note home-note-spaced home-rise home-rise-3">
              Add a shared gallery link or choose a local folder — not your entire cloud account.
            </p>

            {/* Where a link may come from: one recognisable mark per
                source, set on its own surface like a museum's donor
                register. The nuance — which link, which app — lives in
                the FAQ, not beside the brand name. */}
            <div class="home-sources-box home-rise home-rise-3">
              <p class="home-sources-title">Supported cloud sources</p>
              <ul class="home-sources-grid">
                {SOURCES.map((source) => (
                  <li key={source.id} class="home-source-item">
                    <SourceMark id={source.id} />
                    <span class="home-source-name">{source.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* The Library itself, at the size a phone is held: the column is
              sized to the capture so the band reads as one composition rather
              than a narrow column with dead ground either side. */}
          <div class="home-rise home-rise-2">
            {matrix ? <Figure asset={matrix} sizes="(min-width: 1024px) 260px, 60vw" /> : null}
          </div>
        </div>
      </div>
    </section>
  )
}
