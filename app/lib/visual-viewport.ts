/** Keeps `--m-vvh` (visual viewport height) and `--m-keyboard-inset` on an
 *  element, so sheets can size against the space the keyboard leaves rather
 *  than layout height. No-op when VisualViewport is unavailable. */
export const watchVisualViewport = (el: HTMLElement): (() => void) => {
  const vv = typeof visualViewport === 'undefined' ? null : visualViewport
  if (!vv) return () => {}
  const update = () => {
    el.style.setProperty('--m-vvh', `${vv.height}px`)
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    el.style.setProperty('--m-keyboard-inset', `${inset}px`)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
  }
}
