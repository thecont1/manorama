import type { Child, JSX } from 'hono/jsx'

/** 52px top bar with a fixed centre slot. The centre is the shared logo box
 *  (140×47) by default, or a title (Reorder). Start/end slots are flex cells
 *  that truncate rather than overlap the centre at large text sizes. */
type Props = {
  start?: Child
  end?: Child
  title?: string
  logo?: boolean
  /** Marks the bar as a Tauri drag region ("deep": empty pixels drag the
   *  window, clickable children still take their clicks). Inert outside the
   *  desktop shell — no other runtime reads the attribute. */
  drag?: boolean
}

export function TopBar({ start, end, title, logo = true, drag = false }: Props) {
  return (
    <header class="m-topbar" data-tauri-drag-region={drag ? 'deep' : undefined}>
      <div class="m-topbar-slot">{start}</div>
      {title ? (
        <h2 class="m-topbar-title">{title}</h2>
      ) : logo ? (
        <img class="m-topbar-logo" src="/manorama-merged-logo.png" alt="manorama" width="140" height="47" />
      ) : (
        <span aria-hidden="true" />
      )}
      <div class="m-topbar-slot m-topbar-slot--end">{end}</div>
    </header>
  )
}

export default TopBar
