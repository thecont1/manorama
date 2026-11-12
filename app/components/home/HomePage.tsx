import Features from './sections/Features'
import Faq from './sections/Faq'
import FinalCta from './sections/FinalCta'
import Footer from './sections/Footer'
import Header from './sections/Header'
import Hero from './sections/Hero'
import HowItWorks from './sections/HowItWorks'
import Pricing from './sections/Pricing'
import Unify from './sections/Unify'

/**
 * The marketing homepage.
 *
 * Server-rendered, with no island and no hydration: the only script on the
 * page is the renderer's own. The disclosures are `<details>`, the
 * navigation is anchors, and the mobile menu is a disclosure too.
 */
export default function HomePage({
  returning,
  failed,
  next,
  samplePath,
}: {
  /** True when the browser has the returning-visitor hint cookie. */
  returning?: boolean
  /** True when an OAuth round-trip ended in `?error=1`. */
  failed?: boolean
  /** Same-origin path the OAuth callback lands on instead of the dashboard. */
  next?: string
  /** The owner-cleared sample gallery. `null` renders no sample CTA. */
  samplePath?: string | null
}) {
  return (
    <div class="home">
      <Header />
      <main id="content">
        <Hero returning={returning} failed={failed} next={next} samplePath={samplePath} />
        <Unify />
        <HowItWorks />
        <Features />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  )
}
