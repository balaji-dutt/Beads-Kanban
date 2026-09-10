# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that provides a Kanban board interface for issues stored in a `.beads` directory. bd 1.x keeps those issues in Dolt (or JSONL), not SQLite, and the extension never opens the database itself — it shells out to the `bd` CLI daemon for every operation, providing efficient incremental loading and real-time updates. The board uses column-based loading to keep large databases (10,000+ issues) responsive.

## Development Commands

### Build and Watch

- `npm run compile` - Compile TypeScript and copy assets (DOMPurify)
- `npm run watch` - Watch mode for development
- `npm run lint` - Run ESLint on TypeScript files

### Packaging the Extension

**IMPORTANT: Use PowerShell for packaging on Windows**

Git Bash has issues running `vsce package` (silent failures with no output). Always use PowerShell:

```powershell
# In PowerShell (not Git Bash)
vsce package
```

This will:
1. Run `vscode:prepublish` script (which runs `npm run compile`)
2. Compile TypeScript, copy dependencies, and build webview bundle
3. Create `beads-kanban-{version}.vsix` file

**Common Issues:**
- If packaging fails silently in Git Bash, switch to PowerShell
- Ensure you've run `npm run compile` successfully before packaging
- Check that all TypeScript files compile without errors (`tsc -p .`)

### Code Quality

The project uses ESLint with strict TypeScript rules:

- `.eslintrc.json` contains project-specific configuration
- Test files (`.test.ts` and files in `test/`) have relaxed rules (allow `any` types)
- All source code must pass `npm run lint` with no errors
- Use `unknown` type instead of `any` in production code, with proper type assertions

**Type Safety Patterns:**

When replacing `any` types with `unknown` for ESLint compliance:

1. **CLI Result Handling**: Cast results from `execBd()` to expected types:
   ```typescript
   const result = await this.execBd(['info', '--json']);
   const info = result as { daemon_connected?: boolean } | null;
   ```

2. **Object Mapping**: Use type assertions when mapping unknown objects:
   ```typescript
   const issue = rawIssue as Record<string, unknown>;
   const fullCard: FullCard = {
     id: issue.id as string,
     title: (issue.title as string) || '',
     priority: typeof issue.priority === 'number' ? issue.priority : 2,
     // ... other fields
   };
   ```

3. **Array Operations**: Cast arrays before mapping:
   ```typescript
   private async execBd(args: string[]): Promise<unknown> {
     // ... implementation returns unknown
   }

   const issues = (await this.execBd(['list', '--json'])) as Array<Record<string, unknown>>;
   return issues.map(issue => this.mapToFullCard(issue));
   ```

4. **Dependency Extraction**: Type guard patterns for nested structures:
   ```typescript
   private extractParentDependency(issue: Record<string, unknown>): DependencyInfo | undefined {
     if (!issue.dependents || !Array.isArray(issue.dependents)) {
       return undefined;
     }
     for (const d of issue.dependents) {
       const dep = d as Record<string, unknown>;
       if (dep.dependency_type === 'parent-child') {
         return {
           id: dep.id as string,
           title: dep.title as string,
           // ... other fields
         };
       }
     }
     return undefined;
   }
   ```

**Common ESLint Fixes:**

- `no-explicit-any`: Replace `any` with `unknown` + type assertions
- `no-unused-vars`: Remove unused imports, or prefix with `_` if intentionally unused
- `no-case-declarations`: Wrap switch case blocks with braces when declaring variables
- `curly`: Add braces to all control statements (auto-fixable with `eslint --fix`)
- `semi`: Add semicolons (auto-fixable with `eslint --fix`)
- `no-control-regex`: Add `// eslint-disable-next-line no-control-regex` for intentional control character patterns

### Testing

- `npm test` - Run all tests (requires compile first via pretest)
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with c8 coverage
- Press F5 with "Extension Tests" launch config to debug tests

Running specific tests: The test runner uses Mocha with `tdd` UI mode (use `suite()` / `test()`, not `describe()` / `it()`). To run a specific test file or filter by test name, modify `src/test/suite/index.ts` temporarily to use Mocha's `grep` option or change the glob pattern. Test files are in `src/test/suite/*.test.ts`.

**Test quality checklist (apply when writing or reviewing tests):**
- Assertions must test the specific constraint, not pass tautologically
- Test input field names must match the Zod schema field names (`id` not `issueId`)
- When testing "rejects X", confirm the rejection is for the right reason
- Integration tests that depend on `bd` CLI must use `skipIfNoBd` guard for CI

### Running the Extension

- Press F5 in VS Code to launch Extension Development Host
- Use "Beads: Open Kanban Board" command to open the board

## Architecture

### Core Components

Extension Host (TypeScript/Node.js)

- `src/extension.ts` - Entry point; registers commands, creates webview panel, routes messages, enforces read-only mode, and wires file watching
- `src/daemonBeadsAdapter.ts` - Daemon adapter; uses `bd` CLI to read and mutate issues with efficient caching
- `src/beadsWorkspace.ts` - Resolves which workspace folder holds `.beads` (picker choice → root containing `.beads` → upward walk → `roots[0]`). A directory counts only if it holds one of `BEADS_MARKER_ENTRIES` (`metadata.json`, `config.yaml`, `embeddeddolt`, `dolt`) — bare directory existence adopts bd's global `~/.beads`, which is not a repository. The upward walk additionally refuses `$HOME`; opening `$HOME` as a root or picking it still works. No `vscode` import, so it is unit-testable without an Extension Development Host
- `src/beadsWatch.ts` - File-watch globs and deny predicate for auto-refresh. Also `vscode`-free
- `src/sanitizeError.ts` - Maps and scrubs CLI errors before they reach the webview
- `src/types.ts` - Type definitions and Zod schemas
- `src/webview.ts` - Generates webview HTML with CSP and asset URIs

