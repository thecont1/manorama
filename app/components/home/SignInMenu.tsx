import { SIGN_IN_PROVIDERS } from '../../lib/signin'

export default function SignInMenu({
  returning,
  next,
  failed,
  class: cls,
}: {
  returning?: boolean
  next?: string
  failed?: boolean
  class?: string
}) {
  return (
    <>
      <button
        type="button"
        class={`home-signin-trigger${cls ? ` ${cls}` : ''}`}
        popovertarget="home-account-panel"
        popovertargetaction="show"
      >
        Sign in
      </button>
      <div id="home-account-panel" class="home-account-panel" popover="auto">
        <section aria-labelledby="home-account-signin">
          <h2 id="home-account-signin" class="home-account-heading">Continue with</h2>
          <ul class="home-account-list home-signin-list">
            {[...SIGN_IN_PROVIDERS]
              // Apple leads: App Review 4.8 requires it no less prominence.
              .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
              .map(({ id, name, Glyph }) => {
                const action = `${returning ? 'Sign in' : 'Continue'} with ${name}`
                const destination = next ? `/auth/${id}?next=${encodeURIComponent(next)}` : `/auth/${id}`
                return (
                  <li key={id}>
                    <a href={destination} aria-label={action}>
                      <Glyph />
                      <span class="home-account-name">{name}</span>
                    </a>
                  </li>
                )
              })}
          </ul>
        </section>
        {failed ? <p class="home-signin-retry">Sign-in didn’t complete. Please try again.</p> : null}
      </div>
    </>
  )
}
