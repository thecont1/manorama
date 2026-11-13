import Figure from '../Figure'
import { ASSETS } from '../home-manifest'

const FEATURES = [
  {
    title: 'Made for looking.',
    body: "Every photograph is shown whole. Choose a strip, a scroll, or one at a time. Controls appear when you reach for them and fade when you don't.",
  },
  {
    title: 'One Library.',
    body: 'Your cloud galleries, galleries friends have shared, and folders from your own computer, side by side.',
  },
  {
    title: 'The originals stay where they are.',
    body: 'Nothing is moved or changed. Remove a gallery from your Library–the photographs stay exactly where they were.',
  },
  {
    title: 'Take it with you.',
    body: 'Save galleries for offline viewing on mobile devices. Open folders in place on Mac and Windows.',
  },
]

/**
 * What the product does, in four short groups, with the two device
 * pictures that carry the last one.
 */
export default function Features() {
  const iphone = ASSETS.find((asset) => asset.id === 'H3')

  return (
    <section class="home-band" id="features">
      <div class="home-wrap home-split home-split-wide">
        <div>
          <h2 class="home-h2 home-rise home-rise-1">Built around photographs.</h2>
          <div class="home-features">
            {FEATURES.map((feature, index) => (
              <div key={feature.title} class={`home-rise home-rise-${(index % 4) + 1}`}>
                <h3 class="home-h3">{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div class="home-pair">
          {iphone ? (
            <div class="home-phone-figure home-rise home-rise-2">
              <Figure asset={iphone} sizes="(min-width: 1024px) 240px, 55vw" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
