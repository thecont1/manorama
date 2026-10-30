import { SignInLinks } from '../lib/signin'

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
  return (
    <main class="ops-page">
      <header class="ops-header">
        <div>
          <p class="eyebrow">manorama / private operations</p>
          <h1>Keep the manor healthy.</h1>
          <p class="ops-intro">
            {deniedName
              ? `Signed in as ${deniedName} — that account does not hold operations access. Identify yourself another way.`
              : 'This console opens to one manorama account. Identify yourself in any way you like.'}
          </p>
        </div>
        <a class="ops-back" href="/">Return home</a>
      </header>
      <SignInLinks returning={returning ?? Boolean(deniedName)} next="/opman" />
    </main>
  )
}
