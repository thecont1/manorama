import SourceMark from '../home/SourceMark'

type Props = {
  /** The encrypted source's provider — picks the house mark. */
  provider: 'mega' | 'ente' | 'proton'
  /** Provider word under the mark — the same label the card's sub-line uses. */
  label: string
  /** Why this tab cannot paint the cover — one short line. */
  note: string
  /** The cover's stored dims keep the masonry slot honest. `fill` instead
   *  drops the ratio so the tile stretches across a strip frame. */
  storedWidth?: number | null
  storedHeight?: number | null
  fill?: boolean
}

/** The cover tile for an encrypted gallery this shell cannot paint —
 *  Proton refuses web transport outright, MEGA and Ente paint only while
 *  the tab holds the gallery key. The provider's house mark stands in so
 *  the Library reads "encrypted", not "broken" — the same marks the
 *  homepage source row uses, one colour on the card's own surface. */
export function EncryptedCoverPlaceholder({ provider, label, note, storedWidth, storedHeight, fill }: Props) {
  const style = fill
    ? undefined
    : { aspectRatio: storedWidth && storedHeight ? `${Math.max(1, storedWidth)} / ${Math.max(1, storedHeight)}` : '4 / 3' }
  return (
    <div class="lib-cover-encrypted" style={style}>
      <span class="lib-cover-encrypted-mark"><SourceMark id={provider} /></span>
      <span class="lib-cover-encrypted-label">{label}</span>
      <span class="lib-cover-encrypted-note">{note}</span>
    </div>
  )
}
