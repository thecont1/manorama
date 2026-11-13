/* Closes the homepage's disclosure menus (.home-download). The summary
 * opens them natively; this file only closes: a click anywhere outside,
 * a click on one of the items, or Escape. It also lets the "Start free"
 * buttons open the sign-in disclosure from anywhere on the page.
 * Same-origin because the CSP forbids inline script. */
try {
  var menus = Array.prototype.slice.call(document.querySelectorAll('.home-download'))
  var signin = document.querySelector('.home-signin-menu')

  document.addEventListener('click', function (event) {
    var target = event.target
    menus.forEach(function (menu) {
      if (!menu.open) return
      if (menu.contains(target)) {
        if (target.closest && target.closest('a, .home-download-soon')) menu.open = false
      } else {
        menu.open = false
      }
    })
    // "Start free" reveals the sign-in list rather than scrolling to a fold
    // that no longer carries it. The anchor href stays as the no-script
    // fallback; with script we open the disclosure and move focus to the
    // first provider row.
    if (signin && target.closest && target.closest('[data-signin-open]')) {
      event.preventDefault()
      signin.open = true
      var first = signin.querySelector('.home-signin-list a')
      if (first) first.focus()
    }
  })

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    menus.forEach(function (menu) {
      menu.open = false
    })
  })
} catch (e) {}