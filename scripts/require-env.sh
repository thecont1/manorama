#!/usr/bin/env bash
# Fail a release job when a required secret is absent. Prints presence and
# length only — a credential value never reaches the log — then exits 1 if
# any name is missing so the run cannot go green without what it needs.
#
#   scripts/require-env.sh NAME [NAME...]
#
# Portable to macOS's /bin/bash 3.2: no mapfile, no associative arrays.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/require-env.sh NAME [NAME...]" >&2
  exit 2
fi

missing=0
for name in "$@"; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    printf '%-28s set (%s characters)\n' "$name" "${#value}"
  else
    printf '%-28s MISSING\n' "$name"
    echo "::error::$name is not set for this repository, so the workflow cannot see it. Check the spelling, and that it sits under Settings -> Secrets and variables -> Actions in this repo (not another repo, an environment, or the Variables tab)."
    missing=1
  fi
done

exit "$missing"
