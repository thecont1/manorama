import SignInMenu from '../SignInMenu'

function ThemeToggle() {
  return (
    <button type="button" class="home-theme-toggle" data-theme-toggle aria-label="Switch colour theme" hidden>
      <svg class="home-theme-sun" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="3.5" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </svg>
      <svg class="home-theme-moon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" />
      </svg>
    </button>
  )
}

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
        <details class="home-nav-menu">
          <summary>Menu</summary>
          <div class="home-nav-menu-list">
            {sections.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
            <button type="button" class="home-nav-signin" popovertarget="home-account-panel" popovertargetaction="show">Sign in</button>
            <p class="home-nav-menu-label">View</p>
            <ThemeToggle />
          </div>
        </details>
        <nav class="home-nav" aria-label="Sections">
          {sections.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <ThemeToggle />
        <SignInMenu class="home-signin-header" returning={returning} next={next} failed={failed} />
        <button type="button" class="home-btn" popovertarget="home-account-panel" popovertargetaction="show">Start free</button>
      </div>
    </header>
  )
}
