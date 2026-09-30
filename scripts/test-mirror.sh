#!/usr/bin/env bash
# Run the unit suite against this working tree.
#
# Why this exists instead of a bare `bun test`:
#
# bun's test runner discovers specs by walking the working directory. This
# checkout keeps its git worktrees inside the repository at `.worktrees/`, and
# each of those carries its own `node_modules` — about a million files under the
# scan root. bun exhausts its file-descriptor budget before it can even load the
# `bunfig.toml` preload, so `bun test` at the repository root dies with
#
#     error: EMFILE reading ".../test/hono-jsx-dom.ts"
#
# Running the suite from a subdirectory instead is *not* an equivalent
# substitute. The DOM renderer that `test/hono-jsx-dom.ts` preloads is
# order-sensitive (see the note in `bunfig.toml`), and starting the scan inside
# `app/` changes which specs share a process. Measured on one commit:
#
#     bun test ./app/server.test.ts          (repo root)  30 pass / 0 fail
#     cd app && bun test ./server.test.ts              25 pass / 5 fail
#
# So the suite is mirrored into a directory that holds no worktrees and no build
# output, `node_modules` is shared by symlink, and bun runs from that root. The
# checkout is only ever read.
#
# Usage:
#   bun run test:unit              # whole suite
#   bun run test:unit -- -t 'name' # any extra arguments reach `bun test`
#   MANORAMA_TEST_ROOT=/tmp/x bun run test:unit
#
# Caveat: the mirror is not a git checkout, so a spec that shells out to git, or
# one run with `-u` to rewrite snapshots, would write into the mirror rather than
# into this repository.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="${MANORAMA_TEST_ROOT:-${TMPDIR:-/tmp}/manorama-test-root}"

mkdir -p "$root"

# Build output and the nested worktrees are the only large subtrees; everything
# else is small enough to copy on every run.
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.worktrees/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'outputs/' \
  --exclude '.work/' \
  --exclude '.wrangler/' \
  --exclude '.playwright-mcp/' \
  --exclude 'test-results/' \
  --exclude 'playwright-report/' \
  --exclude 'ios/build/' \
  --exclude 'ios/App/build/' \
  --exclude 'src-tauri/target/' \
  --exclude '.vendo/data/' \
  "$repo/" "$root/"

# One dependency tree, shared. A spec that resolves `hono` here gets exactly the
# same files it would get in the checkout.
ln -sfn "$repo/node_modules" "$root/node_modules"

cd "$root"
exec bun test "$@"