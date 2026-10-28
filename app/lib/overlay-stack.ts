/** One overlay stack for sheets, menus and confirmations. The topmost entry
 *  owns Escape and a Tab trap; everything below it and every other body child
 *  is inert while it sits on top. Releasing out of order is safe — a stale
 *  release is ignored until its entry reaches the top, which can't happen
 *  once popped, so it is simply dropped. */

type Entry = {
  host: HTMLElement
  onEscape?: () => void
  returnFocus: Element | null
  inerted: HTMLElement[]
}

const stack: Entry[] = []
let listenerAttached = false

const top = () => stack[stack.length - 1]

const bodyChildren = (): HTMLElement[] =>
  Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement)

const applyInert = () => {
  const active = top()
  for (const el of bodyChildren()) el.inert = active ? el !== active.host : false
}

const restoreInert = (entry: Entry) => {
  for (const el of entry.inerted) if (el.isConnected) el.inert = false
}

const focusables = (root: HTMLElement): HTMLElement[] =>
  Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')

const onKeyDown = (event: KeyboardEvent) => {
  const active = top()
  if (!active) return
  if (event.key === 'Escape') {
    if (active.onEscape) {
      event.preventDefault()
      active.onEscape()
    }
    return
  }
  if (event.key !== 'Tab') return
  const items = focusables(active.host)
  if (items.length === 0) {
    event.preventDefault()
    active.host.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const current = document.activeElement
  if (event.shiftKey && (current === first || !active.host.contains(current))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (current === last || !active.host.contains(current))) {
    event.preventDefault()
    first.focus()
  }
}

const ensureListener = () => {
  if (listenerAttached) return
  document.addEventListener('keydown', onKeyDown, true)
  listenerAttached = true
}

const dropListener = () => {
  if (!listenerAttached || stack.length > 0) return
  document.removeEventListener('keydown', onKeyDown, true)
  listenerAttached = false
}

/** Push an overlay host (the element that contains the dialog/sheet). Returns
 *  a release function; call it exactly once. */
export const pushOverlay = ({ host, onEscape }: { host: HTMLElement; onEscape?: () => void }): (() => void) => {
  const entry: Entry = {
    host,
    onEscape,
    returnFocus: document.activeElement,
    inerted: [],
  }
  stack.push(entry)
  ensureListener()
  entry.inerted = bodyChildren().filter((el) => el !== host)
  applyInert()

  let released = false
  return () => {
    if (released) return
    released = true
    const index = stack.indexOf(entry)
    if (index === -1) return
    stack.splice(index, 1)
    restoreInert(entry)
    applyInert()
    dropListener()
    const target = entry.returnFocus
    if (target instanceof HTMLElement && target.isConnected) target.focus()
  }
}
