import { SignInLinks } from '../lib/signin'

/**
 * The public Welcome — the web landing page's door. It mirrors the native
 * Welcome: the one approved sentence, the one truthful provider explanation,
 * the shared sign-in chooser, and a semantic footer. The route decides the
 * facts (returning cookie, failed sign-in) and the component owns the
 * surface, so the door reads identically wherever it is drawn.
 */

/** The display face shared by the public headings. The quick-add interstitial
 *  imports this too, so the two public surfaces share one heading treatment
 *  without touching app/styles.css. */
export const PUBLIC_HEADING_FONT_FAMILY =
  "'Bricolage Grotesque', 'Manrope', ui-sans-serif, system-ui, sans-serif"

const welcomeHeadingStyle = {
  fontFamily: PUBLIC_HEADING_FONT_FAMILY,
  fontSize: 'clamp(30px, 4.6vw, 46px)',
  fontWeight: 700,
  letterSpacing: '-.03em',
  lineHeight: 1.12,
  margin: '0 0 18px',
}

export default function PublicWelcome({
  returning,
  failed,
}: {
  /** True when the browser has the returning-visitor hint cookie. */
  returning?: boolean
  /** True when an OAuth round-trip ended in `?error=1`. */
  failed?: boolean
}) {
  return (
    <main class="landing-page">
      <div class="landing-brand">
        <span class="brand-mark-wrap">
          <img src="/manorama-merged-logo.png" alt="manorama" class="landing-brand-mark" />
          <span class="brand-tld" aria-hidden="true">.xyz</span>
        </span>
        <h1 style={welcomeHeadingStyle}>
          A quieter place to look at photographs, on your own or with anyone.
        </h1>
        <p class="landing-brand-intro">
          Sign in to add public Dropbox, Google Drive, iCloud, or MEGA folders and albums.
        </p>
        <SignInLinks returning={returning} />
        {failed ? <p class="landing-note">Sign-in didn’t complete. Please try again.</p> : null}
      </div>
      <footer class="site-footer">
        <a class="site-footer-link" href="/privacy">Privacy Policy</a>
        <p class="site-footer-copy">© 2026 Mahesh Shantaram · <a href="https://thecontrarian.in">thecontrarian.in</a></p>
      </footer>
    </main>
  )
}
