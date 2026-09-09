import { z } from 'zod';
import {
  STATUS_ALL_VALUES,
  STATUS_ACTIVE_VALUES,
  PRIORITY_ALL_VALUES,
  TYPE_ALL_VALUES
} from './filterUniverse';

export {
  STATUS_ALL_VALUES,
  STATUS_ACTIVE_VALUES,
  PRIORITY_ALL_VALUES,
  TYPE_ALL_VALUES
};

export type IssueStatus = "open" | "in_progress" | "blocked" | "closed";

export type IssueType = "task" | "bug" | "feature" | "epic" | "chore";

export type BoardColumnKey = "ready" | "open" | "in_progress" | "blocked" | "closed";

export interface IssueRow {
  id: string;
  title: string;
  description: string;
  status: IssueStatus | string;
  priority: number;
  issue_type: string;
  assignee: string | null;
  estimated_minutes: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  external_ref: string | null;
  acceptance_criteria: string;
  design: string;
  notes: string;
  due_at: string | null;
  defer_until: string | null;

  is_ready: number; // 0/1
  blocked_by_count: number; // integer
  pinned: number | null; // 0/1
  is_template: number | null; // 0/1
  ephemeral: number | null; // 0/1

  // Event/Agent metadata
  event_kind: string | null;
  actor: string | null;
  target: string | null;
  payload: string | null;
  sender: string | null;
  mol_type: string | null;
  role_type: string | null;
  rig: string | null;
  agent_state: string | null;
  last_activity: string | null;
  hook_bead: string | null;
  role_bead: string | null;
  await_type: string | null;
  await_id: string | null;
  timeout_ns: number | null;
  waiters: string | null;
}

// 3-Tier Progressive Loading Card Types

/**
 * Tier 1: Minimal card data from fast bd list query (100-300ms for 400 issues)
 * Contains only essential fields for displaying cards in kanban columns
 */
export interface MinimalCard {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  closed_at?: string | null;
  close_reason?: string | null;
  dependency_count: number;
  dependent_count: number;
}

/**
 * Tier 2: Enriched card with optional display enhancement fields
 * Adds labels, assignee, etc. for better UI without full relationship data
 */
export interface EnrichedCard extends MinimalCard {
  assignee?: string | null;
  estimated_minutes?: number | null;
  labels?: string[];
  external_ref?: string | null;
  pinned?: boolean;
  blocked_by_count?: number;
  is_ready?: boolean;

  // Relationships derived from `bd list --json --all` so the kanban card
  // can render the `↳ parent` affordance (and future child / blocker
  // affordances) without a per-card `bd show` round-trip.
  parent?: DependencyInfo;
  children?: DependencyInfo[];
  blocks?: DependencyInfo[];
  blocked_by?: DependencyInfo[];
}

/**
 * Tier 3: Full card with all fields including relationships and comments
 * Loaded on-demand when editing (50ms per issue via bd show)
 */
export interface FullCard extends EnrichedCard {
  acceptance_criteria: string;
  design: string;
  notes: string;
  due_at?: string | null;
  defer_until?: string | null;

  is_ready?: boolean;
  is_template?: boolean;
  ephemeral?: boolean;

  // Event/Agent metadata
  event_kind?: string | null;
  actor?: string | null;
  target?: string | null;
  payload?: string | null;
  sender?: string | null;
  mol_type?: string | null;
  role_type?: string | null;
  rig?: string | null;
  agent_state?: string | null;
  last_activity?: string | null;
  hook_bead?: string | null;
  role_bead?: string | null;
  await_type?: string | null;
  await_id?: string | null;
  timeout_ns?: number | null;
  waiters?: string | null;

  // Relationships
  parent?: DependencyInfo;
  children?: DependencyInfo[];
  blocks?: DependencyInfo[];
  blocked_by?: DependencyInfo[];
  comments?: Comment[];
}

/**
 * Legacy BoardCard interface - maintained for backward compatibility
 * New code should use MinimalCard/EnrichedCard/FullCard hierarchy
 */
export interface BoardCard {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string | null;
  estimated_minutes?: number | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  external_ref?: string | null;
  acceptance_criteria: string;
  design: string;
  notes: string;
  due_at?: string | null;
  defer_until?: string | null;

  is_ready: boolean;
  blocked_by_count: number;
  labels: string[];
  pinned?: boolean;
  is_template?: boolean;
  ephemeral?: boolean;

