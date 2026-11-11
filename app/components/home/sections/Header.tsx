/**
 * The page header: the wordmark, the way in, and the one action.
 *
 * The navigation follows the page: How it works, Features, Pricing, Get
 * the app, and then the two ways in. Under 720px it collapses into a
 * disclosure, and the disclosure carries the same list in the same order,
 * so a phone is not left without the price.
 */
export default function Header() {
  const links = [
    { href: '#how-it-works', label: 'How it works' },
    { href: '#features', label: 'Features' },
    { href: '#pricing', label: 'Pricing' },
    { href: '#get-manorama', label: 'Get the app' },
    { href: '#start', label: 'Sign in' },
  ]

  return (
    <header class="home-header">
      <a class="home-skip" href="#content">Skip to content</a>
      <div class="home-header-inner">
        <a class="home-wordmark" href="/" aria-label="manorama, home">
          <img src="/manorama-merged-logo.png" alt="manorama" width={2170} height={725} />
        </a>
        <nav class="home-nav" aria-label="Primary">
          {links.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <details class="home-nav-menu">
          <summary>Menu</summary>
          <div class="home-nav-menu-list">
            {links.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
        </details>
        <a class="home-btn" href="#start">Start free</a>
      </div>
    </header>
  )
}
