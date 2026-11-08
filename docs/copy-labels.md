# Action labels

One canonical label per job, applied on every shell (web, native, macOS).
Exceptions are listed explicitly; anything not listed is a bug, not a
platform quirk.

| Job | Canonical label | Intentional exceptions |
|---|---|---|
| Add a gallery to the Library | `+ Add Gallery` on the compact library control (web `admin-add-pill`, macOS catalogue pill, native heading button with the `+` icon) | Sentence form `Add a gallery` in explanatory contexts: the empty-library CTA, the Add sheet's title and its submit button |
| Rescan the source folder | `Refresh gallery contents` | — |
| Library heading | `Library` | — |
| Reorder photographs | `Reorder` in the editor bar title; `Reorder photographs` in the card menu that opens it | — |
| Publish / share a local gallery | `Publish` while unpublished, `Share link` once a public link exists | — |
| Viewer chrome | one-word controls (`Display`, `Info`, `Share`) | the one-word rule applies to viewer chrome only — legal text and explanatory forms are exempt |
| Privacy destinations | `Privacy Policy`, `Terms` | `Terms of Use` on the native paywall — the App Store EULA row names Apple's document |

## Touch targets

Interactive controls carry at least a 44×44 CSS-pixel hit area in touch
contexts — `--m-touch`. The shared `.m-btn`, `.m-iconbtn`, `.m-switch`,
`.lib-menu` rows and segmented options already meet it. Compact desktop
treatments (the macOS catalogue's quiet buttons, viewer chrome pills) may
sit smaller where only a fine pointer reaches them; nothing may dip below
44px where a finger can land.
