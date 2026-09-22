# Owner setup runbook

Everything on the critical path that **only Mahesh can do** — it needs an Apple account login,
a dashboard, a credit card, or physical hardware. No agent can do any of this.

Apple Developer Program enrolment cleared **2026-09-22**. The critical path has moved: it is
now the Paid Apps Agreement, not the membership.

Do the gates in order. Gate 1 blocks Gate 2 blocks the paywall (#18). Gate 3 can run any time.

---

## Gate 1 — App Store Connect foundations (~30 min, blocks everything commercial)

**1.1 Sign the Paid Apps Agreement first.** Business → Agreements → Paid Apps → *View and
Agree to Terms*, then complete tax and banking. Requires the **Account Holder** role.

This is the real gate, and it is badly documented. Apple's own help states the agreement "must
be active in order for you to submit or update paid apps and In-App Purchases" and that "you
won't be able to create a new app or In-App Purchase until you've agreed to the most recent
version" ([App Store Connect Help](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/)).
With banking pending, the Create button for in-app products is simply greyed out and Apple
tells you nothing useful — a long-standing trap
([Stack Overflow](https://stackoverflow.com/questions/39732297/unable-to-create-in-app-product-as-the-create-option-is-disabled)),
and products can return as invalid identifiers in sandbox purely because bank details are not
yet active ([Stack Overflow](https://stackoverflow.com/questions/24221054/inapppurchase-invalid-product-identifiers-is-it-due-to-pending-bank-details)).

- [ ] Paid Apps Agreement accepted
- [ ] Tax forms submitted
- [ ] Banking details submitted
- [ ] Agreement status reads **Active**, not Pending

**1.2 Register the App ID.** Certificates, Identifiers & Profiles → Identifiers → new App ID
`in.thecontrarian.manorama`, with the **In-App Purchase** capability enabled.

**1.3 Create the app record** in App Store Connect. Name, primary language, bundle id, SKU.

**1.4 Create a Sandbox tester.** Users and Access → Sandbox → Testers. Use an email alias you
control that is *not* your Apple ID.

**1.5 Generate the In-App Purchase Key.** Users and Access → Integrations → In-App Purchase →
*Generate In-App Purchase Key*. This is required for StoreKit 2 and RevenueCat SDK v5+, which
is what `@revenuecat/purchases-capacitor` uses
([RevenueCat](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/in-app-purchase-key-configuration)).

> **The `.p8` file downloads exactly once.** Save it somewhere you will still have on Saturday.
> Note the Issuer ID and Key ID alongside it.

**1.6 Optional but saves fiddling** — an App Store Connect API key with at least **App Manager**
access, so RevenueCat imports products and prices instead of you retyping them
([RevenueCat](https://www.revenuecat.com/docs/service-credentials/itunesconnect-app-specific-shared-secret/app-store-connect-api-key-configuration)).
Same one-download rule.

---

## Gate 2 — RevenueCat (~20 min, needs 1.5)

- [ ] Project created, iOS app added with bundle id `in.thecontrarian.manorama`
- [ ] In-App Purchase Key uploaded (Issuer ID + Key ID + `.p8`)
- [ ] Entitlement created, identifier exactly **`pro`** — the code in #16 keys off this string
- [ ] Products: `manorama_pro_monthly`, `manorama_pro_yearly`, `manorama_forever`
- [ ] One Offering (`default`) with three packages attached
- [ ] Public SDK key copied for #16
- [ ] Webhook URL pointed at the Worker endpoint from #20

Create the products in App Store Connect too (#17), each with a price and **at least one
localization**, or they will not return in sandbox even with the agreement active
([Apple TN3186](https://developer.apple.com/documentation/technotes/tn3186-troubleshooting-in-app-purchases-availability-in-the-sandbox)).

---

## Gate 3 — AdMob (~15 min, and read the warning)

- [ ] AdMob account created and verified
- [ ] App added, marked **"not published yet"** for now
- [ ] Ad unit: banner for the plate (300×250 medium rectangle) — #19
- [ ] Ad unit: banner for the account slot — #21
- [ ] App ID added to `Info.plist`; SKAdNetwork identifiers added — #36

> ### Expect near-zero fill until after launch
>
> A new AdMob app enters **limited ad serving** and must pass app readiness review before it
> serves normally. Review requires the app to be **published** and **listed in a supported
> store**, linked correctly in AdMob ([AdMob Help](https://support.google.com/admob/answer/10564477?hl=en)).
> Unpublished apps get limited serving and cannot complete the readiness path at all
> ([WebInto](https://webinto.app/blogs/get-admob-approval-new-app)).
>
> **Two consequences, both already reflected in the tracker:**
>
> 1. **The house fallback plate (#22) is no longer optional.** Without it, an App Store
>    reviewer opening a gallery sees an empty frame where an ad should be — which looks like
>    a bug, and invites a rejection you cannot afford on Sep 27.
> 2. **The IAP is the Shipaton eligibility mechanism, not the ads.** Shipaton accepts either
>    an in-app purchase *or* RevenueCat Ads. Since ads demonstrably cannot serve before
>    publication, #18 and #19's purchase path is what makes the entry valid. Ads are the
>    Catvertising story that matures in the days after launch, not the eligibility proof.

**After the app is live** (Sep 30 onward, for the Catvertising submission):

- [ ] AdMob → App settings → App store details → **search by store URL, not bundle id**. AdMob
      has not indexed a freshly published app, so a package-name search finds nothing
      ([r/admob](https://www.reddit.com/r/admob/comments/1w8vluj/limited_ad_serving_linking_your_store_page_is/)).
- [ ] Publish `app-ads.txt` at `manorama.xyz/app-ads.txt` — see #46
- [ ] Confirm app readiness moves from limited to full serving

---

## Gate 4 — The Mac (~30 min, can run in parallel)

- [ ] Xcode installed, command line tools selected (`xcode-select -p`)
- [ ] **Xcode 27.1** if you want the Duo work in #35 — it is required to reach the screen edge,
      and #35 is first on the cut list precisely because this may not land in time
- [ ] Signed into Xcode with the developer account; Automatic signing on
- [ ] Physical iPhone registered as a test device and trusted
- [ ] `bun` and `node` current; `bun install` clean in the repo
- [ ] A real gallery on `manorama.xyz` bookmarked as the demo for #38

---

## Daily rhythm, Tue 22 → Wed 30

| Day | Yours (dashboards, hardware) | Agents (code) |
| --- | --- | --- |
| **Tue 22** | Gates 1, 2, 4 | #14 native SPA entry |
| Wed 23 | Gate 3 · #17 products in ASC | #15 Capacitor iOS · #29 plist · #30 colour |
| Thu 24 | Sandbox purchase test on device | #24 #25 vault · #16 #19 #22 billing + plate |
| Fri 25 | #37 screenshots · #38 reviewer notes · listing copy | #26 offline · #18 paywall · #23 ad tests · #13 |
| **Sat 26** | **Archive, upload, submit.** Arm #40 as manual release | fix whatever the archive surfaces |
| Sun–Tue | Watch review status. Resubmit within hours if rejected | #27 #31 #28 #32 #33 #34 as time allows |
| **Wed 30** | **Hit Release** the moment it is approved. Before 11:45 PM PDT | — |

## Each evening, check three things

1. `bunx tsc --noEmit` clean and `bun test` green on `main`. A red suite compounds.
2. The build still installs and opens a gallery on the physical iPhone. Simulator success is
   not evidence.
3. Nothing on the never-cut list has quietly slipped: #14 #15 shell · #16 #18 #19 #22 #23
   eligibility and ad safety · #24 #25 #26 vault and offline · #29 · #36 #37 #38 #40.

## If review rejects on Guideline 4.2

The prepared answer is #38: encrypted on-device vault, full offline operation, global view,
native IAP, native share, ProMotion and P3 rendering. Reply in Resolution Center the same day
with that list and a screen recording of airplane-mode operation — an offline cold launch is
the single most persuasive artefact, because it is the thing a website cannot do.
