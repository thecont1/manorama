/** Quiet view's curtain: every quieted element fades together. Any staged
 *  per-element delay is cleared before the toggle so the dim lands on the
 *  whole list at once — section titles and gallery titles sink in unison
 *  rather than the titles leading the cards. Photographs keep their own
 *  timing: neither the decode crossfade nor the quiet-mode brightness lift
 *  is retimed. */
export const syncQuietFade = (list: Element | null) => {
  if (list instanceof HTMLElement) list.style.transitionDelay = ''
  list?.querySelectorAll<HTMLElement>('*').forEach((el) => {
    el.style.transitionDelay = ''
  })
}
