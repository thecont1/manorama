import type { NotFoundHandler } from 'hono'

const handler: NotFoundHandler = (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return c.render(
    <main class="not-found">
      <p>There is no gallery here.</p>
    </main>,
  )
}

export default handler
