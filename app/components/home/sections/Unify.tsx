import Figure from '../Figure'
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
              folder, a trip’s photographs still sitting on your own disk. Manorama gathers
              references to them into one Library, and you decide what belongs in it.
            </p>
            <p class="home-note home-note-spaced home-rise home-rise-3">
              One gallery at a time, with one link. Never your whole account.
            </p>

            <div class="home-diagram home-rise home-rise-3">
              <ul class="home-diagram-sources">
                {SOURCES.map((source) => (
                  <li key={source.id}>{source.name}</li>
                ))}
              </ul>
              <p class="home-diagram-arrow" aria-hidden="true">
                ↓
              </p>
              <p class="home-diagram-target">Your Manorama Library</p>
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
