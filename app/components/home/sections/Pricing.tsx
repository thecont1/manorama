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
            <p class="home-plan-price">{PRICING.free}</p>
            <p class="home-plan-line">Keep a few favourites. Share something new.</p>
            <ul class="home-plan-list">
              <li>
                {LIMITS.freePermanent} permanent cloud galleries
              </li>
              <li>
                up to {LIMITS.freeTemporary} temporary galleries at a time, each expiring after{' '}
                {LIMITS.temporaryDays} days and read-only
              </li>
              <li>the same viewing experience</li>
            </ul>
            <p class="home-plan-cta">
              <a class="home-btn home-btn-quiet" href="#start">
                Start free
              </a>
            </p>
          </div>

          <div class="home-plan home-plan-raised home-rise home-rise-3">
            <h3 class="home-plan-name">Visionary</h3>
            <p class="home-plan-price">
              {PRICING.firstYear}
              <span class="home-plan-price-sub">
                for your first year, then {PRICING.yearly} a year
              </span>
            </p>
            <p class="home-plan-line">
              {PRICING.term} subscription. Bring more of your photographic life together.
            </p>
            <ul class="home-plan-list">
              <li>{LIMITS.visionaryPermanent} permanent cloud galleries</li>
              <li>unlimited Local galleries in the Mac and Windows apps</li>
              <li>
                upgrading makes your still-live temporary galleries permanent, within{' '}
                {LIMITS.visionaryPermanent}
              </li>
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
            Permanent galleries have no expiry while your plan stays active and the source link
            keeps working.
          </li>
          <li>Manorama is not photo backup or cloud storage.</li>
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
