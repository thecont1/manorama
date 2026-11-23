import type { Child } from 'hono/jsx'
import Header from './home/sections/Header'
import Footer from './home/sections/Footer'

/**
 * The site chrome around a standalone document — privacy, about, tech
 * specs, terms. The same Header and Footer the homepage carries, so the
 * pages read as pages of manorama.xyz rather than detached documents.
 *
 * `navBase="/"` sends the Features/Pricing/FAQ anchors back to the
 * homepage where those sections live, and the sign-in panel works here
 * exactly as it does there (the popover rides inside SignInMenu).
 */
export default function DocShell({
  html,
  updated,
  returning,
  next,
  signInOrigin,
  children,
}: {
  /** Pre-rendered document HTML for the repo-doc pages; omit when the
   *  document arrives as JSX children that supply their own article. */
  html?: string
  /** The document's "Updated …" line, printed at the top of the page;
   *  omitted entirely when the build could not stamp the source. */
  updated?: string
  returning?: boolean
  next?: string
  signInOrigin?: string
  children?: Child
}) {
  return (
    <div class="home">
      <Header navBase="/" returning={returning} next={next} signInOrigin={signInOrigin} />
      {/* id="content" keeps the header's skip link honest. */}
      <main id="content" class="policy-page">
        {updated ? <p class="doc-updated">{updated}</p> : null}
        {html !== undefined ? (
          <article class="policy-document" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          children
        )}
      </main>
      <Footer />
    </div>
  )
}