Webview (JavaScript/HTML/CSS)

- `src/webview/board.js` - UI logic source; bundled with Pragmatic Drag and Drop using esbuild
- `src/webview/treeBuilder.ts` - Pure helpers for the Tree view (hierarchy construction, filtering, sibling sort, connector structure); no DOM or vscode API so it is unit-testable, inlined into the board bundle by esbuild
- `out/webview/board.js` - Bundled webview JavaScript with drag-and-drop functionality
- `media/styles.css` - Theme-aware styling
- `media/marked.min.js` - Markdown rendering
- `media/purify.min.js` - DOMPurify for sanitization

### Message Protocol

The extension uses a request/response pattern for webview-extension communication:

WebMsg types (Webview -> Extension)

- `board.load` / `board.refresh` - Request board data
- `board.loadColumn` - Fetch a slice of a column (offset/limit)
- `board.loadMore` - Load the next page for a column
- `issue.create` - Create new issue
- `issue.move` - Drag-and-drop status change
- `issue.update` - Update issue fields
- `issue.addComment` - Add comment
- `issue.addLabel` / `issue.removeLabel` - Manage labels
- `issue.addDependency` / `issue.removeDependency` - Manage relationships
- `issue.addToChat` - Send to VS Code chat
- `issue.copyToClipboard` - Copy issue context
- `state.uiState` - Persist UI state (sort, filters, view mode, etc.) across panel close/reopen. Payload validated by `UIStateSchema`; stored in `context.workspaceState` under key `beadsKanban.uiState`. Fire-and-forget from the webview — `mutation.ok` / `mutation.error` are returned but the webview registers no callback.

ExtMsg types (Extension -> Webview)

- `board.data` - Board data payload (may include `columnData` for incremental loading and `uiState` for restored UI state)
- `board.minimal` - Fast-loading minimal cards (may include `uiState` so first paint reflects saved settings)
- `board.columnData` - Column slice payload for incremental loading
- `mutation.ok` - Success response
- `mutation.error` - Error response with message
- `webview.cleanup` - Cleanup before panel disposal

**Persisted UI state (`state.uiState` / `beadsKanban.uiState`)**

The webview calls `saveState()` on every relevant UI change (sort click, column visibility toggle, column-order reset, view-mode switch). Each call writes to `vscode.setState` for fast in-session round-trips AND posts a `state.uiState` message to the extension, which validates with `UIStateSchema` and writes to `context.workspaceState`. On `board.load` / `board.refresh` (and on `board.loadMinimal` and `repo.select`), the extension reads `workspaceState`, re-validates defensively, and attaches the result as `payload.uiState` so the webview can apply it before first render. Persisted values win over `vscode.getState()`. The workspaceState key is `beadsKanban.uiState`, following the same naming convention as `beadsRepoPath`.

**Tree view state (`treeSort` / `treeExpanded`)**

`UIStateSchema` carries two Tree-view fields. `treeSort` is a `{ id, dir }` sibling-sort spec (`updated_at` | `priority` | `title` | `created_at`; default `updated_at` desc). `treeExpanded` is a record of expansion **overrides** keyed by issue id — only deviations from the depth default (top-level rows expanded, deeper rows collapsed) are stored, so issues that appear after the state was saved still follow the default. The webview's `trimTreeExpanded()` runs inside `saveState()` and keeps every payload inside the schema bounds (max 500 entries, 50-char keys, stale ids dropped) because a payload that fails `safeParse` is discarded wholesale, taking the rest of the persisted UI state with it. `migrateUIState()` needs no awareness of these fields; they are optional and pass through untouched.

**Toolbar filter shape (`topBarFilters`, versioned)**

The `topBarFilters` field of `UIStateSchema` holds the Priority / Type / Status dropdown selections under inclusive-multiselect semantics: each entry is an array of explicitly-checked values, an empty array means "None selected" (no card passes that filter), and the "All" / "Active" preset rows are derived from set-equality against the universe / active subset rather than stored as separate filter values. The companion field `topBarFiltersVersion: 2` stamps payloads written by builds using these semantics. The `migrateUIState()` helper in `src/types.ts` reads any persisted payload missing the version field as the older "empty array = All" shape, expands empty arrays to their full universe (`STATUS_ALL_VALUES`, `PRIORITY_ALL_VALUES`, `TYPE_ALL_VALUES`), and stamps the version. The extension's `readPersistedUIState` runs every raw `workspaceState` payload through `migrateUIState` before `UIStateSchema.safeParse`, so the webview only ever sees the current shape.

### Issue Shape

**The extension never opens the database.** bd 1.x stores issues in Dolt (or JSONL), not SQLite, and there is no file the extension could usefully read — `src/beadsWatch.ts` watches Dolt's internal storage only to detect *that* something changed, never to parse it. Every read and every mutation goes through the `bd` CLI and its `--json` output. There is no SQL layer, no ORM, and no schema owned by this repo.

