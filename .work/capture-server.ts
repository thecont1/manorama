/**
 * State-driven capture harness for the native screenshot matrix.
 *
 * Serves the real `native/dist` bundle and injects a driver that puts the
 * viewer into one state per launch. The state is chosen by the calling script
 * over HTTP (`GET /state/<n>`) before each `simctl launch`, so captures are
 * deterministic rather than timing-dependent — no burst-and-guess.
 *
 * The app under capture is the shipped bundle: this server only decides which
 * URL the webview loads and which synthetic clicks the page then dispatches, so
 * the pixels are the product's own UI in the app's own webview.
 *
 *   0  gallery opens, curtain up        -> 02 gallery curtain
 *   1  curtain dismissed                -> 03 first image with controls
 *   2  controls button clicked          -> 04 controls popover
 *   3  signed-in account surface        -> 05 account admin
 *   4  real GlobalView island with local-original fixture -> 06 photo picker
 *   5  the preview take, 14.5s cut      -> the App Store preview clip
 *   6  the preview take, 16s ASC cut    -> the submission cut
 *
 * States 5 and 6 are the one continuous take the App Store preview is cut from.
 * They wait at `GET /__capture/run` until the recorder is rolling, then drive
 * the shot list off a single clock; see CHOREO below.
 *
 * State 3 is the odd one out: it is the owner's own surface, behind a session
 * the simulator cannot obtain, and the Worker will not hand a gallery list to
 * anyone else. So the two session-gated answers (`/api/galleries` and
 * `/api/device-galleries`) and the SecureStorage session are seeded here, and
 * everything else the screen shows is answered live by manorama.xyz — the
 * visibility switch, its day and region, and the thumbnails themselves. The
 * seeded list is built from the owner's own public gallery rather than invented,
 * so the photograph, the title and the caption in the capture are real.
 *
 * The driver reports what it reached back over `POST /__capture/report`, and
 * `GET /__capture/report` hands that to the calling script, which waits for it
 * instead of sleeping.
 *
 * Requires `server.url` to point here for the duration of a harness build; see
 * scripts/capture-screens.sh, which owns that toggle and restores it.
 */
const ROOT = new URL('../native/dist/', import.meta.url).pathname
const PORT = 4181

/** The owner's public gallery, which stands in for the private list. */
const PUBLIC_MANIFEST = 'https://manorama.xyz/api/gallery/thecontrarian/italy'
const PHOTO_DIR = '/Users/home/Library/CloudStorage/Dropbox/italy'
const FIRST_ORIGINAL = `${PHOTO_DIR}/MS201810-Italy0005.jpg`
const FIRST_CAPTURE_PATH = '/__capture/first-original.jpg'
const FIRST_CAPTURE_BASE = `http://localhost:${PORT}`
// NativeManifest rewrites relative paths against apiBase (manorama.xyz), not the
// WebView's origin. Keep this absolute so it stays on the local harness.
const FIRST_CAPTURE_URL = `http://localhost:${PORT}${FIRST_CAPTURE_PATH}`
const OWNER_SLUG = 'thecontrarian'
const OWNER_NAME = 'Mahesh Shantaram'
/** The label the owner's own iPhone registered with the account. */
const DEVICE_LABEL = 'iPhone 17 Pro Max'

type Json = Record<string, unknown>

let state = 0
let report: Json | null = null
let fixture: { gallery: Json; galleries: Json; deviceGalleries: Json } | null = null
/** Held open by the preview choreography until the recorder is rolling. */
let runGate: Promise<void> | null = null
let openRun: (() => void) | null = null

/** The same `variants[0].src ?? src` the row renders, made absolute — the
 *  manifest answers with proxy paths, and the webview has to be able to fetch
 *  them from the production origin. */
const absolute = (src: string) => (src.startsWith('/') ? `https://manorama.xyz${src}` : src)

/** True pixel dimensions of the owner's local originals, keyed by filename.
 *  The public manifest advertises 256x171 — the thumbnail variant, not the
 *  master — so a manifest that serves the real bytes has to declare the real
 *  width and height, or the viewer heals each frame the moment it decodes and
 *  the strip reflows mid-scroll. Written by scripts/capture-preview.sh; absent
 *  until that runs, in which case the public manifest is left alone. */
