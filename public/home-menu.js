/* Enhances the homepage's native disclosure menus (.home-download).
 * Fine-pointer hover opens the two header menus; click, touch and keyboard
 * retain the native summary behavior. Outside clicks, item clicks and Escape
 * close them. "Start free" opens sign-in from anywhere on the page.
 * Same-origin because the CSP forbids inline script. */
try {
  var menus = Array.prototype.slice.call(document.querySelectorAll('.home-download'))
  var headerMenus = Array.prototype.slice.call(document.querySelectorAll('.home-download-header, .home-signin-header'))
  var signin = document.querySelector('.home-signin-menu')
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  var closeMenu = function (menu) {
    menu.open = false
    menu._hoverOpen = false
  }

  headerMenus.forEach(function (menu) {
    var closeTimer
    var summary = menu.querySelector('summary')
    menu.addEventListener('mouseenter', function () {
      if (!finePointer.matches) return
      window.clearTimeout(closeTimer)
      headerMenus.forEach(function (other) {
        if (other !== menu) closeMenu(other)
      })
      if (!menu.open) {
        menu.open = true
        menu._hoverOpen = true
      }
    })
    summary.addEventListener('click', function (event) {
      if (!finePointer.matches || !menu._hoverOpen) return
      // Hover already opened it. A click pins it open instead of letting the
      // native summary toggle immediately undo the hover.
      event.preventDefault()
      menu._hoverOpen = false
      menu.open = true
    })
    menu.addEventListener('mouseleave', function () {
      if (!finePointer.matches || !menu._hoverOpen) return
      window.clearTimeout(closeTimer)
      closeTimer = window.setTimeout(function () {
        var active = document.activeElement
        if (active && menu.contains(active) && active.tagName !== 'SUMMARY') return
        closeMenu(menu)
      }, 150)
    })
  })

  document.addEventListener('click', function (event) {
    var target = event.target
    menus.forEach(function (menu) {
      if (!menu.open) return
      if (menu.contains(target)) {
        if (target.closest && target.closest('a, .home-download-soon')) closeMenu(menu)
      } else {
        closeMenu(menu)
      }
    })
    // The anchor remains a no-script fallback; with script, Start free
    // reveals the provider list and moves focus to its first row.
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
      closeMenu(menu)
    })
  })
} catch (e) {}
