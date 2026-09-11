#!/usr/bin/env bash
#
# Cuts a fork VSIX release for balajidutt/better-beads-kanban.
#
# This fork is not published to the VS Code Marketplace. It ships as a VSIX
# attached to a GitHub release, which downstream installers pin by tag + asset
# name + SHA256. This script produces all three and prints them.
#
# The VSIX filename carries the branch and short SHA so a downloaded asset can
# be identified without guessing, but package.json is packaged exactly as
# committed. That is the difference from scripts/build-local-vsix.sh, which also
# patches displayName: an iteration build has no version to identify it, a
# release does. This script also refuses to run on a dirty tree.
#
# Usage: scripts/release-fork-vsix.sh [--dry-run]
#
# Requires: gh (authenticated), node, npx, shasum or sha256sum.

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
elif [ -n "${1:-}" ]; then
  echo "ERROR: unknown argument '${1}'. Usage: $0 [--dry-run]" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

FORK_REPO="balajidutt/better-beads-kanban"

# --- Preconditions -----------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is dirty." >&2
  echo "  A release must be reproducible from the tagged commit." >&2
  echo "  Commit or stash, or use scripts/build-local-vsix.sh to iterate." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh is required to create the release." >&2
  exit 1
fi

# --- gh identity -------------------------------------------------------------
#
# A release's author is public and cannot be changed after it is created, and any
# account with write access can create one. gh's active account is global rather
# than per-directory, and this machine deliberately leaves a different account
# active for everyday work. Without this guard the script would happily stamp
# whichever account happened to be active onto a permanent, public artifact.
#
# So: borrow the owner's identity for this run and hand it back on the way out.
# The EXIT trap fires on success, on failure under `set -e`, and on Ctrl-C. Only
# SIGKILL skips it, which leaves the account switched — recoverable with a single
# `gh auth switch` and caught by this same guard on the next run.
EXPECTED_OWNER="${FORK_REPO%%/*}"
PREV_GH_ACCOUNT=$(gh api user --jq .login 2>/dev/null || true)

restore_gh_account() {
  if [ -n "${PREV_GH_ACCOUNT:-}" ] && [ "$PREV_GH_ACCOUNT" != "$EXPECTED_OWNER" ]; then
    gh auth switch --hostname github.com --user "$PREV_GH_ACCOUNT" >/dev/null 2>&1 || true
  fi
}
trap restore_gh_account EXIT

if [ "${PREV_GH_ACCOUNT:-}" != "$EXPECTED_OWNER" ] \
   && ! gh auth switch --hostname github.com --user "$EXPECTED_OWNER" >/dev/null 2>&1; then
  echo "ERROR: gh has no '${EXPECTED_OWNER}' account to switch to." >&2
  echo "  Run: gh auth login --hostname github.com --git-protocol ssh --scopes repo" >&2
  exit 1
fi

if [ "$(gh api user --jq .login 2>/dev/null || true)" != "$EXPECTED_OWNER" ]; then
  echo "ERROR: gh identity is not '${EXPECTED_OWNER}'; refusing to create a release." >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
SHA=$(git rev-parse --short HEAD)
# Full SHA for gh's --target: the API accepts a branch name or a full commit
# SHA, and does not reliably resolve an abbreviated one.
FULL_SHA=$(git rev-parse HEAD)
ORIG_NAME=$(node -p "require('./package.json').displayName")
PACKAGE_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

# This used to require an X.Y.Z-bd.N suffix so a fork build could not be mistaken
# for upstream's. That rationale is gone: the extension IDs differ
# (balaji-dutt.better-beads-kanban vs davidcforbes.beads-kanban), this fork is not
# on the marketplace, and since 2.2.0 it is the maintained line rather than a
# patch series on top of one. Plain X.Y.Z is now the normal case; -bd.N stays
# accepted so the older tags remain reproducible. Anything else is still a typo.
# Same shape as SEMVER_RE in scripts/bump-version.js — keep the two in sync.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-bd\.[0-9]+)?$ ]]; then
  echo "ERROR: version '${VERSION}' is not X.Y.Z or X.Y.Z-bd.N." >&2
  echo "  Run: node scripts/bump-version.js X.Y.Z" >&2
  exit 1
fi

