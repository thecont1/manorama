import { useId } from 'hono/jsx'
import ground from '../assets/gallery-ground'

/* The approved photographic field is baked once, not repacked on the device.
   The owner chose a fine 256px repeat of the unchanged 1024-unit artwork.
   Only this decorative vector field scales; photographs and their boxes do not.
   The generator, project parser and model SDK stay out of every app bundle. */
const tileSize = 256
const artworkScale = tileSize / ground.width
type Props = { enabled?: boolean }

export default function SeededDoodleBackground({ enabled = true }: Props) {
  /* Multiple mounted viewers may use different palettes. A local paint-server
     id keeps one SVG from resolving another viewer's currentColor pattern. */
  const patternId = `gallery-ground-${useId().replace(/[^a-zA-Z0-9_-]/g, '-')}`
  if (!enabled) return null

  return (
    <svg
      class="doodle-bg"
      data-doodle-bg
      data-doodle-artwork={ground.artworkId}
      data-doodle-seed={String(ground.seed)}
      data-doodle-count={String(ground.placementCount)}
      width="100%"
      height="100%"
      shape-rendering="geometricPrecision"
      aria-hidden="true"
      role="presentation"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* The repeat is fixed in CSS pixels, not fitted to the viewport.
            One uniform transform scales paths, strokes and packing gaps alike. */}
        <pattern
          id={patternId}
          x="0"
          y="0"
          width={tileSize}
          height={ground.height * artworkScale}
          patternUnits="userSpaceOnUse"
          patternContentUnits="userSpaceOnUse"
          overflow="hidden"
        >
          <g data-gallery-ground-scale={String(artworkScale)} transform={`scale(${artworkScale})`}>
            {ground.groups.map((group, copy) => (
              <g key={copy} data-gallery-ground-motif={group.motifId} data-gallery-ground-placement={group.placementId}>
                {group.paths.map((path, index) => (
                  <path
                    key={index}
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    stroke-width={ground.strokeWidth}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                ))}
              </g>
            ))}
          </g>
        </pattern>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}
