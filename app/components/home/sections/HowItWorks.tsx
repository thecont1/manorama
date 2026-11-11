import Figure from '../Figure'
import { ASSETS, SOURCES } from '../home-manifest'

/**
 * How a gallery gets from a link to a Library, and where a link may come
 * from. The sources are listed in a disclosure because the list is a
 * reference, not an argument.
 */
export default function HowItWorks() {
  const curtain = ASSETS.find((asset) => asset.id === 'H5')

  return (
    <section class="home-band" id="how-it-works">
      <div class="home-wrap home-split">
        <div>
          <h2 class="home-h2 home-rise home-rise-1">How it works</h2>
          <ol class="home-steps home-rise home-rise-2">
            <li>
              <p class="home-step-title">Bring a gallery.</p>
              <p class="home-step-body">
                Add a supported cloud share link, or open a local folder with Visionary.
              </p>
            </li>
            <li>
              <p class="home-step-title">Make it yours.</p>
              <p class="home-step-body">
                Keep it in your Library and arrange your own galleries.
              </p>
            </li>
            <li>
              <p class="home-step-title">Look, and share.</p>
              <p class="home-step-body">
                Enjoy the photographs, and share your galleries through a clean link.
              </p>
              <p class="home-step-note">
                Saving someone else’s gallery keeps a copy for you to view; it doesn’t make you its
                publisher.
              </p>
            </li>
          </ol>

          <details class="home-disclosure home-rise home-rise-3">
            <summary>Supported sources</summary>
            <div class="home-disclosure-body">
              <ul class="home-source-list">
                {SOURCES.map((source) => (
                  <li key={source.id}>
                    <span class="home-source-name">{source.name}</span>
                    <span class="home-source-detail">{source.detail}</span>
                    <span class="home-source-where">{source.where}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </div>

        <div class="home-rise home-rise-2">
          {curtain ? <Figure asset={curtain} sizes="(min-width: 1024px) 45vw, 100vw" /> : null}
        </div>
      </div>
    </section>
  )
}
