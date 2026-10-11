"""The menu's brand should not carry its own copy of the page's brand sizes."""
from pathlib import Path
import sys

# 1 — the markup takes the page's brand scope.
p = Path('native/islands/GalleryList.tsx')
s = p.read_text()
old = """            <div class="native-drawer-brand">
              <span class="brand-mark-wrap">
                <img
                  src="/manorama-merged-logo.png"
                  alt="manorama"
                  class="landing-brand-mark"
                />
                <span class="brand-tld" aria-hidden="true">.xyz</span>
              </span>
              <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            </div>"""
new = """            <div class="native-drawer-brand native-account-side">
              {/* The page's own brand row: the wordmark keeps the account
                  page's cap, including the room the hamburger reserves. */}
              <div class="native-account-head">
                <span class="brand-mark-wrap">
                  <img
                    src="/manorama-merged-logo.png"
                    alt="manorama"
                    class="landing-brand-mark"
                  />
                  <span class="brand-tld" aria-hidden="true">.xyz</span>
                </span>
              </div>
              <p class="landing-brand-intro"><em>adj.</em> a view that is delightful to the mind.<br />Also, the WOW-est way to enjoy a photo gallery with anyone!</p>
            </div>"""
if old not in s:
    sys.exit('drawer brand anchor missing — nothing written')


# 2 — the stylesheet stops restating the brand's sizes.
p2 = Path('native/styles.css')
s2 = p2.read_text()
styles_old = """.native-drawer-brand {
  display: block;
  min-width: 0;
}
.native-drawer-brand .brand-mark-wrap {
  display: block;
  width: min(300px, 100%);
}
.native-drawer-brand .landing-brand-mark {
  display: block;
  width: 100%;
  max-width: 100%;
  height: auto;
}"""
styles_new = """/* The menu's brand carries `.native-account-side`, so the wordmark's cap and
   the tagline's measure are the account page's own rules rather than numbers
   copied here — the tagline wraps at the same word at every width. Only the
   column is re-anchored: the menu's brand starts at the panel's edge and runs
   its full width, instead of centring like the page's 460px column. */
.native-drawer-brand {
  display: block;
  min-width: 0;
  width: 100%;
  margin-inline: 0;
}"""
if styles_old not in s2:
    sys.exit('drawer brand styles anchor missing — nothing written')

# Both anchors hold, so both files change together.
p.write_text(s.replace(old, new, 1))
print('ok: drawer brand markup')
p2.write_text(s2.replace(styles_old, styles_new, 1))
print('ok: drawer brand styles')