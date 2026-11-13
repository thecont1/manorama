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
              <span class="home-plan-price-sub">free forever.</span>
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
              <li>The same beautiful viewing</li>
            </ul>
            <p class="home-plan-cta">
              <button type="button" class="home-btn home-btn-quiet" popovertarget="home-account-panel" popovertargetaction="show">
                Start free
              </button>
            </p>
          </div>

          <div class="home-plan home-plan-raised home-rise home-rise-3">
            <h3 class="home-plan-name">Visionary</h3>
            <p class="home-plan-price">
              {PRICING.firstYear}
              <span class="home-plan-price-sub">
                for your first year, then {PRICING.yearly} a year.
              </span>
            </p>
            <p class="home-plan-line">
              Bring more of your photographic life together.
            </p>
            <ul class="home-plan-list">
              <li>{LIMITS.visionaryPermanent} permanent cloud galleries</li>
              <li>Unlimited local galleries on Mac and Windows</li>
              <li>Your temporary galleries become permanent when you upgrade</li>
            </ul>
            <p class="home-plan-cta">
              <button type="button" class="home-btn" popovertarget="home-account-panel" popovertargetaction="show">
                Go Visionary
              </button>
            </p>
          </div>
        </div>

        <ComparisonTable />

        <div class="home-good-to-know">
          <h3 class="home-shared-title">Good to know</h3>
          <ul class="home-table-notes">
            <li>Permanent galleries stay as long as their source link works.</li>
            <li>Manorama is not a backup service.</li>
            <li>Deleting a gallery from Manorama never deletes the photographs at the source.</li>
            <li>Visionary renews yearly. Subscribe on the web or in the iPhone and iPad app.</li>
          </ul>
        </div>
      </div>
    </section>
  )
}
