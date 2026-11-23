# Owner operations

Manorama has no public user directory or gallery index. The private master operations console lives at **`/opman`** and is available only to the immutable Dropbox identity configured as `MASTER_DROPBOX_SUBJECT`.

## Configure the master account

Open `/opman`. If there is no valid session, it sends the browser through the existing Dropbox OAuth flow and returns to `/opman` after sign-in. No separate operations password exists or is needed.

After the owner has signed in once, read the immutable Dropbox subject returned by Dropbox (`dbid:…`) from the account’s `auth_identities` row and set `MASTER_DROPBOX_SUBJECT` as a protected Worker secret. It is an identity selector, not a credential; do not use a display name, email address, editable owner slug, or password. The check resolves the configured Dropbox subject to its current Manorama account, so the account may retain its normal `acct_<UUID>` internal ID.

If the binding is absent, `/opman`, the account-monitoring API, and site-wide ad suppression management fail closed. A normal signed-in owner can still maintain their own galleries, but cannot access master controls.

## Monitor accounts

Open `/opman` while signed in as the master account. A summary strip above the table totals the real owners — operator accounts are excluded from the figures but still listed — with signups and active accounts over the last 7 and 30 days, gallery activation, gallery/media/temporary totals, the source-provider mix, and one chip per country that filters the table when clicked.

Each row shows:

- display name, owner slug, primary sign-in provider, tier, immutable account ID, creation date, and last-active time;
- gallery count with temporary/hidden/Local-mirror detail, total media items, the gallery source mix (Dropbox, Google Drive, iCloud, and so on — never the links themselves), and the latest gallery date;
- the account's live app devices by type (Mac, Windows, Linux, iPhone, iPad, Android — a device unseen for 180 days drops off the list), or "web only" for accounts that have only signed in on the web;
- a "linked sign-ins" note only when an account has more than one sign-in method;
- the country of the latest signed-in visit, as Cloudflare's geo-IP reports it — a VPN shows its exit country, and accounts with no signed-in activity since tracking began show "Not yet seen";
- a persistent **Master** role badge.

Every column sorts, and the country chips filter the table client-side. The master-grant API (`PUT /api/admin/users/:accountId/master`) remains available for additional operators even though the table does not expose it.

The console intentionally does not show image bytes, source URLs, OAuth provider subjects, or gallery contents. The list is unbounded — every account renders — until the base grows large enough to need paging again.

## Delete a user

Choose **Delete account** beside the account and type the exact immutable account ID into the confirmation prompt. The API then removes that account's Manorama rows, including galleries, device-gallery catalogues, sign-in identities, and auth flows. It does not delete files at Dropbox, Google, Apple, or another external source. The master account cannot delete itself from this console.

Account self-deletion remains available to each signed-in user through the existing account settings surface.

## Global settings

The **Global presentation** section manages site-wide ad-plate suppression by UTC day or ISO-3166 alpha-2 viewer country. `IN` means Cloudflare’s Geo-IP country code for the viewer’s current request, not that the account lives in India. The public `/api/ads/visibility` response reads `request.cf.country`, returns an empty region when Cloudflare cannot determine it, and fails open by showing the plate. These controls call the same protected suppression API used by the ad policy and are master-only.

Additional masters are stored in `master_accounts`. The configured Dropbox-subject master is the bootstrap operator and cannot be revoked from the console; the current operator also cannot revoke their own access. This prevents the last known owner from locking out all operators.
