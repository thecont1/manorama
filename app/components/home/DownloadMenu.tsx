/**
 * The downloads affordance in the header nav. Hover or keyboard focus
 * opens the panel; the trigger itself is a real link to the downloads
 * page, so touch and no-hover visitors still reach it. iPhone & iPad has
 * no published URL yet, so it lists quiet without a link — never a link
 * that goes nowhere.
 */
const ITEMS: { label: string; href: string | null; soon?: boolean }[] = [
  { label: 'Web app', href: 'https://manorama.xyz/' },
  { label: 'Mac', href: 'https://downloads.manorama.xyz/mac' },
  { label: 'Windows', href: 'https://downloads.manorama.xyz/windows' },
  { label: 'Linux', href: 'https://downloads.manorama.xyz/linux' },
  { label: 'Android', href: 'https://downloads.manorama.xyz/android' },
  { label: 'iPhone & iPad', href: null, soon: true },
  { label: 'All Releases', href: 'https://downloads.manorama.xyz/' },
]

export default function DownloadMenu({ class: cls }: { class?: string }) {
  return (
    <div class={`home-downloads${cls ? ` ${cls}` : ''}`}>
      <a class="home-downloads-trigger" href="https://downloads.manorama.xyz/">Downloads</a>
      <div class="home-downloads-panel">
        <ul class="home-downloads-list">
          {ITEMS.map((item) => (
            <li key={item.label}>
              {item.href ? (
                <a href={item.href}>
                  <span class="home-downloads-name">{item.label}</span>
                </a>
              ) : (
                <span class="home-downloads-soon">
                  <span class="home-downloads-name">{item.label}</span>
                  <small>soon</small>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