const DIMS_PATH = '/tmp/mano-photo-dims.json'
const photoDims = (): Record<string, [number, number]> => {
  const file = Bun.file(DIMS_PATH)
  if (!file.size) return {}
  try {
    return JSON.parse(file.text()) as Record<string, [number, number]>
  } catch {
    return {}
  }
}

/** State 5's gallery: the owner's own manifest with every photograph served
 *  from the local original through the harness origin. Byte-identical to what
 *  the provider returns — no resize, no re-encode, no metadata edit — so the
 *  scroll in the preview shows the real photographs instead of a decode race
 *  against the network. Order and declared dimensions are preserved. */
const localGallery = () => {
  const gallery = fixture?.gallery
  if (!gallery) return null
  const dims = photoDims()
  const manifest = gallery.manifest as Json
  const images = (manifest.images as Json[]).map((image) => {
    const filename = image.filename as string
    const [w, h] = dims[filename] ?? [image.width as number, image.height as number]
    return {
      ...image,
      src: `${FIRST_CAPTURE_BASE}/__capture/photo/${encodeURIComponent(filename)}`,
      width: w,
      height: h,
      variants: [],
    }
  })
  return { ...gallery, manifest: { ...manifest, images } }
}

const buildFixture = async () => {
  const response = await fetch(PUBLIC_MANIFEST)
  if (!response.ok) throw new Error(`fixture source answered ${response.status}`)
  const body = (await response.json()) as Json
  const manifest = body.manifest as Json
  const images = (manifest.images as Json[]).map((image) => ({
    id: image.id,
    ref: image.ref ?? image.id,
    filename: image.filename,
    src: absolute(image.src as string),
    width: image.width,
    height: image.height,
    alt: image.alt,
    placeholder: image.placeholder,
    variants: ((image.variants ?? []) as Json[]).map((variant) => ({ ...variant, src: absolute(variant.src as string) })),
  }))
  const title = manifest.title as string
  const caption = manifest.caption as string
  const original = Bun.file(FIRST_ORIGINAL)
  if (!(await original.exists())) throw new Error(`the owner's first original is unavailable: ${FIRST_ORIGINAL}`)
  // The remote thumbnail proxy may not answer in the simulator before its
  // screenshot deadline. The stage gets a byte-identical master through the
  // harness origin instead; no resize, re-encode, or metadata edit occurs.
  const galleryImages = [...(manifest.images as Json[])]
  galleryImages[0] = {
    ...galleryImages[0], src: FIRST_CAPTURE_URL,
    width: 2560, height: 1707, variants: [],
  }
  fixture = {
    gallery: { ...body, manifest: { ...manifest, images: galleryImages } },
    galleries: {
      galleries: [{
        slug: 'capture-gallery',
        title,
        caption,
        date: manifest.date ?? '',
        imageCount: images.length,
        sourceUrl: null,
        createdAt: null,
        retention: 'retained',
        expiresAt: null,
        images,
      }],
    },
    deviceGalleries: {
      galleries: [{
        id: '3f1c2a58-0f7b-4a2e-9a1d-6c5e8b7d4f20',
        title,
        sourceKind: 'folder',
        itemCount: images.length,
        deviceId: 'b7d1e4c6-2a35-4f8b-8e19-0d3c6a5b9e71',
        deviceLabel: DEVICE_LABEL,
        updatedAt: '2026-09-30T00:00:00Z',
      }],
    },
  }
  return fixture
}

/** Runs before the app's module, so the bridge and `fetch` are already patched
 *  by the time the island reads its session. */
