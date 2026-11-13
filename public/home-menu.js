/* The account panel is a native popover. This script only gives the small-
 * screen section disclosure the same outside-click and Escape behavior.
 * Same-origin because the CSP forbids inline script. */
try {
  var menus = Array.prototype.slice.call(document.querySelectorAll('.home-nav-menu'))
  var account = document.getElementById('home-account-panel')
  var signinTriggers = Array.prototype.slice.call(document.querySelectorAll('.home-signin-trigger, .home-btn[popovertarget="home-account-panel"]'))
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
  var hoverOpen = false
  var accountInvoker = null
  var closeTimer

  var cancelClose = function () { window.clearTimeout(closeTimer) }
  var scheduleClose = function () {
    if (!account || !hoverOpen) return
    cancelClose()
    closeTimer = window.setTimeout(function () {
      if (account.contains(document.activeElement)) return
      account.hidePopover()
      hoverOpen = false
    }, 150)
  }

  signinTriggers.forEach(function (trigger) {
    trigger.addEventListener('mouseenter', function () {
      if (!account || !finePointer.matches) return
      cancelClose()
      if (!account.matches(':popover-open')) {
        account.showPopover()
        hoverOpen = true
      }
    })
    trigger.addEventListener('mouseleave', scheduleClose)
    trigger.addEventListener('click', function () {
      hoverOpen = false
      accountInvoker = trigger
      cancelClose()
    })
  })

  if (account) {
    account.addEventListener('mouseenter', cancelClose)
    account.addEventListener('focusin', cancelClose)
    account.addEventListener('mouseleave', scheduleClose)
    account.addEventListener('toggle', function () {
      if (account.matches(':popover-open')) return
      hoverOpen = false
      var active = document.activeElement
      var focusLost = !active || active === document.body || account.contains(active)
      if (accountInvoker && focusLost) accountInvoker.focus()
      accountInvoker = null
    })
  }

  // A failed OAuth round-trip lands on /?error=1 with its retry note inside
  // the panel. Open it on arrival: a message nobody clicks to see is not a
  // message. hoverOpen stays false, so only a dismissal closes it.
  if (account && /[?&]error=1(?:&|$)/.test(window.location.search)) account.showPopover()

  document.addEventListener('click', function (event) {
    var target = event.target
    menus.forEach(function (menu) {
      if (!menu.open) return
      var inside = menu.contains(target)
      var control = inside && target.closest && target.closest('a, button')
      if (inside && !control) return
      menu.open = false
      // Closing hides the button the keyboard was standing on, and focus
      // falls to the body with it. Hand it back to the summary. Anchors are
      // left alone: the browser moves the focus start point to their target,
      // so Tab already continues from the section the visitor jumped to.
      if (!control || control.tagName !== 'BUTTON' || event.detail !== 0) return
      var trigger = menu.querySelector('summary')
      if (trigger) trigger.focus()
    })
  })

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return
    menus.forEach(function (menu) {
      if (!menu.open) return
      menu.open = false
      var trigger = menu.querySelector('summary')
      if (trigger) trigger.focus()
    })
  })
} catch (e) {}
