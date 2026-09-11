# Changelog

All notable changes to the Beads Kanban extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.2] - 2026-09-11

A bug-fix release. Three fixes are visible on the board: scroll position surviving a refresh, light themes rendering correctly, and the board noticing a workspace folder added after it opened. The rest is release and testing tooling. Nothing about the message protocol, the settings, or the extension ID changes, so upgrading is a straight reinstall of the VSIX.

### 🐛 Bug Fixes

- **The Table and Tree views no longer jump to the top when the board refreshes.** Both rebuild their contents wholesale, which destroys the element holding the scroll offset, so every time the file watcher noticed a Dolt write the viewport snapped back to the start. The Kanban view already captured and restored its per-column scroll; the other two now do the same. A refresh in the Table view also returned to page 1 — it now stays on the page you were reading, and a refresh that shrinks the results no longer strands you past the end on an empty table. Expanding or collapsing a row in the Tree view no longer jumps to the top either.
- **Light VS Code themes rendered the board wrong, and in places invisibly.** The stylesheet assumed a dark background, so borders, surface tints and secondary text were all white at low opacity. Under a light theme that left card label chips, parent breadcrumbs, and the edit dialog's section headings and issue ID white on white — present but unreadable. Hover feedback vanished entirely on table rows, view toggles and the column picker, making those controls look unresponsive. The dialog also forced dark rendering on native widgets regardless of theme, which is why its checkboxes appeared as solid black squares. Colours now come from the VS Code theme variables that already adapt.
- **The board ignored workspace folders added after it opened.** Resolution ran once at activation and then only when a command asked for it, so adding your Beads repository as a second workspace folder left an open board reporting no repository until it was closed and reopened. The same gap affected multi-root windows at startup, where a second root can register a moment after the extension activates. The board now re-resolves whenever the folder list changes, retargets, and reloads.

### 🔧 Internal

- **`scripts/bump-version.js` has automated coverage.** Its guards — the accepted version shape, refusing to reuse the current version, requiring a CHANGELOG heading, and writing nothing until every check passes — were verified only by running it by hand at release time. Nine tests now drive the real script against a temporary fixture.
- **`npm test` runs from a git worktree.** macOS caps Unix domain socket paths at 103 characters, and VS Code opens its IPC socket inside the test user-data directory, which defaulted to a path inside the project. From any linked worktree that exceeded the cap and the suite died before a single test ran.
- **The release script no longer leaves its VSIX behind.** Every run left one in the repository root, accumulating one per release, plus a `SHA256SUMS` from a dry run that corresponds to no release at all. Both are attached to the GitHub release, where `gh release download` reproduces them verifiably.
- **The release script's closing pin block describes what actually maintains the pin.** It named three files to hand-edit, under their pre-2.2.0 names, in a repository this one cannot see. It now prints the release facts and nothing else.

### 📚 Documentation

- **`TESTING.md` records the Extension Development Host's traps.** Nothing in the suite activates the extension, so workspace resolution, the watchers and the webview are only reachable by driving the host by hand — where three behaviours that are invisible from the code have each been mistaken for a broken change.

## [2.2.1] - 2026-09-10

A bug-fix release. Five of the fixes are visible on the board; the rest keep the release and testing tooling honest. Nothing about the message protocol, the settings, or the extension ID changes, so upgrading is a straight reinstall of the VSIX.

### 🐛 Bug Fixes

- **The board no longer adopts a `.beads` directory that is not a Beads repository.** The probe tested only that a directory of that name existed. bd keeps global state at `~/.beads` on some machines — `eventsData/` and `shared-server/`, no database — so opening any folder under `$HOME` without a `.beads` of its own climbed upward, adopted it, and then failed every command with a bd error instead of saying no repository was found. A directory now qualifies only if it holds `metadata.json`, `config.yaml`, `embeddeddolt` or `dolt`, and the upward walk refuses `$HOME` outright. Opening `$HOME` as a workspace root, or choosing it in the picker, still works. This is also what made a git worktree opened as a single-root window fail confusingly; it now reports the real problem and offers the folder picker.
- **P4 issues were invisible in every view.** The toolbar's priority filter stopped at P3 while the edit dialog offered P4 and the schema accepted it. Under inclusive-multiselect a card whose priority is not in the checked set is dropped, and there was no P4 checkbox to select it back in — so a P4 issue could be created and saved but never seen again. A stored P0–P3 selection is widened on load, so the fix applies to boards that already had one.
- **The edit dialog's relationship lists never refreshed after a dependency change.** Set Parent, Unlink, Add/remove Blocker and Add/remove Child each reported success while the Parent, Blocked By, Blocks and Children lists kept whatever was drawn when the dialog opened. All seven affected controls now redraw.
- **Dependency lists showed only the last 20 characters of an issue ID.** Left-truncation drops the project prefix and the leading hierarchy segments — the part that identifies the issue — leaving a tail that matches nothing you can search for. IDs now render in full, in monospace, as they already did in the Table and Tree views.
- **The edit dialog occasionally painted an orange highlight across the whole modal on macOS.** Chromium makes scroll containers focusable and paints their focus ring in the OS accent colour, so the dialog's own scrolling container could take the ring. Focus now goes to the title field on open, and the containers no longer paint a ring however they gain focus. Tabbing still rings every form field.