const PREBOOT = (which: number) => {
  // 3 is the account screenshot; 5 and 6 are the preview takes, which open on
  // that same account surface. All three seed the session and answer the two
  // session-gated lists; only 5 and 6 also need a gallery they can navigate
  // into, which the branch below adds.
  const account = which === 3 || which === 5 || which === 6
  if (!account) {
    const gallery = JSON.stringify(fixture?.gallery)
    return `
<script>
(function () {
  var gallery = ${gallery}
  var real = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input)
    if (url.indexOf('/api/gallery/thecontrarian/italy') !== -1) {
      return Promise.resolve(new Response(JSON.stringify(gallery), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
    }
    return real(input, init)
  }
})()
</script>
`
  }
  const payload = JSON.stringify({ ...fixture, ownerSlug: OWNER_SLUG, ownerName: OWNER_NAME })
  // State 5 opens a gallery from the account list, which the state-3 patch
  // never had to answer. It gets the same manifest with the photographs served
  // from the owner's local originals, so the clip's scroll is not racing the
  // network for the pixels it is about to show.
  const local = JSON.stringify(localGallery())
  return `
<script>
(function () {
  var log = function () { console.log.apply(console, ['[capture]'].concat([].slice.call(arguments))) }
  var seeded = ${payload}
  var local = ${local}
  // The harness URL carries the public gallery, which the gallery states need
  // and this one must not have: left in place the island would open \`italy\`
  // instead of the owner's own list. Rewritten before the island reads it.
  if (window.location.search) {
    window.history.replaceState(null, '', window.location.pathname)
    log('cleared the harness query for the account surface')
  }
  var PREFIX = 'capacitor-storage_'
  var store = {}
  store[PREFIX + 'manorama.session-token'] = 'capture-session-token'
  store[PREFIX + 'manorama.owner-slug'] = seeded.ownerSlug

  // The session lives in the Keychain, which a simulator cannot be handed. The
  // bridge is the only seam that reaches it without touching the bundle, so
  // SecureStorage's native calls are answered from memory for this launch.
  var bridge = window.Capacitor
  if (bridge && bridge.nativePromise) {
    var native = bridge.nativePromise.bind(bridge)
    bridge.nativePromise = function (plugin, method, options) {
      if (plugin !== 'SecureStorage') return native(plugin, method, options)
      var key = options && options.prefixedKey
      if (method === 'internalGetItem') {
        return Promise.resolve({ data: Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null })
      }
      if (method === 'internalSetItem') { store[key] = options.data; return Promise.resolve() }
      if (method === 'internalRemoveItem') { delete store[key]; return Promise.resolve({ success: true }) }
      if (method === 'internalGetPrefixedKeys') return Promise.resolve({ keys: Object.keys(store) })
      if (method === 'setSynchronizeKeychain') return Promise.resolve()
      return native(plugin, method, options)
    }
    log('session seeded at the bridge')
  } else {
    log('no native bridge; seeding localStorage instead')
    try {
      Object.keys(store).forEach(function (key) { localStorage.setItem(key, store[key]) })
    } catch (error) { log('storage seed failed', error) }
  }

  var json = function (body) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  var real = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input)
    if (url.indexOf('__capture') !== -1) return real(input, init)
    if (url.indexOf('/api/gallery/') !== -1) return Promise.resolve(json(local))
    if (url.indexOf('/api/device-galleries') !== -1) return Promise.resolve(json(seeded.deviceGalleries))
    if (url.indexOf('/api/galleries') !== -1) return Promise.resolve(json(seeded.galleries))
    if (url.indexOf('/api/account/identities') !== -1) {
      return Promise.resolve(json({ identities: [{ provider: 'dropbox', displayName: seeded.ownerName }] }))
    }
    if (url.indexOf('/api/account') !== -1) return Promise.resolve(json({ ownerSlug: seeded.ownerSlug }))
    // Session-gated, and answered empty: the switch is not suppressed.
    if (url.indexOf('/api/ads/suppressions') !== -1) return Promise.resolve(json({ suppressions: [] }))
    return real(input, init)
  }

  var stills = function () {
    var images = document.querySelectorAll('.native-gallery-thumb img')
    var loaded = 0
    for (var i = 0; i < images.length; i++) if (images[i].complete && images[i].naturalWidth > 0) loaded++
    return { thumbs: images.length, loaded: loaded }
  }
  var send = function (body) {
    // The preview takes (5 and 6) have their own readiness signal from the
    // choreography, and this one is the state-3 screenshot's. Both write the same
    // slot, so on a preview take this would land second and overwrite the page's
    // "account is up" — and the recording script, which is waiting for exactly
    // that, would never see it.
    if (!(${which} === 5 || ${which} === 6)) {
      var url = '/__capture/report'
      body.state = ${which}
      return real(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    }
    return Promise.resolve()
  }
  var started = Date.now()
  var wait = function () {
    var account = document.querySelector('.native-account')
    var cards = document.querySelector('.native-house-cards')
    var policy = document.querySelector('.native-load-policy')
    var strip = stills()
    var ready = Boolean(account && cards && policy && strip.thumbs > 0 && strip.loaded >= 1)
    if (ready || Date.now() - started > 40000) {
      log('state ${which} ready:', ready, JSON.stringify(strip))
      send({
        ready: ready,
        elapsed: Date.now() - started,
        signedIn: Boolean(account),
        houseCards: cards ? (cards.querySelector('.native-house-cards-status') || {}).textContent : null,
        buttons: [].map.call(document.querySelectorAll('.native-house-cards-actions button'), function (b) { return b.textContent }),
        headings: [].map.call(document.querySelectorAll('.native-house-cards h2, .native-load-policy h2, .native-global-setting h2, .native-device h2'), function (h) { return h.textContent }),
        thumbs: strip
      })
      return
    }
    setTimeout(wait, 250)
  }
  setTimeout(wait, 400)
})()
</script>
`
}

