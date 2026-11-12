// downloads.manorama.xyz — the public installer host, backed by the
// manorama-downloads R2 bucket. Objects live under v<semver>/ keys plus a
// latest.json pointer the platform shortcuts resolve through, so shipping a
// release is an upload + pointer bump, never a deploy. GitHub releases stay
// the canonical artifact list; this is the fetch surface.

export const DOWNLOAD_HOST = 'downloads.manorama.xyz'

export type DownloadsEnv = { DOWNLOADS?: R2Bucket }

type LatestManifest = {
  version: string
  released?: string
  assets: { mac?: string; windows?: string; linux?: string; all?: string[] }
}

const PLATFORMS = new Set(['mac', 'windows', 'linux'])
const OBJECT_KEY = /^v\d+\.\d+\.\d+\/[\w.-]+$/

export const isDownloadHost = (hostname: string) => hostname === DOWNLOAD_HOST

const latestManifest = async (env: DownloadsEnv): Promise<LatestManifest | null> => {
  if (!env.DOWNLOADS) return null
  const object = await env.DOWNLOADS.get('latest.json')
  if (!object) return null
  try {
    return (await object.json()) as LatestManifest
  } catch {
    return null
  }
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const indexPage = (manifest: LatestManifest | null): Response => {
  const rows = manifest
    ? (['mac', 'windows', 'linux'] as const)
        .map((platform) => {
          const key = manifest.assets[platform]
          return key ? `<li><a href="/${escapeHtml(key)}">${platform}</a> — ${escapeHtml(key.split('/').pop() ?? key)}</li>` : ''
        })
        .join('')
    : '<li>no release published yet</li>'
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>manorama downloads</title>
<meta name="robots" content="noindex"><style>body{font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#eee;background:#111}a{color:#f0f}</style></head>
<body><h1>manorama ${manifest ? escapeHtml(manifest.version) : ''}</h1><ul>${rows}</ul>
<p>Shortcuts: <a href="/mac">/mac</a> · <a href="/windows">/windows</a> · <a href="/linux">/linux</a> · <a href="/latest.json">/latest.json</a></p></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

const objectResponse = async (env: DownloadsEnv, key: string, head: boolean): Promise<Response> => {
  const object = await env.DOWNLOADS!.get(key)
  if (!object) return new Response('not found', { status: 404 })
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  // Versioned keys never change, so they cache forever; latest.json is the
  // mutable pointer and stays short-lived.
  headers.set('cache-control', key === 'latest.json' ? 'public, max-age=300' : 'public, max-age=31536000, immutable')
  return new Response(head ? null : object.body, { headers })
}

export async function handleDownloads(request: Request, env: DownloadsEnv): Promise<Response> {
  if (!env.DOWNLOADS) return new Response('downloads are not configured', { status: 503 })
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/+|\/+$/g, '')
  const head = request.method === 'HEAD'

  if (path === '') return indexPage(await latestManifest(env))

  if (PLATFORMS.has(path)) {
    const manifest = await latestManifest(env)
    const key = manifest?.assets[path as keyof LatestManifest['assets']]
    if (typeof key !== 'string' || !OBJECT_KEY.test(key)) {
      return new Response('unknown platform or no release published', { status: 404 })
    }
    return Response.redirect(new URL(`/${key}`, url).toString(), 302)
  }

  if (path !== 'latest.json' && !OBJECT_KEY.test(path)) {
    return new Response('not found', { status: 404 })
  }
  return objectResponse(env, path, head)
}
