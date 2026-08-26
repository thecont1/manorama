import { createApp } from 'honox/server'

const app = createApp()

app.use('*', async (c, next) => {
  await next()
  if (c.req.path.endsWith('.js') || c.req.path.endsWith('.css') || c.req.path.startsWith('/images/')) return
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
})

export default app
