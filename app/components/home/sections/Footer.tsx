import { LINKS } from '../home-manifest'

/**
 * The footer. Terms and Support appear only once the owner approves them,
 * so the page never carries a link that goes nowhere.
 */
export default function Footer() {
  return (
    <footer class="home-footer">
      <div class="home-wrap home-footer-inner">
        <nav class="home-footer-links" aria-label="Footer">
          <a href="/privacy">Privacy Policy</a>
          {LINKS.terms ? <a href={LINKS.terms}>Terms</a> : null}
          {LINKS.support ? <a href={LINKS.support}>Support</a> : null}
        </nav>

        <p class="home-footer-copy">
          <span class="home-footer-copy-line">
            <span class="home-footer-brand">
              <img class="home-logo-dark" src="/manorama-merged-logo.png" alt="manorama" width={2027} height={688} />
              <img class="home-logo-light" src="/manorama-merged-logo-light.png" alt="" aria-hidden="true" width={2027} height={688} />
            </span>
            <span>© 2026 Mahesh Shantaram.</span>
          </span>
          <span class="home-footer-ownership">Photographs in galleries belong to their respective owners.</span>
        </p>
      </div>
    </footer>
  )
}
