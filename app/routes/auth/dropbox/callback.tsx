import { createRoute } from 'honox/factory'
import { finishProviderAuth } from '../../../lib/oauth-flow'

export default createRoute((c) => finishProviderAuth(c, 'dropbox', {
  code: c.req.query('code'),
  state: c.req.query('state'),
  error: c.req.query('error'),
}))