const DRIVER = (which: number) => `
<script>
(function () {
  const log = (...a) => console.log('[capture]', ...a)
  const waitFor = (selector, timeout = 25000) => new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const el = document.querySelector(selector)
      if (el) return resolve(el)
      if (Date.now() - started > timeout) return resolve(null)
      setTimeout(tick, 150)
    }
    tick()
  })
  const click = (el) => {
    if (!el) { log('click: element missing'); return false }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  const firstImage = async (timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const image = document.querySelector('[data-stage] .viewer-frame[data-index="1"] img.frame-img')
      if (image?.complete && image.naturalWidth > 0) return image
      await new Promise((r) => setTimeout(r, 250))
    }
    return null
  }
  const report = (ready) => fetch('/__capture/report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: ${which}, ready, firstImageWidth: document.querySelector('[data-stage] .viewer-frame[data-index="1"] img.frame-img')?.naturalWidth ?? 0 })
  })

  ;(async () => {
    if (${which} === 3) return
    const curtain = await waitFor('[data-curtain]')
    log('state ${which}, curtain present:', !!curtain)
    const image = await firstImage()
    log('first image decoded:', image?.naturalWidth ?? 0)
    if (!curtain || !image) { await report(false); return }
    if (${which} === 0) { await report(true); return }

    // Let the gallery settle before anything moves, so the strip is not caught
    // mid-entry.
    await new Promise((r) => setTimeout(r, 1200))
    log('lifting curtain:', click(curtain))
    if (${which} === 1) {
      await new Promise((r) => setTimeout(r, 1300))
      await report(!document.querySelector('body:not(.gallery-entered)'))
      return
    }

    // The lift settles over ~980ms; wait it out so the dot is where the strip
    // left it before the settings modal opens.
    await new Promise((r) => setTimeout(r, 2200))
    log('opening settings:', click(document.querySelector('button.control-logo')))
    await new Promise((r) => setTimeout(r, 300))
    await report(true)
  })()
})()
</script>
`

/**
 * State 5 and 6: the App Store preview take.
 *
 * Same trick as the screenshot driver — the harness only decides which URL the
 * webview loads and which events the page dispatches — but timed against the
 * shot list rather than polled for one state. Nothing here draws: the account
 * surface, the curtain, the lift and the strip are the app's own, and the drag
 * is the viewer's own pointer path through `beginDrag` / `onPointerMove` /
 * `onPointerUp`, so the 1:1 tracking and the momentum glide in the clip are the
 * shipping physics running on the real bundle, not a re-creation.
 *
 * The timeline is event-anchored where it has to be (the curtain rests a real
 * 1.5s before it is raised) and clock-anchored everywhere else, so the scroll
 * block lands on its marks even if the open transition runs long.
 *
 *   5  the 14.5s cut as briefed
 *   6  the 16s App Store Connect cut: same timeline, scroll eased out, end
 *      frame held two seconds longer
 */
