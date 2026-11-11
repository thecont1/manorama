import { SURFACES } from '../home-manifest'

/**
 * Where manorama runs. A surface that has no published URL is hidden in
 * production and shown in development with a marker, so the page never
 * carries a link that goes nowhere.
 */
export default function GetManorama() {
  const dev = import.meta.env?.DEV === true

  return (
    <section class="home-band" id="get-manorama">
      <div class="home-wrap">
        <h2 class="home-h2 home-rise home-rise-1">Get Manorama</h2>
        <p class="home-body home-rise home-rise-2">
          In the browser: nothing to install. In the apps: encrypted offline copies on iPhone and
          iPad, and local folders on Mac and Windows.
        </p>

        <div class="home-tiles">
          {SURFACES.map((surface) => {
            if (!surface.url && !dev) return null
            const published = Boolean(surface.url)
            return (
              <div
                key={surface.id}
                class={`home-tile home-rise home-rise-2${published ? '' : ' home-tile-missing'}`}
              >
                <h3 class="home-tile-name">{surface.label}</h3>
                <p class="home-tile-blurb" title={published ? undefined : 'Set the url in home-manifest.ts'}>
                  {published ? surface.blurb : 'URL missing'}
                </p>
                {published ? (
                  <p class="home-tile-blurb">
                    <a href={surface.href ?? '#start'}>Open manorama</a>
                  </p>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
