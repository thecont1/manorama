import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'

type Props = {
  open: boolean
  url: string
  name: string
  caption: string
  /** True while the link is being checked against the provider. */
  checking: boolean
  /** The verified link's scanned title — non-null only after a clean
   *  scan, which is also what reveals the optional fields below. */
  verifiedTitle: string | null
  busy: boolean
  error?: string | null
  onUrlChange: (value: string) => void
  /** Committed edits (blur/Enter) verify immediately — the typing
   *  debounce is a nicety, a finished paste should not wait on it. */
  onVerify: (url: string) => void
  onNameChange: (value: string) => void
  onCaptionChange: (value: string) => void
  onClose: () => void
  onSubmit: (input: { url: string; name: string; caption: string }) => void
}

/** Explicit ordinary create. The deep-link quick-add path does not mount this
 * sheet, so its zero-click/random-name contract stays independent. */
export function AddGallerySheet({
  open,
  url,
  name,
  caption,
  checking,
  verifiedTitle,
  busy,
  error,
  onUrlChange,
  onVerify,
  onNameChange,
  onCaptionChange,
  onClose,
  onSubmit,
}: Props) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a gallery"
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
          {busy ? 'Creating the gallery…' : 'Create gallery'}
        </Button>
      )}
    >
      <form
        id="m-add-gallery-form"
        class="m-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && url.trim()) onSubmit({ url: url.trim(), name: name.trim(), caption: caption.trim() })
        }}
      >
        <label class="m-field">
          <span>Shared folder or album link</span>
          <input
            class="m-input"
            type="url"
            aria-label="Shared folder or album link — Dropbox, Google Drive, iCloud or MEGA"
            value={url}
            placeholder="https://www.dropbox.com/scl/fo/…"
            autoCapitalize="none"
            autoCorrect="off"
            spellcheck={false}
            required
            disabled={busy}
            onInput={(event) => onUrlChange((event.currentTarget as HTMLInputElement).value)}
            onChange={(event) => onVerify((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        {/* The optional fields stay hidden until the link scans clean —
            asking for a name before the source even answers would put a
            form in front of what might be a typo. */}
        {verifiedTitle !== null ? (
          <>
            <label class="m-field">
              <span>Name <small>(optional)</small></span>
              <input
                class="m-input"
                type="text"
                value={name}
                maxLength={120}
                placeholder={verifiedTitle || 'Use the folder’s name'}
                disabled={busy}
                onInput={(event) => onNameChange((event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="m-field">
              <span>Caption <small>(optional)</small></span>
              <textarea
                class="m-input m-input--textarea"
                value={caption}
                maxLength={500}
                placeholder="A line about these photographs"
                disabled={busy}
                onInput={(event) => onCaptionChange((event.currentTarget as HTMLTextAreaElement).value)}
              />
            </label>
          </>
        ) : null}
        {checking ? <p class="m-note" role="status">Checking the link…</p> : null}
        {error ? <p class="m-error" role="alert">{error}</p> : null}
      </form>
    </Sheet>
  )
}

export default AddGallerySheet
