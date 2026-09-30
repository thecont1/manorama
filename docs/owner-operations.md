# Owner operations

Manorama has no public user directory or gallery index. The private master operations console lives at **`/opman`** and is available only to the immutable Dropbox identity configured as `MASTER_DROPBOX_SUBJECT`.

## Configure the master account

Open `/opman`. If there is no valid session, it sends the browser through the existing Dropbox OAuth flow and returns to `/opman` after sign-in. No separate operations password exists or is needed.

After the owner has signed in once, read the immutable Dropbox subject returned by Dropbox (`dbid:…`) from the account’s `auth_identities` row and set `MASTER_DROPBOX_SUBJECT` as a protected Worker secret. It is an identity selector, not a credential; do not use a display name, email address, editable owner slug, or password. The check resolves the configured Dropbox subject to its current Manorama account, so the account may retain its normal `acct_<UUID>` internal ID.

If the binding is absent, `/opman`, the account-monitoring API, and site-wide ad suppression management fail closed. A normal signed-in owner can still maintain their own galleries, but cannot access master controls.

## Monitor accounts

Open `/opman` while signed in as the master account. The console shows:

- display name, owner slug, tier, immutable account ID, and creation date;
- the number of stored galleries, device-gallery catalogues, and linked sign-in identities;
- a refresh action for current metadata.

The console intentionally does not show image bytes, source URLs, OAuth provider subjects, or gallery contents.

## Delete a user

Choose **Delete account** beside the account and type the exact immutable account ID into the confirmation prompt. The API then removes that account's Manorama rows, including galleries, device-gallery catalogues, sign-in identities, and auth flows. It does not delete files at Dropbox, Google, Apple, or another external source. The master account cannot delete itself from this console.

Account self-deletion remains available to each signed-in user through the existing account settings surface.

## Global settings

The **Global presentation** section manages site-wide ad-plate suppression by UTC day or ISO-3166 region. These controls call the same protected suppression API used by the ad policy and are master-only. The public `/api/ads/visibility` response remains read-only and does not reveal account data.
