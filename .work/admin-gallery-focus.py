from pathlib import Path
p=Path('native/islands/GalleryList.tsx');s=p.read_text()
a="  const visibleAccountGalleries = billingState?.isPro\n    ? (accountGalleries ?? [])\n    : retainedAccountGalleries.slice(0, 3)"
assert a in s;s=s.replace(a,"  // Subscription limits control retention/editing, never whether an owner can see a gallery.\n  const visibleAccountGalleries = accountGalleries ?? []")
s=s.replace('class="native-gallery-thumb is-active"','class="native-gallery-thumb"')
s=s.replace('<span aria-hidden="true">Account <span>›</span></span>', '<span class="native-account-tab-label" aria-hidden="true">Account <span>›</span></span>\n            <svg class="native-account-hamburger" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>')
s=s.replace('You have used {retainedAccountGalleries.length} of your {galleryLimit} gallery limit.', "{retainedAccountGalleries.length <= galleryLimit ? `You have used ${retainedAccountGalleries.length} of your ${galleryLimit} gallery limit.` : `You have ${retainedAccountGalleries.length} retained galleries. Your plan includes ${galleryLimit} editable gallery slots; all your galleries are listed below.`}")
# Gather global tools out of the main gallery card without changing behavior.
start=s.index('            <div class="native-account-delete">');end=s.index('            </div>\n          </div>\n        ) : null}',start)+len('            </div>')
delete=s[start:end];s=s[:start]+s[end:]
start=s.index('        {signedIn ? (\n          <>\n            {billing && billingState ?');end=s.index('      </section>\n    </main>',start)
tools=s[start:end];s=s[:start]+s[end:]
start=s.index('        {/* Legal ends the left column');end=s.index('      </div>\n        <section class="native-gallery-import"',start)
footer=s[start:end];s=s[:start]+s[end:]
# All pipeline records remain in the one ordered list; show their status on the row.
start=s.index('            {!billingState?.isPro && temporaryAccountGalleries.length > 0 ? (');end=s.index('            {deviceListFailed ? (',start);s=s[:start]+s[end:]
s=s.replace('<span class="native-gallery-link">{accountGalleryLink(gallery)}</span>', '<span class="native-gallery-link">{accountGalleryLink(gallery)}</span>\n        {gallery.retention === \'pipeline\' ? <span class="native-account-note">Temporary gallery{gallery.expiresAt ? ` · expires ${gallery.expiresAt.slice(0, 10)}` : \'\'}</span> : null}')
s=s.replace('          <button type="button" class="native-drawer-action" onClick={() => void signOut()}>Sign out</button>',tools+'\n'+delete+'\n'+footer+'\n          <button type="button" class="native-drawer-action" onClick={() => void signOut()}>Sign out</button>')
p.write_text(s)
# Web already holds global settings in Account. Use the same phone affordance and expose the address before greeting.
p=Path('app/islands/Admin.tsx');s=p.read_text().replace('<span aria-hidden="true">Account</span>', '<span class="admin-tab-label" aria-hidden="true">Account</span>\n        <svg class="admin-hamburger" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>')
s=s.replace('<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"', '<svg class="admin-tab-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"')
s=s.replace('        <p class="admin-welcome-note">Hello,', '        <p class="admin-profile-address">manorama.xyz/{owner}</p>\n        <p class="admin-welcome-note">Hello,')
s=s.replace('You have used {retainedCount} of your {retainedLimit} gallery limit.', '{retainedCount <= retainedLimit ? `You have used ${retainedCount} of your ${retainedLimit} gallery limit.` : `You have ${retainedCount} retained galleries. Your plan includes ${retainedLimit} editable gallery slots; all your galleries are listed below.`}')
p.write_text(s)
