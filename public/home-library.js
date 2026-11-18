/* The Library loop: the four appearances of the Library — dark, quiet and
   dark, quiet and light, light — dissolved into one another on a clock.

   This file owns the clock and nothing else. The dissolve, the caption
   swap and the dot are CSS, driven by one attribute on the frame, so the
   page still holds its first state with scripting off.

   The captures are served as their own bytes — the file the browser
   downloads is the capture, not a conversion of it — and they are large.
   So the page asks for one at a time. The first is in the markup, and
   each capture after that is fetched while the one on screen is held.
   The dissolve waits for the capture to have arrived and been decoded: a
   band that dissolves into a layer that is not there would show the page
   through the picture.

   The clock stops entirely when the band is off the screen, when the tab
   is in the background, when the visitor asks for less motion, and when
   the visitor pauses it. */
(() => {
  const root = document.querySelector('[data-library-loop]')
  if (!root) return

  // How long each state is held before the next begins. The dissolve
  // itself is 1100ms of CSS and is not counted here: the clock starts
  // when the dissolve ends.
  const HOLD = 3600

  // How often the clock looks again at a capture that has not arrived.
  const POLL = 250

  const layers = Array.from(root.querySelectorAll('[data-library-layer]'))
  const captions = Array.from(root.querySelectorAll('[data-library-caption]'))
  const dots = Array.from(root.querySelectorAll('[data-library-dot]'))
  const pause = root.querySelector('[data-library-pause]')
  const images = layers.map((layer) => layer.querySelector('img'))
  const count = layers.length
  if (!count) return

  const still = window.matchMedia('(prefers-reduced-motion: reduce)')

  let index = 0
  let hold = null
  let poll = null
  let epoch = 0
  let wanted = true // what the visitor asked for
  let live = false // whether the band is on screen and the tab is visible
  let stopped = false // whether a capture failed to arrive

  const clear = () => {
    // Every wait carries the epoch it started in, so a clock that has
    // been restarted cannot be revived by an old timer.
    epoch += 1
    if (hold) {
      clearTimeout(hold)
      hold = null
    }
    if (poll) {
      clearTimeout(poll)
      poll = null
    }
  }

  // Ask for a capture. The file is the capture itself; nothing is
  // converted on the way to the browser.
  const prefetch = (i) => {
    const img = images[i]
    if (!img || img.getAttribute('src')) return
    const url = img.getAttribute('data-library-src')
    if (url) img.setAttribute('src', url)
  }

  const show = (next) => {
    index = (next + count) % count
    root.dataset.state = String(index)
    layers.forEach((el, i) => el.setAttribute('aria-hidden', i === index ? 'false' : 'true'))
    captions.forEach((el, i) => el.setAttribute('aria-hidden', i === index ? 'false' : 'true'))
    dots.forEach((el, i) => el.classList.toggle('is-on', i === index))
  }

  // A capture has arrived when it has finished loading and has pixels.
  const arrived = (img) =>
    !!img && !!img.getAttribute('src') && img.complete && img.naturalWidth > 0

  // And it has failed when it has finished loading and has none.
  const broken = (img) =>
    !!img && !!img.getAttribute('src') && img.complete && img.naturalWidth === 0

  /* Waits for a capture to arrive and be decoded, then calls back. A
     capture that never arrives stops the clock: the band holds the
     picture it has rather than dissolving into a hole. */
  const whenReady = (i, done) => {
    const img = images[i]
    if (!img) {
      done()
      return
    }
    const mine = epoch
    const attempt = () => {
      if (mine !== epoch) return
      if (broken(img)) {
        stopped = true
        return
      }
      if (arrived(img)) {
        img.decode().then(
          () => {
            if (mine === epoch) done()
          },
          () => {
            if (mine === epoch) poll = setTimeout(attempt, POLL)
          },
        )
        return
      }
      poll = setTimeout(attempt, POLL)
    }
    attempt()
  }

  const tick = () => {
    clear()
    if (!wanted || !live || still.matches || stopped) return
    const next = (index + 1) % count
    // Ask for the capture that is coming while this one is still held.
    prefetch(next)
    whenReady(next, () => {
      if (!wanted || !live || still.matches || stopped) return
      show(next)
      hold = setTimeout(tick, HOLD)
    })
  }

  /* Starts the clock: the state on screen is real, the next capture is
     asked for, and this state is held for its time before anything
     moves. */
  const start = () => {
    clear()
    if (!wanted || !live || still.matches || stopped) return
    whenReady(index, () => {
      if (!wanted || !live || still.matches || stopped) return
      // The state on screen is real, so ask for the one after it now and
      // let it arrive while this one is held.
      prefetch((index + 1) % count)
      hold = setTimeout(tick, HOLD)
    })
  }

  const sync = () => {
    if (wanted && live && !still.matches && !stopped) start()
    else clear()
  }

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