### 🔧 Internal

- **`npm run release:bump` pointed at the wrong release path on success.** It printed `npm run release:package`, which is upstream's Marketplace path; this fork ships through `scripts/release-fork-vsix.sh`, which runs its own verify and package. Following the hint packaged the extension twice and left a stray VSIX behind.
- **The filter dropdowns and the edit-dialog selects are built from one module.** The standalone visual test server hand-transcribed markup that `src/webview.ts` generates, and the copy was kept current by hand. When it fell behind, the harness did not fail — it wrote a selection for checkboxes that did not exist and quietly showed fewer cards, which is the class of bug the harness exists to catch.
- **The visual test server's mock backend applies mutations instead of only acknowledging them.** It answered every write with `mutation.ok` and changed nothing, so any UI that re-reads after a write — the edit dialog refetches after a relationship change — rendered a working fix and a broken one identically.
- **Long-form fixtures added to the visual test server.** The mock dataset was uniformly terse, so bugs that depend on content volume — textarea overflow, markdown preview height, a comment thread past its scroll boundary — could not be reproduced there at all.
- **Removed dead form-rebuild code from `openDetail`.** A large HTML template literal built but never assigned, left over from the static-form refactor.

### 📚 Documentation

- **Repointed every `steveyegge/beads` link at `gastownhall/beads`.** The upstream repository moved and the old links resolved only through GitHub's redirect, which stops working if the old name is ever reclaimed.

## [2.2.0] - 2026-08-16

This fork becomes the maintained line. `main` now carries the fork's work rather than tracking `davidcforbes/Beads-Kanban`, which has been dormant since April 2026. Nothing about how the extension behaves changes in this release — it is an identity, documentation and versioning release. The functional work it collects shipped across 2.1.4-bd.1 through 2.1.4-bd.5; see those entries.

The version is 2.2.0 rather than 2.1.5 because the accumulated fork-only work — tree view, filter state machine, relationship affordances, UI state persistence, bd 1.x / Dolt support — is a feature line, and it drops the `-bd.N` suffix because there is no longer an upstream release series to stay distinguishable from.

### 💥 Breaking

- **The extension ID changed from `balaji-dutt.beads-kanban-bd-fixes` to `balaji-dutt.better-beads-kanban`.** VS Code treats this as a different extension, so upgrading is not automatic. Uninstall the old one — `code --uninstall-extension balaji-dutt.beads-kanban-bd-fixes` — or both will be installed at once and both will register the "Beads: Open Kanban Board" command.

### ✨ Changed

- **Renamed to Better Beads Kanban.** "BD Fixes" described a branch, which stopped being accurate once this became the maintained line rather than a patch series stacked on upstream.
- **Removed the last of the grandparent project's branding.** The HTML `<title>`, the board header, and the Settings UI section header all still read "Agent Native Abstraction Layer for Beads" — the name of the project two forks back. `author` and `sponsor` still pointed at davidcforbes.

### 📚 Documentation

- **README rewritten.** It was upstream's, verbatim, and wrong in ways that mattered: it advertised a Marketplace install (which fetches upstream's 2.1.2, without any of the bd fixes), pointed downloads and clone URLs at davidcforbes, described issues as living in `.beads/*.db` SQLite files, documented a `beadsKanban.doltPath` setting removed in 2.1.4-bd.4, referenced a deleted source file, and narrated the wrong pair of repositories in its attribution. It now leads with what this fork is, explains what it changes and why, and carries the full three-way lineage.
- Corrected two stale claims in `CLAUDE.md`: the same removed `doltPath` setting, and a `src/daemonManager.ts` listed as a core component. That file does not exist and the extension contributes no status bar item.

