#!/usr/bin/env bash
# Commit the outstanding work in logical batches. Run with: bash .work/logical-commits.sh
set -e
cd "$(dirname "$0")/.."

# A batch must contain only what this script stages: work that was already
# staged would be swept into the first commit and mislabelled by it.
if ! git diff --cached --quiet; then
  echo "the index already holds staged changes; commit or reset them first" >&2
  exit 1
fi

git add native/lib/api.ts native/lib/api.test.ts \
        native/lib/offline-gallery.ts native/lib/offline-gallery.test.ts \
        native/lib/vault-settings.ts native/lib/vault-settings.test.ts \
        native/islands/GlobalView.tsx native/islands/GlobalView.test.tsx \
        app/islands/Viewer.tsx native-vault-controls.playwright.ts
git commit -q -F - <<'MSG'
fix(native): let a gallery leave the vault alone and hand the stage back

Account previews read their poster when a summary carries no variant, so a
gallery no longer shows a broken thumbnail before its first vault fill. The
picker opens on what the device already has instead of blocking behind the
vault, and the controls panel carries a return to the galleries plus an
Android back handler, because a phone that opened a gallery had no way out of
it. A per-gallery stream-only switch lets an owner keep one album off the
device without deleting anything already stored; the account-wide policy is
unchanged, and nothing here writes image bytes to the server.
MSG

git add native/islands/GalleryList.tsx native/islands/GalleryList.account.test.tsx \
        native/styles.css app/islands/Admin.tsx app/styles.css \
        desktop/islands/Catalogue.tsx desktop/islands/Catalogue.workbench.test.tsx \
        admin-appearance.playwright.ts \
        .work/admin-gallery-focus.py .work/native-vault-repair.py .work/current-notes-2026-10-11.md
git commit -q -F - <<'MSG'
feat(admin): put the galleries first on every admin surface

The account page now reads logo, ad, address, welcome, add-a-gallery, then
every gallery the account holds. Global settings, the device catalogue and the
legal links moved into the account menu, which drops from the top of a phone
and fills it. An owner sees all of their galleries again: the phone list was
slicing to the free tier's editing limit, which is why three galleries read as
five. Per-gallery copy, open-source, refresh and delete sit on the card outside
its opener, and delete asks once before it removes the record, never a provider
file. Pink selection borders stay where they belong, on the picker's chosen
photograph.
MSG

git add demo-captures/web/admin-appearance demo-captures/desktop-admin demo-captures/admin-gallery-focus
git commit -q -m 'docs(captures): refresh the admin evidence matrix for the gallery-first layout'

git add android/capacitor.settings.gradle
git commit -q -m 'chore(android): let Capacitor regenerate its module paths for this checkout'

git add outputs/native-vault-repair-2026-10-11.md
git commit -q -m 'docs: record the native vault repair and its open gates'

echo '=== commits ==='
git log --oneline -6
echo '=== still uncommitted ==='
git status --porcelain
