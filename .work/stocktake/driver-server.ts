/**
 * State-driven capture driver for the iOS simulator app.
 *
 * The app has `server.url = http://localhost:4181/?owner=thecontrarian&slug=italy`
 * baked in, so whatever answers on 4181 with the real `native/dist` bundle *is*
 * the app. Unlike `.work/capture-server.ts` this one does not intercept the
 * app's fetch calls: the gallery manifest and the photographs come from the live
 * manorama.xyz API, exactly as they do on a device.
 *
 *   GET  /__step?n=3   choose the state the next launch lands in
 *   GET  /__report     what the page reached
 *
 * States
 *   0  curtain up, gallery open behind it
 *   1  curtain lifted — the strip with its chrome
 *   2  display-settings modal open
 *   3  information sheet (I)
 *   4  the G selector filmstrip
 *   5  vertical scroll mode
 */
const ROOT = '/Users/home/DEV/tools/manorama/native/dist'

let step = 0
let report: Record<string, unknown> = { ready: false, note: 'no report yet' }

const DRIVER = `
<script>
(function () {
  const post = (body) => fetch('/__report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {})
  const log = (...a) => console.log('[drive]', ...a)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (selector, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const el = document.querySelector(selector)
      if (el) return el
      await sleep(150)
    }
    return null
  }
  const click = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    return true
  }
  const decode = () => {
    const img = document.querySelector('[data-stage] .viewer-frame img.frame-img')
    return img && img.complete && img.naturalWidth > 0 ? img.naturalWidth : 0
  }
  const metrics = () => {
    const q = (s) => document.querySelector(s)
    const rect = (s) => {
      const el = q(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    }
    return {
      entered: document.body.classList.contains('gallery-entered'),
      curtain: !!q('[data-curtain]'),
      curtainHidden: q('[data-curtain]') ? q('[data-curtain]').hidden : null,
      controlLogo: rect('button.control-logo'),
      stageArrows: rect('.stage-arrows'),
      seq: rect('.stage-seq'),
      prev: rect('.stage-nav-arrow--previous'),
      next: rect('.stage-nav-arrow--next'),
      panel: rect('.controls-panel'),
      frames: document.querySelectorAll('.viewer-frame').length,
      firstDecoded: decode(),
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    }
  }

  const geometry = () => {
    const cs = getComputedStyle(document.documentElement)
    const bodyCs = getComputedStyle(document.body)
    const stage = document.querySelector('[data-stage]')
    const firstFrame = document.querySelector('[data-stage] .viewer-frame')
    const firstImg = firstFrame && firstFrame.querySelector('img.frame-img')
    const r = (el) => {
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
    }
    const fcs = firstFrame ? getComputedStyle(firstFrame) : null
    return {
      html: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
      bodyPad: bodyCs.padding,
      bodyHeight: bodyCs.height,
      vars: {
        chrome: cs.getPropertyValue('--native-chrome-height').trim(),
        safeTop: cs.getPropertyValue('--native-safe-top').trim(),
        safeBottom: cs.getPropertyValue('--native-safe-bottom').trim(),
        safeLeft: cs.getPropertyValue('--native-safe-left').trim(),
        safeRight: cs.getPropertyValue('--native-safe-right').trim(),
      },
      svh: window.innerHeight,
      stage: r(stage),
      firstFrame: r(firstFrame),
      firstImg: r(firstImg),
      frameStyle: fcs ? { width: fcs.width, height: fcs.height, flex: fcs.flex, alignSelf: fcs.alignSelf } : null,
      imgNatural: firstImg ? [firstImg.naturalWidth, firstImg.naturalHeight] : null,
      stageClass: stage ? stage.className : null,
      frameClass: firstFrame ? firstFrame.className : null,
      frameBg: fcs ? fcs.backgroundColor : null,
      canvasVar: cs.getPropertyValue('--gallery-canvas').trim(),
      imgOutline: firstImg ? getComputedStyle(firstImg).outlineColor + ' / ' + getComputedStyle(firstImg).outlineWidth : null,
    }
  }

  ;(async () => {
    const which = Number(await fetch('/__step').then((r) => r.text()).catch(() => '0'))
    log('step', which)
    const curtain = await waitFor('[data-curtain]', 30000)
    const started = Date.now()
    while (decode() === 0 && Date.now() - started < 40000) await sleep(400)
    await sleep(1500)

    if (which === 0) { await post({ which, ready: true, stage: 'curtain', ...metrics(), geometry: geometry() }); return }

    click(curtain)
    await sleep(1800)

    if (which === 1) { await post({ which, ready: true, stage: 'strip', ...metrics(), geometry: geometry() }); return }
    if (which === 2) {
      click(await waitFor('button.control-logo'))
      await sleep(1200)
      await post({ which, ready: true, stage: 'controls', ...metrics() })
      return
    }
    if (which === 3) {
      // The I shortcut is inert while any modal is open, so this state must not
      // open display settings first.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))
      await sleep(2200)
      const sheet = document.querySelector('[aria-label="Image information and Content Credentials"]')
      await post({ which, ready: !!sheet && !sheet.hidden, stage: 'info', ...metrics() })
      return
    }
    if (which === 4) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
      await sleep(1800)
      const strip = document.querySelector('.viewer-filmstrip')
      await post({ which, ready: !!strip, stage: 'selector', ...metrics() })
      return
    }
    if (which === 5) {
      click(await waitFor('button.control-logo'))
      await sleep(1200)
      const buttons = [].slice.call(document.querySelectorAll('.controls-panel button'))
      const target = buttons.find((b) => /vertical/i.test(b.textContent || ''))
      click(target || null)
      await sleep(2000)
      await post({ which, ready: true, stage: 'vertical', ...metrics() })
      return
    }
    await post({ which, ready: false, stage: 'unknown', ...metrics() })
  })().catch((error) => post({ ready: false, stage: 'error', error: String(error && error.message || error) }))
})()
</script>
`

const withDriver = (html: string) => html.replace('</body>', `${DRIVER}</body>`)

const server = Bun.serve({
  port: 4181,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/__step') {
      const next = url.searchParams.get('n')
      if (next !== null) {
        step = Number(next)
        // Clear the previous state's answer, or the shooter's ready-wait is
        // satisfied instantly by a stale report.
        report = { ready: false, which: step, note: 'pending' }
      }
      return new Response(String(step))
    }
    if (url.pathname === '/__report') {
      if (request.method === 'POST') {
        report = (await request.json()) as Record<string, unknown>
        console.log('report:', JSON.stringify(report))
        return new Response('ok')
      }
      return Response.json(report)
    }

    if (url.pathname === '/' || url.pathname === '/index.html' || !url.pathname.includes('.')) {
      const html = await Bun.file(`${ROOT}/index.html`).text()
      return new Response(withDriver(html), { headers: { 'content-type': 'text/html' } })
    }

    const file = Bun.file(`${ROOT}${url.pathname}`)
    if (await file.exists()) return new Response(file)
    return new Response('not found', { status: 404 })
  },
})

console.log(`driver server on http://localhost:${server.port} serving ${ROOT}`)
