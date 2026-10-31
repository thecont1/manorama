import { createClient } from 'honox/client'
import { render } from 'hono/jsx/dom'
import type { Child } from 'hono/jsx'

// honox stamps data-hono-hydrated when it *starts* hydrating an island — in dev
// that is seconds before the module graph loads and listeners exist. Stamping
// data-hono-live after render gives hydrate-guard.js a true "listeners can
// fire" signal so events buffered during the gap can be replayed once.
createClient<Child>({
  hydrate: (node, parent) => {
    render(node, parent as HTMLElement)
    parent.setAttribute('data-hono-live', '')
    window.dispatchEvent(new CustomEvent('hono:island-live', { detail: { island: parent } }))
    // SSR <img onLoad/onError> handlers only attach during hydration — an
    // image whose fetch finished before then keeps its hidden pre-load
    // state forever (e.g. strip thumbnails on a warm cache). Re-dispatch
    // the settled outcome on already-complete images so the freshly bound
    // handlers see it once.
    for (const img of (parent as HTMLElement).querySelectorAll('img') as NodeListOf<HTMLImageElement>)
      if (img.complete && img.currentSrc)
        img.dispatchEvent(new Event(img.naturalWidth > 0 ? 'load' : 'error'))
  },
})
