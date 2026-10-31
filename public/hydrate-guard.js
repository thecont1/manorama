/* Every island's listeners exist only after hydration, so a click landing in
 * the gap between first paint and hydration used to die silently — the same
 * stuck-state class of bug curtain-boot.js covers for the gallery veil. honox
 * marks each island `data-hono-live` the moment its render finishes and fires
 * `hono:island-live`; until then this buffers events aimed inside that island.
 * Because hydration replaces the SSR nodes, the buffer records a child-index
 * path from the island root rather than the element itself, then re-resolves
 * and re-dispatches each event once its island is live.
 *
 * Only dead input is buffered. A click inside a cold island has no native
 * fallback (anchors and form controls are skipped — the browser already
 * handles those, so replaying them would fire the intent twice). Wheel and
 * pointer input only get buffered when untrusted or natively dead: a real
 * wheel or touch pan scrolls a cold island's overflow natively, except a
 * dominant-axis wheel on a cross-axis-only scroller, which has no native
 * effect at the pointed element. Synthetic input — the kind acceptance
 * tests dispatch — has no native effect and would be lost either way.
 * script-src 'self' forbids inline script, so this loads from /public. */
(function () {
  var pending = []
  var coldIsland = function (node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement
    var island = el && el.closest ? el.closest('[component-name]') : null
    return island && !island.hasAttribute('data-hono-live') ? island : null
  }
  // Hydration re-renders the island tree, so raw child indices are not a
  // stable address — a sibling inserted or removed upstream silently shifts
  // everything after it. Each locator segment instead records the node's tag
  // plus its class signature and its rank among same-signature siblings,
  // which survives structural drift as long as the element itself still
  // renders.
  var signatureOf = function (el) {
    var cls = typeof el.className === 'string' ? el.className.trim() : ''
    return cls ? el.tagName + '.' + cls.split(/\s+/).slice(0, 4).join('.') : el.tagName
  }
  var locatorOf = function (el, island) {
    var path = []
    var node = el
    while (node && node !== island) {
      var parent = node.parentElement
      if (!parent) return null
      var signature = signatureOf(node)
      var rank = 0
      for (var s = 0; s < parent.children.length; s++) {
        var sibling = parent.children[s]
        if (sibling === node) break
        if (signatureOf(sibling) === signature) rank++
      }
      path.push({ signature: signature, rank: rank })
      node = parent
    }
    return { path: path, tag: el.tagName }
  }
  var resolve = function (island, path, tag) {
    var el = island
    for (var i = path.length - 1; i >= 0; i--) {
      var seg = path[i]
      var kids = el.children
      var next = null
      var seen = 0
      for (var k = 0; k < kids.length; k++) {
        if (signatureOf(kids[k]) !== seg.signature) continue
        if (seen === seg.rank) { next = kids[k]; break }
        seen++
      }
      if (!next) return null
      el = next
    }
    return el.tagName === tag ? el : null
  }
  var snapshot = function (event) {
    var init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button || 0,
    }
    if (event.type === 'wheel') {
      init.deltaX = event.deltaX
      init.deltaY = event.deltaY
      init.deltaZ = event.deltaZ || 0
      init.deltaMode = event.deltaMode || 0
      return function () {
        return new WheelEvent('wheel', init)
      }
    }
    if (event.type.indexOf('pointer') === 0) {
      init.pointerId = event.pointerId
      init.pointerType = event.pointerType
      init.isPrimary = event.isPrimary
      return function () {
        return new PointerEvent(event.type, init)
      }
    }
    return function () {
      return new MouseEvent('click', init)
    }
  }
  // A trusted wheel normally scrolls a cold island's overflow natively, so
  // replaying it would double-fire the intent. The exception is a strip that
  // pans horizontally in JS: a vertical wheel on it has no native effect at
  // the pointed element, so without a buffer that intent dies too. The walk
  // below reads the nearest scrollable ancestor — if it cannot scroll in the
  // wheel's dominant axis, the event was dead and belongs in the buffer.
  var wheelDeadNatively = function (event) {
    var vertical = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
    var node = event.target
    var el = node && node.nodeType === 1 ? node : node && node.parentElement
    while (el && el !== document.documentElement) {
      var style = getComputedStyle(el)
      var scrollsY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight
      var scrollsX = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth
      if (!scrollsY && !scrollsX) { el = el.parentElement; continue }
      return vertical ? !scrollsY : !scrollsX
    }
    return false
  }
  var buffer = function (event) {
    var target = event.target
    var island = coldIsland(target)
    if (!island) return
    if (event.type !== 'click' && event.isTrusted) {
      if (event.type !== 'wheel' || !wheelDeadNatively(event)) return
    }
    if (event.type === 'click' && target.closest && target.closest('a[href], form, input, select, textarea, label, summary')) return
    var locator = locatorOf(target.nodeType === 1 ? target : target.parentElement, island)
    if (!locator) return
    pending.push({
      island: island,
      path: locator.path,
      tag: locator.tag,
      make: snapshot(event),
      when: Date.now(),
    })
    if (pending.length > 32) pending.shift()
  }
  var types = ['click', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']
  for (var t = 0; t < types.length; t++) {
    document.addEventListener(types[t], buffer, true)
  }
  window.addEventListener('hono:island-live', function (event) {
    var island = event.detail && event.detail.island
    var now = Date.now()
    for (var i = pending.length - 1; i >= 0; i--) {
      var entry = pending[i]
      if (entry.island !== island) continue
      pending.splice(i, 1)
      if (now - entry.when > 15000) continue
      var el = resolve(island, entry.path, entry.tag)
      if (!el) continue
      el.dispatchEvent(entry.make())
    }
  })

  // The replay above assumes the client module evaluates eventually. When it
  // never does — a lost module-eval task, or a fetch that died on a flaky
  // connection — no island is ever stamped `data-hono-hydrated` and every
  // control on the page stays dead. Re-importing the module under a fresh
  // query forces a new module-map entry that evaluates cleanly; honox skips
  // islands already stamped, so a late-arriving original run is a no-op.
  var retries = 0
  var firstSeen = 0
  var lastKick = 0
  var watchdog = window.setInterval(function () {
    var islands = document.querySelectorAll('[component-name]')
    if (!islands.length) {
      if (document.readyState === 'complete') window.clearInterval(watchdog)
      return
    }
    if (!firstSeen) firstSeen = Date.now()
    for (var i = 0; i < islands.length; i++) {
      if (islands[i].hasAttribute('data-hono-hydrated')) {
        window.clearInterval(watchdog)
        return
      }
    }
    // Module scripts hold the load event, so 'complete' already means the
    // client module's fetch finished — an unstamped island then means its
    // evaluation never ran, not that it is still on the wire.
    if (document.readyState !== 'complete') return
    var now = Date.now()
    if (now - firstSeen < 6000 || now - lastKick < 6000) return
    if (retries >= 4) { window.clearInterval(watchdog); return }
    var script = document.querySelector('script[type="module"][src*="/app/client"]')
      || document.querySelector('script[type="module"][src*="/client"]')
      || document.querySelector('script[type="module"][src]')
    if (!script) { window.clearInterval(watchdog); return }
    retries++
    lastKick = now
    var src = script.src
    import(src + (src.indexOf('?') === -1 ? '?' : '&') + 'hono-retry=' + retries).catch(function () {})
  }, 1000)
})()
