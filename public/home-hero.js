/* The hero photograph stands beside the sign-in group, but its top edge
   belongs to the first provider button — "Continue with Apple" — not to
   the lede or the group title above it. The offset is content-sized, so
   it is measured, not hard-coded: on wide screens the media column is
   pushed down until its top meets the button's. Below the split
   breakpoint — or with scripting off — the image simply keeps its
   natural top. */
(() => {
  const anchor = document.querySelector('.home-signin .signin-pill')
  const media = document.querySelector('.home-hero-media')
  if (!anchor || !media) return

  // Layout tops only: offsetTop ignores the rise animation's transform,
  // so measuring mid-animation is still correct.
  const top = (el) => {
    let y = 0
    for (let node = el; node; node = node.offsetParent) y += node.offsetTop
    return y
  }

  const align = () => {
    media.style.marginTop = '0px'
    const beside = media.getBoundingClientRect().left > anchor.getBoundingClientRect().left + 40
    const delta = top(anchor) - top(media)
    media.style.marginTop = beside && delta > 0 ? `${delta}px` : '0px'
  }

  align()
  addEventListener('resize', align)
  document.fonts?.ready.then(align)
})()
