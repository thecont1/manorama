import { LINKS, SURFACES } from '../home-manifest'

/**
 * The footer. Terms and Support appear only once the owner approves them,
 * so the page never carries a link that goes nowhere.
 */
export default function Footer() {
  const published = SURFACES.filter((surface) => surface.url && surface.id !== 'web')

  return (
    <footer class="home-footer">
      <div class="home-wrap home-footer-inner">
        <nav class="home-footer-links" aria-label="Footer">
          <a href="/privacy">Privacy Policy</a>
          {LINKS.terms ? <a href={LINKS.terms}>Terms</a> : null}
          {LINKS.support ? <a href={LINKS.support}>Support</a> : null}
          {published.map((surface) => (
            <a key={surface.id} href={surface.url ?? '#'}>
              {surface.label}
            </a>
          ))}
        </nav>
        <p class="home-footer-copy">Created by documentary photographer Mahesh Shantaram.</p>
        <p class="home-footer-copy">
          © 2026 · <a href="https://thecontrarian.in">thecontrarian.in</a>
        </p>
      </div>
    </footer>
  )
}
