# Owner operations

Manorama has no public user directory or gallery index. The private master operations console lives at **`/ops`** and is available only to the immutable account ID configured as `MASTER_ACCOUNT_ID`.

## Configure the master account

Set `MASTER_ACCOUNT_ID` to the account's immutable `account_id` value in the Worker environment. Do not use an email address or the editable owner slug. In production, set it as a secret or protected environment value through the deployment system; never commit the value to the repository.

If the binding is absent, `/ops`, the account-monitoring API, and site-wide ad suppression management fail closed. A normal signed-in owner can still maintain their own galleries, but cannot access master controls.

## Monitor accounts

Open `/ops` while signed in as the master account. The console shows:

- display name, owner slug, tier, immutable account ID, and creation date;
- the number of stored galleries, device-gallery catalogues, and linked sign-in identities;
- a refresh action for current metadata.

The console intentionally does not show image bytes, source URLs, OAuth provider subjects, or gallery contents.

## Delete a user

Choose **Delete account** beside the account and type the exact immutable account ID into the confirmation prompt. The API then removes that account's Manorama rows, including galleries, device-gallery catalogues, sign-in identities, and auth flows. It does not delete files at Dropbox, Google, Apple, or another external source. The master account cannot delete itself from this console.

Account self-deletion remains available to each signed-in user through the existing account settings surface.

## Global settings

The **Global presentation** section manages site-wide ad-plate suppression by UTC day or ISO-3166 region. These controls call the same protected suppression API used by the ad policy and are master-only. The public `/api/ads/visibility` response remains read-only and does not reveal account data.