What matters here is therefore the JSON shape `bd` returns, not a table layout:

- **Issue fields** - id, title, description, status, priority, issue_type, assignee, estimated_minutes, created_at, updated_at, closed_at, external_ref, acceptance_criteria, design, notes, due_at, defer_until, pinned, is_template, ephemeral, event/agent metadata
- **Relationships** - `parent`, `children`, `blocks`, `blocked_by`, each an array of issue references carrying a `dependency_type` of `parent-child` or `blocks`
- **`labels`** - array of strings
- **`comments`** - array of `{ id, author, text, created_at }`

Not every field is present on every command — `bd list` returns a narrower set than `bd show`. See the table under "Data Adapter" below, which is the reason the three-tier load exists.

Readiness and blocking are computed by bd, not by this extension: `bd ready` decides what is unblocked, and `bd show --json` reports `blocked_by_count`. Do not reimplement that logic locally.

### Column Logic

The board displays 4 columns:

1. Ready - status = open and reported ready by bd
2. In Progress - status = in_progress
3. Blocked - status = blocked, or blocked_by_count > 0, or open but not ready
4. Closed - status = closed

Moving cards between columns updates the underlying issue status. The Ready column maps back to open.

**Toolbar filter defaults and semantics**

The three top-bar dropdowns (Priority / Type / Status) use inclusive multi-select: each row's checked state is the source of truth for whether its value passes through `getFilteredCards`. Preset rows ("All" and Status-only "Active") are derived UI — clicking one drives a state-machine transition but the rows themselves do not carry filter state.

State-machine transitions for Status (`src/webview/filterStateMachine.ts`):

| User action | Resulting selection |
|---|---|
| Click "Active" while unchecked | `['open', 'in_progress', 'blocked', 'deferred']` |
| Click "Active" while checked | full universe (switches to All) |
| Click "All" while unchecked | full universe |
| Click "All" while checked | `[]` (clears to None) |
| Toggle individual value | add / remove from the set |

Priority and Type follow the same machine without the "Active" row.

First-load defaults (no persisted state):

- Status → "Active" (mirrors `bd list`, which excludes closed by default).
- Priority → "All".
- Type → "All".

`tombstone` and `pinned` are part of the Status universe ("All" selects them) but **not** part of "Active", so the default view hides them along with closed.

Empty-state messaging is rendered in `#boardEmptyState` above the board:

- `selectedStatuses.length === 0` → "No statuses selected. Use the Status filter to choose what to show."
- Filtered count is zero but the Status filter is non-empty → "No issues match the current filters."

The "Clear Filters" button resets to the first-load defaults (it does not push every checkbox to "All").

### Tree View

The fourth top-level view (`viewMode === 'tree'`, toolbar button between Table and Graph) renders the parent/child hierarchy like `bd list`'s tree output. Rows follow bd-list order, left to right: connector guides, caret, a colored status glyph (`TREE_STATUS_GLYPHS`: ○ Open, ◐ In Progress, ⊘ Blocked, ◌ Deferred, ● Closed, ✕ Tombstone, ◉ Pinned; formatted name via tooltip), a monospace click-to-copy issue id, priority and type pills, then the title (largest element, single-line ellipsis). Only the assignee pill is right-aligned. `renderTree()` in `board.js` renders into `#board` (same container pattern as the Table view, so table-only controls disappear automatically), delegating all structure decisions to the pure module `src/webview/treeBuilder.ts`:

- **Structure** derives from each card's `parent` pointer only; `children[]` arrays are ignored for edge-building, which makes duplicate or dangling child references harmless. A card is a top-level row when it has no parent, its parent id is not in `cardCache` (orphan rule), or its parent edge was severed to break a cycle (deterministic visited-set walk; self-parents and cycles render every card exactly once).
- **Filtering** follows "matches plus full ancestor chains": the displayed tree contains every card that passes `getFilteredCards()` plus all of its ancestors; non-matching ancestors render with `.tree-dimmed` (opacity) as context. Last-sibling/connector decisions are made on the *displayed* tree, so pruned branches never leave dangling guide lines.
- **Expansion** defaults to top-level rows expanded one level, deeper rows collapsed. Carets toggle per-node overrides (persisted via `treeExpanded`, see Message Protocol). While the user has narrowed the board beyond the first-load defaults (search text, or any dropdown changed from Status=Active / Priority=All / Type=All), branches containing matches auto-expand so every matching issue stays visible; stored expansion state is not mutated. The first-load Active default itself does **not** trigger auto-expand.
- **Connectors** are CSS-drawn (not text glyphs): `flattenVisibleRows()` emits per-row `guides: boolean[]` (one vertical passthrough guide per ancestor level that still has later siblings) and `isLast` (elbow vs tee joiner). `.tree-guide-bar` / `.tree-elbow` draw 1px lines colored `var(--vscode-tree-indentGuidesStroke, var(--vscode-widget-border, var(--border)))`. Line continuity relies on `align-self: stretch` and uniform single-line row height — `.tree-title` truncation to one line is load-bearing.
- **Sibling sort** has its own dropdown (independent of the Table sort): Updated (default, desc) / Priority / Title / Created, applied at every level with the hierarchy preserved; ties break by id ascending. Missing priority sorts as 2, matching `getSortedCards`.
- Clicking a row opens `openDetail(card)`; Enter/ArrowUp/ArrowDown/ArrowLeft/ArrowRight provide keyboard navigation.

