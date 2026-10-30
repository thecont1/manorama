import type { Child, JSX } from 'hono/jsx'

/** Settings/details action rows on a surface panel. A row is a <button> when
 *  given onClick, an <a> when given href, or a non-interactive <div>. The
 *  `control` slot (e.g. a Switch) replaces the chevron; a row carrying a
 *  control is not itself a button, so the control keeps its own events. */

type GroupProps = { label?: string; note?: string; children?: Child }

export function ActionGroup({ label, note, children }: GroupProps) {
  return (
    <section>
      {label ? <h3 class="m-actiongroup-label">{label}</h3> : null}
      {note ? <p class="m-actiongroup-note">{note}</p> : null}
      <div class="m-panel m-actiongroup">{children}</div>
    </section>
  )
}

type RowProps = {
  label: Child
  value?: Child
  /** Optional 22px stroke glyph ahead of the label — the prototype's row
   *  icon, muted like the value text. */
  icon?: Child
  onClick?: () => void
  href?: string
  chevron?: boolean
  tone?: 'default' | 'destructive'
  disabled?: boolean
  control?: Child
}

const Chevron = () => (
  <svg class="m-actionrow-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export function ActionRow({ label, value, icon, onClick, href, chevron, tone = 'default', disabled = false, control }: RowProps) {
  const classes = ['m-actionrow', tone === 'destructive' ? 'm-actionrow--destructive' : ''].filter(Boolean).join(' ')
  const showChevron = control == null && (chevron ?? Boolean(onClick || href))
  const inner = (
    <>
      {icon ? <span class="m-actionrow-icon" aria-hidden="true">{icon}</span> : null}
      <span class="m-actionrow-label">{label}</span>
      {value != null ? <span class="m-actionrow-value">{value}</span> : null}
      {control != null ? <span class="m-actionrow-control">{control}</span> : null}
      {showChevron ? <Chevron /> : null}
    </>
  )
  if (control != null) return <div class={classes}>{inner}</div>
  if (onClick) return <button type="button" class={classes} disabled={disabled} onClick={onClick}>{inner}</button>
  if (href) return <a class={classes} href={href}>{inner}</a>
  return <div class={classes}>{inner}</div>
}
