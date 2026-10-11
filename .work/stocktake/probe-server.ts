/**
 * Diagnostic server for the iOS WebView.
 *
 * The simulator app has `server.url = http://localhost:4181/?owner=…&slug=…`
 * baked in, so anything that answers on 4181 with the real bundle is the app.
 * This server serves `native/dist` untouched — no fetch interception — and
 * injects one script that reports what the page actually did: which images the
 * viewer mounted, whether they decoded, and every resource error.
 *
 *   GET /__probe   the latest report
 */
const ROOT = '/Users/home/DEV/tools/manorama/native/dist'

let report: unknown = { note: 'no report yet' }

const PROBE = `
<script>
(function () {
  const seen = []
  window.addEventListener('error', (event) => {
    const t = event.target
    if (t && t.tagName) {
      seen.push({ kind: 'resource-error', tag: t.tagName, url: String(t.src || t.href || '').slice(0, 240) })
    } else {
      seen.push({ kind: 'error', message: String(event.message).slice(0, 240) })
    }
  }, true)
  window.addEventListener('unhandledrejection', (event) => {
    seen.push({ kind: 'rejection', message: String(event.reason && event.reason.message || event.reason).slice(0, 240) })
  })

  const snapshot = () => {
    const all = [].slice.call(document.images)
    const frames = [].slice.call(document.querySelectorAll('.viewer-frame'))
    const stage = document.querySelector('[data-stage]')
    return {
      now: Date.now(),
      entered: document.body.classList.contains('gallery-entered'),
      curtain: !!document.querySelector('[data-curtain]'),
      stagePresent: !!stage,
      stageChildren: stage ? stage.children.length : -1,
      frameCount: frames.length,
      frameIndexes: frames.slice(0, 5).map((f) => f.getAttribute('data-index')),
      images: all.length,
      decoded: all.filter((i) => i.complete && i.naturalWidth > 0).length,
      sample: all.slice(0, 6).map((i) => ({
        cls: i.className,
        src: String(i.currentSrc || i.src).slice(0, 120),
        complete: i.complete,
        w: i.naturalWidth,
        h: i.naturalHeight,
      })),
      errors: seen.slice(-12),
    }
  }

  const send = () => {
    fetch('/__probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot()),
    }).catch(() => {})
  }
  setTimeout(send, 3000)
  setTimeout(send, 8000)
  setTimeout(send, 15000)
  setTimeout(send, 25000)
  setInterval(send, 10000)
})()
</script>
`

const withProbe = (html: string) => html.replace('</body>', `${PROBE}</body>`)

const server = Bun.serve({
  port: 4181,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/__probe') {
      if (request.method === 'POST') {
        report = await request.json()
        console.log('probe:', JSON.stringify(report))
        return new Response('ok')
      }
      return Response.json(report as object)
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await Bun.file(`${ROOT}/index.html`).text()
      return new Response(withProbe(html), { headers: { 'content-type': 'text/html' } })
    }

    const file = Bun.file(`${ROOT}${url.pathname}`)
    if (await file.exists()) return new Response(file)

    // SPA fallback — the app is a single page.
    const html = await Bun.file(`${ROOT}/index.html`).text()
    return new Response(withProbe(html), { headers: { 'content-type': 'text/html' } })
  },
})

console.log(`probe server on http://localhost:${server.port} serving ${ROOT}`)