### 🔧 Internal

- **`scripts/release-fork-vsix.sh` accepts plain `X.Y.Z` versions.** It hard-refused anything without a `-bd.N` suffix, to keep fork builds from colliding with upstream on the Marketplace. The extension IDs differ, this fork was never published there, and it is no longer a patch series — so the guard blocked nothing but 2.2.0. It now shares the version shape with `scripts/bump-version.js` and takes both forms. Release tags drop the `bd-fixes-v` prefix for `v`.
- **Release builds no longer patch `displayName`.** The script rewrote `package.json` to `"<name> [<branch>+<sha>]"` before packaging and restored it from an `EXIT` trap, so an installed build could be traced to a commit. A real version and a matching tag do that now. `scripts/build-local-vsix.sh` keeps its own tagging — an iteration build has no version to identify it.
- **`.claude/` no longer ships inside the VSIX.** `vsce` reads `.vscodeignore`, not `.gitignore`, so `.claude/settings.local.json` being git-ignored did nothing to keep it out. Every build up to 2.1.4-bd.5 packaged it, including the absolute local paths in its permission entries. No secrets were exposed, but it was never extension content.
- **The Graph view is testable in the visual test server again.** Its mock `issue.getFull` handler hardcoded `parent: null` and empty `children` / `blocks` / `blocked_by`, overwriting whatever the fixture card carried. `renderGraph()` builds every edge from that response, so the view drew zero edges regardless of the fixture hierarchy — it had never been meaningfully exercised there. The same script gains a `--dataset=showcase` flag that swaps the two deliberately hostile fixture titles (a 200-character overflow case and an XSS probe) for ordinary ones, so the board can be screenshotted without them. Neither change affects the shipped extension; `scripts/` is excluded from the VSIX.

## [2.1.4-bd.5] - 2026-08-16

Fork-only build (`balaji-dutt/Beads-Kanban`), distributed as a GitHub release VSIX rather than through the marketplace. Repackaging of 2.1.4-bd.4; no behaviour changes.

### 🔧 Internal

- **`SHA256SUMS` no longer ends up inside the VSIX.** The release script writes it after `vsce` has packaged, so a copy left by an earlier release — or by `--dry-run`, which packages and checksums before it skips the upload — was picked up as extension content by the following run. 2.1.4-bd.4 shipped with a stale one at `extension/SHA256SUMS`, 40 files instead of 39. Inert, but it meant the release could not be reproduced from a clean checkout of its own tag. The script now clears it before packaging, and `.vscodeignore` excludes both it and `*.vsix`.

## [2.1.4-bd.4] - 2026-08-16

Fork-only build (`balaji-dutt/Beads-Kanban`), distributed as a GitHub release VSIX rather than through the marketplace.

### 🐛 Bug Fixes

- **A missing `bd` executable no longer reports itself as a missing database.** Node emits `spawn bd ENOENT` when `bd` is not on PATH, and the error mapper matched any `ENOENT` first, so a PATH problem came out as "Database file not found — check that the .beads directory exists" and sent debugging into the folder picker. The message that should have appeared was already written but unreachable: it matched `bd: command not found`, a shell phrasing Node never produces, and sat 33 lines below the branch that always won. Spawn failures are now classified first, and against the raw error rather than the path-scrubbed one — an absolute `beadsKanban.bdPath` is rewritten to `[PATH]` before the mapper sees it, so matching on the binary name could not have worked. A spawn `EACCES`/`EPERM` gets its own message too, instead of claiming the database is unreadable.
- **The board finds `.beads` anywhere in the workspace.** It used `workspaceFolders[0]` unconditionally, with no discovery of any kind, so a multi-root workspace worked only when the folder holding `.beads` happened to be listed first, and opening a subfolder of the repository did not work at all. Resolution now prefers the folder chosen through the repository picker, then checks every workspace root in order, then walks upward from each root, and only then falls back to the first root. When several roots qualify the first is used and the rest are named in the output channel.
- **Auto-refresh works for Dolt-backed repositories.** The file watcher globbed `.beads/**/*.{db,sqlite,sqlite3}`. bd 1.x replaced SQLite with Dolt, so such a repository contains no file matching any of those extensions and the watcher had never once fired for one. It now watches the bd-level write signals at the top of `.beads` and the Dolt journal under `<database>/.dolt/noms/`, filtering out the server log, lock and pid files that change constantly on their own. Both patterns are needed: on Windows `bd` runs as a client against a Dolt server hosted elsewhere, and there is no local `dolt/` directory to watch.
- **The repository picker's choice survives a window reload.** The chosen path was written to workspace state under a key nothing ever read, so the comment claiming it was stored "for future sessions" was false and the board reverted to the first workspace folder on every reopen. The value is now read back and given precedence over discovery, and is cleared automatically if that folder loses its `.beads` directory. Switching repositories also rebinds the file watchers, which previously stayed pointed at the old one.

