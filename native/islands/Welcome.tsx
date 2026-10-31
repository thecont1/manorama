import type { Child } from 'hono/jsx'
import { SIGN_IN_PROVIDERS } from '../../app/lib/signin'
import type { AuthProvider } from '../lib/session'

type Props = {
  signedIn: boolean | null
  onSignIn?: (provider: AuthProvider) => void
  authError?: string | null
  pendingQuickAdd: boolean
  accountAdAside?: Child
  onPrivacy: () => void
  onAuthor: () => void
}

/** The native door: one sentence, one truthful explanation, and full-width
 * provider actions with Apple at equal first prominence. */
export default function Welcome({ signedIn, onSignIn, authError, pendingQuickAdd, accountAdAside, onPrivacy, onAuthor }: Props) {
  return (
    <main class="m-owner native-welcome" aria-live="polite">
      <div class="native-welcome-focal">
        <span class="native-welcome-logo">
          <img src="/manorama-merged-logo.png" width="140" height="47" alt="manorama" />
        </span>
        <h1>the WOW-est way to enjoy a photo gallery with anyone</h1>
        <p>manorama turns a folder of images (either on this device or in the cloud) into a beautiful full-screen hi-res gallery with a custom link of your own</p>
      </div>
      {accountAdAside}
      {signedIn === false && onSignIn ? <div class="native-welcome-providers">
        {[...SIGN_IN_PROVIDERS]
          .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
          .map(({ id, label, Glyph }) => (
            <button key={id} type="button" class={`native-welcome-provider native-welcome-provider--${id}`} onClick={() => onSignIn(id)}>
              <Glyph />
              <span>Continue with {label}</span>
            </button>
          ))}
      </div> : null}
      {signedIn === null ? <p class="native-welcome-note">Checking your session…</p> : null}
      {authError ? <p class="native-welcome-note" role="alert">{authError}</p> : null}
      {pendingQuickAdd ? <p class="native-welcome-note">Sign in to turn this supported cloud folder into a Manorama gallery.</p> : null}
      <footer class="site-footer">
        <button type="button" class="site-footer-link" onClick={onPrivacy}>Privacy Policy</button>
        <p class="site-footer-copy">© 2026 Mahesh Shantaram · <button type="button" onClick={onAuthor}>thecontrarian.in</button></p>
      </footer>
    </main>
  )
}