const CHOREO = (which: number) => {
  // Cycle starts are absolute, not relative, so one stroke running long cannot
  // push the rest of the take with it. Each start sits clear of the previous
  // stroke's settle (~0.2s of stillness reads as a thumb lifting off), and the
  // last one is placed so the strip is already at rest when the end frame
  // begins: a measured take settles ~0.2s after its cycle start, so 11.2 lands
  // at ~13.4s for the 14.5s cut and 11.7 at ~13.7s for the 16s one.
  const schema = which === 6
    ? { total: 16.0, raise: 3.4, cycles: [4.45, 8.20, 11.70] }
    : { total: 14.5, raise: 3.4, cycles: [4.45, 8.00, 11.20] }
  return `
<script>
(function () {
  const log = (...a) => console.log('[capture]', ...a)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const frame = () => new Promise((r) => requestAnimationFrame(r))
  const post = (body) => fetch('/__capture/report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })

  // setPointerCapture rejects a pointerId the browser never issued, and a
  // synthetic event has no live pointer to capture. Every strip listener is
  // bound to the stage itself, so dispatching there needs no retargeting and
  // capture can be stubbed out. Touch, not mouse: the viewer's glide constants
  // are chosen on event.pointerType, and only the touch path is the one a
  // thumb on glass would take.
  Element.prototype.setPointerCapture = function () {}
  Element.prototype.releasePointerCapture = function () {}
  const ev = (type, x, y) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'touch', isPrimary: true,
    clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1
  })

  const SCHEMA = ${JSON.stringify(schema)}
  const marks = {}
  let t0 = 0
  const mark = (name) => { marks[name] = +((performance.now() - t0) / 1000).toFixed(3) }
  const at = (s) => sleep(Math.max(0, t0 + s * 1000 - performance.now()))

  // --- the copy ---------------------------------------------------------------
  //
  // Set in the app's own type, not burned on afterwards. Playfair at the curtain
  // caption's own variation settings is the treatment the gallery already uses,
  // and the browser has the variable font loaded already, so the overlay is
  // rasterised by the same engine that rasterised the photographs beside it —
  // no second compositor, no resample, nothing to disagree about the colour.
  //
  // It sits in the band between the status bar and the top of a photograph,
  // which is stage black at every frame of the take: strip frames are
  // vertically centred, so the band never closes as the strip moves.
  //
  // Line 2 is not the brief's wording and the substitution is deliberate. The
  // brief asks for "every photograph at full height", but imageStageSize caps a
  // strip frame at min(stageHeight/h, 1/dpr) — a 2560x1707 source on a 3x screen
  // would need a 1.63x upscale to reach full height, so the app floats it at
  // honest size and leaves stage black above and below. "full height" on screen
  // would be a false claim in Apple's own review of a product whose thesis is
  // that it never fabricates pixels.
  const COPY = [
    { from: 5.0, to: 8.5, text: 'one strip, no gaps — drag it', italic: true, top: 64 },
    { from: 9.0, to: 12.5, text: 'every photograph, never upscaled', italic: true, top: 64 },
    { from: 13.0, to: SCHEMA.total, text: 'manorama.xyz', italic: false, top: 62 },
    // Stacked under the wordmark, not on it: the end frame carries both at
    // once, and they are the same size so neither reads as the disclaimer.
    { from: 13.6, to: SCHEMA.total, text: 'Sign in required', italic: false, top: 96 },
  ]
  const copyLayer = document.createElement('div')
  copyLayer.setAttribute('data-preview-copy', '')
  copyLayer.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647', 'pointer-events:none',
    'font-family:Playfair,Bricolate Grotesque,ui-serif,Georgia,serif',
    'font-optical-sizing:auto', 'font-variation-settings:"wdght" 300,"wdth" 85',
    "color:rgba(243,240,232,.88)", 'letter-spacing:-.01em',
  ].join(';')
  for (const line of COPY) {
    const el = document.createElement('div')
    el.textContent = line.text
    el.style.cssText = [
      'position:absolute', 'left:22px',
      // Clear of the status bar, and above the tallest frame's top edge.
      'top:' + line.top + 'px',
      'font-size:16px', 'line-height:1.5', 'font-style:' + (line.italic ? 'italic' : 'normal'),
      'opacity:0', 'transition:opacity 260ms ease',
    ].join(';')
    copyLayer.appendChild(el)
    line.el = el
  }
  const mountCopy = () => document.body.appendChild(copyLayer)
  // Driven off the same clock as the choreography rather than off its own
  // timers, so a stroke running long cannot leave the copy off its marks.
  const runCopy = () => {
    const now = (performance.now() - t0) / 1000
    for (const line of COPY) {
      const on = t0 > 0 && now >= line.from && now <= line.to
      if (on !== line.on) { line.on = on; line.el.style.opacity = on ? '1' : '0' }
    }
    requestAnimationFrame(runCopy)
  }

  const trackX = () => {
    const track = document.querySelector('[data-track]')
    const m = track && /translate3d\\(\\s*(-?[\\d.]+)px/.exec(track.style.transform || '')
    return m ? parseFloat(m[1]) : 0
  }
  // The strip is at rest when its own transform has stopped changing. Reads the
  // track the viewer writes, so this is the shipping position, not a guess.
  const atRest = async (still = 8) => {
    let count = 0, last = trackX()
    while (count < still) {
      await frame()
      const now = trackX()
      count = Math.abs(now - last) < 0.01 ? count + 1 : 0
      last = now
    }
    return last
  }

  // One thumb stroke: a slow 1:1 travel, then a short fast move, then release.
  // The viewer derives momentum from the pointer samples inside its last 100ms
  // window, so the flick — not the slow part — is what makes the strip glide on
  // instead of stopping where the finger left it.
  const stroke = async (stage, y, x0, x1, ms, flickPx, flickMs) => {
    const start = performance.now()
    stage.dispatchEvent(ev('pointerdown', x0, y))
    const travel = (from, to, dur) => new Promise((resolve) => {
      const t0 = performance.now()
      const step = () => {
        const p = Math.min(1, (performance.now() - t0) / dur)
        stage.dispatchEvent(ev('pointermove', from + (to - from) * p, y))
        if (p < 1) requestAnimationFrame(step); else resolve()
      }
      requestAnimationFrame(step)
    })
    await travel(x0, x1, ms)
    if (flickPx) {
      await travel(x1, x1 - flickPx, flickMs)
      stage.dispatchEvent(ev('pointerup', x1 - flickPx, y))
    } else {
      stage.dispatchEvent(ev('pointerup', x1, y))
    }
  }

  ;(async () => {
    // --- the account surface, held still -------------------------------------
    const row = await (async () => {
      const started = Date.now()
      while (Date.now() - started < 60000) {
        const account = document.querySelector('.native-account')
        const el = document.querySelector('button.native-gallery-row')
        const img = el && el.querySelector('.native-gallery-thumb img')
        if (account && el && img && img.complete && img.naturalWidth > 0) return el
        await sleep(250)
      }
      return null
    })()
    if (!row) { await post({ ready: false, stage: 'account' }); return }
    await post({ ready: true, stage: 'account' })

    // The calling script starts the recorder first and only then fires this,
    // so t0 is the first frame of the hold rather than whenever the app booted.
    await fetch('/__capture/run')
    t0 = performance.now()
    mountCopy()
    requestAnimationFrame(runCopy)
    // Wall-clock epoch of t0, so the calling script can trim the head exactly
    // instead of guessing at the recorder's spin-up. performance.now() and the
    // host clock are bridged here, once, at the instant the gate opens.
    marks.epochAtT0 = Math.round(Date.now() - performance.now() + t0)
    mark('hold')

    // --- 1.5s: the tap, which is the app's own transition --------------------
    await at(1.5)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    mark('tappedCard')

    // --- the curtain rests over the first photograph -------------------------
    const curtain = await (async () => {
      const started = Date.now()
      while (Date.now() - started < 20000) {
        const el = document.querySelector('[data-curtain]')
        const first = document.querySelector('[data-stage] .viewer-frame[data-index="1"] img.frame-img')
        if (el && first && first.complete && first.naturalWidth > 0) return el
        await sleep(50)
      }
      return null
    })()
    if (!curtain) { await post({ ready: false, stage: 'curtain', marks }); return }
    mark('curtainRests')

    // A real 1.5s of legible title and caption, and never earlier than the
    // shot list's mark.
    await at(Math.max(SCHEMA.raise, (performance.now() - t0) / 1000 + 1.5))
    curtain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    mark('curtainRaised')

    // --- the scroll ----------------------------------------------------------
    const stage = await (async () => {
      const started = Date.now()
      while (Date.now() - started < 20000) {
        const el = document.querySelector('[data-stage]')
        if (el && document.body.classList.contains('gallery-entered') && !document.querySelector('[data-curtain].is-lifting')) return el
        await sleep(50)
      }
      return document.querySelector('[data-stage]')
    })()
    if (!stage) { await post({ ready: false, stage: 'strip', marks }); return }

    const rect = stage.getBoundingClientRect()
    const y = Math.round(rect.height * 0.5)
    const frameEl = stage.querySelector('.viewer-frame')
    const imgW = frameEl ? frameEl.offsetWidth || rect.width : rect.width
    const right = Math.round(rect.width * 0.86)
    // Every stroke is a fraction of one photograph's own width, so the strip
    // travels the full width of a picture before the next one arrives at any
    // screen size. 1.0 is a full-width travel; the strokes below sit under it.
    const at1 = (n) => Math.round(right - n * imgW)
    mark('stripReady')
    log('mode:', stage.className, 'image width:', imgW, 'right edge:', right)

    // Three strokes: a long one with a real momentum carry, a slower second,
    // then a short settle-in. Crosses three to four photographs in total.
    const strokes = [
      { at: SCHEMA.cycles[0], travel: 0.70, ms: 1750, flick: 0.16, flickMs: 110 },
      { at: SCHEMA.cycles[1], travel: 0.66, ms: 2000, flick: 0.13, flickMs: 130 },
      { at: SCHEMA.cycles[2], travel: 0.58, ms: 1300, flick: 0.10, flickMs: 140 },
    ]
    for (const s of strokes) {
      await at(s.at)
      const before = trackX()
      await stroke(stage, y, right, at1(s.travel), s.ms, Math.round(s.flick * imgW), s.flickMs)
      const after = trackX()
      await atRest()
      mark('settled@' + s.at)
      log('stroke at', s.at, 'travelled', (after - before).toFixed(1), 'px, resting at', trackX().toFixed(1))
    }

    // --- the end frame -------------------------------------------------------
    await atRest()
    marks.restX = +trackX().toFixed(1)
    marks.mode = stage.className
    marks.imageWidth = imgW
    marks.total = SCHEMA.total
    await post({ ready: true, stage: 'done', marks })
  })().catch((error) => { log('choreography failed', error); post({ ready: false, stage: 'error', error: String(error) }) })
})()
</script>
`
}

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  // The preview choreography holds a request open at /__capture/run for as long
  // as the app takes to reach its account surface, which is however long the
  // owner's own thumbnails take. Bun's default idle timeout is 10s and kills it
  // mid-wait, which the page sees as a failed fetch.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)

    // The calling script picks the state before each launch.
    const stateMatch = url.pathname.match(/^\/state\/(\d+)$/)
    if (stateMatch) {
      state = Number(stateMatch[1])
      report = null
      // A gate left over from a previous take would let the next one start
      // before its recorder is rolling.
      openRun?.()
      runGate = null
      openRun = null
      return new Response(`state=${state}\n`)
    }

    if (url.pathname === '/__capture/run') {
      // The gate between "the app is on screen" and "the recorder is rolling".
      // The page holds this request open and the calling script answers it the
      // moment it has started recording, so t0 in the choreography is the first
      // recorded frame rather than whenever the app happened to finish booting.
      if (request.method === 'POST') {
        openRun?.()
        openRun = null
        runGate = null
        return new Response('running\n')
      }
      if (!runGate) {
        runGate = new Promise<void>((resolve) => { openRun = resolve })
      }
      await runGate
      return new Response('go\n')
    }

    if (url.pathname === '/__capture/report') {
      if (request.method === 'POST') {
        report = (await request.json()) as Json
        console.log('capture report:', JSON.stringify(report))
        return new Response('ok\n')
      }
      return new Response(report ? JSON.stringify(report) : 'null', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }

    if (url.pathname === FIRST_CAPTURE_PATH) {
      return new Response(Bun.file(FIRST_ORIGINAL), {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
      })
    }

    if (url.pathname === '/__capture/gallery-fixture') {
      return Response.json(fixture?.gallery, { headers: { 'cache-control': 'no-store' } })
    }
    if (url.pathname.startsWith('/__capture/photo/')) {
      const filename = decodeURIComponent(url.pathname.slice('/__capture/photo/'.length))
      const allowed = (fixture?.gallery.manifest as Json)?.images as Json[] | undefined
      const image = allowed?.find((item) => item.filename === filename)
      if (!/^[A-Za-z0-9._-]+\.jpg$/i.test(filename) || !image) {
        return new Response('not found', { status: 404 })
      }
      const photo = Bun.file(`${PHOTO_DIR}/${filename}`)
      if (await photo.exists()) {
        // A Dropbox File Provider placeholder advertises the master's size but
        // reads as zero bytes. Never answer with its advertised Content-Length
        // and an empty body; that leaves a blank cell in the picker. Read the
        // local bytes first, and only serve them if they are complete.
        try {
          const bytes = new Uint8Array(await photo.arrayBuffer())
          if (bytes.byteLength === photo.size && bytes.byteLength > 0) {
            return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } })
          }
        } catch {
          // File Provider can also reject the read with DEADLK while it
          // materializes a placeholder. The public original is the fallback.
        }
      }
      // The public provider proxy returns the same original JPEG, transiently,
      // without resizing or writing image bytes to the server or disk.
      const remote = await fetch(absolute(image.src as string))
      if (!remote.ok) return new Response('original unavailable', { status: 502 })
      return new Response(remote.body, {
        headers: { 'content-type': remote.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'no-store' },
      })
    }
    if (url.pathname === '/__capture/global-view.css') {
      return new Response(Bun.file(new URL('../native/styles/global-view.css', import.meta.url).pathname), {
        headers: { 'content-type': 'text/css; charset=utf-8' },
      })
    }
    if (url.pathname === '/__capture/global-view-fixture.js') {
      const file = Bun.file('/tmp/capture-global/global-view-fixture.js')
      return (await file.exists())
        ? new Response(file, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
        : new Response('build the GlobalView fixture first', { status: 503 })
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const file = Bun.file(ROOT + path.replace(/^\//, ''))

    if (!(await file.exists())) {
      // A route the SPA owns still needs the shell, exactly as the bundled
      // shell would serve it.
      const shell = Bun.file(ROOT + 'index.html')
      if (!(await shell.exists())) return new Response('not found', { status: 404 })
      return html(await shell.text())
    }
    if (path.endsWith('.html')) return html(await file.text())
    return new Response(file)
  },
})

function html(source: string) {
  if (state === 4) {
    const style = source.match(/href="(\/assets\/[^" ]+\.css)"/)?.[1]
    if (!style) return new Response('native CSS not found', { status: 500 })
    return new Response(`<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<link rel="stylesheet" href="${style}" /><link rel="stylesheet" href="/__capture/global-view.css" /></head>
<body style="margin:0;background:#0a0a0a"><img src="${FIRST_CAPTURE_PATH}" alt="" aria-hidden="true"
style="position:fixed;inset:0;width:100%;height:100%;object-fit:contain" /><div id="app"></div>
<script type="module" src="/__capture/global-view-fixture.js"></script></body></html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  const injected = PREBOOT(state) + (state === 5 || state === 6 ? CHOREO(state) : DRIVER(state))
  const body = source.includes('</body>')
    ? source.replace('</body>', injected + '</body>')
    : source + injected
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

await buildFixture()
console.log(`capture harness on http://localhost:${server.port} serving ${ROOT}`)
console.log(`state 3 fixture: ${JSON.stringify(fixture?.galleries).slice(0, 120)}…`)