  // Event/Agent metadata
  event_kind?: string | null;
  actor?: string | null;
  target?: string | null;
  payload?: string | null;
  sender?: string | null;
  mol_type?: string | null;
  role_type?: string | null;
  rig?: string | null;
  agent_state?: string | null;
  last_activity?: string | null;
  hook_bead?: string | null;
  role_bead?: string | null;
  await_type?: string | null;
  await_id?: string | null;
  timeout_ns?: number | null;
  waiters?: string | null;

  // Relationships
  parent?: DependencyInfo;
  children?: DependencyInfo[];
  blocks?: DependencyInfo[];
  blocked_by?: DependencyInfo[];
  comments?: Comment[];
}

export interface DependencyInfo {
  id: string;
  title: string;
  created_at?: string;
  created_by?: string;
  metadata?: string;
  thread_id?: string;
}

export interface Comment {
  id: number;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

export interface BoardColumn {
  key: BoardColumnKey;
  title: string;
}

export interface BoardData {
  columns: BoardColumn[];
  cards?: BoardCard[];  // Optional - not needed when using columnData
  // Enhanced fields for incremental loading (optional for backward compat)
  columnData?: ColumnDataMap;
  // Read-only mode flag - when true, webview should disable all mutation controls
  readOnly?: boolean;
  // Persisted UI state from context.workspaceState (sort, filters, view mode, etc.).
  // When present, the webview applies these on receipt, taking precedence over
  // vscode.getState() so settings survive panel close/reopen.
  uiState?: UIState;
}

// Helper types for incremental loading
export interface ColumnLoadState {
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
}

export interface ColumnData extends ColumnLoadState {
  cards: BoardCard[];
}

export type ColumnDataMap = Record<BoardColumnKey, ColumnData>;

// Issue ID format: [project.]prefix-suffix (e.g. beads-abc, smth-abc.3, my-org.beads-xyz)
// Alphanumeric segments separated by dots/underscores/hyphens; at least one hyphen required.
// Prevents consecutive special characters, path traversal, XSS, and command injection.
export const ISSUE_ID_PATTERN = /^([a-z0-9]+([._-][a-z0-9]+)*\.)?[a-z0-9]+-[a-z0-9]+([._-][a-z0-9]+)*$/i;

// Zod validation schemas for runtime message validation
export const IssueIdSchema = z.string().regex(
  ISSUE_ID_PATTERN,
  'Invalid issue ID format - must match pattern: prefix-suffix'
);
const BoardColumnKeySchema = z.enum(['ready', 'open', 'in_progress', 'blocked', 'closed']);

// Long-text cap: 65536. These fields reach bd as single argv entries
// (--description/--acceptance/--design/--notes in DaemonBeadsAdapter), and Linux
// caps one argv entry at 128 KiB (MAX_ARG_STRLEN). 65536 ASCII chars is 65536
// bytes; all-2-byte UTF-8 lands exactly at the limit. Raising this further trades
// a clean validation error for a spawn-time E2BIG.
const LONG_TEXT_MAX = 65536;

export const IssueUpdateSchema = z.object({
  id: IssueIdSchema,
  updates: z.object({
    title: z.string().max(500).optional(),
    description: z.string().max(LONG_TEXT_MAX).optional(),
    status: z.enum(['open', 'in_progress', 'blocked', 'closed']).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    issue_type: z.enum(['task', 'bug', 'feature', 'epic', 'chore']).optional(),
    assignee: z.string().max(100).nullable().optional(),
    estimated_minutes: z.number().int().min(0).nullable().optional(),
    acceptance_criteria: z.string().max(LONG_TEXT_MAX).optional(),
    design: z.string().max(LONG_TEXT_MAX).optional(),
    notes: z.string().max(LONG_TEXT_MAX).optional(),
    external_ref: z.string().max(200).nullable().optional(),
    due_at: z.union([z.string().datetime(), z.null()]).optional(),
    defer_until: z.union([z.string().datetime(), z.null()]).optional(),
    // Present in IssueCreateSchema from the start; missing here until now, so
    // Zod stripped them and the edit dialog's checkboxes never persisted.
    pinned: z.boolean().optional(),
    is_template: z.boolean().optional(),
    ephemeral: z.boolean().optional()
  })
});

export const IssueCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(LONG_TEXT_MAX).optional(),
  status: z.enum(['open', 'in_progress', 'blocked', 'closed']).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  issue_type: z.enum(['task', 'bug', 'feature', 'epic', 'chore']).optional(),
  assignee: z.string().max(100).nullable().optional(),
  estimated_minutes: z.number().int().min(0).nullable().optional(),
  acceptance_criteria: z.string().max(LONG_TEXT_MAX).optional(),
  design: z.string().max(LONG_TEXT_MAX).optional(),
  notes: z.string().max(LONG_TEXT_MAX).optional(),
  external_ref: z.string().max(200).nullable().optional(),
  due_at: z.union([z.string().datetime(), z.null()]).optional(),
  defer_until: z.union([z.string().datetime(), z.null()]).optional(),
  labels: z.array(z.string().max(100)).optional(),
  pinned: z.boolean().optional(),
  is_template: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  parent_id: IssueIdSchema.optional(),
  blocked_by_ids: z.array(IssueIdSchema).optional(),
  children_ids: z.array(IssueIdSchema).optional()
});