### 🧹 Cleanup

- **Removed the `beadsKanban.doltPath` setting.** It was contributed in `package.json` and read by nothing. The extension has not touched Dolt directly since `better-sqlite3` was dropped — it shells out to `bd`. `beadsKanban.bdPath` is unaffected and still works.

### 🔧 Internal

- **Release tags now point at the code that was built.** `scripts/release-fork-vsix.sh` called `gh release create` without `--target`, so GitHub created the tag on the default branch. Every release so far — bd.1, bd.2 and bd.3 — carries a tag resolving to upstream's `main` rather than to the fork commit the VSIX was packaged from. The published assets were never affected, since they are pinned by sha256.
- **`sanitizeError` has tests.** It had none, and `security.test.ts` carried a comment claiming the functions were not exported, which had never been true. New suites cover the error mapper, the workspace resolver and the watch filter, taking the suite from 387 to 446 passing. The resolver and watch rules live in `src/beadsWorkspace.ts` and `src/beadsWatch.ts` with no `vscode` import, so they are testable without an Extension Development Host.

## [2.1.4-bd.3] - 2026-08-09

Fork-only build (`balaji-dutt/Beads-Kanban`), distributed as a GitHub release VSIX rather than through the marketplace.

### 🐛 Bug Fixes

- **The Pinned, Template and Ephemeral checkboxes now work when editing an issue.** They were missing from `IssueUpdateSchema`, and Zod strips unknown keys, so the values were discarded before reaching `bd` — the boxes looked functional and persisted nothing. Create and read had always handled them; only the update path was blind. `pinned` and `template` are written to issue metadata (where `bd` 1.0+ keeps them, since it dropped the `--pinned`/`--template` flags), and `ephemeral` uses `--ephemeral` with its inverse `--persistent`. Ephemeral is applied in its own `bd` call, because that operation can fail inside `bd` on some databases and would otherwise discard every other field in the same save.
- **The edit dialog can be dismissed again when it has unsaved changes.** Escape, the close button and clicking outside all ran through a guard calling `window.confirm`, which VS Code stubs out in webviews — it returns `false` immediately without showing anything, so the guard could never be satisfied. Confirmation now uses a real VS Code modal. Dirty state is also compared against the values the form was opened with instead of being a one-way flag, so reverting an edit genuinely un-dirties the form; previously typing a character and deleting it left the dialog stuck.
- **The estimate field no longer goes negative when you scroll.** Chromium steps a focused number input on wheel events and the dialog scrolls, so scrolling with the pointer over "Est. Minutes" silently edited it. The input now has `min="0"` and blurs on wheel.
- **Title, assignee and external reference carry the length limits the schema enforces**, so over-long input is prevented rather than rejected at save time. The markdown fields are deliberately left unbounded, since `maxlength` truncates a paste silently.
- **Validation failures read as `field: reason`** instead of dumping the raw Zod issue array as JSON into the notification.

### 🧹 Cleanup

- **Removed the SQLite-era test tooling.** `bd` 1.x dropped SQLite for Dolt, so `scripts/generate-test-db.js` and `scripts/benchmark-loading.js` could no longer produce a database the extension can read. The latter was doubly dead — it required `sql.js`, which was never a dependency. Their tracked benchmark reports and ~220 lines of `TESTING.md` went with them.
- **Deleted two dead duplicates of the board.** `src/webview/editForm.js` (~1000 lines) was imported by nothing and never reached a bundle; `media/board.js` (~2875 lines) was a stale pre-bundling copy that `webview.ts` does not load. A bug in the edit dialog was recently diagnosed against `editForm.js`, which is not the code that runs.
- **Dropped `better-sqlite3`, `@electron/rebuild` and `node-gyp`.** The visual test harness was the last consumer, and the other two existed only to build it. No native modules remain.

