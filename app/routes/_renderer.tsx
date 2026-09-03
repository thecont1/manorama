import { jsxRenderer } from 'hono/jsx-renderer'
import { HasIslands } from 'honox/server'
import { Link, Script } from 'honox/server'

export default jsxRenderer(({ children, title }, c) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="robots" content="noindex, nofollow, noarchive" />
      <meta name="theme-color" content="#0a0a0a" />
      <Link href="/app/styles.css" rel="stylesheet" />
      <title>{title}</title>
      <HasIslands>
        <Script src="/app/client.ts" async />
      </HasIslands>
      <Script src="/app/vendo-client.tsx" async />
    </head>
    <body>{children}<div id="vendo-root" /></body>
  </html>
))
