/* The gallery curtain's dismissal listeners live in the viewer island, so a
 * tap or upward swipe landing before hydration used to die silently and leave
 * the veil stuck on stage. Registered at parse time, this arms a short replay
 * for each real tap — and for an upward swipe, which browsers do not report
 * as a click: every retry re-dispatches a click until the island's own
 * dismissal takes it (the veil gains `fading` or `hidden`).
 *
 * There is no clock-based arm window: once hydrated, the island's own click
 * handler runs in the target phase before this document listener and marks
 * the veil `fading` synchronously, so replay never starts on a live island
 * and never double-fires. The pointer bookkeeping mirrors the island's own
 * suppression rule — a click released after a >12px drag is not a tap, so it
 * never arms replay either. The 30s bound only covers an island that never
 * hydrates at all. script-src 'self' forbids inline script, so this loads
 * from /public. */
(function () {
  var pending = 0
  var pointerStart = null
  var suppressClick = false
  var replay = function (curtain) {
    if (pending) return
    var armedAt = Date.now()
    pending = window.setInterval(function () {
      if (curtain.classList.contains('fading') || curtain.hidden || Date.now() - armedAt > 30000) {
        window.clearInterval(pending)
        pending = 0
        return
      }
      curtain.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, 150)
  }
  document.addEventListener('pointerdown', function (event) {
    var target = event.target
    if (target && target.closest && target.closest('[data-curtain]')) {
      pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }
    }
  }, true)
  document.addEventListener('pointerup', function (event) {
    if (!pointerStart || pointerStart.id !== event.pointerId) return
    var horizontal = Math.abs(event.clientX - pointerStart.x)
    var upward = pointerStart.y - event.clientY
    suppressClick = horizontal > 12 || Math.abs(upward) > 12
    pointerStart = null
  }, true)
  document.addEventListener('click', function (event) {
    if (!event.isTrusted) return
    if (suppressClick) { suppressClick = false; return }
    var target = event.target
    var curtain = target && target.closest ? target.closest('[data-curtain]') : null
    if (!curtain || curtain.classList.contains('fading')) return
    replay(curtain)
  })
  // The island dismisses on a ≥48px upward swipe; the same intent replays as a
  // tap when it lands before hydration.
  var touchStart = null
  document.addEventListener('touchstart', function (event) {
    var target = event.target
    var curtain = target && target.closest ? target.closest('[data-curtain]') : null
    var touch = event.touches && event.touches[0]
    touchStart = curtain && touch ? { y: touch.clientY, curtain: curtain } : null
  }, { passive: true })
  document.addEventListener('touchend', function (event) {
    if (!touchStart) return
    var start = touchStart
    touchStart = null
    var touch = event.changedTouches && event.changedTouches[0]
    if (!touch || start.curtain.classList.contains('fading')) return
    if (start.y - touch.clientY >= 48) replay(start.curtain)
  }, { passive: true })
})()
