import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'

export type GalleryEditField = 'name' | 'caption' | 'address'

type Props = {
  open: boolean
  field: GalleryEditField | null
  value: string
  busy: boolean
  note?: string | null
  onValueChange: (value: string) => void
  onSubmit: (value: string) => void
  onClose: () => void
}

const TITLES: Record<GalleryEditField, string> = {
  name: 'Edit name',
  caption: 'Edit caption',
  address: 'Edit address',
}
const FIELD_META: Record<GalleryEditField, {
  type: 'text' | 'textarea'
  label: string
  placeholder: string
}> = {
  name: { type: 'text', label: 'Name', placeholder: 'Gallery name' },
  caption: { type: 'textarea', label: 'Caption', placeholder: 'A line about the gallery' },
  address: { type: 'text', label: 'Address', placeholder: 'gallery-address' },
}

/** Small shared metadata editor for the details surface: one field per
 *  sheet (name / caption / address), reusing the shared Sheet + Button
 *  primitives. Validation and persistence stay with the container, which
 *  owns the PATCH calls. */
export function GalleryEditSheet({ open, field, value, busy, note, onValueChange, onSubmit, onClose }: Props) {
  if (!field) return null
  const meta = FIELD_META[field]
  const submit = () => { if (!busy && value.trim()) onSubmit(value.trim()) }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={TITLES[field]}
      size="half"
      dismissible={!busy}
      footer={(
        <Button
          variant="primary"
          block
          type="submit"
          form="m-edit-gallery-form"
          disabled={busy || !value.trim()}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      )}
    >
      <form
        id="m-edit-gallery-form"
        class="m-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label class="m-field">
          <span>{meta.label}</span>
          {meta.type === 'textarea' ? (
            <textarea
              class="m-input m-input--textarea"
              rows={3}
              value={value}
              disabled={busy}
              aria-label={meta.label}
              placeholder={meta.placeholder}
              onInput={(event) => onValueChange((event.currentTarget as HTMLTextAreaElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose()
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() }
              }}
            />
          ) : (
            <input
              class="m-input"
              type="text"
              value={value}
              disabled={busy}
              aria-label={meta.label}
              placeholder={meta.placeholder}
              spellcheck={false}
              autoCapitalize={field === 'address' ? 'none' : undefined}
              autoCorrect={field === 'address' ? 'off' : undefined}
              onInput={(event) => onValueChange((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onClose()
                if (event.key === 'Enter') { event.preventDefault(); submit() }
              }}
            />
          )}
        </label>
        {note ? <p class="m-error" role="alert">{note}</p> : null}
      </form>
    </Sheet>
  )
}

export default GalleryEditSheet