### 🔧 Internal

- **The `DaemonBeadsAdapter` integration tests actually run now.** They drive a real `bd` CLI and this repo has no `.beads` database, so all six were skipping. The suite builds a throwaway Dolt database in a temp directory and seeds it. Local runs go from 378 passing / 7 pending to 387 / 1.
- **The visual test harness seeds through the `bd` CLI** instead of hand-writing SQLite tables, so its board is no longer empty. It also now identifies the webview by the `vscode-webview://` scheme: the previous title match caught the workbench, because the checkout directory is called `Beads-Kanban`, and advertised the wrong CDP target.
- CI runs on `integration/bd-fixes`, and `actions/checkout` / `actions/setup-node` moved to v7 to clear the Node 20 runtime deprecation.

## [2.1.4-bd.2] - 2026-08-09

Fork-only build (`balaji-dutt/Beads-Kanban`), distributed as a GitHub release VSIX rather than through the marketplace.

### 🐛 Bug Fixes

- **Editing an issue no longer fails because of an untouched field.** The edit dialog posted every form field on every save, so one oversized field made *any* edit fail validation — unassigning an issue whose `design` held a long plan document was rejected before `bd` was ever invoked. Saves now send only the fields that actually changed. Saving with nothing changed reports "No changes to save" instead of posting a no-op update.
- **Raised the long-text cap from 10,000 to 65,536 characters** for `description`, `acceptance_criteria`, `design`, and `notes` on both `IssueUpdateSchema` and `IssueCreateSchema`. `bd` stores these as `longtext`; the limit was purely client-side. 65,536 is deliberate, not round: these values reach `bd` as single argv entries, and Linux caps one argv entry at 128 KiB (`MAX_ARG_STRLEN`). Comment text is unchanged at 10,000.

### 🔧 Internal

- **`npm test` runs again on macOS.** `@vscode/test-electron` 2.5.2 hardcoded `Contents/MacOS/Electron`, which VS Code renamed to `Code` in 1.110, so every run died with `spawn ... ENOENT` after downloading 300 MB. Bumped to `^3.1.0`, which resolves the executable by product name.
- **Integration tests skip instead of failing when there's no beads database.** `skipIfNoBd` only matched `daemon is not running` and `ENOENT` — wording from before bd 1.0 removed the daemon. bd now reports `no beads database found`, so six `DaemonBeadsAdapter` tests failed on any checkout without a `.beads` directory.
- `scripts/bump-version.js` accepts `X.Y.Z-bd.N` alongside strict `major.minor.patch`. Other pre-release tags are still rejected, since the marketplace refuses them.
- Added `scripts/release-fork-vsix.sh`, which builds the branch/SHA-tagged VSIX, writes `SHA256SUMS`, and cuts the `bd-fixes-v<version>-<sha>` GitHub release. This previously lived in git-excluded `.local/` and did not survive a fresh clone.

## [2.1.4] - 2026-04-24

### 🧹 Cleanup

- **Removed leftover `[DEBUG]` console.log statements** in `src/webview/board.js` that printed the detail-dialog element and a stack trace on every board open and every issue click. These cluttered the DevTools console with no runtime value.
- **Dropped `frame-ancestors 'none'` from the `<meta>` CSP**. Browsers ignore `frame-ancestors` when delivered via a `<meta>` element (it only works in an HTTP response header), so the directive produced a permanent browser warning with no real effect. VS Code webviews are already sandboxed by the host iframe. Added an explanatory comment documenting the intentional omission and removed the two tests that asserted the now-absent string.

### 📦 Marketplace metadata

- Declared `"pricing": "Free"` so the marketplace can show the explicit Free badge.
- Added a `"sponsor"` entry pointing at https://github.com/sponsors/davidcforbes so the listing page surfaces a Sponsor button.

## [2.1.3] - 2026-04-24

### 🐛 Bug Fixes