### Data Adapter

The extension uses the DaemonBeadsAdapter exclusively for all database operations:

- Uses column-based `bd` queries for incremental loading and `bd show --json` for details
- Uses `bd` CLI for mutations (create/update/move/comments/labels/deps)
- Short-lived cache to reduce CLI overhead
- Exposes `getColumnData` / `getColumnCount` for incremental loading paths
- Auto-starts daemon on extension load if not running

**Which fields each command returns**

This asymmetry is the whole reason for the three-tier `MinimalCard` / `EnrichedCard` / `FullCard` split. `bd list` is cheap but omits everything a card badge needs; `bd show` has it all but costs one process per issue. Consult this before adding a field to a card — if it is `bd show`-only, rendering it on the board means an N+1 of CLI calls.

| Field | `bd list` | `bd show` | Used on a card |
|---|---|---|---|
| id, title, status, priority, issue_type | yes | yes | required |
| description | yes | yes | search only (can be large) |
| created_at, updated_at | yes | yes | sorting |
| created_by, closed_at, close_reason | yes | yes | not shown |
| dependency_count | yes | **no** | blocked badge |
| dependent_count | yes | **no** | not shown |
| assignee, estimated_minutes, labels | **no** | yes | badge |
| blocked_by_count, external_ref, pinned | **no** | yes | badge |
| acceptance_criteria, design, notes, due_at, defer_until | **no** | yes | edit dialog only |
| parent, children, blocks, blocked_by, comments | **no** | yes | edit dialog only |

### Input Validation

All mutation messages from the webview MUST be validated with Zod (`src/types.ts`) before use:

- `IssueCreateSchema` / `IssueUpdateSchema`
- `CommentAddSchema` / `LabelSchema` / `DependencySchema`
- `IssueIdSchema` / `ISSUE_ID_PATTERN` - shared regex for issue ID validation (supports custom prefixes and hierarchical dot-separated IDs like `stuff-30m.1.4.9`)
- `BoardLoadColumnSchema` - bounds for incremental loading
- **New handlers** must add their own Zod schema — see Security Rules section

Issue IDs are opaque strings, not necessarily UUIDs. The `bd init` command allows custom project prefixes (e.g., `stuff-`, `proj-`), so validation must not hardcode `beads-`.

### Incremental Loading Architecture

The extension uses column-based incremental loading to support large databases (10,000+ issues) without performance degradation.

**Problem:** Loading all issues at once causes:

- Slow initial load (200+ sequential CLI calls for daemon adapter)
- High memory usage (all issues in memory)
- Slow rendering (thousands of DOM nodes)

**Solution:** Column-based lazy loading:

1. **Initial Load**: Load only visible columns (Ready, In Progress, Blocked) with limited items per column
2. **Lazy Load**: Load Closed column and additional pages only when needed
3. **Pagination**: Load in configurable chunks (default: 100 initial, 50 per page)

**Configuration Settings:**

- `beadsKanban.initialLoadLimit` (default: 100, range: 10-1000) - Issues per column on initial load
- `beadsKanban.pageSize` (default: 50, range: 10-500) - Issues to load when clicking Load More
- `beadsKanban.preloadClosedColumn` (default: false) - Whether to load closed issues initially
- `beadsKanban.autoLoadOnScroll` (default: false) - Auto-load more issues on scroll (future feature)
- `beadsKanban.maxIssues` (DEPRECATED) - Use initialLoadLimit and pageSize instead

**Message Protocol for Incremental Loading:**

New request types:

- `board.loadColumn(column, offset, limit)` - Load specific column chunk
- `board.loadMore(column)` - Load next page for a column

Enhanced response:

- `board.data` now includes `columnData` field with per-column metadata (cards, offset, totalCount, hasMore)
- `board.columnData` response for incremental loads

**Frontend State:**

- Column-based state management (`columnState` per column)
- Tracks loaded ranges, total counts, and hasMore flags
- Load More buttons appear when hasMore is true
- Column headers show "loaded / total" counts

**Backend Support:**
The adapter implements:

- `getColumnData(column, offset, limit)` - Paginated column queries
- `getColumnCount(column)` - Fast count queries

**Backward Compatibility:**

- Old `board.load` still works (loads full board up to maxIssues limit)
- Legacy `maxIssues` setting still respected
- Flat `cards` array included in responses for compatibility

**Migration Guide:**
If you have a custom `maxIssues` setting:

1. Set `initialLoadLimit` to your preferred initial load size (default: 100)
2. Set `pageSize` to your preferred page size (default: 50)
3. Remove or ignore `maxIssues` (will be removed in future version)

Example: If you had `maxIssues: 500`, use:

```json
{
  "beadsKanban.initialLoadLimit": 200,
  "beadsKanban.pageSize": 100,
  "beadsKanban.preloadClosedColumn": true
}
```

### Planned UI Consolidation

The Create New Issue and Edit Issue forms will be consolidated into a single shared form unit to ensure identical fields, validation, and features across both workflows.

## Security Rules

These rules are mandatory for all code changes. Violations have caused real bugs in this codebase.

### Webview HTML Safety

