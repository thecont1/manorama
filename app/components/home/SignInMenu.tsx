import { SignInLinks } from '../../lib/signin'
import { LIMITS } from './home-manifest'

/**
 * The sign-in affordance, as one disclosure in the same shape as Download.
 * The three provider buttons live here now — the hero fold is left to the
 * photographs. It reuses the `.home-download` mechanics so the menu script
 * closes it on an outside click, an item click or Escape, exactly like the
 * download list beside it.
 */
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
        <p class="home-signin-menu-title">Start free or sign in</p>
        <SignInLinks returning={returning} next={next} />
        <p class="home-note home-signin-note">
          The same button creates your account the first time and signs you in after.
        </p>
        <p class="home-note home-signin-note">
          Free includes {LIMITS.freePermanent} permanent cloud galleries.
        </p>
        {failed ? (
          <p class="home-note home-signin-note">Sign-in didn’t complete. Please try again.</p>
        ) : null}
      </div>
    </details>
  )
}