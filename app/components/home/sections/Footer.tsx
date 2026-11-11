import { LINKS, SURFACES } from '../home-manifest'

/**
 * The footer. Terms and Support appear only once the owner approves them,
 * so the page never carries a link that goes nowhere.
 *
 * The bottom of the page carries the two notices that belong there: the
 * privacy notice, in the words the privacy policy uses, and the owner's
 * copyright. The privacy notice says the two things a visitor can be
 * surprised by — a link is unlisted but not private, and the photographs
 * stay at the source — because a link in a footer is read by exactly the
 * people who did not read the FAQ.
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

        <p class="home-footer-privacy">
          Gallery links are unlisted and not indexed, but anyone with the link can view a gallery.
          Manorama keeps the list of what is in a gallery, not the photographs: the originals stay
          where they are.
        </p>

        <p class="home-footer-copy">
          © 2026 Mahesh Shantaram /{' '}
          <a href="https://thecontrarian.in">thecontrarian.in</a>. All platform rights reserved.
        </p>
      </div>
    </footer>
  )
}
