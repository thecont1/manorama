import { createRoute } from 'honox/factory'
import { getGallery } from '../lib/gallery-repository'

type RuntimeEnv = {
  AIRTABLE_PAT?: string
  AIRTABLE_BASE_ID?: string
  AIRTABLE_GALLERIES_TABLE?: string
  OWNER_SLUG?: string
}

export default createRoute(async (c) => {
  const env = c.env as RuntimeEnv
  const slug = c.req.param('slug')
  const gallery = await getGallery(slug, env)
  if (!gallery) return c.notFound()
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  c.header('Cache-Control', 'no-cache')
  return c.redirect(`/${env.OWNER_SLUG || 'thecontrarian'}/${gallery.slug}`, 308)
})
