/* Closes the homepage's disclosure menus (.home-download). The summary
 * opens them natively; this file only closes: a click anywhere outside,
 * a click on one of the items, or Escape. Same-origin because the CSP
 * forbids inline script. */
try {
  var menus = Array.prototype.slice.call(document.querySelectorAll('.home-download'))

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
  })

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    menus.forEach(function (menu) {
      menu.open = false
    })
  })
} catch (e) {}
