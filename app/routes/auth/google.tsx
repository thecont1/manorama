import { createRoute } from 'honox/factory'
import { providerAuthEntry } from '../../lib/oauth-flow'

export default createRoute((c) => providerAuthEntry(c, 'google'))
