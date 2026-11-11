/**
 * The page header: the wordmark, the way in, and the one action.
 *
 * The navigation collapses into a disclosure under 720px. The Pricing link
 * stays visible beside the action at every width, because the price is the
 * one thing a visitor looks for on a phone.
 */
export default function Header() {
  return (
    <header class="home-header">
      <a class="home-skip" href="#content">Skip to content</a>
      <div class="home-header-inner">
        <a class="home-wordmark" href="/" aria-label="manorama, home">
          <img src="/manorama-merged-logo.png" alt="manorama" width={2170} height={725} />
        </a>
        <nav class="home-nav" aria-label="Primary">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#get-manorama">Get the app</a>
          <a href="#start">Sign in</a>
        </nav>
        <details class="home-nav-menu">
          <summary>Menu</summary>
          <div class="home-nav-menu-list">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
            <a href="#get-manorama">Get the app</a>
            <a href="#start">Sign in</a>
          </div>
        </details>
        <a class="home-btn" href="#start">Start free</a>
      </div>
    </header>
  )
}
