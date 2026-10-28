import { useId } from 'hono/jsx/dom'

/** Aria switch: a labelled <button role="switch">. The track fills with
 *  --m-primary when on. */
type Props = {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  describedBy?: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, describedBy, disabled = false }: Props) {
  const id = `m-switch-${useId()}`
  return (
    <button
      type="button"
      role="switch"
      id={id}
      class="m-switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span class="m-switch-track" aria-hidden="true" />
      <span class="m-switch-label">{label}</span>
    </button>
  )
}
