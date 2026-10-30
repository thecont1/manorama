import { createRoute } from 'honox/factory'
import { confirmPendingAccount } from '../../lib/oauth-flow'

export const POST = createRoute(confirmPendingAccount)

export default createRoute((c) => c.redirect('/'))
