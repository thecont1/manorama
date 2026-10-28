/** One overlay stack for sheets, menus and confirmations. The topmost entry
 *  owns Escape and a Tab trap; every other body child is inert while an
 *  overlay is on top — except elements marked `data-overlay-exempt`, which
 *  must stay live (the announcer live region must keep reaching screen
 *  readers while a sheet is open).
 *
 *  Inert is restored, not cleared: the original `inert` value of every
 *  element the stack touches is remembered the first time it is touched, and
 *  put back when the stack empties, so an element that was already inert
 *  before any overlay opened stays inert. Releasing out of order is safe. */

type Entry = {
  host: HTMLElement
  onEscape?: () => void
  returnFocus: Element | null
}

const stack: Entry[] = []
const originalInert = new Map<HTMLElement, boolean>()
let listenerAttached = false

const top = () => stack[stack.length - 1]

const exempt = (el: HTMLElement) => el.hasAttribute('data-overlay-exempt')

/** Everything except the host and its ancestor chain: all siblings at every
 *  level from the host up to <body>. Works whether the host is a direct body
 *  child (portal-style) or nested inside the app root (inline render). */
const wantedInert = (host: HTMLElement): Set<HTMLElement> => {
  const wanted = new Set<HTMLElement>()
  let node: HTMLElement | null = host
  while (node.parentElement) {
    for (const sib of node.parentElement.children) {
      if (sib instanceof HTMLElement && sib !== node && !exempt(sib)) wanted.add(sib)
    }
    node = node.parentElement
  }
  return wanted
}

const applyInert = () => {
  const active = top()
  const wanted = active ? wantedInert(active.host) : new Set<HTMLElement>()
  for (const [el, orig] of [...originalInert]) {
    if (!wanted.has(el)) {
      el.inert = orig
      originalInert.delete(el)
    }
  }
  for (const el of wanted) {
    if (!originalInert.has(el)) originalInert.set(el, el.inert)
    el.inert = true
  }
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
  }
  stack.push(entry)
  ensureListener()
  applyInert()

  let released = false
  return () => {
    if (released) return
    released = true
    const index = stack.indexOf(entry)
    if (index === -1) return
    stack.splice(index, 1)
    applyInert()
    dropListener()
    const target = entry.returnFocus
    if (target instanceof HTMLElement && target.isConnected) target.focus()
  }
}

/** Diagnostic depth — tests assert the stack has exactly one entry while a
 *  single sheet is open. */
export const overlayDepth = (): number => stack.length

/** Test teardown: releases every live entry in order. Production code must
 *  not call this — it exists so a fixture that drops its overlay DOM can
 *  drain the stack deterministically. */
export const releaseAllOverlays = (): void => {
  while (stack.length > 0) {
    const entry = stack.pop()!
    applyInert()
    const target = entry.returnFocus
    if (target instanceof HTMLElement && target.isConnected) target.focus()
  }
  dropListener()
}
