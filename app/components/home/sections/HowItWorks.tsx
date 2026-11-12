import Figure from '../Figure'
import { ASSETS } from '../home-manifest'

/**
 * How a gallery gets from a link to a Library. The sources list lives
 * with the Library story above — this band keeps to the three steps.
 */
export default function HowItWorks() {
  const curtain = ASSETS.find((asset) => asset.id === 'H5')

  return (
    <section class="home-band" id="how-it-works">
      <div class="home-wrap home-split home-split-flip">
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
                Saving someone else’s gallery keeps a gallery saved to your Library; it doesn’t
                make you its publisher.
              </p>
            </li>
          </ol>
        </div>

        <div class="home-rise home-rise-2">
          {curtain ? <Figure asset={curtain} sizes="(min-width: 1024px) 45vw, 100vw" /> : null}
        </div>
      </div>
    </section>
  )
}