# Tag and asset are derivable from the version alone, deliberately. Downstream
# installers pin this release by tag + asset name + sha256, and an automated pin
# updater can build "v2.2.0" and
# "better-beads-kanban-2.2.0.vsix" from a version string, but could never have
# reconstructed the previous "-${BRANCH}-${SHA}" forms. Traceability is not lost:
# the release is created with --target ${FULL_SHA}, and the body names the
# commit. Uniqueness comes from the version — bump-version.js refuses to reuse
# one, and the guards below refuse an existing tag or release.
TAG="v${VERSION}"
TARGET_VSIX="${PACKAGE_NAME}-${VERSION}.vsix"
RELEASE_TITLE="${ORIG_NAME} ${VERSION}"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "ERROR: tag ${TAG} already exists locally." >&2
  echo "  Bump the version before cutting another release." >&2
  exit 1
fi

if gh release view "$TAG" --repo "$FORK_REPO" >/dev/null 2>&1; then
  echo "ERROR: release ${TAG} already exists on ${FORK_REPO}." >&2
  exit 1
fi

# The tag must point at a commit that exists on the remote, or the release will
# reference something nobody else can fetch.
if ! git branch -r --contains HEAD 2>/dev/null | grep -q .; then
  echo "ERROR: HEAD (${SHA}) has not been pushed to any remote." >&2
  echo "  Push the branch first, then re-run." >&2
  exit 1
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    echo "ERROR: neither shasum nor sha256sum is available." >&2
    return 1
  fi
}

# --- Verify ------------------------------------------------------------------

echo "==> Verifying (tsc --noEmit, eslint, tests)"
npm run verify

# --- Build -------------------------------------------------------------------

# A release build packages package.json exactly as committed. Earlier versions
# patched displayName to "<name> [<branch>+<sha>]" here and restored it via an
# EXIT trap, so an installed build could be traced back to a commit. That is now
# the version number's job: releases carry a real X.Y.Z and a matching tag, and
# the branch is always main. build-local-vsix.sh still tags its displayName —
# that is the point of an iteration build, which has no version to identify it.

# SHA256SUMS is written after packaging, so one left behind by an earlier run
# or by --dry-run would be picked up as extension content.
rm -f SHA256SUMS

echo "==> Packaging ${TARGET_VSIX}"
npx @vscode/vsce package --out "${TARGET_VSIX}"

sha256_file "${TARGET_VSIX}" > SHA256SUMS
EXPECTED_SHA=$(cut -d ' ' -f 1 < SHA256SUMS)

# --- Release -----------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "==> Dry run: skipping 'gh release create'."
  echo "    Would create tag ${TAG} on ${FORK_REPO}."
else
  echo "==> Creating release ${TAG} on ${FORK_REPO}"
  # Without --target, GitHub creates the tag on the repository's default branch
  # rather than on the commit that was built, so checking out the tag yields the
  # wrong tree. Releases bd.1 through bd.3 all carry this defect.
  #
  # --latest is passed rather than left to the default because the two sources
  # disagree on what that default is: the REST API documents make_latest as
  # defaulting to true, while `gh release create --help` describes it as
  # automatic, based on release date and version. The automatic form would have
  # to compare "v2.2.0" against tags shaped like
  # "bd-fixes-v2.1.4-bd.5-fed50b3", which is not a comparison worth trusting.
  # Every release this script cuts is the newest one, so say so.
  gh release create "${TAG}" \
    --repo "${FORK_REPO}" \
    --target "${FULL_SHA}" \
    --latest \
    --title "${RELEASE_TITLE}" \
    --notes "Fork build of ${PACKAGE_NAME} ${VERSION} from ${BRANCH} at ${SHA}. See CHANGELOG.md for what changed." \
    "${TARGET_VSIX}" SHA256SUMS
fi

# --- Pin block ---------------------------------------------------------------

cat <<EOF

Pin values for downstream installers:

  TAG="${TAG}"
  ASSET="${TARGET_VSIX}"
  EXPECTED_SHA="${EXPECTED_SHA}"
  VERSION="${VERSION}"

The same checksum is published as the release's SHA256SUMS asset, so an
automated pin can pick it up without downloading the VSIX.
EOF

# --- Cleanup -----------------------------------------------------------------

# After a real run both files are on the release, where `gh release download`
# reproduces them verifiably; after a dry run nothing needs them, because what a
# dry run is read for — file count and size — is vsce's own output above. Either
# way a copy left in the repo root is dead weight that accumulates per release.
#
# EXPECTED_SHA was read into a variable before the pin block, so deleting
# SHA256SUMS here cannot affect what was printed. A failed upload exits earlier
# under `set -e` and never reaches this, which is the one case where the local
# copy is the only copy.
rm -f "${TARGET_VSIX}" SHA256SUMS