- **bd CLI 1.0.0 compatibility**: bd 1.0 removed the daemon subsystem and several flags the extension depended on. The Kanban board was failing to connect, every edit threw "unknown flag: --no-daemon", and pinned/template issue creation threw "unknown flag: --pinned".
  - Replaced the `bd info --json` daemon probe (bd 1.0 emits plaintext) with a `bd stats --json` CLI smoke test in `DaemonBeadsAdapter.ensureConnected()`
  - Dropped the `--no-daemon` workaround from `updateIssue` — the flag no longer exists, so every edit was failing
  - Migrated pinned/template persistence from the removed `--pinned`/`--template` flags to `bd update --set-metadata pinned=true` / `template=true`; read paths now pull from `issue.metadata` with a legacy top-level fallback
  - Fixed flag ordering in `addDependency`: `--type` is now emitted before the `--` separator (it was being silently treated as a positional argument, so every user-created dependency fell back to the default `blocks` type)

### 🔧 Removed

- **DaemonManager and the `beadsKanban.showDaemonActions` command**: `bd daemon` no longer exists as a command. The status bar, auto-start, polling, and daemon action menu have been removed. Direct CLI mode is now the only mode.
- Deleted `src/daemonManager.ts` and `src/test/suite/daemon.test.ts`.

## [2.1.1] - 2026-03-28

### Security

- **Fix 3 XSS vulnerabilities**: Added DOMPurify.sanitize() to parentDisplay, advanced metadata, and footer innerHTML assignments in both board.js and editForm.js
- **Fix CLI injection**: Moved --author flag before -- separator in addComment to prevent flag bypass
- **Add Zod validation for table.loadPage**: Previously the only unvalidated message handler; now enforces bounds on sorting, offset, limit, and filter fields
- **Apply IssueIdSchema to dependency fields**: parent_id, blocked_by_ids, children_ids in IssueCreateSchema now use IssueIdSchema instead of z.string().max(100)
- **Sanitize stderr in error messages**: Raw CLI stderr no longer leaks internal paths to the webview
- **Add path validation to setWorkspaceRoot**: Prevents path traversal and control character injection

### Added

