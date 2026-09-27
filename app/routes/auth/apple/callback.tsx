import { createRoute } from 'honox/factory'
import { finishProviderAuth } from '../../../lib/oauth-flow'

const field = (value: unknown) => (typeof value === 'string' ? value : undefined)

// Apple's response_mode=form_post arrives cross-site as a POST; the flow
// state is server-side (auth_flows), so no SameSite=None cookie is needed.
export const POST = createRoute(async (c) => {
  const form = await c.req.parseBody()
  return finishProviderAuth(c, 'apple', {
    code: field(form.code),
    state: field(form.state),
    error: field(form.error),
    user: form.user,
  })
})

// There is no GET leg on Apple's callback — anything arriving here as a
// browser navigation is not a sign-in response.
export default createRoute((c) => c.redirect('/?error=1'))