export const SetStatusSchema = z.object({
  id: IssueIdSchema,
  status: z.enum(['open', 'in_progress', 'blocked', 'closed'])
});

export const CommentAddSchema = z.object({
  id: IssueIdSchema,
  text: z.string().min(1).max(10000),
  author: z.string().max(100)
});

export const LabelSchema = z.object({
  id: IssueIdSchema,
  label: z.string().min(1).max(100)
});

export const DependencySchema = z.object({
  id: IssueIdSchema,
  otherId: IssueIdSchema,
  type: z.enum(['blocks', 'parent-child']).optional()
});

// Schemas for incremental loading messages
export const BoardLoadColumnSchema = z.object({
  column: BoardColumnKeySchema,
  offset: z.number().int().min(0).max(5000), // Prevent DoS from excessive offset values
  limit: z.number().int().min(1).max(500)
});

export const BoardLoadMoreSchema = z.object({
  column: BoardColumnKeySchema
});

// Persisted UI state — mirrors the fields the webview's saveState() writes today.
// Used for cross-session persistence via context.workspaceState (per-workspace).
// tableFilters shape is intentionally permissive so future filter changes can land
// without breaking persisted values stored by an older build.
export const UIStateSchema = z.object({
  viewMode: z.enum(['kanban', 'table', 'graph', 'tree']).optional(),
  collapsedColumns: z.array(z.string().max(50)).max(20).optional(),
  tableSorting: z.array(z.object({
    id: z.string().max(50),
    dir: z.enum(['asc', 'desc'])
  })).max(5).optional(),
  tableColumnVisibility: z.record(z.string().max(50), z.boolean()).optional(),
  tableColumnOrder: z.array(z.string().max(50)).max(50).optional(),
  tableFilters: z.record(z.string().max(50), z.unknown()).optional(),
  // Toolbar dropdown selections (Priority / Type / Status). Each entry is the
  // array of explicitly-checked values under inclusive-multiselect semantics:
  // an empty array means "None selected" (no issues match), and the "All" /
  // "Active" preset rows are derived state, not separate filter values.
  topBarFilters: z.object({
    priority: z.array(z.string().max(20)).max(10).optional(),
    type: z.array(z.string().max(50)).max(20).optional(),
    status: z.array(z.string().max(50)).max(20).optional()
  }).optional(),
  // Version stamp for the topBarFilters shape. Version 1 (the field absent)
  // used an empty filter array as the sentinel for "All"; version 2 shares the
  // current semantics but predates P4 in the priority universe. migrateUIState()
  // upgrades both before they reach the webview.
  topBarFiltersVersion: z.literal(3).optional(),
  // Tree view sibling-sort spec. Sorting applies within each parent's
  // children; the hierarchy itself is never reordered.
  treeSort: z.object({
    id: z.enum(['updated_at', 'priority', 'title', 'created_at']),
    dir: z.enum(['asc', 'desc'])
  }).optional(),
  // Tree view expansion overrides, keyed by issue id. Only deviations from
  // the depth-based default (top-level rows expanded, deeper rows collapsed)
  // are stored, so issues that appear after the state was saved still follow
  // the default. The webview trims this record before sending (stale ids,
  // redundant entries, size cap) so a stored payload can never fail this
  // validation and take the rest of the persisted UI state down with it.
  treeExpanded: z.record(z.string().max(50), z.boolean())
    .refine(rec => Object.keys(rec).length <= 500, {
      message: 'treeExpanded must have at most 500 entries'
    })
    .optional()
});

export type UIState = z.infer<typeof UIStateSchema>;

// The priority universe as version 2 knew it. Frozen on purpose: it is the
// yardstick for recognising a stored "All" selection from that era, so it must
// not track later additions to PRIORITY_ALL_VALUES.
const PRIORITY_V2_VALUES: readonly string[] = ['0', '1', '2', '3'];