- **Configurable CLI paths** (GitHub issue #6): New `beadsKanban.bdPath` and `beadsKanban.doltPath` settings allow specifying absolute paths to the bd and dolt executables for portable setups
- **Visual UI testing framework**: Standalone test server (`scripts/visual-test-server.js`) serves the webview in Chrome for automated visual testing with Chrome DevTools MCP
- **Test data seeder**: `scripts/seed-test-data.sh` creates 53 representative issues covering all visual scenarios
- **Security Rules in CLAUDE.md**: 9 mandatory development guidelines codifying lessons from the security review
- **CI improvements**: Added `npm run lint` step and VSIX artifact verification to GitHub Actions workflow

### Fixed

- **Issue ID validation** (GitHub issue #5, PR #4): IDs with custom prefixes and hierarchical dot-separated suffixes (e.g. `stuff-30m.1.4.9`) are now accepted via shared `ISSUE_ID_PATTERN` constant
- **DaemonManager.spawnAsync timeout**: Added 30-second timeout and 10MB buffer limit matching DaemonBeadsAdapter.execBd safeguards
- **Event listener accumulation**: openDetail no longer stacks markDirty listeners on each call
- **Split-brain detailDirty state**: board.js and editForm.js now share dirty state via window.__editFormDirty
- **Save button double-submit**: Disabled during in-flight postAsync to prevent duplicate issues
- **Concurrent openDetail race**: Generation counter aborts stale dialog population
- **DOM clobbering risk**: btnSave reads scoped to form.querySelector instead of document.getElementById
- **Test correctness**: Fixed tautological assertions in security tests, wrong field names in schema tests, assert.fail caught by own catch block in daemonAdapter tests
- **Mocha UI mode**: Test runner correctly uses tdd mode matching suite()/test() syntax (PR #4)
- **Node.js version**: Dropped Node 18 (EOL), added Node 22, enforced >=20 (PR #4)

## [2.0.6] - 2026-01-20

### ✨ New Features

- **Dependency Graph View**: Visualize issue relationships with interactive dependency graph
  - Third view mode alongside Kanban and Table views
  - Hierarchical BFS-based layout algorithm
  - Visual dependency types: parent-child (green), blocks (red dashed), blocked-by (orange dashed)
  - Node colors by status: ready (yellow), in progress (green), blocked (red), closed (gray)
  - Interactive features: drag nodes, click to edit, zoom/pan controls
  - Focus mode to view specific issue + N levels of dependencies
  - Auto-layout with top-bottom or left-right direction
  - Legend showing node status colors and edge types
  - Sidebar with issue list for quick navigation

### 🐛 Bug Fixes

- **Dependency extraction**: Fixed parent, children, and blocked_by relationships not displaying in edit form
  - Root cause: extractParentDependency was checking wrong field (dependents vs dependencies)
  - Now correctly reads from issue.dependencies for parent and blocker relationships
  - Now correctly reads from issue.dependents for children and blocked issues
- **Graph edge deduplication**: Fixed phantom duplicate arrows in dependency graph
  - Added edge deduplication using Set to track unique edges
  - Each relationship now creates only one edge, even if found in both directions
- **Graph infinite loop**: Fixed concurrent render operations causing browser freeze
  - Added concurrency guard to prevent multiple simultaneous graph renders
  - Proper error handling with try/catch/finally blocks

### 🚀 Performance

- **Extension bundling**: Implemented esbuild bundling for both extension host and webview code
  - Created `scripts/build-extension.js` to bundle all TypeScript sources into single file
  - Extension host: All sources bundled into `out/extension.js` (636 KB)
  - Webview: UI code + Pragmatic Drag and Drop bundled into `out/webview/board.js` (243 KB total)
  - **97% reduction in file count**: 900 files → 31 files
  - **60% reduction in package size**: 2.26 MB → 1.54 MB
  - Faster installation and extension activation time
  - Improved overall performance

### 🔧 Build System

- **Build scripts**: Updated compilation pipeline
  - `npm run build-extension` - Bundle extension host code
  - `npm run build-webview` - Bundle webview code
  - `npm run watch` - Watch mode with automatic rebuilding
  - All dependencies bundled into output files (no node_modules in VSIX)

- **.vscodeignore optimization**: Cleaned up package exclusions
  - Exclude all source files (bundled into out/)
  - Exclude all node_modules (dependencies bundled)
  - Exclude development artifacts (test outputs, reports, workspace files)
  - Keep only essential files for distribution (23 files total)

### 📚 Documentation

- **Extension bundling guide**: Added comprehensive bundling documentation to CLAUDE.md
  - Why bundling is needed (performance benefits)
  - Build scripts configuration and usage
  - Development workflow with bundled code
  - .vscodeignore configuration for optimal packaging
  - External dependencies handling
  - Debugging bundled code with source maps

- **Publishing output reference**: Added before/after comparison showing bundling impact
  - Documented expected vsce package output
  - File count and size improvements

---

## [2.0.5] - 2026-01-17

### 🐛 Bug Fixes

- **Dialog visibility bug**: Fixed Edit Issue dialog being visible on page load even when not open
  - Root cause: CSS `display: flex` was overriding native `<dialog>` hidden behavior
  - Solution: Only apply `display: flex` when dialog has `[open]` attribute

### 🔧 Code Quality

- **ESLint compliance**: Fixed all 152 ESLint errors and warnings
  - Created `.eslintrc.json` with project-specific configuration
  - Replaced all `any` types with `unknown` + proper type assertions
  - Added test file exceptions (allow `any` in test files)
  - Fixed auto-fixable issues (curly braces, semicolons)

- **TypeScript type safety**: Resolved type conflicts between ESLint and TypeScript
  - Added comprehensive type assertions for CLI result handling
  - Implemented proper type guards for dependency extraction
  - Fixed all compilation errors while maintaining ESLint compliance

### 📚 Documentation

- **Marketplace publishing**: Added comprehensive publishing guide to CLAUDE.md
  - Azure DevOps account requirements
  - Personal Access Token (PAT) setup
  - Publishing workflow and checklist
  - Version management requirements

- **Development patterns**: Documented common bug patterns and solutions
  - Dialog visibility issues with native `<dialog>` elements
  - TypeScript vs ESLint type conflict resolution strategies
  - Type assertion patterns for `unknown` to typed object conversions

- **Build instructions**: Added packaging workflow documentation
  - PowerShell requirement for Windows (Git Bash has issues)
  - Version synchronization between package.json and webview.ts
  - Common packaging issues and solutions

### 🔨 Fixed Issues

- Fixed version badge in README.md (1.0.5 → 2.0.5)
- Updated marketplace installation instructions
- Added VS Code version badge

---

## [2.0.0] - 2026-01-16

### 🚨 BREAKING CHANGES

- **Daemon-only architecture**: Extension now requires `bd` CLI daemon for all operations
- Removed `beadsKanban.useDaemonAdapter` configuration option (always daemon mode)
- sql.js adapter and all in-memory SQLite functionality removed

### ✨ Added

- Auto-start daemon functionality when extension loads
- Comprehensive migration guide (MIGRATION.md)
- External dependencies security review documentation (External_Dependencies_Review.md)
- Improved error messaging for daemon connection issues

### 🗑️ Removed

- **sql.js adapter** (~1.7MB) - Complete removal of in-memory SQLite functionality
- **src/beadsAdapter.ts** (~2000 lines) - Removed sql.js-based adapter class
- **uuid** dependency - Completely unused package eliminated
- **@types/uuid** - Type definitions for removed package
- **@types/sql.js** - Type definitions for removed package
- **9 test files** - BeadsAdapter-specific tests no longer applicable
- `beadsKanban.useDaemonAdapter` configuration option
- sql-wasm.wasm file copy from build process

### 📝 Changed

- Extension now always uses DaemonBeadsAdapter for all database operations
- Extension requires workspace folder to be open (improved error handling)
- Updated README.md with daemon requirements and prerequisites section
- Updated CLAUDE.md to remove sql.js references and clarify daemon-only architecture
- Daemon auto-start attempts on extension load if not running
- Improved daemon status messaging and error handling

### 📦 Dependencies

**Removed:**
- sql.js: ^1.13.0 (~1.7MB saved)
- @types/sql.js: ^1.4.9
- uuid: ^10.0.0 (unused)
- @types/uuid: ^10.0.0 (unused)

**Current runtime dependencies (2):**
- dompurify: ^3.3.1 (23KB minified)
- zod: ^4.3.4 (58KB unminified)

**Bundle size reduction:** ~1.7MB

### 🔧 Internal

- Simplified adapter architecture (one adapter instead of two)
- Removed 9 adapter-specific test files
- Updated copy-deps.js script to remove sql-wasm.wasm handling
- Cleaned up extension.ts adapter selection logic

### 📚 Documentation

- Added MIGRATION.md with comprehensive v1.x to v2.0.0 upgrade guide
- Added External_Dependencies_Review.md with security analysis
- Updated README.md with new prerequisites and daemon requirements
- Updated CLAUDE.md with daemon-only architecture documentation

### 🐛 Bug Fixes

- Fixed potential null reference when no workspace folder is open
- Improved daemon connection error messages

---

## [1.0.5] - 2026-01-15

### Fixed

- Missing metadata in VS Code Marketplace "Resources" section
- Simplified `repository` and `bugs` fields in `package.json` for better compatibility
- Removed non-standard `qna` field
- Corrected version badges and documentation links

## [1.0.0] - 2024-01-15

### Added

- Initial release of Beads Kanban (forked from agent.native.activity.layer.beads)
- Visual Kanban board with drag-and-drop functionality
- Table view with sortable columns and filtering
- Dual adapter support (sql.js in-memory and bd daemon)
- Incremental loading for large issue databases (10,000+ issues)
- Column visibility controls in table view
- Multi-column sorting with Shift+Click
- Comprehensive issue editing with all metadata fields
- Markdown support with live preview
- Comment system with author and timestamp
- Label management
- Dependency tracking (parent-child and blocks relationships)
- Pagination controls for table view
- Configurable page sizes and load limits
- GitHub issue templates (bug report and feature request)
- Pull request template
- Contributing guidelines
- Professional documentation and screenshots
- MIT License with proper attribution

### Fixed

- Column picker dropdown positioning in table view
- Missing table controls section (pagination buttons)
- Event listener memory leaks in column picker
- Screenshot file organization in repository

### Changed

- Rebranded from "agent.native.activity.layer.beads" to "Beads Kanban"
- Updated repository URL to <https://github.com/davidcforbes/Beads-Kanban>
- Improved README.md with comprehensive feature documentation
- Enhanced .gitignore patterns for better file organization
- Updated package.json with new branding and metadata

### Deprecated

- `beadsKanban.maxIssues` setting (use `initialLoadLimit` and `pageSize` instead)

## Attribution

This project is a continuation of the original work by [sebcook-ctrl](https://github.com/sebcook-ctrl/agent.native.activity.layer.beads).

When the original author became non-responsive, this repository was established to continue active development and accept community contributions.

---

**Full Changelog**: <https://github.com/davidcforbes/Beads-Kanban/commits/main>
