import type { Child } from 'hono/jsx'
import { AppleGlyph, DropboxGlyph, GoogleGlyph } from '../../lib/signin'

/**
 * The source marks. Real monochrome glyphs where the brand already owns
 * them — the same monotone `currentColor` marks the sign-in chooser uses
 * (Apple for iCloud, Google for Drive). Where no mark exists the source
 * gets a DM Mono initial in the same tile, so the row reads as one set
 * rather than three logos and four gaps.
 */

/* The real MEGA mark, recoloured to the tile: the disc takes the ink,
   the M knocks out to the tile's own surface so it stays one-colour like
   the rest of the row. */
const MegaGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M12 24C5.376 24 0 18.624 0 12C0 5.376 5.376 0 12 0C18.624 0 24 5.376 24 12C24 18.624 18.624 24 12 24Z"
      fill="currentColor"
    />
    <path
      fill-rule="evenodd"
      clip-rule="evenodd"
      d="M18 15.653C18 15.848 17.8425 15.9997 17.6475 15.9997H16.1325C15.9375 15.9997 15.78 15.848 15.78 15.653V11.1247C15.78 11.0813 15.7275 11.0669 15.705 11.0886L12.5025 14.2086C12.225 14.483 11.775 14.483 11.4975 14.2086L8.295 11.0886C8.2725 11.0669 8.22 11.0813 8.22 11.1247V15.653C8.22 15.848 8.0625 15.9997 7.8675 15.9997H6.3525C6.1575 15.9997 6 15.848 6 15.653V7.67967C6 7.48467 6.1575 7.33301 6.3525 7.33301H7.395C7.5825 7.33301 7.7625 7.40523 7.8975 7.53523L11.8725 11.4136C11.94 11.4786 12.06 11.4786 12.1275 11.4136L16.1025 7.53523C16.2375 7.40523 16.4175 7.33301 16.605 7.33301H17.6475C17.8425 7.33301 18 7.48467 18 7.67967V15.653Z"
      fill="var(--home-surface-raised)"
    />
  </svg>
)

const FolderGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M2 6c0-1.66 1.34-3 3-3h4.2L11.5 5H19c1.66 0 3 1.34 3 3v10c0 1.66-1.34 3-3 3H5c-1.66 0-3-1.34-3-3V6z"
      fill="currentColor"
    />
  </svg>
)

/* The Google Photos mark. The real mark is four colours in a pin; this is
   the same silhouette in one colour, with the aperture knocked out in the
   tile's own surface — the same move the MEGA mark makes. A pin reads as
   the Photos mark where four petals would only read as a plus sign. */
const GPhotosGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 2.4c-4 0-7.3 3.2-7.3 7.3 0 5.3 6.5 11.1 6.8 11.3a.65.65 0 0 0 .9 0c.3-.2 6.9-6 6.9-11.3 0-4.1-3.3-7.3-7.3-7.3Z"
    />
    <circle cx="12" cy="9.6" r="2.6" fill="var(--home-surface-raised)" />
  </svg>
)

const MARKS: Record<string, Child> = {
  dropbox: <DropboxGlyph />,
  gdrive: <GoogleGlyph />,
  gphotos: <GPhotosGlyph />,
  icloud: <AppleGlyph />,
  mega: <MegaGlyph />,
  ente: <span class="home-source-initial">e</span>,
  proton: <span class="home-source-initial">P</span>,
  local: <FolderGlyph />,
}

export default function SourceMark({ id }: { id: string }) {
  const mark = MARKS[id]
  return mark ? (
    <span class="home-source-mark" aria-hidden="true">
      {mark}
    </span>
  ) : null
}
