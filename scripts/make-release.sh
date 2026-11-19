#!/usr/bin/env bash
# make-release.sh — build the source tarball that gets deployed to /opt/lab2date.
#
#   bash scripts/make-release.sh [<commit>]     # default: HEAD
#
# Result: release-<short-sha>.tgz in the repo root, unpacked on the server with
#   tar -xzf release-<sha>.tgz -C <dir>
#
# Uses `git archive`, so the tarball holds exactly the committed files of that
# commit (no node_modules, .next, .env*, untracked or locally edited files) with
# LF line endings even when it is built on Windows.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

REF="${1:-HEAD}"
SHA="$(git rev-parse --short=7 "$REF^{commit}")"
OUT="$REPO_ROOT/release-$SHA.tgz"

# core.autocrlf=false: no CRLF even if the commit predates .gitattributes.
git -c core.autocrlf=false archive --format=tar.gz -o "$OUT" "$SHA"

CHECK="$(mktemp -d)"
trap 'rm -rf "$CHECK"' EXIT
tar -xzf "$OUT" -C "$CHECK"
# -I skips binary files (images, fonts), which may legitimately contain \r.
# Not inside $(...): Git Bash on Windows drops the \r there. -U: Windows grep
# otherwise strips CR before matching (no-op on Linux).
if grep -rlIU $'\r$' "$CHECK/" > "$CHECK.crlf"; then
  echo "[err] CRLF in:"; sed "s#$CHECK/#  #" "$CHECK.crlf"; rm -f "$OUT" "$CHECK.crlf"; exit 1
fi
rm -f "$CHECK.crlf"

echo "==> $OUT ($(git rev-parse "$SHA"), $(tar -tzf "$OUT" | grep -vc '/$') files, LF only)"
