/** Quiet view's curtain: each card's fade is delayed by its own index so the
 *  dim falls down the list card by card instead of washing over everything at
 *  once. Delay is written to every descendant — the delay longhand does not
 *  inherit — and DOM order is visual order in the list's single column.
 *  Re-runs on every toggle, so the words also lift back up top-first. */
export const curtainStagger = (list: Element | null, stepMs = 55) => {
  const cards = list?.querySelectorAll<HTMLElement>('.lib-card, [data-gallery-card]') ?? []
  cards.forEach((card, index) => {
    const delay = `${index * stepMs}ms`
    card.style.transitionDelay = delay
    card.querySelectorAll<HTMLElement>('*').forEach((el) => {
      el.style.transitionDelay = delay
    })
  })
}