**Rule: Every assignment to element.innerHTML MUST go through DOMPurify.sanitize(html, purifyConfig).**

No exceptions. Even if the values are pre-escaped with escapeHtml(), wrap the final assignment in DOMPurify. This is defense-in-depth: a future refactor that adds HTML tags to escapeHtml-only code would immediately create stored XSS.

**Audit pattern:** Search for `.innerHTML =` and verify every match uses DOMPurify.sanitize().

### CLI Argument Ordering

**Rule: All flags (--flag value) MUST come BEFORE the -- separator in execBd calls.**

The `--` tells the CLI "no more flags follow." Placing --author, --type, etc. after `--` means the CLI treats them as positional arguments, bypassing the injection guard entirely.

```typescript
// WRONG - --author after -- is treated as positional text, not a flag
await this.execBd(['comments', 'add', id, '--', text, '--author', author]);

// CORRECT - flags before --, user content after
await this.execBd(['comments', 'add', id, '--author', author, '--', text]);
```

### Input Validation

**Rule: Every webview message handler MUST validate its payload with a Zod schema before use.**

No handler should extract fields from msg.payload without .safeParse(). This includes new message types like table.loadPage. Copy the validation pattern from adjacent handlers.

**Rule: All issue ID fields in Zod schemas MUST use IssueIdSchema, not z.string().max(N).**

This includes parent_id, blocked_by_ids, children_ids, and any field that accepts an issue ID. The Zod schema is the first line of defense; the adapter's validateIssueId() is defense-in-depth, not the primary guard.

### Subprocess Safety

**Rule: All spawn wrappers MUST have a timeout and output buffer limit.**

The DaemonBeadsAdapter.execBd method has both (30s timeout, 50MB buffer). Any new spawn wrapper must replicate these safeguards. Without them, a hung CLI process leaks memory and stalls the extension host event loop.

### Error Message Sanitization

**Rule: Never embed raw CLI stderr in thrown Error messages.**

Run stderr through sanitizeError() or truncate before embedding. Raw stderr can contain internal paths, database locations, and debug output that leaks to the webview via mutation.error.

### Test Correctness

**Rule: Test assertions must test the specific constraint claimed by the test name.**

- Never use tautological assertions like `assert.ok(x || !x)` — these always pass.
- Verify test input objects use the correct field names matching the Zod schema (e.g., `id` not `issueId`, `otherId` not `dependsOnId`).
- When testing "rejects X", ensure the rejection is for the right reason (not a missing required field).

### Event Listener Hygiene in Webview

**Rule: When reusing DOM elements across multiple openDetail() calls, clean up event listeners before adding new ones.**

Use removeEventListener before addEventListener, or use AbortController signals. The form fields are static HTML reused for every card — each openDetail() must not accumulate listeners.

### Shared State Across Modules

**Rule: A safety-critical variable (like detailDirty) must have a single source of truth.**

Two independent copies of such a variable cause the unsaved-change guard to be bypassed depending on which code path opened the dialog. If a second module ever needs to read dirty state, share one reference (e.g. export a getter/setter) rather than tracking it separately.

This rule earned its place: `src/webview/editForm.js` was a full duplicate of the edit dialog that no longer participated in the build, and its stale `window.__editFormDirty` handshake outlived it. The file has been deleted — the edit dialog lives only in `src/webview/board.js`. Do not reintroduce a parallel copy.

### GitHub Identity for Public Writes

**Rule: any `gh` command that writes a public author to this repo MUST run as `balajidutt`.**

This repo is owned by `balajidutt`. The machine's default active `gh` account is a different one, and that is deliberate — see the note below. Release authors and issue/PR authors are permanent: GitHub provides no way to reassign either after creation.

- **Releases** are already fenced. `scripts/release-fork-vsix.sh` switches to `balajidutt`, verifies the switch took, and restores the previous account through an `EXIT` trap. Do not bypass it by calling `gh release create` directly.
- **Issues and PRs** have no script to hang a guard on. Before `gh issue create`, `gh pr create`, or any comment written from the CLI, run `gh auth switch --user balajidutt` and switch back afterwards. This matters from the moment `bbk-8f2` enables Issues.

Everything else is safe to leave alone. `git push`, `git fetch`, and `bd dolt push` go over SSH via the `github-balajidutt` host alias and never consult `gh` at all, and `gh api` reads carry no author. So the default account stays put rather than being switched globally — the switch is scoped to the operations that leave a public trace.

## Common Bug Patterns

### Dialog Visibility Issues

**Problem**: HTML `<dialog>` element visible when it shouldn't be, even though JavaScript shows `dialog.open === false`.

**Root Cause**: CSS with `display: flex` (or other display values) applied unconditionally overrides the native `<dialog>` hidden behavior.

**Fix**: Use attribute selector to only apply display styles when dialog is actually open:

```css
/* WRONG - always visible */
#detailDialog {
  display: flex;
}

/* CORRECT - only visible when open */
#detailDialog[open] {
  display: flex;
}
```

**Why it happens**: The native `<dialog>` element uses the `[open]` attribute to control visibility. CSS rules that set `display` without checking for `[open]` will override this behavior.

### TypeScript vs ESLint Type Conflicts

**Problem**: Code satisfies ESLint but fails TypeScript compilation after changing `any` to `unknown`.

**Root Cause**: `unknown` requires explicit type assertions before property access, while `any` allows implicit access.

