/**
 * The page header: the wordmark, the way in, and the one action.
 *
 * The navigation follows the page: Features, Pricing, FAQ, and then the
 * two ways in. Under 720px it collapses into a
 * disclosure, and the disclosure carries the same list in the same order,
 * so a phone is not left without the price.
 */
import DownloadMenu from '../DownloadMenu'
import { SURFACES } from '../home-manifest'

export default function Header() {
  // The section links mirror the page's own order — a table of contents
  // for the deep parts of the page. Download, Sign in and Start free are
  // actions, not sections: Download opens its own list, and the two links
  // take you home to the sign-in, where a utility belongs.
  const sections = [
    { href: '#unify', label: 'Features' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#faq', label: 'FAQ' },
  ]

  return (
    <header class="home-header">
      <a class="home-skip" href="#content">Skip to content</a>
      <div class="home-header-inner">
        <a class="home-wordmark" href="/" aria-label="manorama, home">
          <img class="home-logo-dark" src="/manorama-merged-logo.png" alt="manorama" width={2027} height={688} />
          <img class="home-logo-light" src="/manorama-merged-logo-light.png" alt="" aria-hidden="true" width={2027} height={688} />
        </a>
        <nav class="home-nav" aria-label="Sections">
          {sections.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <details class="home-nav-menu">
          <summary>Menu</summary>
          <div class="home-nav-menu-list">
            {sections.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
            <p class="home-nav-menu-label">Download</p>
            {SURFACES.filter((surface) => surface.url).map((surface) => (
              <a key={surface.id} href={surface.href ?? surface.url ?? '#start'}>
                {surface.label}
              </a>
            ))}
            <p class="home-nav-menu-label">View</p>
            <button type="button" class="home-theme-toggle" data-theme-toggle hidden>
              Light mode
            </button>
            <p class="home-nav-menu-label">Account</p>
            <a href="#start">Sign in</a>
          </div>
        </details>
        <DownloadMenu class="home-download-header" />
        <button type="button" class="home-theme-toggle" data-theme-toggle hidden>
          Light mode
        </button>
        <a class="home-nav-signin" href="#start">Sign in</a>
        <a class="home-btn" href="#start">Start free</a>
      </div>
    </header>
  )
}
