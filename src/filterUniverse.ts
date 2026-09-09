// Toolbar filter universe constants. These define which values appear in each
// top-bar dropdown and back the inclusive-multiselect semantics:
//   - selected = []         → "None" (no issues match this filter)
//   - selected = full set   → "All" (the preset row appears checked)
//   - selected = STATUS_ACTIVE_VALUES → "Active" preset (Status only; mirrors `bd list`)
//   - selected = anything else → that explicit subset
//
// This module is the single source of truth for all three universes. It stays
// free of `vscode`, `zod` and the DOM so both bundles can import it: the
// extension host reaches it through src/types.ts and src/webview.ts, and the
// webview through src/webview/board.js. A value added here reaches the filter
// dropdowns, the edit-dialog selects and the persisted-state migration at once.

export const STATUS_ALL_VALUES = [
  'open', 'in_progress', 'blocked', 'deferred', 'closed', 'tombstone', 'pinned'
] as const;
export const STATUS_ACTIVE_VALUES = [
  'open', 'in_progress', 'blocked', 'deferred'
] as const;
// Must cover the full 0..4 range IssueCreateSchema accepts (P4 is bd's
// "backlog" level). A priority missing here cannot be selected, so cards
// carrying it are filtered out of every view.
export const PRIORITY_ALL_VALUES = ['0', '1', '2', '3', '4'] as const;
export const TYPE_ALL_VALUES = ['task', 'bug', 'feature', 'epic', 'chore'] as const;