**Solution**: Use type assertions at usage points:

```typescript
// Before (works but fails ESLint)
const result: any = await execBd(['show', id]);
return result.id;

// After (satisfies both ESLint and TypeScript)
const result = await execBd(['show', id]);
const issue = result as { id?: string } | null;
return issue?.id;
```

## Releasing

This fork is **not** on the VS Code Marketplace. It ships as a VSIX attached to a GitHub release on `balajidutt/better-beads-kanban`.

**See [RELEASING.md](RELEASING.md).** That is the only description of the path that applies: how backlog scope maps to a release, the CHANGELOG-first ordering `scripts/bump-version.js` enforces, `npm run release:bump`, and `scripts/release-fork-vsix.sh` for the dry run and the publish.

Two traps worth repeating here, because both have cost time:

- **Do not run `npm run release:package` for a fork release.** That is the Marketplace path. `release-fork-vsix.sh` runs its own verify and package; running both packages twice and can leave a stray VSIX behind.
- **`package.json` and `src/webview.ts` versions must match exactly.** The webview cache-bust query string is keyed on the constant in `webview.ts`. `release:bump` updates both in lockstep — do not edit either by hand.

A full Marketplace publishing runbook used to live here, inherited from upstream along with `PUBLISHING.md`. Both were removed in bbk-vi1: they described a publisher account this fork does not own and a distribution channel it does not use. `git log -- PUBLISHING.md` has the history if it is ever needed.

## Extension Bundling

The extension uses esbuild to bundle both the extension host code and webview code into single files, reducing the total file count from 900+ to under 50.

### Why Bundle?

**Problem:** Without bundling, the extension includes:
- 900+ files (592 JavaScript files from node_modules)
- 2.26 MB VSIX package size
- Slow installation and activation

**Solution:** Bundle extension host and webview code separately:
- Extension host: All TypeScript sources bundled into `out/extension.js`
- Webview: UI code + Pragmatic Drag and Drop bundled into `out/webview/board.js`
- Result: ~40 files, ~1.2 MB VSIX, faster activation

### Build Scripts

**Extension host bundler:** `scripts/build-extension.js`
- Bundles all TypeScript sources (`src/**/*.ts` except webview and tests)
- Entry point: `src/extension.ts`
- Output: `out/extension.js` (single file)
- Platform: Node.js
- External dependencies: `vscode` module (provided by VS Code)

**Webview bundler:** `scripts/build-webview.js` (already exists)
- Bundles webview UI code + Pragmatic Drag and Drop
- Entry point: `src/webview/board.js`
- Output: `out/webview/board.js`
- Platform: Browser
- Format: IIFE (immediately invoked function expression)

### Build Configuration

**package.json scripts:**
```json
{
  "vscode:prepublish": "npm run compile",
  "compile": "npm run build-extension && npm run build-webview && npm run copy-deps",
  "build-extension": "node scripts/build-extension.js",
  "build-webview": "node scripts/build-webview.js",
  "watch": "npm run build-extension -- --watch"
}
```

**Development workflow:**
- `npm run compile` - Build everything (extension + webview)
- `npm run watch` - Watch mode for development (auto-rebuild on file changes)
- `npm run build-extension` - Build extension host only
- `npm run build-webview` - Build webview only

### .vscodeignore Updates

The `.vscodeignore` file is updated to exclude source files and keep only the bundled outputs:
```
src/**              # Exclude source files
out/test/**         # Exclude test outputs
**/*.map            # Exclude source maps (keep for debugging if needed)
node_modules/**     # Most of node_modules excluded
!node_modules/zod/  # Keep zod runtime (if needed)
scripts/**          # Exclude build scripts
```

**Important:** After bundling, the VSIX should include:
- `out/extension.js` - Bundled extension host
- `out/webview/board.js` - Bundled webview
- `media/**` - Static assets (CSS, marked.js, purify.js)
- `images/**` - Icon and README screenshots
- `.github/**` - Issue and PR templates (deliberate; they are small)
- `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`

