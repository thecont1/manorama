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
              A friend's shared Google Drive album. A trip still on your laptop. A folder in
              someone's Dropbox.
            </p>
            <p class="home-body home-rise home-rise-2">
              The photographs you love are all over the place. View them all in one place, your
              manorama Library.
            </p>
            <p class="home-body home-rise home-rise-2">
              And when you add more photographs to an album, your Library notices and brings them
              in by itself.
            </p>

            {/* Where a link may come from: one recognisable mark per
                source, set on its own surface like a museum's donor
                register. Under each name, the one line that says what the
                source actually gives — photos, photos and video, decrypted
                on your own device. The nuance — which link, which app —
                lives in the FAQ, not beside the brand name. */}
            <div class="home-sources-box home-rise home-rise-3">
              <p class="home-sources-title">Supported cloud drives</p>
              <ul class="home-sources-grid">
                {SOURCES.map((source) => (
                  <li key={source.id} class="home-source-item">
                    <SourceMark id={source.id} />
                    <span class="home-source-text">
                      <span class="home-source-name">{source.name}</span>
                      <span class="home-source-detail">{source.detail}</span>
                    </span>
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