// Upgrade a persisted UI-state payload to the current topBarFilters shape.
//
// Version 1 (no version stamp) used an empty filter array as a sentinel for
// "All selected", where the current shape reads an empty array as "None
// selected". Left alone, a workspace persisted by such a build renders an
// empty board the first time the user opens it after upgrading.
//
// Version 2 shares the current semantics but predates P4 in the priority
// universe. "All" is derived by set-equality, so a stored ['0','1','2','3']
// now reads as an explicit 4-of-5 subset and keeps P4 hidden. Widening it is
// safe because P4 had no checkbox then, so that exact set can only have meant
// "All".
//
// Behavior:
//   - Non-object input → returned as-is (defensive; safeParse will reject).
//   - topBarFiltersVersion === 3 → returned as-is (already current).
//   - Version 1 only → each empty array under topBarFilters is expanded to the
//     corresponding full universe.
//   - Versions 1 and 2 → a priority selection equal to the version 2 universe
//     is widened to PRIORITY_ALL_VALUES. A proper subset and an empty array
//     are deliberate choices and are left alone.
//   - topBarFiltersVersion: 3 is stamped.
//
// Pure; does not mutate the input.
export function migrateUIState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return raw; }
  const state = raw as Record<string, unknown>;
  if (state.topBarFiltersVersion === 3) { return state; }

  const result: Record<string, unknown> = { ...state };
  const topBar = state.topBarFilters;
  if (topBar && typeof topBar === 'object' && !Array.isArray(topBar)) {
    const tb = topBar as Record<string, unknown>;
    const migratedTopBar: Record<string, unknown> = { ...tb };
    const expandIfEmpty = (key: string, universe: readonly string[]): void => {
      const value = migratedTopBar[key];
      if (Array.isArray(value) && value.length === 0) {
        migratedTopBar[key] = [...universe];
      }
    };
    if (state.topBarFiltersVersion !== 2) {
      expandIfEmpty('priority', PRIORITY_ALL_VALUES);
      expandIfEmpty('type', TYPE_ALL_VALUES);
      expandIfEmpty('status', STATUS_ALL_VALUES);
    }
    const priority = migratedTopBar.priority;
    if (Array.isArray(priority) && setEquals(priority, PRIORITY_V2_VALUES)) {
      migratedTopBar.priority = [...PRIORITY_ALL_VALUES];
    }
    result.topBarFilters = migratedTopBar;
  }
  result.topBarFiltersVersion = 3;
  return result;
}

function setEquals(a: readonly unknown[], b: readonly string[]): boolean {
  if (a.length !== b.length) { return false; }
  const seen = new Set(a);
  return seen.size === b.length && b.every(v => seen.has(v));
}

export const TableLoadPageSchema = z.object({
  filters: z.object({
    search: z.string().max(200).optional(),
    priority: z.string().max(10).optional(),
    type: z.string().max(50).optional(),
    status: z.string().max(50).optional(),
    assignee: z.string().max(100).optional(),
    labels: z.array(z.string().max(100)).max(20).optional()
  }).optional(),
  sorting: z.array(z.object({ id: z.string().max(50), dir: z.enum(['asc', 'desc']) })).max(5).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  limit: z.number().int().min(1).max(500).optional()
});

// Graph View Types
export interface GraphNode {
  id: string;
  card: EnrichedCard | FullCard;
  x: number;
  y: number;
  layer: number; // BFS depth level
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'parent-child' | 'blocks' | 'blocked-by';
}

export interface GraphViewState {
  nodePositions?: Record<string, { x: number; y: number }>;
  focusMode: boolean;
  focusDepth: number;
  direction: 'TB' | 'LR';
  zoom: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphLayoutOptions {
  direction?: 'TB' | 'LR';
  nodeWidth?: number;
  nodeHeight?: number;
  horizontalSpacing?: number;
  verticalSpacing?: number;
  focusMode?: boolean;
  focusNodeId?: string;
  focusDepth?: number;
}

/**
 * Render a Zod failure as something a user can act on.
 *
 * `error.message` is a JSON dump of the issue array, which reaches the webview
 * toast verbatim and reads like a stack trace. This flattens it to
 * `field: reason`, dropping the `updates` wrapper from the path since it is an
 * implementation detail of the message envelope, not a field the user sees.
 */
export function describeValidationError(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const field = issue.path.filter(segment => segment !== 'updates').join('.');
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
