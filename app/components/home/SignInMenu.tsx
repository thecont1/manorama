import { SIGN_IN_PROVIDERS } from '../../lib/signin'

/** The sign-in chooser: three flat provider rows like Download, no pitch. */
export default function SignInMenu({
  returning,
  next,
  failed,
  class: cls,
}: {
  /** True when the browser has the returning-visitor hint cookie. */
  returning?: boolean
  /** Same-origin path the OAuth callback lands on instead of the dashboard. */
  next?: string
  /** True when an OAuth round-trip ended in `?error=1`. */
  failed?: boolean
  class?: string
}) {
  return (
    <details class={`home-download home-signin-menu${cls ? ` ${cls}` : ''}`}>
      <summary>Sign in</summary>
      <div class="home-download-panel home-signin-panel">
        <ul class="home-download-list home-signin-list">
          {[...SIGN_IN_PROVIDERS]
            // Apple leads: App Review 4.8 requires it no less prominence.
            .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
            .map(({ id, label, Glyph }) => {
              const text = `${returning ? 'Sign in' : 'Continue'} with ${label}`
              const destination = next ? `/auth/${id}?next=${encodeURIComponent(next)}` : `/auth/${id}`
              return (
                <li key={id}>
                  <a href={destination} aria-label={text}>
                    <Glyph />
                    <span class="home-download-name">{text}</span>
                  </a>
                </li>
              )
            })}
        </ul>
        {failed ? (
          <p class="home-signin-retry">Sign-in didn’t complete. Please try again.</p>
        ) : null}
      </div>
    </details>
  )
}