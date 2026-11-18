/* The Library loop: the four appearances of the Library — dark, quiet and
   dark, quiet and light, light — dissolved into one another on a clock.

   This file owns the clock and nothing else. The dissolve, the caption
   swap and the dot are CSS, driven by one attribute on the frame, so the
   page still holds its first state with scripting off.

   The clock waits for every capture to be decoded before the first
   dissolve, so the band never dissolves into an empty layer, and it stops
   entirely when the band is off the screen, when the tab is in the
   background, when the visitor asks for less motion, and when the
   visitor pauses it. */
(() => {
  const root = document.querySelector('[data-library-loop]')
  if (!root) return

  // How long each state is held before the next begins. The dissolve
  // itself is 1100ms of CSS and is not counted here: the clock starts
  // when the dissolve ends.
  const HOLD = 3600

  const layers = Array.from(root.querySelectorAll('[data-library-layer]'))
  const captions = Array.from(root.querySelectorAll('[data-library-caption]'))
  const dots = Array.from(root.querySelectorAll('[data-library-dot]'))
  const pause = root.querySelector('[data-library-pause]')
  const images = Array.from(root.querySelectorAll('img'))
  const count = layers.length
  if (!count) return

  const still = window.matchMedia('(prefers-reduced-motion: reduce)')

  let index = 0
  let timer = null
  let wanted = true // what the visitor asked for
  let live = false // whether the band is on screen and the tab is visible
  let ready = false // whether every capture has arrived

  const show = (next) => {
    index = (next + count) % count
    root.dataset.state = String(index)
    layers.forEach((el, i) => el.setAttribute('aria-hidden', i === index ? 'false' : 'true'))
    captions.forEach((el, i) => el.setAttribute('aria-hidden', i === index ? 'false' : 'true'))
    dots.forEach((el, i) => el.classList.toggle('is-on', i === index))
  }

  const stop = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const tick = () => {
    stop()
    if (!wanted || !live || !ready || still.matches) return
    timer = setTimeout(() => {
      show(index + 1)
      tick()
    }, HOLD)
  }

  const sync = () => {
    if (wanted && live && ready && !still.matches) tick()
    else stop()
  }

  // The captures are lazy, so they arrive as the band is scrolled to. The
  // loop waits for all of them: a dissolve into a layer that has not
  // loaded yet would show the ground through the picture.
  const checkReady = () => {
    ready = images.every((img) => img.complete)
    sync()
  }

  images.forEach((img) => {
    if (img.complete) return
    img.addEventListener('load', checkReady, { once: true })
    img.addEventListener('error', checkReady, { once: true })
  })
  checkReady()

  document.addEventListener('visibilitychange', () => {
    live = document.visibilityState === 'visible'
    sync()
  })

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        live = entries.some((entry) => entry.isIntersecting)
        sync()
      },
      { threshold: 0.15 }
    )
    io.observe(root)
  } else {
    live = true
    sync()
  }

  still.addEventListener('change', sync)

  if (pause) {
    pause.hidden = false
    pause.addEventListener('click', () => {
      wanted = !wanted
      pause.textContent = wanted ? 'pause' : 'play'
      pause.setAttribute('aria-label', wanted ? 'Pause the Library loop' : 'Play the Library loop')
      sync()
    })
  }
})()
