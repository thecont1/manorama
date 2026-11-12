const QUESTIONS = [
  {
    q: 'Does Manorama store or move my original photographs?',
    a: [
      'No. Manorama keeps a list of what is in the gallery and streams the photographs when you look. Nothing is copied to Manorama’s storage, and nothing at the source is changed.',
      'On iPhone and iPad you can choose to keep an encrypted copy on that device.',
    ],
  },
  {
    q: 'Which cloud links can I add?',
    a: [
      'Dropbox shared folders, Google Drive folders shared with anyone, iCloud Photos Shared Album links, MEGA folders and collections, Ente albums, and Proton Drive share links in the apps. Local folders work in the Mac and Windows apps.',
      'The full list is under Supported cloud sources. Ente opens in the browser too.',
    ],
  },
  {
    q: 'Can I keep galleries someone else shares with me?',
    a: [
      'Yes. Add to Library saves your own copy to view. It counts toward your allowance, and it does not let you edit the original.',
    ],
  },
  {
    q: 'Can I use local folders, and do they sync?',
    a: [
      'With Visionary, in the Mac and Windows apps. Folders open in place, where they already sit on the disk.',
      'Only titles and counts sync to your account, never the photographs, and a local gallery opens only on the computer that has the folder.',
    ],
  },
  {
    q: 'What does “permanent gallery” mean?',
    a: ['It does not expire while your plan is active. It still depends on its source link staying available.'],
  },
  {
    q: 'What happens when a temporary gallery expires?',
    a: [
      'After 30 days it is removed from Manorama. The source is untouched, and nothing at the provider is deleted.',
      'Upgrading before then makes the whole set permanent.',
    ],
  },
  {
    q: 'Can I use Manorama offline?',
    a: [
      'On iPhone and iPad, the galleries you have kept a copy of open without a connection. The web needs a connection.',
    ],
  },
  {
    q: 'How do billing and cancellation work?',
    a: [
      'Visionary is a yearly subscription. On iPhone and iPad it is billed and managed through your Apple account.',
    ],
  },
  {
    q: 'Are my gallery links private?',
    a: [
      'Gallery links are unlisted and are not indexed, but anyone with a link can view it. Do not share a link you need kept private.',
      'Provider sign-ins and share links are handled by each provider in its own way. The Privacy Policy says more.',
    ],
  },
]

/**
 * The questions people actually ask, answered in a sentence each. A
 * disclosure, so the page stays quiet until the question is asked.
 */
export default function Faq() {
  return (
    <section class="home-band" id="faq">
      <div class="home-wrap">
        <div class="home-faq">
          <h2 class="home-h2 home-rise home-rise-1">FAQ</h2>
          <div class="home-faq-list">
            {QUESTIONS.map((item, index) => (
              <details key={item.q} class={`home-faq-item home-rise home-rise-${(index % 4) + 2}`}>
                <summary>{item.q}</summary>
                <div class="home-faq-answer">
                  {item.a.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
