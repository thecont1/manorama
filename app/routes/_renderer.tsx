import { jsxRenderer } from 'hono/jsx-renderer'
import { HasIslands } from 'honox/server'
import { Link, Script } from 'honox/server'

export default jsxRenderer(({ children, title, description, ogImage }) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <meta name="theme-color" content="#0a0a0a" />
      <link rel="icon" type="image/png" sizes="64x64" href="/manorama_64x64.png" />
      <link rel="icon" type="image/png" sizes="256x256" href="/manorama_256x256.png" />
      <link rel="apple-touch-icon" href="/manorama_256x256.png" />
      <Link href="/app/styles.css" rel="stylesheet" />
      <title>{title}</title>
      <meta property="og:site_name" content="manorama" />
      <meta property="og:type" content="website" />
      <meta property="og:title" content={title ?? 'manorama'} />
      {description ? <meta property="og:description" content={description} /> : null}
      <meta property="og:image" content={ogImage ?? '/og-image.png'} />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title ?? 'manorama'} />
      {description ? <meta name="twitter:description" content={description} /> : null}
      <meta name="twitter:image" content={ogImage ?? '/og-image.png'} />
      <HasIslands>
        <Script src="/app/client.ts" async />
      </HasIslands>
    </head>
    <body>{children}</body>
  </html>
))
