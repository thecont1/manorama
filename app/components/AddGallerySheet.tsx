import { useState } from 'hono/jsx'
import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'

type Props = {
  open: boolean
  url: string
  name: string
  busy: boolean
  error?: string | null
  onUrlChange: (value: string) => void
  onNameChange: (value: string) => void
  onClose: () => void
  onSubmit: (input: { url: string; name: string }) => void
}

/** Explicit ordinary create. The deep-link quick-add path does not mount this
 * sheet, so its zero-click/random-name contract stays independent. */
export function AddGallerySheet({
  open,
  url,
  name,
  busy,
  error,
  onUrlChange,
  onNameChange,
  onClose,
  onSubmit,
}: Props) {
  const [pasteError, setPasteError] = useState<string | null>(null)
  const paste = async () => {
    setPasteError(null)
    try {
      const value = await navigator.clipboard.readText()
      onUrlChange(value.trim())
    } catch {
      setPasteError('The clipboard could not be read. Paste the link into the field instead.')
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add gallery"
      size="half"
      dismissible={!busy}
      footer={(
        <Button
          variant="primary"
          block
          type="submit"
          form="m-add-gallery-form"
          disabled={busy || !url.trim()}
        >
          {busy ? 'Adding gallery…' : 'Add gallery'}
        </Button>
      )}
    >
      <form
        id="m-add-gallery-form"
        class="m-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && url.trim()) onSubmit({ url: url.trim(), name: name.trim() })
        }}
      >
        <label class="m-field">
          <span>Public Dropbox, Google Drive, iCloud, or MEGA link</span>
          <input
            class="m-input"
            type="url"
            aria-label="Public Dropbox, Google Drive, iCloud, or MEGA link"
            value={url}
            placeholder="Paste a public folder or album link"
            autoCapitalize="none"
            autoCorrect="off"
            spellcheck={false}
            required
            disabled={busy}
            onInput={(event) => onUrlChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="m-form-inline">
          <Button variant="secondary" type="button" disabled={busy} onClick={() => void paste()}>Paste</Button>
        </div>
        <label class="m-field">
          <span>Name <small>(optional)</small></span>
          <input
            class="m-input"
            type="text"
            value={name}
            maxLength={120}
            placeholder="Use the folder’s name"
            disabled={busy}
            onInput={(event) => onNameChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {pasteError ? <p class="m-note" role="status">{pasteError}</p> : null}
        {error ? <p class="m-error" role="alert">{error}</p> : null}
      </form>
    </Sheet>
  )
}

export default AddGallerySheet
