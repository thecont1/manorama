/* The homepage's theme toggle. The key and the class are the app's own —
 * manorama:theme and html.light — so a choice made here follows the
 * visitor into the dashboard and the apps. theme-init.js has already
 * flipped the class before paint; this file only labels the controls,
 * reveals them once they can work, and wires the click. Same-origin
 * because the CSP forbids inline script. */
try {
  var KEY = 'manorama:theme'
  var root = document.documentElement
  var toggles = Array.prototype.slice.call(document.querySelectorAll('[data-theme-toggle]'))

  var current = root.classList.contains('light') ? 'light' : 'dark'

  var apply = function (theme) {
    var light = theme === 'light'
    root.classList.toggle('light', light)
    var label = light ? 'Dark mode' : 'Light mode'
    toggles.forEach(function (el) {
      el.hidden = false
      el.textContent = label
      el.setAttribute('aria-label', label)
      el.setAttribute('aria-pressed', light ? 'true' : 'false')
    })
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', light ? '#f3f0e8' : '#0a0a0a')
  }

  apply(current)

  toggles.forEach(function (el) {
    el.addEventListener('click', function () {
      current = current === 'light' ? 'dark' : 'light'
      try { localStorage.setItem(KEY, current) } catch (e) {}
      apply(current)
    })
  })
} catch (e) {}
