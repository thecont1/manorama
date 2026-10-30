import { SIGN_IN_PROVIDERS } from '../lib/signin'

/** The /opman door. The operations console sits behind the same manorama
 *  sign-in as everything else — the operator picks whichever linked
 *  identity they like, and the master check happens after the session
 *  resolves, never by steering them to one provider. A signed-in account
 *  without operations access gets the same door with a note, so a second
 *  identity is one tap away rather than a sign-out detour. */
export default function OpsDoor({
  returning,
  deniedName,
}: {
  /** The browser signed into manorama before — use the shorter lead. */
  returning?: boolean
  /** The current session resolved but holds no master role. */
  deniedName?: string
}) {
  const lead = returning ?? Boolean(deniedName)
  return (
    <main class="ops-page">
      <header class="ops-header">
        <div>
          <h1>Janitors check-in here.</h1>
          {deniedName ? (
            <p class="ops-intro">
              Signed in as {deniedName} — that account does not hold operations access. Identify yourself another way.
            </p>
          ) : null}
        </div>
        <a class="ops-back" href="/">Return home</a>
      </header>
      <div class="ops-signin">
        {[...SIGN_IN_PROVIDERS]
          // Apple leads the row everywhere — App Review 4.8 requires it given
          // no less prominence than the other providers, and one order across
          // web and the shells keeps the door recognisable on every platform.
          .sort((a, b) => (a.id === 'apple' ? -1 : b.id === 'apple' ? 1 : 0))
          .map(({ id, name, Glyph }) => (
            <a
              key={id}
              class="ops-provider"
              href={`/auth/${id}?next=${encodeURIComponent('/opman')}`}
              aria-label={`${lead ? 'Sign in' : 'Continue'} with ${name}`}
            >
              <Glyph />
              <span>{lead ? 'Sign in' : 'Continue'} with {name}</span>
            </a>
          ))}
      </div>
    </main>
  )
}
