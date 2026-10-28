/** Strips the transient `?photo=` intent after hydration so a reload starts
 *  at the first photograph. Keeps every other param and the hash. */
import { useEffect } from 'hono/jsx'

export default function PhotoParamCleanup() {
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('photo')) return
    url.searchParams.delete('photo')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }, [])
  return null
}
