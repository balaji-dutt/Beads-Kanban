# Releasing

How a backlog item becomes a shipped release, and how to cut one.

This fork is **not** on the VS Code Marketplace. It ships as a VSIX attached to a
GitHub release on `balajidutt/better-beads-kanban`. Upstream's Marketplace
runbook was removed in bbk-vi1; if you find instructions anywhere that mention
`vsce publish` or a publisher account, they are not this path.

## Accounts and remotes

The repo is owned by the `balajidutt` GitHub account, which is separate from the
account `gh` is normally logged in as. Two consequences:

- `origin` uses the `github-balajidutt` SSH host alias, not `github.com`. The
  alias and its key are provisioned by the `private-dotfiles` chezmoi source. On
  Windows there is no keychain, so run `ssh-add` on the key once per session or
  every push prompts for the passphrase.
- **You do not need to switch `gh` accounts by hand to cut a release.**
  `scripts/release-fork-vsix.sh` borrows the `balajidutt` identity for its own
  run and restores the previous active account on exit. It refuses to run if
  that account is not configured — a release's author is public and cannot be
  changed afterwards, which is the whole reason for the guard.

## How the backlog maps to a release

**No bead carries a version number.** Not a label, not a title, not a field.

The semver level is an output of a release, not an input. You cannot know whether
a fix is a patch or a minor until you know what shipped alongside it and whether
the result is user-visible. `scripts/bump-version.js` already enforces that
ordering: it refuses to bump unless a `## [X.Y.Z]` heading already exists in
`CHANGELOG.md`. Write what shipped, then pick the number.

So scope lives in the dependency graph instead:

**1. The release is a bead.** Title it generically while the number is unknowable.

```bash
bd create --type=task --priority=1 --title="Cut the next release"
```

**2. Issues in scope get an edge into it.** The release depends on the work.

```bash
bd dep add <release-id> <issue-id>    # release depends on issue
```

Add these as you decide, one at a time. Re-scoping is `bd dep remove`, not a
relabelling sweep.

**3. `bd show <release-id>` is the scope.** Exact and queryable. The release bead
stays blocked until every scoped issue closes, then surfaces in `bd ready` — the
cut signal is derived, not remembered.

A release bead with no edges appears in `bd ready` immediately. That reads as
"ship now" but means "scope undecided", so attach at least one edge when you
create it.

**4. At cut time, write the CHANGELOG entry from the `blocks` list.** That list
*is* the scope, so the entry is not reconstructed from `git log`. Writing it
tells you the level: breaking change → major, new capability → minor, fixes only
→ patch.

**5. Now the number exists. Retitle.**

```bash
bd update <release-id> --title="Cut the 2.2.1 release"
```

**6. Bump and ship** (next section).

`bbk-gno` ("Cut the 2.2.0 release") is the worked example — it carries its scope,
its dry-run values, and the published sha256 in its close reason.

### Why not epics

Parent-child drives the Tree view's hierarchy (`src/webview/treeBuilder.ts`),
where it means work decomposition. A release epic parenting unrelated bugs would
overload that structure with a second, unrelated axis. Use `blocks`.

### When to cut

There is no auto-update for a GitHub-release VSIX — every release costs a manual
reinstall on every machine. Cut when there is a reason to reinstall, not when
some number of issues have closed. 2.1.4-bd.4 → bd.5 shipped the same day and
bd.5 was pure repackaging; that is the failure mode.

## Cutting a release

### Preconditions

`scripts/release-fork-vsix.sh` refuses to run unless all of these hold, so check
them first rather than discovering them halfway:

- Working tree is clean.
- `HEAD` is pushed to a remote — the tag must point at a commit others can fetch.
- The tag `v<version>` exists neither locally nor on the GitHub repo.
- `gh` is installed.
- The version in `package.json` is `X.Y.Z` or `X.Y.Z-bd.N`.

Not enforced, but required anyway: `gh` must be *authenticated*, and `node`,
`npx`, and `shasum` or `sha256sum` must be available (the checksum tools are
checked only at the point of use, after packaging). Release from `main` — that is
convention, not a guard; nothing stops you tagging a release off a branch.

### 1. Write the CHANGELOG entry first

`release:bump` fails without a `## [X.Y.Z]` heading. Keep-a-Changelog format,
newest at the top; see existing entries for the category headings in use
(`💥 Breaking`, `✨ Added` / `Changed`, `🐛 Bug Fixes`, `🔧 Internal`,
`📚 Documentation`, `🧹 Cleanup`).

### 2. Bump

```bash
npm run release:bump -- X.Y.Z
```

Updates `package.json` and the cache-busting `const version` in `src/webview.ts`
in lockstep, and only after every check passes. The two must match or the webview
serves stale assets.

Accepted shapes are `X.Y.Z` and `X.Y.Z-bd.N` (the legacy fork series, kept so
those tags stay reproducible). The regex is duplicated in
`scripts/bump-version.js` and `scripts/release-fork-vsix.sh` — change one and you
must change the other.

### 3. Dry run

```bash
bash scripts/release-fork-vsix.sh --dry-run
```

Verifies, packages, and checksums without publishing. Confirm the emitted `TAG`
and `ASSET` look right and the package is roughly 39 files / 1.34 MB. A file
count in the hundreds means the bundler regressed.

The printed sha256 is indicative only — VSIX zips are not guaranteed
byte-reproducible across runs. Take the authoritative value from the real run.

### 4. Ship

```bash
bash scripts/release-fork-vsix.sh
```

The script runs `npm run verify` itself (`tsc --noEmit`, `eslint`, the Mocha
suite), packages the VSIX, writes `SHA256SUMS`, creates the tag on the built
commit via `--target <full-sha>`, marks the release `--latest`, and uploads the
VSIX and `SHA256SUMS`.

`SHA256SUMS` is load-bearing, not decoration. An installer that pins this
release by checksum can read the value out of a few bytes of manifest instead of
downloading the VSIX to hash it. Keep uploading it.

> **Trap: do not run `npm run release:package` for a fork release.** That is the
> Marketplace path (verify + `vsce package`, for a manual web upload).
> `release-fork-vsix.sh` does its own verify and package; running both just
> packages twice and can leave a stray VSIX behind.

### 5. Close the release bead

Record the published sha256 in the close reason, so the release is traceable from
the backlog later:

```bash
bd close <release-id> --reason="Released vX.Y.Z from <sha>. Published asset sha256: <sha256>."
```

The script also prints a pin block — tag, asset name, sha256, version — for
anyone installing this release from a pinned reference rather than from the
releases page. Nothing in this repo consumes those values.

### 6. Verify the release landed

```bash
gh release view vX.Y.Z --repo balajidutt/better-beads-kanban
```

Check the tag resolves to the commit you built, `Latest` is set, and both assets
are attached. Also check the release author is `balajidutt` — the script's guard
should make that automatic, and an author of anything else means the guard was
bypassed and the release needs deleting and recreating.