Documentation shipping to users is **only** `README.md` and `CHANGELOG.md`. Everything else in the root — `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `TESTING.md`, `RELEASING.md`, `SECURITY.md` — is named in `.vscodeignore` and stays out. Adding a new root document means adding a matching line there; the default is to ship, which is how four upstream planning documents ended up inside installed extensions before bbk-vi1.

### External Dependencies

Some dependencies must remain external (not bundled):
- `vscode` - VS Code extension API (provided by host)
- Test frameworks - Only used in development, not in production

Runtime dependencies that ARE bundled:
- `zod` - Used for validation at runtime
- `@atlaskit/pragmatic-drag-and-drop` - Webview drag-and-drop (webview bundle)

### Debugging Bundled Code

Source maps are generated for debugging:
- `out/extension.js.map` - Extension host source map
- `out/webview/board.js.map` - Webview source map

To debug, keep source maps in the VSIX by removing `**/*.map` from `.vscodeignore`.

## Important Notes

- The extension requires `bd` CLI on PATH (or configured via `beadsKanban.bdPath` setting) and auto-starts the daemon on load.
- **Configurable CLI path:** the `beadsKanban.bdPath` setting allows users to specify an absolute path to the `bd` executable, supporting portable setups where it is not on the system PATH. (A `beadsKanban.doltPath` setting existed until 2.1.4-bd.4 and was removed — nothing read it. The extension has not touched Dolt directly since `better-sqlite3` was dropped; it shells out to `bd`.)
- `npm run compile` copies DOMPurify to the media folder via the `copy-deps` script.
- Webview scripts are loaded via CSP nonce; HTML uses inline styles extensively.
- `retainContextWhenHidden: true` keeps webview state when hidden.
- Markdown preview uses marked.js with GFM and DOMPurify sanitization.
- **Webview cache-busting:** The version in `src/webview.ts` must match `package.json` version for proper cache invalidation.
- **Windows packaging:** Always use PowerShell, not Git Bash, for `vsce package` command.
- **Current version:** 2.2.0. This fork is the maintained line; `main` carries the work and tracks `origin/main`. It is not on the VS Code Marketplace — releases ship as a VSIX from this repo's GitHub Releases. The `upstream` remote (davidcforbes) is kept only so a revival would be noticeable; never merge or pull it into `main`.
- **Visual testing:** Run `npm run test:visual-server` to launch the standalone visual test server with mock data in Chrome. Use Chrome DevTools MCP to automate visual validation. Note: Chrome DevTools MCP does NOT work with VS Code's Electron webviews (Puppeteer's `Target.getDevToolsTarget` is unsupported in Electron). The standalone server renders the same webview code in regular Chrome where MCP works. Add `--dataset=showcase` to swap the two deliberately hostile fixture titles (a 200-character overflow case and an XSS probe) for ordinary ones when capturing screenshots.
- **Test data seeding:** Run `bash scripts/seed-test-data.sh` to populate a .beads database with 53 representative issues for testing. Clean with `bash scripts/clean-test-data.sh`.

## Issue tracking

This project uses **bd (beads)** for its own backlog, dogfooding the extension. Issue prefix `bbk-`, embedded Dolt backend, database under `.beads/` (gitignored).

- `bd ready` — available work, respecting blockers
- `bd show <id>` / `bd create` / `bd close <id> --reason "..."`
- `scripts/bd-sync.sh` / `scripts/bd-sync.sh --pull` — cross-machine sync, guarded (see below)

No bead carries a version number. Release scope is expressed as dependency edges into a release bead — see [RELEASING.md](RELEASING.md).

`.beads/` being gitignored does **not** pin the backlog to one machine. The Dolt working files are what stays untracked; the issue *data* syncs to `refs/dolt/data` on the same GitHub remote — a ref namespace that never appears in the working tree. On a second machine: clone, then bare `bd dolt pull` to bootstrap — `scripts/bd-sync.sh` requires a `.beads/` directory that a fresh clone does not have yet, and refuses before reaching the network. Every sync after that goes through the script.

**The Dolt remote is configured separately from the git remote, and has drifted before.** `bd dolt remote list` should show:

```
origin               git+ssh://git@github-balajidutt/balajidutt/better-beads-kanban.git
```

It was found pointing at the pre-`bbk-7lf` owner path, over bare `github.com` instead of the `github-balajidutt` alias — so it resolved through the machine's default SSH identity rather than the scoped one. That kept working, because GitHub redirects renamed repos over SSH and the default key had access, which is exactly why it went unnoticed. There is no `set-url`: fix it with `bd dolt remote remove origin`, then `bd dolt remote add origin <url>`. Dolt shells out to `git`, so `~/.ssh/config` host aliases resolve normally.

Changing that URL leaves litter. Dolt caches each git-protocol remote under `.beads/embeddeddolt/bbk/.dolt/git-remote-cache/<sha256-of-url>/`, so every URL the remote has ever had keeps its own directory — three of them had accumulated by `bbk-s7a`. It is a pure cache, regenerated on the next push or pull, so stale directories are safe to delete once you have matched each one to its URL with `git -C <dir>/repo.git config --get remote.origin.url`.

**Sync through `scripts/bd-sync.sh`, not through `bd dolt push` directly.** This is the repo's guarded sync helper, which is the phrase the global agent instructions key on.

```bash
scripts/bd-sync.sh            # push, and verify refs/dolt/data actually advanced
scripts/bd-sync.sh --pull     # pull, and verify the local head actually moved
scripts/bd-sync.sh --flush    # bd dolt commit first, then push
```

It exists because **`bd dolt push` prints `Push complete.` and exits 0 even when nothing moved** — upstream [gastownhall/beads#5433](https://github.com/gastownhall/beads/issues/5433). Under that bug, writes stay in the Dolt working set and never become commits, so a total failure to sync is indistinguishable from a successful one. The reporter lost 103 issues. The script compares the remote ref before and after and gives that silence an exit code:

| Exit | Meaning |
|---|---|
| 0 | pushed, or verified already up to date |
| 1 | STALL — bd reported a transfer, the ref did not follow |
| 2 | UNVERIFIED — cannot prove either way (no baseline yet, or a concurrent writer) |
| 3 | precondition failed; nothing was pushed |
| 4 | bd itself exited non-zero |

Exit 2 is not a failure. It most often means the state file under `.beads/` has no baseline yet, which is the expected first run on a machine.

**#5433 has two halves, and the ref comparison only sees one of them.** If Dolt commits exist but the push does not move the ref, comparing the ref catches it. If the writes never became commits in the first place, there is genuinely nothing to push — the head does not move, neither ref moves, and every hash the script can see agrees that all is well. That half is caught by a different signal: the script records an issue count and the newest `updated_at` alongside the head, and issue data that changed while the Dolt head stood still is the stall. That check is inert until the first verified push writes a baseline, and it deliberately does not backfill one on the up-to-date path — recording a baseline mid-stall would mask the stall permanently.

Three things about it are load-bearing and easy to undo by accident:

- **It resolves the remote URL from `bd context --json`, never from a remote named `origin`.** The Dolt remote is configured separately and has drifted (see above); hardcoding `origin` would verify a different URL than bd pushes to, which fails either permanently or — worse — silently.
- **It records state only when an advance is attributable to this run**, using the `timestamp` in `refs/heads/__dolt_remote_info__`. "The ref moved, therefore I pushed" is the tempting shortcut and it is a false pass: the other machine may have moved it, after which the next run reports "up to date" over an unpushed local head.
- **It never writes the state file on a path it could not verify.** Every failure mode of that file should cost a spurious exit 2, which is merely annoying. A single write on an unverified path converts it into a silent "up to date" over unsynced data, which is the failure this whole script exists to prevent.

A measured fact worth keeping: a no-op `bd dolt push` leaves `refs/heads/__dolt_remote_info__` alone. That is what makes "info ref moved but `refs/dolt/data` did not" a trustworthy stall signal rather than noise.

`--flush` is opt-in rather than automatic because `bd dolt commit` answers `Nothing to commit.` in exactly the broken state, so it is one of #5433's liars, and because it commits the whole working set — which can include a half-finished write from the Kanban board.

To take over by hand, or on a machine without the script:

```bash
git ls-remote <dolt-url> refs/dolt/data   # note the hash
command bd dolt push
git ls-remote <dolt-url> refs/dolt/data   # confirm it changed
```

**`routing.mode` must stay `maintainer`** in `.beads/config.yaml`. Under `routing.mode: auto`, bd asks `beads.role` whether this machine is a maintainer or a contributor and routes `bd create` writes to `routing.maintainer` or `routing.contributor` accordingly. This machine has `routing.contributor = ~/.beads-planning`, so the wrong answer silently files new issues into a separate planning database with prefix `bktest-`. The symptom is issues coming back with the wrong prefix and `bd list` showing unrelated seed fixtures.

**Verify with `bd config get routing.mode`, not with `bd config list`.** Three layers feed this and only `bd config get` reports the winner:

| Key | Stored in | This repo |
|---|---|---|
| `routing.mode` | `.beads/config.yaml` (YAML-only key; beats the database) | `maintainer` |
| `beads.role` | `.git/config` | `maintainer` |
| `routing.mode`, `routing.contributor`, `sync.remote` | the Dolt database | stale, unreachable |

`bd config list` prints the database rows and does not show a conflicting `config.yaml` value, so it reports `routing.mode = auto` and looks alarming. `bd config show` prints every layer with provenance but does not mark which one wins.

**Do not run `bd config unset routing.mode` to clear the stale database row.** `routing.*` and `sync.*` are YAML-only keys, so `unset` strikes the `config.yaml` line — deleting the pin and leaving the database's `auto` as the effective value. That is the opposite of the intended cleanup, and there is no documented command that removes the database rows for a YAML-only key. They are inert; leave them.

`beads.role` was `contributor` until `bbk-2ik`, inherited from when this was a fork of davidcforbes/Beads-Kanban. It was inert while `routing.mode` stayed `maintainer`, which is exactly why it went unnoticed: it only becomes load-bearing if the `config.yaml` line is ever lost, and then it routes the backlog somewhere else without a word.

### Working in a git worktree

**`bd` does not work from a worktree, and must not be made to.** A worktree only receives tracked files. `.beads/` is gitignored, so a worktree has neither the database nor the `config.yaml` carrying the `routing.mode: maintainer` pin. Every `bd` command there fails with:

```
Error: no beads database found
Hint: run 'bd where' to inspect the resolved workspace, or 'bd init' to create a new database
```

**Do not follow that hint. `bd init` creates a second, empty database inside the worktree** — a silent fork of the backlog that syncs nowhere. Nothing recovers from it automatically.

Run bd against the main checkout instead. Derive the path rather than hardcoding it, so this works from any worktree and on either machine:

```bash
BD_REPO="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
command bd -C "$BD_REPO" ready
```

`--git-common-dir` resolves to the main checkout's `.git` from any linked worktree, so `$BD_REPO` is the main checkout.

Two consequences worth knowing:

- **There is one database, not per-branch state.** Closing an issue on a feature branch closes it immediately and globally, whether or not that branch ever merges. Close when the work is done; reopen if the branch is abandoned.
- **A worktree opened as a single-root window has no Beads repository to find.** It has no `.beads` of its own, and the upward walk will not adopt one: `~/.beads` fails the marker check, and the walk refuses `$HOME` regardless. The board says no Beads repository was found and offers the folder picker. Add the main checkout as a second workspace folder, or pick it.

Merging a worktree branch into `main` is unaffected. No bead data is tracked by git; it travels on `refs/dolt/data` via `scripts/bd-sync.sh`, and refs are shared across worktrees. There is nothing for a merge to conflict on. The script derives the main checkout the same way as the snippet above, so it is safe to run from a worktree.
