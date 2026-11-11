import { SURFACES } from '../home-manifest'

/**
 * Where manorama is available, in one compact line.
 *
 * A surface without a published URL does not appear: a link that goes
 * nowhere is worse than a missing link. The full list, with the
 * development-only markers for the ones still waiting, is in Get Manorama.
 */
export default function AccessRow() {
  const published = SURFACES.filter((surface) => surface.url)

  return (
    <nav class="home-access" aria-label="Where manorama is available">
      <span class="home-access-label">Get it:</span>
      {published.map((surface) => (
        <a key={surface.id} href={surface.href ?? surface.url ?? '#get-manorama'}>
          {surface.label}
          <span class="home-access-blurb">: {surface.blurb}</span>
        </a>
      ))}
      <a href="#get-manorama">All options ↓</a>
    </nav>
  )
}
