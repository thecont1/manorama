import { useState } from 'hono/jsx'
import type { GallerySharePayload } from '../lib/gallery-share'
import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'

type Props = {
  payload: GallerySharePayload
  onClose: () => void
  onCopy: (url: string) => Promise<boolean>
}

/** Explicit fallback when neither native nor Web Share accepts the handoff.
 * Only presentation metadata and the public URL cross this boundary. */
export function GalleryShareSheet({ payload, onClose, onCopy }: Props) {
  const [note, setNote] = useState<string | null>(null)
  const text = `${payload.title} ${payload.url}`
  const body = payload.caption.trim() ? `${payload.caption.trim()}\n\n${payload.url}` : payload.url
  const copy = async () => {
    const copied = await onCopy(payload.url)
    setNote(copied ? 'Gallery link copied' : 'Copy the address above instead.')
  }
  return (
    <Sheet open onClose={onClose} title={`Share ${payload.title}`}>
      <div class="m-share">
        <p class="m-share-address">{payload.url}</p>
        <div class="m-share-actions">
          <Button variant="primary" block onClick={() => void copy()}>Copy link</Button>
          <a class="m-btn m-btn--secondary m-btn--block" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">WhatsApp</a>
          <a class="m-btn m-btn--secondary m-btn--block" href={`sms:?&body=${encodeURIComponent(text)}`}>Messages</a>
          <a
            class="m-btn m-btn--secondary m-btn--block"
            href={`mailto:?subject=${encodeURIComponent(payload.title)}&body=${encodeURIComponent(body)}`}
          >
            Email
          </a>
        </div>
        {note ? <p class="m-note" role="status">{note}</p> : null}
      </div>
    </Sheet>
  )
}

export default GalleryShareSheet
