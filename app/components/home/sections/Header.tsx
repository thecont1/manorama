import DownloadMenu from '../DownloadMenu'
import SignInMenu from '../SignInMenu'
import { SURFACES } from '../home-manifest'

export default function Header({
  returning,
  next,
  failed,
}: {
  returning?: boolean
  next?: string
  failed?: boolean
}) {
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
          </div>
        </details>
        <DownloadMenu class="home-download-header" />
        <button type="button" class="home-theme-toggle" data-theme-toggle hidden>
          Light mode
        </button>
        <SignInMenu class="home-signin-header" returning={returning} next={next} failed={failed} />
        <a class="home-btn" href="#start" data-signin-open>Start free</a>
      </div>
    </header>
  )
}
