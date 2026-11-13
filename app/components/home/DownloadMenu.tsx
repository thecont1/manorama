import { SURFACES } from './home-manifest'

/**
 * The download affordance, as one disclosure shared by the header and the
 * hero fold. Surfaces with no published URL are listed quiet and without a
 * link — an honest "not yet", never a link that goes nowhere.
 */
export default function DownloadMenu({
  summary = 'Downloads',
  class: cls,
}: {
  summary?: string
  class?: string
}) {
  return (
    <details class={`home-download${cls ? ` ${cls}` : ''}`}>
      <summary>{summary}</summary>
      <div class="home-download-panel">
        <ul class="home-download-list">
          {SURFACES.map((surface) => (
            <li key={surface.id}>
              {surface.url ? (
                <a href={surface.href ?? surface.url}>
                  <span class="home-download-name">{surface.label}</span>
                </a>
              ) : (
                <span class="home-download-soon">
                  <span class="home-download-name">{surface.label}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}
