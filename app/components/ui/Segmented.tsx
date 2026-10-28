import { useRef, useState } from 'hono/jsx'

/** Segmented control: role=radiogroup, options role=radio with a roving
 *  tabindex; Arrow/Home/End keys move and select. */
type Option<T extends string> = { value: T; label: string }

type Props<T extends string> = {
  label: string
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}

export function Segmented<T extends string>({ label, options, value, onChange }: Props<T>) {
  const [focusIdx, setFocusIdx] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)))
  const groupRef = useRef<HTMLDivElement | null>(null)
  const currentIdx = options.findIndex((o) => o.value === value)
  const activeIdx = currentIdx >= 0 ? currentIdx : focusIdx

  const move = (next: number) => {
    const wrapped = (next + options.length) % options.length
    setFocusIdx(wrapped)
    onChange(options[wrapped].value)
    // Arrow-key selection must carry DOM focus along with it — the radio
    // pattern fails when the checked option moves but focus stays behind
    // on an element that has just gone tabindex=-1.
    const radios = groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')
    radios?.[wrapped]?.focus()
  }

  const onKeyDown = (e: { key: string; preventDefault(): void }) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(activeIdx + 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(activeIdx - 1) }
    else if (e.key === 'Home') { e.preventDefault(); move(0) }
    else if (e.key === 'End') { e.preventDefault(); move(options.length - 1) }
  }

  return (
    <div class="m-segmented" role="radiogroup" aria-label={label} onKeyDown={onKeyDown} ref={groupRef}>
      {options.map((option, i) => (
        <button
          type="button"
          role="radio"
          class="m-segmented-option"
          aria-checked={option.value === value ? 'true' : 'false'}
          tabIndex={i === activeIdx ? 0 : -1}
          key={option.value}
          onClick={() => { setFocusIdx(i); onChange(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
