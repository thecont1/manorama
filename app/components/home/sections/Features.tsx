import Figure from '../Figure'
import { ASSETS } from '../home-manifest'

const FEATURES = [
  {
    title: 'A viewing experience built for photographs.',
    body: 'Whole images, never cropped or enlarged past their real resolution. Strip, scroll or one at a time. Controls that get out of the way.',
  },
  {
    title: 'A Library across sources.',
    body: 'Your cloud galleries, galleries you have saved from others, and your Visionary Local galleries, together.',
  },
  {
    title: 'Your originals stay yours.',
    body: 'No migration to another storage service. Removing a gallery from Manorama never touches the source.',
  },
  {
    title: 'Beyond the browser.',
    body: 'iPhone and iPad keep an encrypted offline copy of the galleries you choose. Mac and Windows open local folders in place.',
    caveat: 'Offline copies are an iPhone and iPad feature. Local folders need Visionary.',
  },
]

/**
 * What the product does, in four short groups, with the two device
 * pictures that carry the last one.
 */
export default function Features() {
  const iphone = ASSETS.find((asset) => asset.id === 'H3')
  const macos = ASSETS.find((asset) => asset.id === 'H4')

  return (
    <section class="home-band" id="features">
      <div class="home-wrap home-split home-split-wide">
        <div>
          <h2 class="home-h2 home-rise home-rise-1">Built around the photographs.</h2>
          <div class="home-features">
            {FEATURES.map((feature, index) => (
              <div key={feature.title} class={`home-rise home-rise-${(index % 4) + 1}`}>
                <h3 class="home-h3">{feature.title}</h3>
                <p>{feature.body}</p>
                {feature.caveat ? <p class="home-feature-caveat">{feature.caveat}</p> : null}
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
          {macos ? (
            <div class="home-pair-wide home-rise home-rise-3">
              <Figure asset={macos} sizes="(min-width: 1024px) 26vw, 100vw" />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
