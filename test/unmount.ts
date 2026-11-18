import { flushSync, render } from 'hono/jsx/dom'
import { createElement, Fragment, useState } from 'hono/jsx'

/**
 * Unmounts mounts through reconciliation — the only path that runs effect
 * cleanup.
 *
 * hono's root `render()` never diffs the previous tree: it builds a fresh
 * vnode, applies it to a new fragment and `replaceChildren`s it into the
 * container. `render(null, container)` therefore skips cleanup exactly like
 * wiping `innerHTML` does — the mounted component's effects, timers and
 * listeners stay armed, and a post-teardown flush resolves globals against
 * whichever file's happen to be installed (or none). Reconciliation is the
 * only path that walks the old tree: when a state update removes a child,
 * `removeNode` runs its effect cleanups and marks it so later updates abort.
 *
 * Each `mount` wraps the child in a state-controlled harness; the returned
 * drop flips the flag inside a `flushSync`, so the child unwinds
 * synchronously. `unmountAll` drains every tracked drop — call it before
 * clearing the DOM or restoring globals.
 *
 * Plain `createElement` calls rather than JSX: the client build sweeps
 * everything reachable and its transform targets `react/jsx-runtime`,
 * which this repo does not have.
 */
export const unmountTracker = () => {
  const drops: (() => void)[] = []
  return {
    mount: (jsxNode: Parameters<typeof render>[0], container: HTMLElement): (() => void) => {
      let drop: (() => void) | null = null
      const Harness = () => {
        const [show, setShow] = useState(true)
        drop = () => setShow(false)
        return createElement(Fragment, null, show ? jsxNode : null)
      }
      render(createElement(Harness, null), container)
      const disposer = () => flushSync(() => drop?.())
      drops.push(disposer)
      return disposer
    },
    unmountAll: () => {
      for (const drop of drops.splice(0)) drop()
    },
  }
}
