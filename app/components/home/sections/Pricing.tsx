import ComparisonTable from './ComparisonTable'
import { LIMITS, PRICING } from '../home-manifest'

/**
 * The price, and what it buys. The numbers come from the policy module, so
 * the page cannot promise an allowance the product does not grant.
 */
export default function Pricing() {
  return (
    <section class="home-band" id="pricing">
      <div class="home-wrap">
        <h2 class="home-h2 home-rise home-rise-1">
          Start free. Bring more together with Visionary.
        </h2>
        <div class="home-plans">
          <div class="home-plan home-rise home-rise-2">
            <h3 class="home-plan-name">Free</h3>
            <p class="home-plan-price">
              {PRICING.free}
              <span class="home-plan-price-sub">
                Free forever. No payment card required.
              </span>
            </p>
            <p class="home-plan-line">Keep a few favourites. Share something new.</p>
            <ul class="home-plan-list">
              <li>
                {LIMITS.freePermanent} permanent cloud galleries
              </li>
              <li>
                Up to {LIMITS.freeTemporary} temporary cloud galleries, each lasting{' '}
                {LIMITS.temporaryDays} days
              </li>
              <li>Temporary galleries cannot be edited</li>
              <li>The same core viewing experience</li>
            </ul>
            <p class="home-plan-note">
              Sign in with Apple, Dropbox or Google to create an account.
            </p>
            <p class="home-plan-cta">
              <a class="home-btn home-btn-quiet" href="#start" data-signin-open>
                Start free
              </a>
            </p>
          </div>

          <div class="home-plan home-plan-raised home-rise home-rise-3">
            <h3 class="home-plan-name">Visionary</h3>
            <p class="home-plan-price">
              {PRICING.firstYear}
              <span class="home-plan-price-sub">
                for your first year, then {PRICING.yearly}/year
              </span>
            </p>
            <p class="home-plan-line">
              Bring more of your photographic life together.
            </p>
            <ul class="home-plan-list">
              <li>{LIMITS.visionaryPermanent} permanent cloud galleries</li>
              <li>Unlimited local galleries on supported desktop apps</li>
              <li>Upgrade your unexpired temporary galleries to permanent</li>
              <li>Annual subscription</li>
            </ul>
            <p class="home-plan-note">
              Subscribe from your Library on the web, or in the iPhone and iPad app.
            </p>
            <p class="home-plan-cta">
              <a class="home-btn" href="/?next=/">
                Go Visionary
              </a>
            </p>
          </div>
        </div>

        <ComparisonTable />

        <ul class="home-table-notes">
          <li>
            When you upgrade, your unexpired temporary galleries become permanent within your
            Visionary allowance.
          </li>
          <li>Saving a gallery does not give you control of its original.</li>
          <li>Deleting a Manorama gallery never deletes the photographs at the source.</li>
          <li>
            Visionary renews yearly. On iPhone and iPad it is billed and managed through your
            Apple account.
          </li>
        </ul>
      </div>
    </section>
  )
}
