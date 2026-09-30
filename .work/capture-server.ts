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

/** The same `variants[0].src ?? src` the row renders, made absolute — the
 *  manifest answers with proxy paths, and the webview has to be able to fetch
 *  them from the production origin. */
const absolute = (src: string) => (src.startsWith('/') ? `https://manorama.xyz${src}` : src)

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
  if (which !== 3) {
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
  return `
<script>
(function () {
  var log = function () { console.log.apply(console, ['[capture]'].concat([].slice.call(arguments))) }
  var seeded = ${payload}
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
    var url = '/__capture/report'
    body.state = ${which}
    return real(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
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

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url)

    // The calling script picks the state before each launch.
    const stateMatch = url.pathname.match(/^\/state\/(\d+)$/)
    if (stateMatch) {
      state = Number(stateMatch[1])
      report = null
      return new Response(`state=${state}\n`)
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
  const injected = PREBOOT(state) + DRIVER(state)
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
