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
              <p class="home-step-title"><span class="home-step-number" aria-hidden="true">01</span> Bring a gallery.</p>
              <p class="home-step-body">
                Paste a share link, or choose a folder on your computer.
              </p>
            </li>
            <li>
              <p class="home-step-title"><span class="home-step-number" aria-hidden="true">02</span> Make it yours.</p>
              <p class="home-step-body">
                Name it, arrange it, keep it in your Library.
              </p>
            </li>
            <li>
              <p class="home-step-title"><span class="home-step-number" aria-hidden="true">03</span> Look, and share.</p>
              <p class="home-step-body">
                Send anyone a clean link. They can look without signing in.
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
