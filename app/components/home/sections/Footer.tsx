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
          © 2026 Mahesh Shantaram / <a href="https://thecontrarian.in">thecontrarian.in</a>.
          <br />
          All platform rights reserved.
        </p>
      </div>
    </footer>
  )
}
