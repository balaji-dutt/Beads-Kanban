// Webview side
import { draggable } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { GraphView } from './graph-view.js';
import { buildRelationshipBadges } from './cardRelationships';
import {
    nextFilterSelection,
    computeFilterLabel,
    isPresetChecked,
    selectionEquals,
    formatStatusValue,
    formatTypeValue,
    formatPriorityValue
} from './filterStateMachine';
import {
    STATUS_ALL_VALUES,
    STATUS_ACTIVE_VALUES,
    PRIORITY_ALL_VALUES,
    TYPE_ALL_VALUES
} from '../filterUniverse';
import {
    buildDisplayTree,
    flattenVisibleRows,
    defaultExpanded,
    DEFAULT_TREE_SORT
} from './treeBuilder';

const vscode = acquireVsCodeApi();

const boardEl = document.getElementById("board");
const refreshBtn = document.getElementById("refreshBtn");
const newBtn = document.getElementById("newBtn");
const repoMenuBtn = document.getElementById("repoMenuBtn");
const toastEl = document.getElementById("toast");

const detDialog = document.getElementById("detailDialog");
const detTitle = document.getElementById("detTitle");
const detDesc = document.getElementById("detDesc");
const detMeta = document.getElementById("detMeta");
const addToChatBtn = document.getElementById("addToChatBtn");
const copyContextBtn = document.getElementById("copyContextBtn");

const filterPriorityBtn = document.getElementById("filterPriorityBtn");
const filterPriorityLabel = document.getElementById("filterPriorityLabel");
const filterPriorityDropdown = document.getElementById("filterPriorityDropdown");
const filterTypeBtn = document.getElementById("filterTypeBtn");
const filterTypeLabel = document.getElementById("filterTypeLabel");
const filterTypeDropdown = document.getElementById("filterTypeDropdown");
const filterStatusBtn = document.getElementById("filterStatusBtn");
const filterStatusLabel = document.getElementById("filterStatusLabel");
const filterStatusDropdown = document.getElementById("filterStatusDropdown");
const filterSearch = document.getElementById("filterSearch");
const clearFiltersBtn = document.getElementById("clearFiltersBtn");

// Global unhandled promise rejection handler
// Prevents webview from becoming unresponsive due to uncaught rejections (e.g., postAsync timeouts)
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  toast('An error occurred. Please try again.', 'Refresh', () => location.reload());
  event.preventDefault(); // Prevent default browser error handling
});

// Set up event delegation for card interactions
// This prevents memory leaks from re-attaching listeners on every render
function setupBoardEventDelegation() {
    if (!boardEl) return;

    let selectedCard = null;

    // Handle single click events on cards - highlight/select only
    boardEl.addEventListener('click', (e) => {
        // Find the closest .card element
        const cardEl = e.target.closest('.card');
        if (!cardEl) return;

        const cardId = cardEl.dataset.id;
        if (!cardId) return;

        // Remove previous selection
        if (selectedCard) {
            selectedCard.classList.remove('selected');
        }

        // Highlight the clicked card
        cardEl.classList.add('selected');
        selectedCard = cardEl;
        cardEl.focus(); // Focus for keyboard navigation
    });

    // Handle double-click events on cards - open edit form
    boardEl.addEventListener('dblclick', (e) => {
        // Find the closest .card element
        const cardEl = e.target.closest('.card');
        if (!cardEl) return;

        const cardId = cardEl.dataset.id;
        if (!cardId) return;

        // Look up the card from cardCache
        const card = cardCache.get(cardId);
        if (!card) {
            console.warn('Card not found in cache:', cardId);
            return;
        }

        openDetail(card);
    });

    // Handle keyboard events on cards (Enter opens edit form)
    boardEl.addEventListener('keydown', (e) => {
        // Only handle if target is a card
        if (!e.target.classList.contains('card')) return;

        if (e.key === 'Enter') {
            e.preventDefault();

            const cardId = e.target.dataset.id;
            if (!cardId) return;

            const card = cardCache.get(cardId);
            if (!card) {
                console.warn('Card not found in cache:', cardId);
                return;
            }

            openDetail(card);
        }
    });
}

// Initialize event delegation
setupBoardEventDelegation();

// Inclusive-multiselect top-bar filter dropdowns (Priority / Type / Status).
//
// Source of truth: the `checked` state of the value rows (rows without a
// `data-preset` attribute). Preset rows ("All" / "Active") are derived UI —
// their checked state mirrors set-equality of the current selection against
// the corresponding universe / subset.
//
// State-machine transitions live in src/webview/filterStateMachine.ts so
// they can be unit-tested without a DOM. The values themselves live in
// src/filterUniverse.ts, shared with the extension host so the dropdown rows
// generated there and the selections read here cannot diverge. The code below
// is the glue that reads/writes checkboxes and labels.

const STATUS_UNIVERSE = {
    prefix: 'Status',
    allValues: STATUS_ALL_VALUES,
    activeValues: STATUS_ACTIVE_VALUES,
    formatValue: formatStatusValue
};
const PRIORITY_UNIVERSE = {
    prefix: 'Priority',
    allValues: PRIORITY_ALL_VALUES,
    formatValue: formatPriorityValue
};
const TYPE_UNIVERSE = {
    prefix: 'Type',
    allValues: TYPE_ALL_VALUES,
    formatValue: formatTypeValue
};

// Read currently-checked *value* rows (string values) for a dropdown. Preset
// rows are skipped via the data-preset attribute.
function readSelectedStrings(dropdown) {
    if (!dropdown) { return []; }
    const boxes = dropdown.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(boxes)
        .filter(cb => !cb.dataset.preset && cb.value !== '')
        .map(cb => cb.value);
}

// Public getters consumed by getFilteredCards / renderTable / renderGraph.
// Priority returns numbers for compatibility with card.priority comparisons.
function getSelectedPriorities() {
    return readSelectedStrings(filterPriorityDropdown).map(v => parseInt(v, 10));
}

function getSelectedTypes() {
    return readSelectedStrings(filterTypeDropdown);
}

function getSelectedStatuses() {
    return readSelectedStrings(filterStatusDropdown);
}

// Write the dropdown's checkbox state from a selected-values array. Both the
// value rows and the preset rows are updated; preset rows are derived from
// set-equality against the universe / active subset.
function writeSelection(dropdown, universe, selected) {
    if (!dropdown) { return; }
    const selectedSet = new Set(selected);
    const boxes = dropdown.querySelectorAll('input[type="checkbox"]');
    boxes.forEach(cb => {
        const preset = cb.dataset.preset;
        if (preset === 'all') {
            cb.checked = isPresetChecked(selected, 'all', universe);
        } else if (preset === 'active') {
            cb.checked = isPresetChecked(selected, 'active', universe);
        } else if (cb.value !== '') {
            cb.checked = selectedSet.has(cb.value);
        }
    });
}

function updatePriorityLabel() {
    if (!filterPriorityLabel) { return; }
    filterPriorityLabel.textContent = computeFilterLabel(
        readSelectedStrings(filterPriorityDropdown),
        PRIORITY_UNIVERSE
    );
}

function updateTypeLabel() {
    if (!filterTypeLabel) { return; }
    filterTypeLabel.textContent = computeFilterLabel(
        readSelectedStrings(filterTypeDropdown),
        TYPE_UNIVERSE
    );
}

function updateStatusLabel() {
    if (!filterStatusLabel) { return; }
    filterStatusLabel.textContent = computeFilterLabel(
        readSelectedStrings(filterStatusDropdown),
        STATUS_UNIVERSE
    );
}

// Handle a click on any checkbox in a filter dropdown.
//
// Subtle ordering: the browser flips a checkbox's `checked` attr BEFORE
// firing `change`, so reading the value rows here gives the post-click DOM
// state. For an individual-value click that's exactly the new selection
// (the browser has already done the add/remove). For a preset row click
// the value rows weren't touched by the browser, so the post-click DOM
// state still IS the pre-click selection — which is what the state-machine
// table needs to evaluate transitions like "All checked → clear".
function handleFilterClick(dropdown, universe, updateLabel, checkbox) {
    const preset = checkbox.dataset.preset;
    let next;
    if (preset === 'all' || preset === 'active') {
        // Pre-click selection: value rows are unaffected by a preset click.
        const before = readSelectedStrings(dropdown);
        next = nextFilterSelection(before, { kind: 'preset', preset }, universe);
    } else {
        // Post-click selection IS the new selection. Reorder to universe
        // order for deterministic persistence.
        const after = new Set(readSelectedStrings(dropdown));
        next = universe.allValues.filter(v => after.has(v));
    }
    writeSelection(dropdown, universe, next);
    updateLabel();
    debouncedRender();
    saveState();
}

function wireFilterDropdown(btn, dropdown, universe, updateLabel) {
    if (!btn || !dropdown) { return; }
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('hidden');
    });
    // Single delegated listener — picks up clicks on the input element (the
    // browser fires `change` after the checked attribute flips, but we use
    // `change` here so keyboard activation works the same as mouse clicks).
    dropdown.addEventListener('change', (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') { return; }
        handleFilterClick(dropdown, universe, updateLabel, target);
    });
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
            dropdown.classList.add('hidden');
        }
    });
    dropdown.addEventListener('click', (e) => { e.stopPropagation(); });
}

wireFilterDropdown(filterPriorityBtn, filterPriorityDropdown, PRIORITY_UNIVERSE, updatePriorityLabel);
wireFilterDropdown(filterTypeBtn, filterTypeDropdown, TYPE_UNIVERSE, updateTypeLabel);
wireFilterDropdown(filterStatusBtn, filterStatusDropdown, STATUS_UNIVERSE, updateStatusLabel);

// Apply the first-load defaults: Status → Active, Priority → All, Type → All.
// Called once at boot before persisted state arrives (so persisted state
// still wins) and again by the Clear Filters button.
function initFilterDefaults() {
    writeSelection(filterStatusDropdown, STATUS_UNIVERSE, [...STATUS_ACTIVE_VALUES]);
    writeSelection(filterPriorityDropdown, PRIORITY_UNIVERSE, [...PRIORITY_ALL_VALUES]);
    writeSelection(filterTypeDropdown, TYPE_UNIVERSE, [...TYPE_ALL_VALUES]);
    updateStatusLabel();
    updatePriorityLabel();
    updateTypeLabel();
}

initFilterDefaults();

const viewKanbanBtn = document.getElementById("viewKanbanBtn");
const viewTableBtn = document.getElementById("viewTableBtn");
const viewGraphBtn = document.getElementById("viewGraphBtn");
const viewTreeBtn = document.getElementById("viewTreeBtn");

// Graph view elements
const dependencyDiagram = document.getElementById("dependencyDiagram");
const focusModeToggle = document.getElementById("focusModeToggle");
const focusDepthInput = document.getElementById("focusDepth");
const graphDirectionSelect = document.getElementById("graphDirection");
const autoLayoutBtn = document.getElementById("autoLayoutBtn");
const resetLayoutBtn = document.getElementById("resetLayoutBtn");
const centerViewBtn = document.getElementById("centerViewBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const nodeCountEl = document.getElementById("nodeCount");
const edgeCountEl = document.getElementById("edgeCount");

// Column-based state for incremental loading
let columns = [];
let columnState = {
  ready: { cards: [], offset: 0, totalCount: 0, hasMore: false, loading: false },
  in_progress: { cards: [], offset: 0, totalCount: 0, hasMore: false, loading: false },
  blocked: { cards: [], offset: 0, totalCount: 0, hasMore: false, loading: false },
  closed: { cards: [], offset: 0, totalCount: 0, hasMore: false, loading: false }
};

// Legacy boardData for backward compatibility
let boardData = null;
let readOnly = false; // Read-only mode flag from extension
let detailDirty = false;
let openDetailGeneration = 0;
function markDetailDirty() { detailDirty = true; }

// Snapshot of the edit form as loaded, used both to diff on save and to decide
// whether closing would actually discard anything. Module-scoped because the
// close handlers live outside openDetail.
let editBaselineValues = null;

// Phase 2: Client-side card cache for fast filtering/sorting
// Maps card ID to card data (MinimalCard, EnrichedCard, or FullCard)
const cardCache = new Map();

// Track which tier each card is loaded to: 'minimal' | 'enriched' | 'full'
// This prevents redundant loads when we already have the data
const cardStateLevel = new Map();

// Table view pagination state (server-side)
let tablePaginationState = {
    currentPage: 0,
    pageSize: 100, // Configurable page size
    totalCount: 0,
    cards: [],
    loading: false
};

// Store column picker document listener for cleanup
let columnPickerDocListener = null;

// Store pagination listeners for cleanup to prevent memory leaks
let pageSizeChangeListener = null;
let tablePrevPageListener = null;
let tableNextPageListener = null;
let resetTableColumnsListener = null;

// Debounce utility for performance optimization
function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

/**
 * Whether the edit form differs from what was loaded into it.
 *
 * markDetailDirty is one-way - any keystroke sets it and only a successful save
 * clears it - so typing a character and deleting it used to leave the dialog
 * permanently "dirty". Comparing against the baseline snapshot instead means
 * reverting an edit genuinely un-dirties the form.
 */
function isEditFormDirty() {
    if (!detDialog) { return false; }
    const form = detDialog.querySelector("form");
    if (!form || !editBaselineValues) { return detailDirty; }
    try {
        return Object.keys(diffEditFormValues(editBaselineValues, readEditFormValues(form))).length > 0;
    } catch (_e) {
        return detailDirty;
    }
}

/**
 * Ask the extension host to confirm discarding unsaved edits.
 *
 * window.confirm is stubbed out in VS Code webviews: it returns false straight
 * away without showing anything. This guard therefore could never be satisfied,
 * so a dialog with unsaved changes could not be closed by Escape or by clicking
 * outside it at all - the only way out was to revert the edit and save.
 *
 * Resolves false on timeout, which keeps the dialog open rather than silently
 * discarding work.
 */
function confirmDiscard() {
    return new Promise((resolve) => {
        const reqId = requestId();
        const timeoutId = setTimeout(() => {
            if (pendingRequests.has(reqId)) {
                pendingRequests.delete(reqId);
                resolve(false);
            }
        }, 30000);
        pendingRequests.set(reqId, { resolve, timeoutId });
        vscode.postMessage({ type: "ui.confirmDiscard", requestId: reqId });
    });
}

async function requestDetailClose() {
    if (!isEditFormDirty()) {
        detDialog.close();
        return;
    }
    if (await confirmDiscard()) {
        detailDirty = false;
        editBaselineValues = null;
        detDialog.close();
    }
}

detDialog.addEventListener("cancel", (event) => {
    if (!isEditFormDirty()) {
        return;
    }
    event.preventDefault();
    requestDetailClose();
});
// Restore state from VS Code persisted state
const vscodeState = vscode.getState() || {};
const collapsedColumns = new Set(vscodeState.collapsedColumns || []);

// View mode: 'kanban' (default), 'table', 'graph', or 'tree'
let viewMode = vscodeState.viewMode || 'kanban';

// Initialize graph view
let graphView = null;
let graphState = {
  focusMode: false,
  focusNodeId: null,
  focusDepth: 2,
  direction: 'TB'
};
let isRenderingGraph = false; // Guard to prevent concurrent graph renders

// Table-specific state
// Default sort is updated_at descending; written into sorting so the column
// header indicator renders identically to a user-chosen sort.
const DEFAULT_TABLE_SORTING = [{ id: 'updated_at', dir: 'desc' }];
let tableState = {
  sorting: (Array.isArray(vscodeState.tableSorting) && vscodeState.tableSorting.length > 0)
    ? vscodeState.tableSorting
    : DEFAULT_TABLE_SORTING.slice(),
  columnVisibility: vscodeState.tableColumnVisibility || {},
  columnOrder: vscodeState.tableColumnOrder || [],
  filters: vscodeState.tableFilters || {} // Additional table filters (status, assignee, labels)
};

// Tree-specific state. expandedOverrides holds only deviations from the
// depth-based default (top-level expanded, deeper collapsed) keyed by issue
// id, so issues that appear after the state was saved still follow the
// default. Entries are re-inserted on every toggle so key order doubles as
// a least-recently-touched list for the size cap in trimTreeExpanded().
let treeState = {
  sort: (vscodeState.treeSort && typeof vscodeState.treeSort === 'object')
    ? { ...vscodeState.treeSort }
    : { ...DEFAULT_TREE_SORT },
  expandedOverrides: (vscodeState.treeExpanded && typeof vscodeState.treeExpanded === 'object')
    ? { ...vscodeState.treeExpanded }
    : {}
};

// Table column definitions
const tableColumns = [
  {
    id: 'type',
    label: 'Type',
    visible: true,
    width: 80,
    getValue: c => c.issue_type || 'task',
    render: (c) => {
      const type = c.issue_type || 'task';
      return `<span class="badge ${sanitizeClassName('badge-type-' + type)}">${escapeHtml(type)}</span>`;
    },
    sort: (a, b) => {
      const order = ['epic', 'feature', 'bug', 'task', 'chore'];
      const aType = a.issue_type || 'task';
      const bType = b.issue_type || 'task';
      return order.indexOf(aType) - order.indexOf(bType);
    }
  },
  {
    id: 'id',
    label: 'ID',
    visible: true,
    width: 100,
    getValue: c => c.id,
    render: (c) => `<span class="table-id copy-id" data-full-id="${escapeHtml(c.id)}" title="Click to copy: ${escapeHtml(c.id)}">${escapeHtml(c.id)}</span>`,
    sort: (a, b) => a.id.localeCompare(b.id)
  },
  {
    id: 'title',
    label: 'Title',
    visible: true,
    width: 300,
    getValue: c => c.title,
    render: (c) => `<span class="table-title">${escapeHtml(c.title)}</span>`,
    sort: (a, b) => (a.title || '').localeCompare(b.title || '')
  },
  {
    id: 'status',
    label: 'Status',
    visible: true,
    width: 100,
    getValue: c => c.status,
    render: (c) => `<span class="badge">${escapeHtml(c.status || 'open')}</span>`,
    sort: (a, b) => {
      const order = ['open', 'in_progress', 'blocked', 'closed'];
      return order.indexOf(a.status || 'open') - order.indexOf(b.status || 'open');
    }
  },
  {
    id: 'priority',
    label: 'Priority',
    visible: true,
    width: 80,
    getValue: c => c.priority,
    render: (c) => `<span class="badge badge-priority-${c.priority}">P${c.priority}</span>`,
    sort: (a, b) => (a.priority || 2) - (b.priority || 2)
  },
  {
    id: 'assignee',
    label: 'Assignee',
    visible: true,
    width: 120,
    getValue: c => c.assignee || 'Unassigned',
    render: (c) => {
      if (c.assignee) {
        return `<span class="badge badge-assignee">${escapeHtml(c.assignee)}</span>`;
      }
      return `<span class="badge badge-assignee badge-unassigned">Unassigned</span>`;
    },
    sort: (a, b) => (a.assignee || 'zzz').localeCompare(b.assignee || 'zzz')
  },
  {
    id: 'labels',
    label: 'Labels',
    visible: true,
    width: 150,
    getValue: c => (c.labels || []).join(', '),
    render: (c) => {
      if (!c.labels || c.labels.length === 0) return '';
      const labelBadges = c.labels.slice(0, 3).map(l => 
        `<span class="badge">#${escapeHtml(l)}</span>`
      ).join(' ');
      const more = c.labels.length > 3 ? ` <span class="badge">+${c.labels.length - 3}</span>` : '';
      return labelBadges + more;
    },
    sort: (a, b) => ((a.labels || []).join(',')).localeCompare((b.labels || []).join(','))
  },
  {
    id: 'estimate',
    label: 'Estimate',
    visible: false,
    width: 80,
    getValue: c => c.estimated_minutes || 0,
    render: (c) => {
      if (!c.estimated_minutes) return '';
      const hours = Math.floor(c.estimated_minutes / 60);
      const mins = c.estimated_minutes % 60;
      let timeStr = '';
      if (hours > 0) timeStr += `${hours}h`;
      if (mins > 0) timeStr += `${mins}m`;
      return `<span class="badge badge-estimate">⏱ ${timeStr}</span>`;
    },
    sort: (a, b) => (a.estimated_minutes || 0) - (b.estimated_minutes || 0)
  },
  {
    id: 'updated_at',
    label: 'Updated',
    visible: true,
    width: 120,
    getValue: c => c.updated_at,
    render: (c) => {
      if (!c.updated_at) return '';
      const date = new Date(c.updated_at);
      return `<span class="table-date">${date.toLocaleDateString()}</span>`;
    },
    sort: (a, b) => {
      const aTime = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const bTime = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return bTime - aTime; // Most recent first
    }
  },
  {
    id: 'due_at',
    label: 'Due Date',
    visible: false,
    width: 120,
    getValue: c => c.due_at,
    render: (c) => {
      if (!c.due_at) return '';
      const dueDate = new Date(c.due_at);
      const now = new Date();
      const isOverdue = dueDate < now;
      return `<span class="badge ${isOverdue ? 'badge-overdue' : 'badge-due'}">📅 ${dueDate.toLocaleDateString()}</span>`;
    },
    sort: (a, b) => {
      const aTime = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bTime = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return aTime - bTime;
    }
  }
];

// Read toolbar-filter dropdown selections (priority/type/status). Under
// inclusive-multiselect semantics the array IS the source of truth: an empty
// array means "None selected" and the full universe means "All".
function getTopBarFilterValues() {
    return {
        priority: readSelectedStrings(filterPriorityDropdown),
        type: readSelectedStrings(filterTypeDropdown),
        status: readSelectedStrings(filterStatusDropdown)
    };
}

// Apply persisted toolbar-filter values back to the dropdown checkboxes and
// refresh their visible labels. Preset rows are derived from set-equality
// against the universe / active subset.
function applyTopBarFilters(filters) {
    if (!filters || typeof filters !== 'object') { return; }
    const applyOne = (dropdown, universe, values, updateLabel) => {
        if (!dropdown || !Array.isArray(values)) { return; }
        const cleaned = values.filter(v => typeof v === 'string');
        writeSelection(dropdown, universe, cleaned);
        if (typeof updateLabel === 'function') { updateLabel(); }
    };
    applyOne(filterPriorityDropdown, PRIORITY_UNIVERSE, filters.priority, updatePriorityLabel);
    applyOne(filterTypeDropdown, TYPE_UNIVERSE, filters.type, updateTypeLabel);
    applyOne(filterStatusDropdown, STATUS_UNIVERSE, filters.status, updateStatusLabel);
}

// Maximum treeExpanded entries / key length the UIStateSchema accepts. The
// trim below must keep every saved payload inside these bounds — a payload
// that fails validation is discarded wholesale on the extension side,
// taking the rest of the persisted UI state with it.
const TREE_EXPANDED_MAX_ENTRIES = 500;
const TREE_EXPANDED_MAX_KEY_LENGTH = 50;

// Reduce the expansion-override record to a schema-safe payload: drop keys
// the schema would reject and overrides for issues no longer in the cache.
// (Overrides equal to the depth default are already pruned at toggle time,
// where the node's depth is known.) If still over the cap, keep the most
// recently touched entries — key order is maintained as least-recently-
// touched-first by the toggle handler.
function trimTreeExpanded(overrides) {
    const entries = Object.entries(overrides).filter(([id, expanded]) => {
        if (typeof expanded !== 'boolean') { return false; }
        if (id.length > TREE_EXPANDED_MAX_KEY_LENGTH) { return false; }
        if (cardCache.size > 0 && !cardCache.has(id)) { return false; }
        return true;
    });
    const kept = entries.length > TREE_EXPANDED_MAX_ENTRIES
        ? entries.slice(entries.length - TREE_EXPANDED_MAX_ENTRIES)
        : entries;
    return Object.fromEntries(kept);
}

// Helper to persist all UI state.
// Writes to vscode.setState for fast same-session round-trips AND posts to the
// extension host for cross-session persistence via context.workspaceState. The
// post is fire-and-forget — no pendingRequests entry is registered, so any
// mutation.ok / mutation.error response harmlessly misses.
function saveState() {
    const payload = {
        collapsedColumns: [...collapsedColumns],
        viewMode: viewMode,
        tableSorting: tableState.sorting,
        tableColumnVisibility: tableState.columnVisibility,
        tableColumnOrder: tableState.columnOrder,
        tableFilters: tableState.filters,
        topBarFilters: getTopBarFilterValues(),
        topBarFiltersVersion: 3,
        treeSort: treeState.sort,
        treeExpanded: trimTreeExpanded(treeState.expandedOverrides)
    };
    vscode.setState({
        ...vscode.getState(),
        ...payload
    });
    vscode.postMessage({
        type: 'state.uiState',
        requestId: `state.uiState-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload
    });
}

// Legacy function name for backward compatibility
function saveCollapsedColumnsState() {
    saveState();
}

// Apply persisted UI state delivered by the extension on board.data / board.minimal.
// The extension has already Zod-validated the payload, but the webview re-checks
// types defensively because board.data is also constructed by adapter paths that
// don't run the schema (e.g., adapter.getBoard() shape).
function applyPersistedUIState(uiState) {
    if (!uiState || typeof uiState !== 'object') { return; }
    if (uiState.viewMode === 'kanban' || uiState.viewMode === 'table' || uiState.viewMode === 'graph' || uiState.viewMode === 'tree') {
        viewMode = uiState.viewMode;
        syncViewModeButtons();
    }
    if (Array.isArray(uiState.collapsedColumns)) {
        collapsedColumns.clear();
        for (const c of uiState.collapsedColumns) {
            if (typeof c === 'string') { collapsedColumns.add(c); }
        }
    }
    if (Array.isArray(uiState.tableSorting) && uiState.tableSorting.length > 0) {
        tableState.sorting = uiState.tableSorting;
    }
    if (uiState.tableColumnVisibility && typeof uiState.tableColumnVisibility === 'object') {
        tableState.columnVisibility = uiState.tableColumnVisibility;
    }
    if (Array.isArray(uiState.tableColumnOrder)) {
        tableState.columnOrder = uiState.tableColumnOrder;
    }
    if (uiState.tableFilters && typeof uiState.tableFilters === 'object') {
        tableState.filters = uiState.tableFilters;
    }
    if (uiState.topBarFilters && typeof uiState.topBarFilters === 'object') {
        applyTopBarFilters(uiState.topBarFilters);
    }
    if (uiState.treeSort && typeof uiState.treeSort === 'object' && typeof uiState.treeSort.id === 'string') {
        treeState.sort = { ...uiState.treeSort };
    }
    if (uiState.treeExpanded && typeof uiState.treeExpanded === 'object' && !Array.isArray(uiState.treeExpanded)) {
        treeState.expandedOverrides = { ...uiState.treeExpanded };
    }
}
let activeRequests = 0;

// Loading indicator helpers
function showLoading(message = 'Loading...') {
    activeRequests++;
    const loader = document.getElementById('loadingOverlay');
    const loaderText = document.getElementById('loadingText');
    if (loader) {
        loader.classList.remove('hidden');
    }
    if (loaderText) {
        loaderText.textContent = message;
    }
}

function hideLoading() {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) {
        const loader = document.getElementById('loadingOverlay');
        if (loader) {
            loader.classList.add('hidden');
        }
    }
}

// Configure DOMPurify for safe HTML sanitization
const purifyConfig = {
    ALLOWED_TAGS: ['div', 'span', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button', 'label', 'select', 'option', 'input', 'textarea', 'form', 'datalist', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'title', 'class', 'id', 'type', 'value', 'selected', 'disabled', 'style', 'data-column-id', 'data-id', 'data-label', 'data-full-id', 'placeholder', 'rows', 'required', 'for', 'checked', 'list', 'name', 'cols', 'open', 'autocomplete'],
    ALLOW_DATA_ATTR: true,
    // Prevent XSS via javascript: URIs - only allow safe protocols
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
};

// HTML escape function to prevent XSS in dynamic content
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Safe function for HTML attributes - escapes quotes and special chars
function safe(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Safely render markdown with size limits to prevent DoS
 * Aligned with schema validation (IssueCreateSchema/IssueUpdateSchema in types.ts)
 * @param {string} text - The markdown text to render
 * @returns {string} - Sanitized HTML or error message if too large
 */
function safeRenderMarkdown(text) {
    const MAX_MARKDOWN_SIZE = 100000; // 100KB limit to prevent DoS from unbounded parsing
    if (!text) return '';
    if (text.length > MAX_MARKDOWN_SIZE) {
        return `<div class="error" style="color: var(--error); padding: 8px; background: rgba(255,0,0,0.1); border-radius: 4px;">
            Content too large to display (${Math.round(text.length / 1024)}KB). Maximum size: ${Math.round(MAX_MARKDOWN_SIZE / 1024)}KB.
        </div>`;
    }
    return DOMPurify.sanitize(marked.parse(text), purifyConfig);
}

// Validate CSS class names to prevent injection attacks
// Only allows alphanumeric, hyphens, and underscores
function sanitizeClassName(cls) {
    if (!cls) return '';
    // Allow only safe characters in class names (including spaces for multiple classes)
    const safe = String(cls).replace(/[^a-zA-Z0-9_\- ]/g, '');
    // Prevent classes that start with numbers or hyphens followed by numbers
    if (safe && !/^-?\d/.test(safe)) {
        return safe;
    }
    return '';
}

// Configure marked to use GFM breaks
if (typeof marked !== 'undefined') {
    marked.use({
        breaks: true,
        gfm: true
    });
}

// Request/response tracking for async operations
const pendingRequests = new Map();

// Cleanup pending requests to prevent memory leaks
function cleanupPendingRequests() {
    for (const [reqId, { reject }] of pendingRequests.entries()) {
        reject(new Error('Request cancelled: webview hidden or disposed'));
    }
    pendingRequests.clear();
}

// Cleanup pending requests when webview becomes hidden or is disposed
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cleanupPendingRequests();
    }
});

// Also cleanup on page unload
window.addEventListener('pagehide', cleanupPendingRequests);

// Periodic cleanup for stale requests (prevents memory leak if extension becomes unresponsive)
// Store interval ID so it can be cleaned up on webview disposal
const cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const MAX_REQUEST_AGE = 60000; // 60 seconds
    let cleanedCount = 0;

    for (const [reqId, { timeoutId, createdAt }] of pendingRequests.entries()) {
        if (createdAt && now - createdAt > MAX_REQUEST_AGE) {
            clearTimeout(timeoutId);
            pendingRequests.delete(reqId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`[Cleanup] Removed ${cleanedCount} stale request(s) older than 60s`);
    }
}, 10000); // Run cleanup every 10 seconds

// Clear interval on page unload to prevent memory leak
window.addEventListener('pagehide', () => {
    clearInterval(cleanupIntervalId);
});

function requestId() {
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Post with promise support
function postAsync(type, payload, loadingMessage = 'Loading...') {
    showLoading(loadingMessage);
    const reqId = requestId();
    return new Promise((resolve, reject) => {
        // Timeout after 30 seconds
        const timeoutId = setTimeout(() => {
            if (pendingRequests.has(reqId)) {
                pendingRequests.delete(reqId);
                // Don't call hideLoading here - let finally block handle it
                reject(new Error('Request timeout'));
            }
        }, 30000);

        // Store resolve, reject, timeoutId, and createdAt in the Map
        // This allows response handlers to clear the timeout properly and periodic cleanup
        pendingRequests.set(reqId, { resolve, reject, timeoutId, createdAt: Date.now() });
        vscode.postMessage({ type, requestId: reqId, payload });
    }).finally(() => {
        // Cleanup: Clear the timeout if the request is still pending
        // The response handlers will have already cleared it if they ran
        if (pendingRequests.has(reqId)) {
            const { timeoutId } = pendingRequests.get(reqId);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(reqId);
        }
        // Always call hideLoading exactly once per showLoading
        hideLoading();
    });
}

function post(type, payload) {
    const reqId = requestId();

    vscode.postMessage({ type, requestId: reqId, payload });
}

function toLocalDateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toIsoFromLocalInput(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

function toast(msg, actionName, actionCb) {
    toastEl.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = msg;
    toastEl.appendChild(span);

    if (actionName && actionCb) {
        const btn = document.createElement("button");
        btn.className = "toast-btn";
        btn.textContent = actionName;
        btn.onclick = () => {
            actionCb();
            toastEl.classList.add("hidden");
        };
        toastEl.appendChild(btn);
    }

    toastEl.classList.remove("hidden");

    // Auto-hide with hover detection
    let isHovering = false;
    const onMouseEnter = () => { isHovering = true; };
    const onMouseLeave = () => { isHovering = false; };

    toastEl.addEventListener('mouseenter', onMouseEnter);
    toastEl.addEventListener('mouseleave', onMouseLeave);

    const hideToast = () => {
        if (!isHovering) {
            toastEl.classList.add("hidden");
            toastEl.removeEventListener('mouseenter', onMouseEnter);
            toastEl.removeEventListener('mouseleave', onMouseLeave);
        } else {
            // Check again in 1 second if still hovering
            setTimeout(hideToast, 1000);
        }
    };

    setTimeout(hideToast, 5000);
}

function columnForCard(card) {
    // Deterministic mapping (matches extension-side assumptions)
    if (card.status === "closed") return "closed";
    if (card.is_ready) return "ready";
    if (card.status === "in_progress") return "in_progress";

    // If it's open but not ready, it must be because of blocking (direct or transitive).
    // So we classify it as blocked.
    if (card.status === "blocked" || (card.blocked_by_count || 0) > 0) return "blocked";

    // Fallback: If status is 'open' and not ready, and not explicitly blocked by count (transitive block),
    // we still put it in 'blocked' because 'open' column is gone.
    if (card.status === "open") return "blocked";

    return "blocked"; // Default fallback
}

// Phase 2: In-memory filtering over cardCache
// Returns filtered array of cards based on current filter values
// Performance target: <16ms for 10,000 cards
function getFilteredCards() {
    const sVal = filterSearch?.value?.toLowerCase()?.trim() || "";

    // Inclusive-multiselect semantics: an empty array means "None selected",
    // i.e. no card matches that filter. The toolbar's first-load defaults
    // (initFilterDefaults) ensure these arrays are non-empty unless the user
    // explicitly cleared a filter, so the all-empty case is the user's intent
    // to see zero issues.
    const selectedPriorities = new Set(getSelectedPriorities());
    const selectedTypes = new Set(getSelectedTypes());
    const selectedStatuses = new Set(getSelectedStatuses());

    const filtered = [];
    for (const card of cardCache.values()) {
        if (!selectedPriorities.has(card.priority)) { continue; }
        if (!selectedTypes.has(card.issue_type)) { continue; }
        if (!selectedStatuses.has(card.status)) { continue; }

        // Search filter (title, description, ID, or labels)
        if (sVal !== "") {
            const titleMatch = card.title.toLowerCase().includes(sVal);
            const descMatch = card.description && card.description.toLowerCase().includes(sVal);
            const idMatch = card.id.toLowerCase().includes(sVal);
            const labelMatch = card.labels && card.labels.some(label => label.toLowerCase().includes(sVal));

            if (!titleMatch && !descMatch && !idMatch && !labelMatch) {
                continue;
            }
        }

        filtered.push(card);
    }

    return filtered;
}

// Phase 2: In-memory sorting
// Takes array of cards and sorts by specified field and direction
// Performance target: <16ms for 10,000 cards
// sortBy: 'updated_at' | 'created_at' | 'priority' | 'title' | 'status' (default: 'updated_at')
// sortDir: 'asc' | 'desc' (default: 'desc')
function getSortedCards(cards, sortBy = 'updated_at', sortDir = 'desc') {
    if (!cards || cards.length === 0) {
        return [];
    }
    
    const sorted = [...cards]; // Copy to avoid mutating input
    
    sorted.sort((a, b) => {
        let aVal, bVal;
        
        switch (sortBy) {
            case 'priority':
                aVal = a.priority ?? 2; // Default to medium priority
                bVal = b.priority ?? 2;
                break;
            
            case 'title':
                aVal = (a.title || '').toLowerCase();
                bVal = (b.title || '').toLowerCase();
                return sortDir === 'asc' 
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            
            case 'status':
                aVal = a.status || '';
                bVal = b.status || '';
                return sortDir === 'asc'
                    ? aVal.localeCompare(bVal)
                    : bVal.localeCompare(aVal);
            
            case 'created_at':
                aVal = new Date(a.created_at || 0).getTime();
                bVal = new Date(b.created_at || 0).getTime();
                break;
            
            case 'updated_at':
            default:
                aVal = new Date(a.updated_at || 0).getTime();
                bVal = new Date(b.updated_at || 0).getTime();
                break;
        }
        
        // Numeric comparison for dates and priority
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    return sorted;
}

// Phase 2: In-memory grouping by column
// Takes array of cards and groups them into columns
// Performance target: <16ms for 10,000 cards
// Returns: { ready: [], in_progress: [], blocked: [], closed: [] }
function getCardsByColumn(cards) {
    const byColumn = {
        ready: [],
        in_progress: [],
        blocked: [],
        closed: []
    };
    
    if (!cards || cards.length === 0) {
        return byColumn;
    }
    
    for (const card of cards) {
        const col = columnForCard(card);
        if (byColumn[col]) {
            byColumn[col].push(card);
        }
    }
    
    return byColumn;
}

// Dispatch to the appropriate render function based on view mode
function render() {

    if (!columns || columns.length === 0) {

        return;
    }

    // Update UI based on read-only mode
    if (readOnly) {
        newBtn.style.display = 'none'; // Hide New Issue button

        // Show read-only banner if not already present
        if (!document.getElementById('readOnlyBanner')) {
            const banner = document.createElement('div');
            banner.id = 'readOnlyBanner';
            banner.style.cssText = 'background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); padding: 12px; text-align: center; font-weight: 600; margin-bottom: 12px; border-radius: 6px; border: 1px solid var(--vscode-inputValidation-warningBorder);';
            banner.textContent = '📖 Read-Only Mode - Viewing only, changes are disabled';
            boardEl.parentElement.insertBefore(banner, boardEl);
        }
    } else {
        newBtn.style.display = ''; // Show New Issue button

        // Remove read-only banner if present
        const banner = document.getElementById('readOnlyBanner');
        if (banner) {
            banner.remove();
        }
    }

    // Reset table pagination when filters/sort changes (user likely wants to see results from page 1)
    tablePaginationState.currentPage = 0;

    if (viewMode === 'graph') {
        renderGraph();
    } else if (viewMode === 'table') {
        renderTable();
    } else if (viewMode === 'tree') {
        renderTree();
    } else {
        renderKanban();
    }

    renderEmptyStateHint();
}

// Update the empty-state hint above the board. Two distinct messages:
//   - Specific: the Status filter is empty (None selected) — the user has
//     explicitly chosen to show no statuses.
//   - Generic:  status is non-empty but every card was filtered out by some
//     combination of the other filters or the search box.
// Hidden otherwise.
function renderEmptyStateHint() {
    const hint = document.getElementById('boardEmptyState');
    if (!hint) { return; }
    const statuses = getSelectedStatuses();
    if (statuses.length === 0) {
        hint.textContent = 'No statuses selected. Use the Status filter to choose what to show.';
        hint.classList.remove('hidden');
        return;
    }
    const filtered = getFilteredCards();
    if (filtered.length === 0 && cardCache.size > 0) {
        hint.textContent = 'No issues match the current filters.';
        hint.classList.remove('hidden');
        return;
    }
    hint.textContent = '';
    hint.classList.add('hidden');
}

// Create debounced render function for filter changes (300ms delay)
// This prevents excessive re-renders when users change multiple filters quickly
const debouncedRender = debounce(render, 300);

// Create debounced renderTable function for table pagination changes (150ms delay)
// This prevents listener accumulation and deadlock during rapid page size changes
const debouncedRenderTable = debounce(() => {
    if (typeof renderTable === 'function') {
        renderTable();
    }
}, 150);

// Kanban view rendering
function renderKanban() {


    // Phase 2: Use in-memory filtering, sorting, and grouping over cardCache
    // This provides instant UI updates without server round-trips
    const filtered = getFilteredCards();
    const sorted = getSortedCards(filtered, 'updated_at', 'desc'); // Sort by most recently updated
    const byCol = getCardsByColumn(sorted);
    

    
    // Legacy filtering for backward compatibility when cardCache is not populated
    // This handles the case where board.load (old path) is used instead of board.loadMinimal
    if (cardCache.size === 0) {

        const selectedPriorities = new Set(getSelectedPriorities());
        const selectedTypes = new Set(getSelectedTypes());
        const sVal = filterSearch.value.toLowerCase();

        for (const col of columns) {
            const colKey = col.key;
            const colCards = columnState[colKey]?.cards || [];

            byCol[colKey] = colCards.filter(c => {
                if (!selectedPriorities.has(c.priority)) return false;
                if (!selectedTypes.has(c.issue_type)) return false;
                if (sVal !== "" && !c.title.toLowerCase().includes(sVal)) return false;
                return true;
            });
        }
    }

    // Capture scroll positions before clearing
    const scrollPositions = new Map();
    boardEl.querySelectorAll('.dropZone').forEach(el => {
        const colKey = el.dataset.col;
        if (colKey) {
            scrollPositions.set(colKey, el.scrollTop);
        }
    });

    // Clean up Pragmatic Drag and Drop instances before clearing DOM
    // This prevents memory leaks from orphaned event listeners
    boardEl.querySelectorAll('.dropZone').forEach(dropZone => {
        // Call cleanup functions for drop targets
        if (dropZone._cleanupFns) {
            dropZone._cleanupFns.forEach(cleanup => cleanup());
            dropZone._cleanupFns = [];
        }
    });

    // Clean up draggable instances on cards
    boardEl.querySelectorAll('.card').forEach(card => {
        if (card._cleanup) {
            card._cleanup();
            card._cleanup = null;
        }
    });

    boardEl.innerHTML = "";
    for (const col of columns) {
        const colWrap = document.createElement("section");
        colWrap.className = "column";
        if (collapsedColumns.has(col.key)) {
            colWrap.classList.add("collapsed");
        }

        const header = document.createElement("div");
        header.className = "columnHeader";

        // Collapse toggle button
        const toggleBtn = document.createElement("button");
        toggleBtn.className = "icon-btn";
        toggleBtn.innerHTML = collapsedColumns.has(col.key)
            ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentcolor"><path d="M6 12l4-4-4-4"/></svg>` // Right arrow
            : `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentcolor"><path d="M4 6l4 4 4-4"/></svg>`; // Down arrow (or similar indicating expansion) (Actually left/right might be better for column? Let's use simple chevrons)

        // Better Ref: Expanded = Left/Inward? Collapsed = ...
        // Let's just use standard: 
        // Generic "Toggle" icon or:
        // Expanded: < (collapse)
        // Collapsed: > (expand)

        // Let's match typical VS Code or side-panel behavior.
        // When expanded, show "Collapse" (e.g. arrow pointing opposite to content flow or just standard chevron).
        // Let's use: 
        // Expanded: SVG for "Contract" (Arrows pointing in?) Or simple "Chevron Left" if it collapses left?
        // Let's stick to: Chevron Left (<) to collapse, Chevron Right (>) to expand? 
        // Or simply toggling state icon.
        if (collapsedColumns.has(col.key)) {
            // Is collapsed. Show Expand (Right or Open)
            toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
        } else {
            // Is expanded. Show Collapse (Left? or Down?)
            // Since it collapses horizontally, maybe Left < ?
            toggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
        }

        toggleBtn.onclick = () => {
            if (collapsedColumns.has(col.key)) {
                collapsedColumns.delete(col.key);
            } else {
                collapsedColumns.add(col.key);
            }
            saveCollapsedColumnsState();
            render();
        };

        const titleDiv = document.createElement("div");
        titleDiv.className = "columnTitle";
        titleDiv.textContent = col.title;

        const countDiv = document.createElement("div");
        countDiv.className = "columnCount";

        // Show "loaded / total" format for incremental loading
        const colState = columnState[col.key];
        const filteredCount = (byCol[col.key] || []).length;
        // Under inclusive-multiselect semantics, "active filter" means the
        // selection is narrower than the full universe for at least one
        // dropdown (so the count display reflects that some cards are hidden).
        const hasActiveFilters = !isPresetChecked(readSelectedStrings(filterPriorityDropdown), 'all', PRIORITY_UNIVERSE)
            || !isPresetChecked(readSelectedStrings(filterTypeDropdown), 'all', TYPE_UNIVERSE)
            || !isPresetChecked(readSelectedStrings(filterStatusDropdown), 'all', STATUS_UNIVERSE)
            || !!filterSearch.value;

        if (colState && colState.totalCount > colState.cards.length) {
            // Partial load: show "filtered (loaded / total)"
            if (hasActiveFilters && filteredCount !== colState.cards.length) {
                countDiv.textContent = `${filteredCount} matches (${colState.cards.length} / ${colState.totalCount} loaded)`;
                countDiv.setAttribute('title', `${filteredCount} cards match filters out of ${colState.cards.length} loaded (${colState.totalCount} total in this column)`);
            } else {
                countDiv.textContent = `${colState.cards.length} / ${colState.totalCount} loaded`;
                countDiv.setAttribute('title', `${colState.cards.length} cards loaded out of ${colState.totalCount} total in this column`);
            }
        } else if (colState && colState.totalCount > 0) {
            // Fully loaded: show "filtered / total"
            if (hasActiveFilters && filteredCount !== colState.totalCount) {
                countDiv.textContent = `${filteredCount} matches of ${colState.totalCount}`;
                countDiv.setAttribute('title', `${filteredCount} cards match filters out of ${colState.totalCount} total in this column`);
            } else {
                countDiv.textContent = `${colState.totalCount}`;
                countDiv.setAttribute('title', `${colState.totalCount} cards in this column`);
            }
        } else {
            // Legacy or no data
            countDiv.textContent = filteredCount;
            countDiv.setAttribute('title', `${filteredCount} cards in this column`);
        }

        header.appendChild(titleDiv);
        header.appendChild(countDiv);
        header.appendChild(toggleBtn);


        const dropZone = document.createElement("div");
        dropZone.className = "dropZone";
        dropZone.dataset.col = col.key;

        // Initialize Pragmatic Drag and Drop on the dropZone
        // Store cleanup functions for this column
        if (!dropZone._cleanupFns) {
            dropZone._cleanupFns = [];
        }

        // Only set up drop target if not in read-only mode
        if (!readOnly) {
            const cleanupDropTarget = dropTargetForElements({
                element: dropZone,
                onDragEnter: () => {
                    dropZone.classList.add('sortable-ghost');
                },
                onDragLeave: () => {
                    dropZone.classList.remove('sortable-ghost');
                },
                onDrop({ source, location }) {
                    dropZone.classList.remove('sortable-ghost');

                    const destination = location.current.dropTargets[0];
                    if (!destination) return;

                    const itemEl = source.element;
                    const id = itemEl.dataset.id;
                    const toColumn = destination.element.dataset.col;
                    const fromColumn = itemEl.closest('.dropZone')?.dataset.col;

                    if (!id || !toColumn) return;

                    // If moved to a different column
                    if (toColumn !== fromColumn) {
                        post("issue.move", { id, toColumn });
                    }
                }
            });
            dropZone._cleanupFns.push(cleanupDropTarget);
        }

        // Performance optimization: Use DocumentFragment for batch DOM operations
        // This prevents reflow/repaint for each card, significantly improving render time for large datasets
        const fragment = document.createDocumentFragment();

        for (const card of (byCol[col.key] || [])) {
            const el = document.createElement("div");
            el.className = "card";
            el.dataset.id = card.id;

            // Accessibility: Make cards keyboard-navigable
            el.setAttribute('tabindex', '0');
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', `Issue: ${escapeHtml(card.title)}`);

            // Event listeners are now handled via event delegation on boardEl (see setupBoardEventDelegation)
            // This prevents memory leaks from re-attaching listeners on every render

            const badges = [];
            // Sanitize all class names to prevent injection
            badges.push({ text: `P${card.priority}`, cls: sanitizeClassName(`badge-priority-${card.priority}`) });
            if (card.issue_type) {
                badges.push({
                    text: card.issue_type,
                    cls: sanitizeClassName(`badge-type-${card.issue_type}`)
                });
            }
            // Assignee badge positioned right after type
            if (card.assignee) {
                badges.push({ text: `Assignee: ${card.assignee}`, cls: 'badge-assignee' });
            } else {
                badges.push({ text: 'Assignee: Unassigned', cls: 'badge-assignee badge-unassigned' });
            }
            if (card.estimated_minutes) {
                const hours = Math.floor(card.estimated_minutes / 60);
                const mins = card.estimated_minutes % 60;
                let timeStr = '';
                if (hours > 0) timeStr += `${hours}h`;
                if (mins > 0) timeStr += `${mins}m`;
                badges.push({ text: `⏱ ${timeStr}`, cls: 'badge-estimate' });
            }

            // Relationship affordances: blocked_by / blocks / children.
            // Parent is rendered separately as the `.cardParent` line above the title.
            badges.push(...buildRelationshipBadges(card));

            if (card.external_ref) badges.push({ text: card.external_ref });
            for (const l of (card.labels || []).slice(0, 4)) badges.push({ text: `#${l}` });

            // Flag badges
            if (card.pinned) badges.push({ text: '📌 Pinned', cls: 'badge-flag' });
            if (card.is_template) badges.push({ text: '📄 Template', cls: 'badge-flag' });
            if (card.ephemeral) badges.push({ text: '⏱ Ephemeral', cls: 'badge-flag' });

            // Scheduling badges
            if (card.due_at) {
                const dueDate = new Date(card.due_at);
                const now = new Date();
                const isOverdue = dueDate < now;
                badges.push({
                    text: `📅 Due: ${dueDate.toLocaleDateString()}`,
                    cls: isOverdue ? 'badge-overdue' : 'badge-due'
                });
            }
            if (card.defer_until) {
                const deferDate = new Date(card.defer_until);
                badges.push({ text: `⏰ Defer: ${deferDate.toLocaleDateString()}`, cls: 'badge-defer' });
            }

            // Parent info
            let parentHtml = "";
            if (card.parent) {
                parentHtml = `<div class="cardParent" title="Parent: ${escapeHtml(card.parent.title)}">
                    <span class="icon-parent">↳</span> ${escapeHtml(card.parent.title)}
                </div>`;
            }

            // Apply DOMPurify to all innerHTML content for defense-in-depth
            const htmlContent = `
        ${parentHtml}
        <div class="cardTitle">${escapeHtml(card.title)}</div>
        <div class="badges">${badges.map(b => `<span class="badge ${sanitizeClassName(b.cls || '')}"${b.title ? ` title="${escapeHtml(b.title)}"` : ''}>${escapeHtml(b.text)}</span>`).join("")}</div>
      `;
            el.innerHTML = DOMPurify.sanitize(htmlContent, purifyConfig);

            // Make card draggable (unless in read-only mode)
            if (!readOnly) {
                const cleanupDraggable = draggable({
                    element: el,
                    getInitialData: () => ({ id: card.id, fromColumn: col.key }),
                    onDragStart: () => {
                        el.classList.add('sortable-drag');
                    },
                    onDrop: () => {
                        el.classList.remove('sortable-drag');
                    },
                });
                // Store cleanup function on the element
                el._cleanup = cleanupDraggable;
            }

            fragment.appendChild(el);
        }

        // Single DOM operation: append all cards at once
        dropZone.appendChild(fragment);

        // Add loading spinner if column is loading
        // colState already declared at line 536
        if (colState && colState.loading) {
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'column-loading';
            loadingDiv.innerHTML = `
                <div class="spinner"></div>
                <span>Loading...</span>
            `;
            dropZone.appendChild(loadingDiv);
        }

        // Add Load More button if there are more cards to load
        if (colState && colState.hasMore && !colState.loading) {
            const loadMoreDiv = document.createElement('div');
            loadMoreDiv.className = 'load-more-container';
            
            const remaining = colState.totalCount - colState.cards.length;
            const btn = document.createElement('button');
            btn.className = 'btn load-more-btn';
            btn.textContent = `Load More (${remaining} remaining)`;
            btn.dataset.column = col.key;
            
            btn.onclick = async () => {
                try {
                    // Set loading state
                    columnState[col.key].loading = true;
                    render(); // Re-render to show spinner
                    
                    // Request more data
                    await postAsync('board.loadMore', { column: col.key }, 'Loading more issues...');
                } catch (error) {

                    toast(`Failed to load more: ${error.message}`);
                    columnState[col.key].loading = false;
                    render();
                }
            };
            
            loadMoreDiv.appendChild(btn);
            dropZone.appendChild(loadMoreDiv);
        }

        // Restore scroll position for this column
        if (scrollPositions.has(col.key)) {
            // Use setTimeout to ensure DOM is fully rendered before scrolling
            setTimeout(() => {
                dropZone.scrollTop = scrollPositions.get(col.key);
            }, 0);
        }

        colWrap.appendChild(header);
        colWrap.appendChild(dropZone);
        boardEl.appendChild(colWrap);
    }

}

// Flatten columnState into a deduplicated array of cards
function flattenColumnState() {
    const cardMap = new Map();
    
    // Iterate through all columns and collect cards
    for (const col of columns) {
        const colState = columnState[col.key];
        if (colState && colState.cards) {
            for (const card of colState.cards) {
                // Use Map to deduplicate by id (last occurrence wins)
                if (!cardMap.has(card.id)) {
                    cardMap.set(card.id, card);
                }
            }
        }
    }
    
    return Array.from(cardMap.values());
}

// Check if there's more data to load across all columns
function hasPartialData() {
    for (const col of columns) {
        const colState = columnState[col.key];
        if (colState && colState.hasMore) {
            return true;
        }
    }
    return false;
}

// Get total count across all columns
function getTotalCount() {
    let total = 0;
    for (const col of columns) {
        const colState = columnState[col.key];
        if (colState && colState.totalCount) {
            total += colState.totalCount;
        }
    }
    return total;
}

// Get loaded count across all columns
function getLoadedCount() {
    let loaded = 0;
    for (const col of columns) {
        const colState = columnState[col.key];
        if (colState && colState.cards) {
            loaded += colState.cards.length;
        }
    }
    return loaded;
}

// Load table page from server with filters and sorting
// Phase 2: In-memory table pagination using cardCache
// No server requests - instant filtering, sorting, and pagination
function loadTablePage(page = null) {
    if (page !== null) {
        tablePaginationState.currentPage = page;
    }



    // Get filtered cards from cache (uses same filters as Kanban view)
    let filteredCards = getFilteredCards();
    
    // Apply table-specific filters (if any)
    if (tableState.filters.status && tableState.filters.status !== '') {
        filteredCards = filteredCards.filter(card => card.status === tableState.filters.status);
    }
    if (tableState.filters.assignee && tableState.filters.assignee !== '') {
        filteredCards = filteredCards.filter(card => card.assignee === tableState.filters.assignee);
    }
    if (tableState.filters.labels && tableState.filters.labels.length > 0) {
        filteredCards = filteredCards.filter(card => 
            card.labels && tableState.filters.labels.some(label => card.labels.includes(label))
        );
    }

    // Sort cards by primary sort column (tableState.sorting is always non-empty;
    // see DEFAULT_TABLE_SORTING).
    const primarySort = tableState.sorting[0];
    const sortedCards = getSortedCards(filteredCards, primarySort.id, primarySort.dir);

    // Calculate pagination
    const totalCount = sortedCards.length;
    const offset = tablePaginationState.currentPage * tablePaginationState.pageSize;
    const limit = tablePaginationState.pageSize;
    
    // Slice for current page
    const pageCards = sortedCards.slice(offset, offset + limit);

    // Update state
    tablePaginationState.cards = pageCards;
    tablePaginationState.totalCount = totalCount;
    tablePaginationState.loading = false;


    return true;
}

// Table view rendering (synchronous - uses in-memory cardCache)
function renderTable() {


    // Load current page from cardCache with filters and sorting (instant)
    const success = loadTablePage();
    if (!success) {
        // Error already displayed by loadTablePage
        return;
    }

    const tableRows = tablePaginationState.cards;
    const totalCount = tablePaginationState.totalCount;
    const totalPages = Math.ceil(totalCount / tablePaginationState.pageSize);
    const currentPage = tablePaginationState.currentPage;
    const startIdx = currentPage * tablePaginationState.pageSize;
    const endIdx = Math.min(startIdx + tablePaginationState.pageSize, totalCount);



    // Get visible columns (respecting user preferences)
    let visibleColumns = tableColumns.filter(col => {
        if (Object.keys(tableState.columnVisibility).length > 0) {
            // If column is explicitly in saved state, use that preference
            if (col.id in tableState.columnVisibility) {
                return tableState.columnVisibility[col.id] !== false;
            }
        }
        // Fall back to default visibility
        return col.visible;
    });

    // Apply column order if set
    if (tableState.columnOrder.length > 0) {
        visibleColumns = tableState.columnOrder
            .map(id => visibleColumns.find(c => c.id === id))
            .filter(Boolean);
    }

    // Build table HTML with pagination controls in header
    let tableHtml = `
        <div class="table-view">
            <div class="table-controls">
                <div class="table-controls-left">
                    <label for="pageSizeSelect">Rows per page:</label>
                    <select id="pageSizeSelect" class="page-size-select">
                        <option value="25" ${tablePaginationState.pageSize === 25 ? 'selected' : ''}>25</option>
                        <option value="50" ${tablePaginationState.pageSize === 50 ? 'selected' : ''}>50</option>
                        <option value="100" ${tablePaginationState.pageSize === 100 ? 'selected' : ''}>100</option>
                        <option value="250" ${tablePaginationState.pageSize === 250 ? 'selected' : ''}>250</option>
                        <option value="500" ${tablePaginationState.pageSize === 500 ? 'selected' : ''}>500</option>
                    </select>
                    <span class="pagination-info">Showing ${startIdx + 1}-${endIdx} of ${totalCount} rows</span>
                    <div class="table-column-controls">
                        <button class="btn" id="columnPickerBtn" title="Show/hide columns">⚙ Columns</button>
                        <button class="btn" id="resetTableColumns" title="Reset table columns to defaults">Reset Columns</button>
                        <div class="column-picker-dropdown" id="columnPickerDropdown" style="display: none;">
                            <div class="column-picker-header">
                                <span>Show/Hide Columns</span>
                                <button class="close-btn" id="closeColumnPicker">✕</button>
                            </div>
                            <div class="column-picker-list">
                                ${tableColumns.map(col => {
                                    const isVisible = visibleColumns.some(vc => vc.id === col.id);
                                    return `
                                        <label class="column-picker-item">
                                            <input type="checkbox"
                                                class="column-toggle"
                                                data-column-id="${col.id}"
                                                ${isVisible ? 'checked' : ''}>
                                            <span>${col.label}</span>
                                        </label>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="table-controls-right">
                    ${totalPages > 1 ? `
                        <button class="btn pagination-btn" id="tablePrevPage" ${currentPage === 0 ? 'disabled' : ''}>Previous</button>
                        <span class="pagination-info">Page ${currentPage + 1} of ${totalPages}</span>
                        <button class="btn pagination-btn" id="tableNextPage" ${currentPage >= totalPages - 1 ? 'disabled' : ''}>Next</button>
                    ` : ''}
                </div>
            </div>
            <div class="table-wrapper">
                <table class="issues-table">
                    <thead>
                        <tr>
                            ${visibleColumns.map(col => {
                                const sortSpec = tableState.sorting.find(s => s.id === col.id);
                                const sortIndicator = sortSpec 
                                    ? `<span class="sort-indicator ${sortSpec.dir}">${sortSpec.dir === 'asc' ? '▲' : '▼'}</span>`
                                    : '';
                                return `<th class="sortable" data-column-id="${escapeHtml(col.id)}" style="width: ${col.width}px">${escapeHtml(col.label)}${sortIndicator}</th>`;
                            }).join('')}
                        </tr>
                    </thead>
                    <tbody>
    `;

    // Render all rows (already paginated server-side)
    for (const card of tableRows) {
        tableHtml += '<tr class="table-row" data-id="' + escapeHtml(card.id) + '">';
        for (const col of visibleColumns) {
            const cellContent = col.render(card);
            tableHtml += '<td>' + cellContent + '</td>';
        }
        tableHtml += '</tr>';
    }

    tableHtml += `
                    </tbody>
                </table>
            </div>
        </div>
    `;

    // Apply DOMPurify to table HTML for defense-in-depth
    boardEl.innerHTML = DOMPurify.sanitize(tableHtml, purifyConfig);

    // Add page size selector handler with cleanup and debouncing
    const pageSizeSelect = document.getElementById('pageSizeSelect');
    if (pageSizeSelect) {
        // Remove old listener to prevent accumulation
        if (pageSizeChangeListener) {
            pageSizeSelect.removeEventListener('change', pageSizeChangeListener);
        }

        pageSizeChangeListener = (e) => {
            tablePaginationState.pageSize = parseInt(e.target.value);
            tablePaginationState.currentPage = 0; // Reset to first page
            debouncedRenderTable(); // Use debounced version to prevent rapid re-renders
        };

        pageSizeSelect.addEventListener('change', pageSizeChangeListener);
    }

    // Add pagination button handlers with cleanup (buttons are now in header)
    if (totalPages > 1) {
        const prevBtn = document.getElementById('tablePrevPage');
        const nextBtn = document.getElementById('tableNextPage');

        if (prevBtn) {
            // Remove old listener to prevent accumulation
            if (tablePrevPageListener) {
                prevBtn.removeEventListener('click', tablePrevPageListener);
            }

            tablePrevPageListener = () => {
                if (tablePaginationState.currentPage > 0) {
                    tablePaginationState.currentPage--;
                    renderTable();
                }
            };

            prevBtn.addEventListener('click', tablePrevPageListener);
        }

        if (nextBtn) {
            // Remove old listener to prevent accumulation
            if (tableNextPageListener) {
                nextBtn.removeEventListener('click', tableNextPageListener);
            }

            tableNextPageListener = () => {
                if (tablePaginationState.currentPage < totalPages - 1) {
                    tablePaginationState.currentPage++;
                    renderTable();
                }
            };

            nextBtn.addEventListener('click', tableNextPageListener);
        }
    }

    // Add reset columns button handler with cleanup
    const resetBtn = document.getElementById('resetTableColumns');
    if (resetBtn) {
        // Remove old listener to prevent accumulation
        if (resetTableColumnsListener) {
            resetBtn.removeEventListener('click', resetTableColumnsListener);
        }

        resetTableColumnsListener = () => {
            // Reset column visibility and order to defaults
            tableState.columnVisibility = {};
            tableState.columnOrder = [];
            saveState();
            renderTable();
        };

        resetBtn.addEventListener('click', resetTableColumnsListener);
    }

    // Add column picker dropdown handlers
    const columnPickerBtn = document.getElementById('columnPickerBtn');
    const columnPickerDropdown = document.getElementById('columnPickerDropdown');
    const closeColumnPickerBtn = document.getElementById('closeColumnPicker');

    if (columnPickerBtn && columnPickerDropdown) {
        // Toggle dropdown visibility
        columnPickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = columnPickerDropdown.style.display === 'block';
            columnPickerDropdown.style.display = isVisible ? 'none' : 'block';
        });

        // Close button handler
        if (closeColumnPickerBtn) {
            closeColumnPickerBtn.addEventListener('click', () => {
                columnPickerDropdown.style.display = 'none';
            });
        }

        // Handle checkbox changes
        const checkboxes = columnPickerDropdown.querySelectorAll('.column-toggle');
        checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const columnId = e.target.dataset.columnId;
                const isChecked = e.target.checked;

                // Update column visibility state
                tableState.columnVisibility[columnId] = isChecked;
                saveState();
                renderTable();
            });
        });

        // Close dropdown when clicking outside
        // Store old listener reference before creating new one to prevent memory leaks
        const oldListener = columnPickerDocListener;
        if (oldListener) {
            document.removeEventListener('click', oldListener);
        }

        columnPickerDocListener = (e) => {
            const dropdown = document.getElementById('columnPickerDropdown');
            const btn = document.getElementById('columnPickerBtn');
            if (dropdown && !dropdown.contains(e.target) && e.target !== btn) {
                dropdown.style.display = 'none';
            }
        };

        document.addEventListener('click', columnPickerDocListener);
    }

    // Add click and keyboard handlers to table rows
    const rows = boardEl.querySelectorAll('.table-row');
    let selectedRow = null;

    for (const row of rows) {
        const cardId = row.dataset.id;
        const card = tableRows.find(c => c.id === cardId);
        if (!card) continue;

        row.style.cursor = 'pointer';
        row.setAttribute('tabindex', '0');

        // Single click: select/highlight row
        row.addEventListener('click', (e) => {
            // Remove previous selection
            if (selectedRow) {
                selectedRow.classList.remove('selected');
            }
            // Highlight this row
            row.classList.add('selected');
            selectedRow = row;
            row.focus();
        });

        // Double-click: open edit form
        row.addEventListener('dblclick', (e) => {
            openDetail(card);
        });

        // Keyboard navigation
        row.addEventListener('keydown', (e) => {
            const currentIndex = Array.from(rows).indexOf(row);

            if (e.key === 'Enter') {
                e.preventDefault();
                openDetail(card);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextRow = rows[currentIndex + 1];
                if (nextRow) {
                    nextRow.click(); // Triggers selection
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevRow = rows[currentIndex - 1];
                if (prevRow) {
                    prevRow.click(); // Triggers selection
                }
            } else if (e.key === 'PageDown') {
                e.preventDefault();
                // Jump down by ~10 rows (approximately one screen)
                const targetIndex = Math.min(currentIndex + 10, rows.length - 1);
                rows[targetIndex]?.click();
            } else if (e.key === 'PageUp') {
                e.preventDefault();
                // Jump up by ~10 rows (approximately one screen)
                const targetIndex = Math.max(currentIndex - 10, 0);
                rows[targetIndex]?.click();
            }
        });
    }

    // Add click handlers to sortable headers
    const headers = boardEl.querySelectorAll('th.sortable');
    for (const header of headers) {
        const columnId = header.dataset.columnId;
        header.addEventListener('click', (e) => {
            handleColumnSort(columnId, e.shiftKey);
        });
    }

    // Add copy handlers for ID cells
    const idCells = boardEl.querySelectorAll('.copy-id');
    for (const cell of idCells) {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', (e) => {
            e.stopPropagation();
            const fullId = cell.dataset.fullId;
            post('issue.copyToClipboard', { text: fullId });
            toast(`Copied: ${fullId}`);
        });
    }


}

// Tree view sibling-sort options, in dropdown order.
const TREE_SORT_OPTIONS = [
    { id: 'updated_at', label: 'Updated' },
    { id: 'priority', label: 'Priority' },
    { id: 'title', label: 'Title' },
    { id: 'created_at', label: 'Created' }
];

// bd-list-style status glyphs for tree rows. The formatted status name is
// exposed via the title tooltip; the glyph + color carry it at a glance.
const TREE_STATUS_GLYPHS = {
    open: { glyph: '○', cls: 'tree-status-open' },
    in_progress: { glyph: '◐', cls: 'tree-status-in-progress' },
    blocked: { glyph: '⊘', cls: 'tree-status-blocked' },
    deferred: { glyph: '◌', cls: 'tree-status-deferred' },
    closed: { glyph: '●', cls: 'tree-status-closed' },
    tombstone: { glyph: '✕', cls: 'tree-status-tombstone' },
    pinned: { glyph: '◉', cls: 'tree-status-pinned' }
};

// Stored expansion for a tree node: explicit override, else depth default.
function isTreeNodeExpanded(id, depth) {
    const override = treeState.expandedOverrides[id];
    return typeof override === 'boolean' ? override : defaultExpanded(depth);
}

// Flip a tree node's expansion relative to its *rendered* state, so
// collapsing an auto-expanded branch behaves as the user expects. The
// override entry is deleted before being re-added so Object key order
// doubles as a least-recently-touched list for trimTreeExpanded(), and
// overrides equal to the depth default are pruned rather than stored.
function toggleTreeNode(id, depth, renderedExpanded) {
    const next = !renderedExpanded;
    delete treeState.expandedOverrides[id];
    if (next !== defaultExpanded(depth)) {
        treeState.expandedOverrides[id] = next;
    }
    saveState();
    renderTree();
}

// Tree view rendering. Builds the displayed hierarchy from cardCache via
// the pure treeBuilder helpers, then renders flat rows whose connector
// lines (vertical guides + tee/elbow joiners) are drawn entirely in CSS.
function renderTree() {
    const matched = getFilteredCards();
    const matchedIds = new Set(matched.map(c => c.id));
    // Auto-expand only when the user has narrowed the board beyond the
    // first-load defaults (Status: Active, Priority/Type: All, empty
    // search). The Active default itself excludes closed issues, so a
    // plain "fewer matches than cards" check would force-expand every
    // branch with active descendants on a fresh board, defeating the
    // one-level default expansion.
    const searchActive = !!(filterSearch && filterSearch.value && filterSearch.value.trim());
    const filtersAtDefaults = selectionEquals(getSelectedStatuses(), STATUS_ACTIVE_VALUES)
        && selectionEquals(readSelectedStrings(filterPriorityDropdown), PRIORITY_ALL_VALUES)
        && selectionEquals(getSelectedTypes(), TYPE_ALL_VALUES);
    const filterActive = searchActive || !filtersAtDefaults;
    const roots = buildDisplayTree([...cardCache.values()], matchedIds, treeState.sort);
    const rows = flattenVisibleRows(roots, isTreeNodeExpanded, filterActive);
    const rowsById = new Map(rows.map(r => [r.id, r]));

    const sortOptions = TREE_SORT_OPTIONS.map(opt =>
        `<option value="${opt.id}" ${treeState.sort.id === opt.id ? 'selected' : ''}>${opt.label}</option>`
    ).join('');

    let treeHtml = `
        <div class="tree-view">
            <div class="tree-controls">
                <label for="treeSortSelect">Sort siblings by:</label>
                <select id="treeSortSelect" class="tree-sort-select">${sortOptions}</select>
                <button class="btn" id="treeSortDirBtn" title="Toggle sort direction">${treeState.sort.dir === 'asc' ? '▲ Asc' : '▼ Desc'}</button>
                <span class="pagination-info">Showing ${rows.length} of ${cardCache.size} issues</span>
            </div>
            <div class="tree-rows" id="treeRows">
    `;

    for (const row of rows) {
        const card = cardCache.get(row.id);
        if (!card) { continue; }
        const type = card.issue_type || 'task';
        const priority = typeof card.priority === 'number' ? card.priority : 2;
        const status = card.status || 'open';
        const guides = row.guides.map(bar =>
            `<span class="tree-guide ${bar ? 'tree-guide-bar' : 'tree-guide-blank'}"></span>`
        ).join('');
        const joiner = row.depth > 0
            ? `<span class="tree-elbow${row.isLast ? ' tree-elbow-last' : ''}"></span>`
            : '';
        const caret = row.hasChildren
            ? `<span class="tree-caret" data-id="${escapeHtml(row.id)}" title="${row.expanded ? 'Collapse' : 'Expand'}">${row.expanded ? '▾' : '▸'}</span>`
            : '<span class="tree-caret tree-caret-spacer"></span>';
        const statusInfo = TREE_STATUS_GLYPHS[status] || TREE_STATUS_GLYPHS.open;
        // bd-list row order: status glyph, id, priority, type, then title;
        // only the assignee remains right-aligned.
        treeHtml += `<div class="tree-row${row.matches ? '' : ' tree-dimmed'}" data-id="${escapeHtml(row.id)}">`
            + guides + joiner + caret
            + `<span class="tree-status ${sanitizeClassName(statusInfo.cls)}" data-status="${safe(formatStatusValue(status))}">${statusInfo.glyph}</span>`
            + `<span class="tree-id copy-id" data-full-id="${escapeHtml(card.id)}" title="Click to copy: ${safe(card.id)}">${escapeHtml(card.id)}</span>`
            + `<span class="badge ${sanitizeClassName('badge-priority-' + priority)}">P${priority}</span>`
            + `<span class="badge ${sanitizeClassName('badge-type-' + type)}">${escapeHtml(type)}</span>`
            + `<span class="tree-title" title="${safe(card.title || '')}">${escapeHtml(card.title || '')}</span>`
            + (card.assignee ? `<span class="badge badge-assignee">${escapeHtml(card.assignee)}</span>` : '')
            + '</div>';
    }

    treeHtml += `
            </div>
        </div>
    `;

    // Apply DOMPurify to tree HTML for defense-in-depth
    boardEl.innerHTML = DOMPurify.sanitize(treeHtml, purifyConfig);

    // The elements below are recreated on every renderTree() call (innerHTML
    // replacement), so attaching fresh listeners here cannot accumulate.
    const sortSelect = document.getElementById('treeSortSelect');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            treeState.sort = { ...treeState.sort, id: e.target.value };
            saveState();
            renderTree();
        });
    }

    const sortDirBtn = document.getElementById('treeSortDirBtn');
    if (sortDirBtn) {
        sortDirBtn.addEventListener('click', () => {
            treeState.sort = { ...treeState.sort, dir: treeState.sort.dir === 'asc' ? 'desc' : 'asc' };
            saveState();
            renderTree();
        });
    }

    const treeRowsEl = document.getElementById('treeRows');
    if (!treeRowsEl) { return; }

    // tabindex is not in the DOMPurify ALLOWED_ATTR list; set it after
    // sanitization (same pattern as the table rows).
    const rowEls = treeRowsEl.querySelectorAll('.tree-row');
    for (const rowEl of rowEls) {
        rowEl.setAttribute('tabindex', '0');
    }

    // One delegated listener for carets, copy-id affordances, and row bodies.
    treeRowsEl.addEventListener('click', (e) => {
        const caretEl = e.target.closest('.tree-caret');
        if (caretEl && caretEl.dataset.id) {
            e.stopPropagation();
            const row = rowsById.get(caretEl.dataset.id);
            if (row) {
                toggleTreeNode(row.id, row.depth, row.expanded);
            }
            return;
        }
        const copyEl = e.target.closest('.copy-id');
        if (copyEl && copyEl.dataset.fullId) {
            e.stopPropagation();
            post('issue.copyToClipboard', { text: copyEl.dataset.fullId });
            toast(`Copied: ${copyEl.dataset.fullId}`);
            return;
        }
        const rowEl = e.target.closest('.tree-row');
        if (rowEl && rowEl.dataset.id) {
            const card = cardCache.get(rowEl.dataset.id);
            if (card) {
                openDetail(card);
            }
        }
    });

    treeRowsEl.addEventListener('keydown', (e) => {
        const rowEl = e.target.closest('.tree-row');
        if (!rowEl || !rowEl.dataset.id) { return; }
        const row = rowsById.get(rowEl.dataset.id);
        if (!row) { return; }
        const allRows = Array.from(treeRowsEl.querySelectorAll('.tree-row'));
        const currentIndex = allRows.indexOf(rowEl);

        if (e.key === 'Enter') {
            e.preventDefault();
            const card = cardCache.get(row.id);
            if (card) {
                openDetail(card);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            allRows[currentIndex + 1]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            allRows[currentIndex - 1]?.focus();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (row.hasChildren && !row.expanded) {
                toggleTreeNode(row.id, row.depth, row.expanded);
                document.querySelector(`.tree-row[data-id="${CSS.escape(row.id)}"]`)?.focus();
            }
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (row.hasChildren && row.expanded) {
                toggleTreeNode(row.id, row.depth, row.expanded);
                document.querySelector(`.tree-row[data-id="${CSS.escape(row.id)}"]`)?.focus();
            }
        }
    });
}

// Handle column sorting
function handleColumnSort(columnId, isShiftKey) {

    
    // Find existing sort for this column
    const existingIndex = tableState.sorting.findIndex(s => s.id === columnId);
    
    if (!isShiftKey) {
        // Single column sort: cycle through none -> asc -> desc -> none
        if (existingIndex === -1) {
            // Not sorted: set to asc
            tableState.sorting = [{ id: columnId, dir: 'asc' }];
        } else {
            const currentDir = tableState.sorting[existingIndex].dir;
            if (currentDir === 'asc') {
                // asc -> desc
                tableState.sorting = [{ id: columnId, dir: 'desc' }];
            } else {
                // desc -> none (clear sorting)
                tableState.sorting = [];
            }
        }
    } else {
        // Multi-column sort: shift+click adds/cycles secondary sort
        if (existingIndex === -1) {
            // Add new sort as secondary
            tableState.sorting.push({ id: columnId, dir: 'asc' });
        } else {
            const currentDir = tableState.sorting[existingIndex].dir;
            if (currentDir === 'asc') {
                // asc -> desc
                tableState.sorting[existingIndex].dir = 'desc';
            } else {
                // desc -> remove this sort
                tableState.sorting.splice(existingIndex, 1);
            }
        }
    }
    

    // Reset to first page when sorting changes (for table view server-side pagination)
    tablePaginationState.currentPage = 0;
    saveState();
    render();
}

// Graph view rendering
async function renderGraph() {
    // Guard: Prevent concurrent renders
    if (isRenderingGraph) {
        return;
    }

    isRenderingGraph = true;

    try {
        // Hide board, show graph container
        boardEl.classList.add('hidden');
        dependencyDiagram.classList.remove('hidden');

        // Initialize graph view if not already created
        if (!graphView) {
            graphView = new GraphView(dependencyDiagram, {
                onNodeClick: (card) => {
                    openDetail(card);
                },
                onNodeDrag: (nodeId, x, y) => {
                    // TODO: Save node positions to state
                    console.log(`Node ${nodeId} dragged to ${x}, ${y}`);
                }
            });
        }

        // Get all cards (apply filters) - these are EnrichedCard without dependencies
        const enrichedCards = getFilteredCards();

        // Batch-load full details with dependencies for graph rendering
        const fullCards = [];
        for (const card of enrichedCards) {
            // Use the same getIssueFull mechanism that the detail form uses
            const fullCard = await new Promise((resolve, reject) => {
                const reqId = requestId();
                const timeoutId = setTimeout(() => {
                    if (pendingRequests.has(reqId)) {
                        pendingRequests.delete(reqId);
                        reject(new Error(`Timeout loading ${card.id}`));
                    }
                }, 30000);

                pendingRequests.set(reqId, { resolve, reject, timeoutId, createdAt: Date.now() });
                vscode.postMessage({ type: 'issue.getFull', requestId: reqId, payload: { id: card.id } });
            });

            // Extract the card from the response (response is the full message object)
            if (fullCard && fullCard.payload && fullCard.payload.card) {
                fullCards.push(fullCard.payload.card);
            }
        }

        // Build graph data
        const layoutOptions = {
            direction: graphState.direction,
            focusMode: graphState.focusMode,
            focusNodeId: graphState.focusNodeId,
            focusDepth: graphState.focusDepth
        };

        // Render the graph with full card data (includes parent, children, blocks, blocked_by)
        const layout = graphView.render(fullCards, layoutOptions);

        // Update stats
        if (nodeCountEl && edgeCountEl) {
            nodeCountEl.textContent = layout.nodes.length;
            edgeCountEl.textContent = layout.edges.length;
        }

        // Populate sidebar issue list
        populateGraphSidebar(enrichedCards);

        // Wire up context menu actions (only once)
        if (!graphView.contextMenuWired) {
            setupGraphContextMenu();
            graphView.contextMenuWired = true;
        }
    } catch (error) {
        console.error('[Graph] Render error:', error);
        toast('Failed to render graph: ' + error.message);
    } finally {
        // Always clear the rendering flag
        isRenderingGraph = false;
    }
}

function populateGraphSidebar(cards) {
    const issueList = document.getElementById('graphIssueList');
    if (!issueList) return;

    issueList.innerHTML = '';

    for (const card of cards) {
        const item = document.createElement('div');
        item.className = 'graph-issue-item';
        item.setAttribute('data-issue-id', card.id);

        const idSpan = document.createElement('span');
        idSpan.className = 'issue-id';
        idSpan.textContent = card.id;

        const titleSpan = document.createElement('span');
        titleSpan.className = 'issue-title';
        titleSpan.textContent = card.title;

        item.appendChild(idSpan);
        item.appendChild(titleSpan);

        // Click to focus on node in graph
        item.addEventListener('click', () => {
            if (graphView) {
                graphView.clearSelection();
                const node = graphView.currentNodes.find(n => n.id === card.id);
                if (node) {
                    graphView.selectNode(node, false);
                    // Center view on selected node
                    graphView.centerView([node]);
                }
            }
        });

        issueList.appendChild(item);
    }
}

function setupGraphContextMenu() {
    const contextMenu = document.getElementById('graphContextMenu');
    if (!contextMenu) return;

    contextMenu.addEventListener('click', (e) => {
        const action = e.target.getAttribute('data-action');
        if (!action || e.target.classList.contains('disabled')) return;

        if (action === 'link') {
            linkSelectedIssues();
        } else if (action === 'unlink') {
            unlinkSelectedIssues();
        } else if (action === 'focus') {
            focusOnSelectedNode();
        }

        contextMenu.classList.add('hidden');
    });
}

function linkSelectedIssues() {
    if (!graphView || graphView.selectedNodeIds.size < 2) {
        console.warn('Need at least 2 selected nodes to link');
        return;
    }

    const selectedIds = Array.from(graphView.selectedNodeIds);
    // Link first node to all others (parent-child or blocks relationship)
    const fromId = selectedIds[0];
    for (let i = 1; i < selectedIds.length; i++) {
        const toId = selectedIds[i];
        post('issue.addDependency', {
            id: fromId,
            otherId: toId,
            type: 'blocks'
        });
    }

    setTimeout(() => {
        post('board.refresh');
    }, 200);
}

function unlinkSelectedIssues() {
    if (!graphView || graphView.selectedNodeIds.size === 0) {
        console.warn('Need at least 1 selected node to unlink');
        return;
    }

    const selectedIds = Array.from(graphView.selectedNodeIds);
    // Remove all dependencies between selected nodes
    for (let i = 0; i < selectedIds.length; i++) {
        for (let j = i + 1; j < selectedIds.length; j++) {
            post('issue.removeDependency', {
                id: selectedIds[i],
                otherId: selectedIds[j]
            });
            post('issue.removeDependency', {
                id: selectedIds[j],
                otherId: selectedIds[i]
            });
        }
    }

    setTimeout(() => {
        post('board.refresh');
    }, 200);
}

function focusOnSelectedNode() {
    if (!graphView || graphView.selectedNodeIds.size === 0) {
        console.warn('Need a selected node to focus');
        return;
    }

    const selectedId = Array.from(graphView.selectedNodeIds)[0];
    graphState.focusMode = true;
    graphState.focusNodeId = selectedId;

    const focusModeToggle = document.getElementById('focusModeToggle');
    if (focusModeToggle) {
        focusModeToggle.checked = true;
    }

    renderGraph();
}

// Removed duplicate escapeHtml function - using the DOM-based implementation at line ~284 instead

// View toggle event listeners
viewKanbanBtn.addEventListener("click", () => {
    if (viewMode !== 'kanban') {
        viewMode = 'kanban';
        viewKanbanBtn.classList.add('active');
        viewTableBtn.classList.remove('active');
        viewGraphBtn.classList.remove('active');
        viewTreeBtn.classList.remove('active');
        boardEl.classList.remove('hidden');
        dependencyDiagram.classList.add('hidden');
        saveState();
        render();
    }
});

viewTableBtn.addEventListener("click", () => {
    if (viewMode !== 'table') {
        viewMode = 'table';
        viewTableBtn.classList.add('active');
        viewKanbanBtn.classList.remove('active');
        viewGraphBtn.classList.remove('active');
        viewTreeBtn.classList.remove('active');
        boardEl.classList.remove('hidden');
        dependencyDiagram.classList.add('hidden');
        saveState();
        render();
    }
});

viewGraphBtn.addEventListener("click", () => {
    if (viewMode !== 'graph') {
        viewMode = 'graph';
        viewGraphBtn.classList.add('active');
        viewKanbanBtn.classList.remove('active');
        viewTableBtn.classList.remove('active');
        viewTreeBtn.classList.remove('active');
        saveState();
        render();
    }
});

viewTreeBtn.addEventListener("click", () => {
    if (viewMode !== 'tree') {
        viewMode = 'tree';
        viewTreeBtn.classList.add('active');
        viewKanbanBtn.classList.remove('active');
        viewTableBtn.classList.remove('active');
        viewGraphBtn.classList.remove('active');
        boardEl.classList.remove('hidden');
        dependencyDiagram.classList.add('hidden');
        saveState();
        render();
    }
});

// Sync toolbar view-toggle buttons to the current viewMode. Called once at
// boot and again after persisted state is restored so the highlighted button
// matches the rendered view.
function syncViewModeButtons() {
    const buttons = {
        kanban: viewKanbanBtn,
        table: viewTableBtn,
        graph: viewGraphBtn,
        tree: viewTreeBtn
    };
    const activeKey = Object.prototype.hasOwnProperty.call(buttons, viewMode) ? viewMode : 'kanban';
    for (const [key, btn] of Object.entries(buttons)) {
        btn.classList.toggle('active', key === activeKey);
    }
    if (viewMode === 'graph') {
        boardEl.classList.add('hidden');
        dependencyDiagram.classList.remove('hidden');
    } else {
        boardEl.classList.remove('hidden');
        dependencyDiagram.classList.add('hidden');
    }
}

// Initialize view toggle buttons based on saved state
syncViewModeButtons();

// Graph control event listeners
if (focusModeToggle) {
    focusModeToggle.addEventListener('change', () => {
        graphState.focusMode = focusModeToggle.checked;
        // If enabling focus mode but no node is selected, use the first node
        if (graphState.focusMode && !graphState.focusNodeId && graphView) {
            graphState.focusNodeId = graphView.getSelectedNodeId();
        }
        if (viewMode === 'graph') {
            renderGraph();
        }
    });
}

if (focusDepthInput) {
    focusDepthInput.addEventListener('change', () => {
        graphState.focusDepth = parseInt(focusDepthInput.value, 10);
        if (viewMode === 'graph') {
            renderGraph();
        }
    });
}

if (graphDirectionSelect) {
    graphDirectionSelect.addEventListener('change', () => {
        graphState.direction = graphDirectionSelect.value;
        if (viewMode === 'graph') {
            renderGraph();
        }
    });
}

if (autoLayoutBtn) {
    autoLayoutBtn.addEventListener('click', () => {
        if (graphView && viewMode === 'graph') {
            // Clear saved positions and re-calculate layout
            graphView.clearSavedPositions();
            renderGraph();
        }
    });
}

if (resetLayoutBtn) {
    resetLayoutBtn.addEventListener('click', () => {
        if (graphView) {
            graphView.resetView();
        }
    });
}

if (centerViewBtn) {
    centerViewBtn.addEventListener('click', () => {
        if (graphView && viewMode === 'graph') {
            renderGraph(); // Re-render to center
        }
    });
}

if (zoomInBtn) {
    zoomInBtn.addEventListener('click', () => {
        if (graphView) {
            graphView.zoom(1.5);
        }
    });
}

if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', () => {
        if (graphView) {
            graphView.zoom(0.67);
        }
    });
}

if (zoomResetBtn) {
    zoomResetBtn.addEventListener('click', () => {
        if (graphView) {
            graphView.resetView();
        }
    });
}

refreshBtn.addEventListener("click", () => post("board.refresh"));
newBtn.addEventListener("click", () => {
    // Use full detail form for creating new issues
    const emptyCard = {
        id: null, // null indicates create mode
        title: "",
        description: "",
        status: "open",
        priority: 2,
        issue_type: "task",
        assignee: null,
        estimated_minutes: null,
        external_ref: null,
        due_at: null,
        defer_until: null,
        acceptance_criteria: "",
        design: "",
        notes: "",
        labels: [],
        comments: [],
        blocked_by: [],
        blocks: [],
        children: [],
        parent: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    openDetail(emptyCard);
});

repoMenuBtn.addEventListener("click", () => {
    post("repo.select");
    toast("Opening repository selector...");
});

// Apply debouncing to filter changes to prevent excessive re-renders
// Priority, Type, and Status filters use debouncedRender in checkbox handlers
filterSearch.addEventListener("input", debouncedRender);

// Clear all filters — resets to the first-load defaults (Status → Active,
// Priority → All, Type → All) and clears the search box.
clearFiltersBtn.addEventListener("click", () => {
    initFilterDefaults();
    filterSearch.value = '';
    render();
    saveState();
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
    // Detect platform-specific modifier key
    const modKey = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey;
    
    // Ignore shortcuts when typing in input fields (except Escape)
    const isTyping = e.target.tagName === 'INPUT' || 
                     e.target.tagName === 'TEXTAREA' || 
                     e.target.isContentEditable;
    
    // Escape: Close detail dialog
    if (e.key === 'Escape' && detDialog.open) {
        e.preventDefault();
        requestDetailClose();
        return;
    }
    
    // Don't trigger other shortcuts while typing (unless it's Escape)
    if (isTyping && e.key !== 'Escape') {
        // Allow Ctrl/Cmd+F even in input fields to focus search
        if (modKey && e.key.toLowerCase() === 'f') {
            // Continue to handler below
        } else {
            return;
        }
    }
    
    // Ctrl/Cmd+R: Refresh board
    if (modKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        post("board.refresh");
        toast("Refreshing board...");
        return;
    }
    
    // Ctrl/Cmd+N: New issue
    if (modKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newBtn.click();
        return;
    }
    
    // Ctrl/Cmd+F: Focus search
    if (modKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        filterSearch.focus();
        filterSearch.select();
        return;
    }
});

window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || !msg.type) {
        return;
    }


    // Handle cleanup message from extension (for proper disposal)
    if (msg.type === "webview.cleanup") {
        cleanupPendingRequests();
        return;
    }

    if (msg.type === "board.data") {
        // Validate payload structure (defense-in-depth, extension already validates with Zod)
        if (!msg.payload || typeof msg.payload !== 'object') {
            console.error('Invalid board.data payload: missing or non-object payload');
            toast('Invalid data received from extension', 'Refresh', () => location.reload());
            return;
        }

        // Clear cache to prevent stale data from deleted/modified cards
        cardCache.clear();
        cardStateLevel.clear();

        // Support both legacy flat cards array and new columnData structure
        if (msg.payload.columnData) {
            // New incremental loading format

            // Validate columns array
            columns = Array.isArray(msg.payload.columns) ? msg.payload.columns : [];

            // Validate columnData is an object
            if (typeof msg.payload.columnData !== 'object') {
                console.error('Invalid columnData: expected object');
                toast('Invalid data format', 'Refresh', () => location.reload());
                return;
            }

            // Initialize columnState from columnData
            for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
                const data = msg.payload.columnData[col];
                if (data && typeof data === 'object') {
                    columnState[col] = {
                        cards: Array.isArray(data.cards) ? data.cards : [],
                        offset: typeof data.offset === 'number' ? data.offset : 0,
                        totalCount: typeof data.totalCount === 'number' ? data.totalCount : 0,
                        hasMore: Boolean(data.hasMore),
                        loading: false
                    };
                } else {
                    // Reset to empty if not provided
                    columnState[col] = { cards: [], offset: 0, totalCount: 0, hasMore: false, loading: false };
                }
            }
        } else {
            // Legacy format: flat cards array

            // Validate arrays
            columns = Array.isArray(msg.payload.columns) ? msg.payload.columns : [];
            const cards = Array.isArray(msg.payload.cards) ? msg.payload.cards : [];

            // Distribute cards into columns
            for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
                columnState[col] = {
                    cards: [],
                    offset: 0,
                    totalCount: 0,
                    hasMore: false,
                    loading: false
                };
            }

            for (const card of cards) {
                // Validate card is an object with required properties
                if (!card || typeof card !== 'object' || !card.id) {
                    console.warn('Skipping invalid card:', card);
                    continue;
                }
                const col = columnForCard(card);
                if (columnState[col]) {
                    columnState[col].cards.push(card);
                }
            }

            // Update counts
            for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
                columnState[col].totalCount = columnState[col].cards.length;
            }
        }
        
        // Maintain backward compatibility
        boardData = msg.payload;
        readOnly = msg.payload.readOnly || false; // Extract read-only flag

        // Apply persisted UI state (sort, filters, view mode, etc.) before rendering
        // so the first paint reflects the user's saved preferences.
        applyPersistedUIState(msg.payload.uiState);

        render();
        hideLoading();

        // Resolve any pending request waiting for board data
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            // Clear timeout immediately to prevent unnecessary memory overhead
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(msg.payload);
        }
        return;
    }

    // Phase 2: Handle board.minimal response (fast loading with MinimalCard[])
    if (msg.type === "board.minimal") {

        
        const cards = msg.payload.cards || [];
        
        // Initialize columns with default kanban columns
        columns = [
            { key: "ready", title: "Ready" },
            { key: "in_progress", title: "In Progress" },
            { key: "blocked", title: "Blocked" },
            { key: "closed", title: "Closed" }
        ];
        
        // Phase 2: Populate cardCache with all MinimalCard data
        cardCache.clear();
        cardStateLevel.clear();
        for (const card of cards) {
            cardCache.set(card.id, card);
            cardStateLevel.set(card.id, 'minimal');
        }

        
        // Initialize columnState by distributing cards into columns
        for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
            columnState[col] = {
                cards: [],
                offset: 0,
                totalCount: 0,
                hasMore: false,
                loading: false
            };
        }
        
        // Distribute cards into appropriate columns
        for (const card of cards) {
            const col = columnForCard(card);
            if (columnState[col]) {
                columnState[col].cards.push(card);
            }
        }
        
        // Update counts
        for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
            columnState[col].totalCount = columnState[col].cards.length;
        }
        
        // Maintain backward compatibility with boardData
        boardData = {
            columns: columns,
            cards: cards
        };

        // Apply persisted UI state before first paint so saved sort / filters /
        // view mode are reflected immediately on fast-loading boot.
        applyPersistedUIState(msg.payload.uiState);

        render();
        hideLoading();

        // Resolve any pending request waiting for board data
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(msg.payload);
        }
        return;
    }

    if (msg.type === "board.columnData") {
        // Validate payload structure
        if (!msg.payload || typeof msg.payload !== 'object') {
            console.error('Invalid board.columnData payload: missing or non-object payload');
            return;
        }

        const { column, cards, offset, totalCount, hasMore } = msg.payload;

        // Validate column is a valid key
        if (!columnState[column]) {
            console.warn('Invalid column in board.columnData:', column);
            return;
        }

        // Validate cards is an array
        if (!Array.isArray(cards)) {
            console.error('Invalid board.columnData: cards is not an array');
            return;
        }

        // Validate numeric fields
        const validOffset = typeof offset === 'number' ? offset : 0;
        const validTotalCount = typeof totalCount === 'number' ? totalCount : cards.length;
        const validHasMore = Boolean(hasMore);

        // Update specific column
        if (validOffset === 0) {
            // Replace cards (refresh)
            columnState[column].cards = cards;
        } else {
            // Append cards (loading more)
            columnState[column].cards = [...columnState[column].cards, ...cards];
        }

        columnState[column].offset = validOffset + cards.length;
        columnState[column].totalCount = validTotalCount;
        columnState[column].hasMore = validHasMore;
        columnState[column].loading = false;
        

        render();
        
        // Resolve any pending request
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(msg.payload);
        }
        return;
    }

    if (msg.type === "mutation.error") {
        toast(msg.error || "Operation failed.");
        
        // Reject pending request
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { reject, timeoutId } = pendingRequests.get(msg.requestId);
            // Clear timeout immediately to prevent unnecessary memory overhead
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            reject(new Error(msg.error || "Operation failed"));
        }
        return;
    }

    if (msg.type === "table.pageData") {

        
        // Resolve pending request with the payload
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            // Clear timeout immediately
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(msg);  // Resolve with the full message so loadTablePage can check response.type
        }
        return;
    }

    // Phase 2: Handle issue.full response (full card details)
    if (msg.type === "issue.full") {

        
        // Resolve pending request with the full message
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            // Clear timeout immediately
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(msg);  // Resolve with the full message so loadFullIssue can check response.type
        }
        return;
    }

    // Reply to ui.confirmDiscard. It needs its own type because mutation.ok
    // resolves with no value, and this one has to carry the user's answer.
    if (msg.type === "ui.confirm.result") {
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve(Boolean(msg.payload && msg.payload.confirmed));
        }
        return;
    }

    if (msg.type === "mutation.ok") {
        // Resolve pending request
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
            const { resolve, timeoutId } = pendingRequests.get(msg.requestId);
            // Clear timeout immediately to prevent unnecessary memory overhead
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            pendingRequests.delete(msg.requestId);
            resolve();
        }
        return;
    }
});

// Initial load

// Phase 2: Load full issue details on-demand
// Checks cardStateLevel and only loads from server if needed
// Returns: Promise<FullCard>
async function loadFullIssue(issueId) {
    if (!issueId) {
        throw new Error('Issue ID is required');
    }
    
    // Check if we already have full details in cache
    const currentLevel = cardStateLevel.get(issueId);
    if (currentLevel === 'full') {

        return cardCache.get(issueId);
    }
    

    
    try {
        // Request full issue details from extension
        const response = await postAsync('issue.getFull', { id: issueId }, 'Loading issue details...');
        
        if (response.type === 'issue.full' && response.payload?.card) {
            const fullCard = response.payload.card;
            
            // Update cache with full card data
            cardCache.set(issueId, fullCard);
            cardStateLevel.set(issueId, 'full');
            

            return fullCard;
        } else {
            throw new Error('Unexpected response type: ' + response.type);
        }
    } catch (error) {

        toast('Failed to load issue details: ' + error.message);
        throw error;
    }
}

// ============================================================================
// EDIT FORM READ-BACK - Reads the form and works out what the user changed
// ============================================================================
// Reads the edit-dialog inputs into the payload shape issue.create / issue.update
// expect. Both the pre-edit baseline snapshot and the save-time read go through
// this one function on purpose: comparing values produced by two different code
// paths is how dirty-field diffing grows false positives, especially on the two
// datetime fields, which lose precision on the round trip through <input>.
function readEditFormValues(form) {
    return {
        title: form.querySelector("#editTitle").value.trim(),
        status: form.querySelector("#editStatus").value,
        issue_type: form.querySelector("#editType").value,
        priority: parseInt(form.querySelector("#editPriority").value),
        assignee: form.querySelector("#editAssignee").value.trim() || null,
        estimated_minutes: form.querySelector("#editEst").value ? parseInt(form.querySelector("#editEst").value) : null,
        external_ref: form.querySelector("#editExtRef").value.trim() || null,
        due_at: toIsoFromLocalInput(form.querySelector("#editDueAt").value),
        defer_until: toIsoFromLocalInput(form.querySelector("#editDeferUntil").value),
        description: form.querySelector("#editDesc").value,
        acceptance_criteria: form.querySelector("#editAC").value,
        design: form.querySelector("#editDesign").value,
        notes: form.querySelector("#editNotes").value,
        pinned: form.querySelector("#editPinned").checked,
        is_template: form.querySelector("#editTemplate").checked,
        ephemeral: form.querySelector("#editEphemeral").checked
    };
}

function blurNumberInputOnWheel(e) {
    if (document.activeElement === e.currentTarget) {
        e.currentTarget.blur();
    }
}

// The fields IssueUpdateSchema accepts. Keep in sync with it: anything missing
// there is stripped by Zod, so listing it here would send a payload that
// validates down to {} and reaches bd with no flags.
const UPDATABLE_EDIT_FIELDS = [
    "title", "status", "issue_type", "priority", "assignee",
    "estimated_minutes", "external_ref", "due_at", "defer_until",
    "description", "acceptance_criteria", "design", "notes",
    "pinned", "is_template", "ephemeral"
];

// Only the fields the user actually touched. Posting the whole form on every save
// means a single oversized untouched field fails validation for the entire edit —
// which is what made assignee-only edits impossible on issues carrying a long
// design. Object.is rather than !== so an empty numeric input (NaN) compares equal
// to itself and doesn't register as a change on every save.
function diffEditFormValues(baseline, current) {
    const updates = {};
    for (const key of UPDATABLE_EDIT_FIELDS) {
        if (!Object.is(current[key], baseline[key])) {
            updates[key] = current[key];
        }
    }
    return updates;
}

// ============================================================================
// STATIC FORM POPULATION - Populates the static HTML form with card data
// ============================================================================
function populateStaticEditForm(form, card, isCreateMode) {
    // Helper functions
    const setVal = (sel, val) => { const el = form.querySelector(sel); if (el) el.value = val ?? ''; };
    const setChk = (sel, val) => { const el = form.querySelector(sel); if (el) el.checked = !!val; };
    const setHtml = (sel, html) => { const el = form.querySelector(sel); if (el) el.innerHTML = DOMPurify.sanitize(html, purifyConfig); };
    
    // Header
    const header = form.querySelector('#editFormHeader');
    if (header) {
        if (isCreateMode) {
            header.innerHTML = 'Create New Issue';
        } else {
            header.innerHTML = `Edit Issue <span style="color: var(--muted); font-weight: normal; font-size: 14px;">${escapeHtml(card.id)}</span>`;
        }
    }
    
    // Basic fields
    setVal('#editTitle', card.title);
    setVal('#editStatus', card.status || 'open');
    setVal('#editType', card.issue_type || 'task');
    setVal('#editPriority', card.priority ?? 2);
    setVal('#editAssignee', card.assignee);
    setVal('#editEst', card.estimated_minutes);
    setVal('#editExtRef', card.external_ref);
    setVal('#editDueAt', toLocalDateTimeInput(card.due_at));
    setVal('#editDeferUntil', toLocalDateTimeInput(card.defer_until));
    setVal('#editDesc', card.description);
    setVal('#editAC', card.acceptance_criteria);
    setVal('#editDesign', card.design);
    setVal('#editNotes', card.notes);
    setChk('#editPinned', card.pinned);
    setChk('#editTemplate', card.is_template);
    setChk('#editEphemeral', card.ephemeral);
    
    // Save button text
    const btnSave = form.querySelector('#btnSave');
    if (btnSave) btnSave.textContent = isCreateMode ? 'Create Issue' : 'Save Changes';
    
    // Create mode comment note
    const commentNote = form.querySelector('#createModeCommentNote');
    if (commentNote) commentNote.classList.toggle('hidden', !isCreateMode);
    
    // Labels
    refreshStaticFormLabels(form, card);
    
    // Relationships
    refreshStaticFormRelationships(form, card);
    
    // Comments
    refreshStaticFormComments(form, card);
    
    // Advanced metadata
    refreshStaticFormAdvancedMetadata(form, card);
    
    // Issue datalist
    refreshStaticFormIssueDatalist(form, card);
    
    // Footer
    const footer = form.querySelector('#editFormFooter');
    if (footer) {
        if (isCreateMode) {
            footer.innerHTML = '<span>ID: Assigned on create</span><span>Created: Not yet created</span><span>Updated: Not yet created</span>';
        } else {
            let html = `<span>ID: ${escapeHtml(card.id)}</span>`;
            html += `<span>Created: ${new Date(card.created_at).toLocaleString()}</span>`;
            html += `<span>Updated: ${new Date(card.updated_at).toLocaleString()}</span>`;
            if (card.closed_at) html += `<span>Closed: ${new Date(card.closed_at).toLocaleString()}</span>`;
            footer.innerHTML = DOMPurify.sanitize(html, purifyConfig);
        }
    }
    
    // Reset markdown previews
    form.querySelectorAll('.toggle-preview').forEach(btn => {
        const targetId = btn.dataset.target;
        const textarea = form.querySelector(`#${targetId}`);
        const preview = form.querySelector(`#${targetId}-preview`);
        if (textarea && preview) {
            textarea.classList.remove('hidden');
            preview.classList.add('hidden');
            btn.textContent = 'Preview';
        }
    });
}

// Helper: format dependency for display
function formatStaticFormDep(dep) {
    const idSuffix = dep.id ? dep.id.slice(-20) : '';
    const title = dep.title || '';
    return `${escapeHtml(idSuffix)}: ${escapeHtml(title)}`;
}

function refreshStaticFormLabels(form, card) {
    const container = form.querySelector('#labelsContainer');
    if (!container) return;
    
    const labels = card.labels || [];
    if (labels.length === 0) {
        container.innerHTML = '<span class="muted-note">None</span>';
        return;
    }
    
    const html = labels.map(l => `
        <span class="label-badge">#${escapeHtml(l)}<span class="remove-label" data-label="${escapeHtml(l)}">&times;</span></span>
    `).join('');
    container.innerHTML = DOMPurify.sanitize(html, purifyConfig);
}

function refreshStaticFormRelationships(form, card) {
    // Parent
    const parentDisplay = form.querySelector('#parentDisplay');
    const removeParentBtn = form.querySelector('#removeParent');
    const parentAddRow = form.querySelector('#parentAddRow');
    
    if (parentDisplay) {
        if (card.parent) {
            parentDisplay.innerHTML = DOMPurify.sanitize(formatStaticFormDep(card.parent), purifyConfig);
            parentDisplay.classList.remove('none');
            if (removeParentBtn) removeParentBtn.classList.remove('hidden');
            if (parentAddRow) parentAddRow.classList.add('hidden');
        } else {
            parentDisplay.textContent = 'None';
            parentDisplay.classList.add('none');
            if (removeParentBtn) removeParentBtn.classList.add('hidden');
            if (parentAddRow) parentAddRow.classList.remove('hidden');
        }
    }
    
    // Blocked By
    const blockedByList = form.querySelector('#blockedByList');
    if (blockedByList) {
        const blockers = card.blocked_by || [];
        if (blockers.length === 0) {
            blockedByList.innerHTML = '';
        } else {
            const html = blockers.map(b => `<li>${formatStaticFormDep(b)} <span class="remove-dep remove-blocker" data-id="${escapeHtml(b.id)}">&times;</span></li>`).join('');
            blockedByList.innerHTML = DOMPurify.sanitize(html, purifyConfig);
        }
    }
    
    // Blocks
    const blocksList = form.querySelector('#blocksList');
    if (blocksList) {
        const blocks = card.blocks || [];
        blocksList.innerHTML = blocks.length === 0 ? '' : DOMPurify.sanitize(blocks.map(b => `<li>${formatStaticFormDep(b)}</li>`).join(''), purifyConfig);
    }
    
    // Children
    const childrenList = form.querySelector('#childrenList');
    if (childrenList) {
        const children = card.children || [];
        if (children.length === 0) {
            childrenList.innerHTML = '';
        } else {
            const html = children.map(c => `<li>${formatStaticFormDep(c)} <span class="remove-dep remove-child" data-id="${escapeHtml(c.id)}">&times;</span></li>`).join('');
            childrenList.innerHTML = DOMPurify.sanitize(html, purifyConfig);
        }
    }
}

function refreshStaticFormComments(form, card) {
    const list = form.querySelector('#commentsList');
    if (!list) return;
    
    const comments = card.comments || [];
    if (comments.length === 0) {
        list.innerHTML = '';
        return;
    }
    
    const html = comments.map(c => `
        <div class="comment">
            <div class="comment-header"><span>${escapeHtml(c.author)}</span><span>${new Date(c.created_at).toLocaleString()}</span></div>
            <div class="comment-body markdown-body">${safeRenderMarkdown(c.text || '')}</div>
        </div>
    `).join('');
    list.innerHTML = DOMPurify.sanitize(html, purifyConfig);
}

function refreshStaticFormAdvancedMetadata(form, card) {
    const container = form.querySelector('#advancedMetadata');
    const content = form.querySelector('#advancedMetadataContent');
    if (!container || !content) return;
    
    const hasData = card.event_kind || card.actor || card.target || card.payload || card.sender || 
                    card.mol_type || card.role_type || card.rig || card.agent_state || card.last_activity || 
                    card.hook_bead || card.role_bead || card.await_type || card.await_id || 
                    card.timeout_ns !== null || card.waiters;
    
    if (!hasData) {
        container.classList.add('hidden');
        return;
    }
    
    container.classList.remove('hidden');
    const fields = [
        ['Event Kind', card.event_kind], ['Actor', card.actor], ['Target', card.target],
        ['Sender', card.sender], ['Mol Type', card.mol_type], ['Role Type', card.role_type],
        ['Rig', card.rig], ['Agent State', card.agent_state],
        ['Last Activity', card.last_activity ? new Date(card.last_activity).toLocaleString() : null],
        ['Hook Bead', card.hook_bead], ['Role Bead', card.role_bead], ['Await Type', card.await_type],
        ['Await ID', card.await_id], ['Timeout (ns)', card.timeout_ns], ['Waiters', card.waiters]
    ];
    
    let html = '';
    for (const [label, value] of fields) {
        if (value !== null && value !== undefined && value !== '') {
            html += `<span class="meta-label">${label}:</span><span class="meta-value">${escapeHtml(String(value))}</span>`;
        }
    }
    if (card.payload) html += `<span class="meta-label">Payload:</span><pre>${escapeHtml(card.payload)}</pre>`;
    content.innerHTML = DOMPurify.sanitize(html, purifyConfig);
}

function refreshStaticFormIssueDatalist(form, card) {
    const datalist = form.querySelector('#issueIdOptions');
    if (!datalist) return;
    
    const allCards = [];
    for (const col of ['ready', 'in_progress', 'blocked', 'closed']) {
        if (columnState[col]?.cards) allCards.push(...columnState[col].cards);
    }
    
    datalist.innerHTML = allCards
        .filter(c => !card.id || c.id !== card.id)
        .map(c => `<option value="${escapeHtml(c.id)}" label="${escapeHtml(c.title)}"></option>`)
        .join('');
}

async function openDetail(card) {
    const thisGeneration = ++openDetailGeneration;

    if (!card) return;

    // Defensive check: ensure dialog exists
    if (!detDialog) {
        console.error('Detail dialog element not found');
        return;
    }

    // Phase 2: Load full issue details if editing existing issue
    const isCreateMode = card.id === null;
    if (!isCreateMode) {
        try {
            // Load full details from server or cache
            const fullCard = await loadFullIssue(card.id);
            if (thisGeneration !== openDetailGeneration) { return; } // stale call, abort
            // Use full card data for the rest of the function
            card = fullCard;
        } catch (error) {
            // Error already displayed by loadFullIssue()
            return;
        }
    }

    const form = detDialog.querySelector("form");
    if (!form) {
        console.error('Dialog form not found');
        return;
    }

    populateStaticEditForm(form, card, isCreateMode);

    // Snapshot the form as loaded so save can send only what changed.
    editBaselineValues = readEditFormValues(form);

    detailDirty = false;
    const dirtyFieldIds = [
        "editTitle",
        "editStatus",
        "editType",
        "editPriority",
        "editAssignee",
        "editEst",
        "editExtRef",
        "editDueAt",
        "editDeferUntil",
        "editDesc",
        "editAC",
        "editDesign",
        "editNotes",
        "editPinned",
        "editTemplate",
        "editEphemeral"
    ];
    dirtyFieldIds.forEach((id) => {
        const field = form.querySelector(`#${id}`);
        if (!field) return;
        field.removeEventListener("input", markDetailDirty);
        field.removeEventListener("change", markDetailDirty);
        field.addEventListener("input", markDetailDirty);
        field.addEventListener("change", markDetailDirty);

        // Chromium steps a focused number input on wheel events. The edit form
        // scrolls, so scrolling with the pointer over "Est. Minutes" silently
        // edits it - which is how an estimate ends up negative without anyone
        // typing. Blurring on wheel lets the dialog scroll and leaves the value
        // alone.
        if (field.type === "number") {
            field.removeEventListener("wheel", blurNumberInputOnWheel);
            field.addEventListener("wheel", blurNumberInputOnWheel, { passive: true });
        }
    });

    // Bind events
    form.querySelector("#btnClose").onclick = (e) => {
        e.preventDefault();
        requestDetailClose();
    };

    const btnSave = form.querySelector("#btnSave");
    btnSave.onclick = async (e) => {
        e.preventDefault();
        if (btnSave.disabled) { return; }
        btnSave.disabled = true;
        try {
        const current = readEditFormValues(form);

        // Create sends the whole form; update sends only what the user changed.
        let data = current;

        // In create mode, include labels, parent, blockers, and children
        if (isCreateMode) {
            if (card.labels && card.labels.length > 0) {
                data.labels = card.labels;
            }
            if (card.parent) {
                data.parent_id = card.parent.id;
            }
            if (card.blocked_by && card.blocked_by.length > 0) {
                data.blocked_by_ids = card.blocked_by.map(b => b.id);
            }
            if (card.children && card.children.length > 0) {
                data.children_ids = card.children.map(c => c.id);
            }
        } else {
            data = diffEditFormValues(editBaselineValues, current);
            if (current.title && Object.keys(data).length === 0) {
                toast("No changes to save");
                detailDirty = false;
                detDialog.close();
                return;
            }
        }

        // Guard on the form value, not the diff: an unchanged title is absent from
        // an update payload but is still a valid title.
        if (current.title) {
            try {
                if (isCreateMode) {
                    // Create new issue
                    const createResponse = await postAsync("issue.create", data, "Creating issue...");
                    const newIssueId = createResponse?.payload?.id;

                    // Post any comments that were added in create mode
                    let failedComments = 0;
                    if (newIssueId && card.comments && card.comments.length > 0) {
                        for (const comment of card.comments) {
                            try {
                                await postAsync("issue.addComment", {
                                    id: newIssueId,
                                    text: comment.text,
                                    author: comment.author
                                }, "Adding comment...");
                            } catch (commentErr) {
                                // Track failed comments but don't fail the whole operation
                                failedComments++;
                                console.error(`Failed to post comment: ${commentErr.message}`);
                            }
                        }
                    }

                    // Show appropriate success/warning message
                    if (failedComments > 0) {
                        toast(`Issue created, but ${failedComments} comment(s) failed to post`);
                    } else {
                        toast("Issue created successfully");
                    }
                } else {
                    // Update existing issue
                    await postAsync("issue.update", { id: card.id, updates: data }, "Saving changes...");
                    toast("Changes saved successfully");
                }
                detailDirty = false;
                detDialog.close();
            } catch (err) {
                // Show error feedback (mutation.error toast or timeout/network error)

                toast(`Failed to ${isCreateMode ? 'create issue' : 'save changes'}: ${err.message}`);
            }
        } else {
            toast("Title is required");
        }
        } finally {
            btnSave.disabled = false;
        }
    };

    function renderCommentsList() {
        if (!card.comments || card.comments.length === 0) {
            return '<div style="font-size: 12px; color: var(--muted); font-style: italic;">No comments yet.</div>';
        }
        return card.comments.map(c => `
            <div class="comment" style="padding: 8px; background: rgba(255,255,255,0.03); border-radius: 6px; border: 1px solid var(--border);">
                <div style="font-size: 11px; color: var(--muted); margin-bottom: 4px; display: flex; justify-content: space-between;">
                    <span>${escapeHtml(c.author)}</span>
                    <span>${new Date(c.created_at).toLocaleString()}</span>
                </div>
                <div class="markdown-body" style="font-size: 13px;">${safeRenderMarkdown(c.text)}</div>
            </div>
        `).join('');
    }

    function refreshCommentsDisplay() {
        const list = form.querySelector("#commentsList");
        if (!list) return;
        // Apply DOMPurify for defense-in-depth
        list.innerHTML = DOMPurify.sanitize(renderCommentsList(), purifyConfig);
    }

    const btnPostComment = form.querySelector("#btnPostComment");
    if (btnPostComment) {
        btnPostComment.onclick = async (e) => {
            e.preventDefault();
            const commentInput = form.querySelector("#newCommentText");
            const text = commentInput.value.trim();
            if (!text) return;

            if (isCreateMode) {
                // In create mode, just add to local array
                if (!card.comments) card.comments = [];
                card.comments.push({
                    id: Date.now(),
                    issue_id: null, // Will be set after creation
                    author: "Me",
                    text,
                    created_at: new Date().toISOString()
                });
                commentInput.value = "";
                refreshCommentsDisplay();
                toast("Comment added (will be posted on save)");
            } else {
                // In edit mode, call API
                try {
                    await postAsync("issue.addComment", { id: card.id, text, author: "Me" }, "Adding comment...");
                    if (!card.comments) card.comments = [];
                    card.comments.push({
                        id: Date.now(),
                        issue_id: card.id,
                        author: "Me",
                        text,
                        created_at: new Date().toISOString()
                    });
                    commentInput.value = "";
                    refreshCommentsDisplay();
                    toast("Comment posted");
                } catch (err) {
    
                    toast(`Failed to add comment: ${err.message}`);
                }
            }
        };
    }

// Helper function to refresh labels display in the dialog
    function refreshLabelsDisplay() {
        const labelsContainer = form.querySelector(".labels-container");
        if (!labelsContainer) return;

        const labels = card.labels || [];
        if (labels.length === 0) {
            labelsContainer.innerHTML = '<span style="font-size: 11px; font-style: italic; color: var(--muted);">None</span>';
            return;
        }

        // Apply DOMPurify for defense-in-depth
        const labelsHtml = labels.map(l => `
            <span class="badge" style="background: var(--bg2); padding: 4px 8px; border-radius: 4px; display: flex; align-items: center; gap: 4px;">
                #${escapeHtml(l)}
                <span class="remove-label" data-label="${escapeHtml(l)}" style="cursor: pointer; opacity: 0.7;">&times;</span>
            </span>
        `).join('');
        labelsContainer.innerHTML = DOMPurify.sanitize(labelsHtml, purifyConfig);
        
        // Re-attach remove handlers
        labelsContainer.querySelectorAll(".remove-label").forEach(btn => {
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Use currentTarget instead of target to ensure we get the .remove-label element
                const label = e.currentTarget.dataset.label;
                if (isCreateMode) {
                    // In create mode, just remove from local array
                    card.labels = (card.labels || []).filter(l => l !== label);
                    refreshLabelsDisplay();
                    toast("Label removed");
                } else {
                    // In edit mode, call API
                    try {
                        await postAsync("issue.removeLabel", { id: card.id, label }, "Removing label...");
                        // Update card.labels array
                        card.labels = (card.labels || []).filter(l => l !== label);
                        // Refresh the display
                        refreshLabelsDisplay();
                        toast("Label removed");
                        // Refresh board in background
                        postAsync("board.refresh", {}, "Refreshing board...");
                    } catch (err) {
        
                        toast(`Failed to remove label: ${err.message}`);
                    }
                }
            };
        });
    }

    // Label Events - supports comma-separated multiple labels
    const btnAddLabel = form.querySelector("#btnAddLabel");
    if (btnAddLabel) {
        btnAddLabel.onclick = async (e) => {
        e.preventDefault();
        const input = form.querySelector("#newLabel");
        const rawLabels = input.value.trim();
        if (!rawLabels) return;

        // Split by comma, trim, filter empties, and dedupe
        const labels = [...new Set(
            rawLabels.split(',')
                .map(l => l.trim())
                .filter(l => l.length > 0)
        )];

        if (labels.length === 0) return;

        let successCount = 0;
        let failedLabels = [];

        if (isCreateMode) {
            // In create mode, just add to local array
            for (const label of labels) {
                if (!card.labels) card.labels = [];
                if (!card.labels.includes(label)) {
                    card.labels.push(label);
                    successCount++;
                }
            }
            toast(`Added ${successCount} label${successCount > 1 ? 's' : ''}`);
            input.value = ''; // Clear input
            refreshLabelsDisplay();
        } else {
            // In edit mode, call API for each label
            for (const label of labels) {
                try {
                    await postAsync("issue.addLabel", { id: card.id, label }, "Adding label...");
                    // Update card.labels array
                    if (!card.labels) card.labels = [];
                    if (!card.labels.includes(label)) {
                        card.labels.push(label);
                    }
                    successCount++;
                } catch (err) {
    
                    failedLabels.push(label);
                }
            }

            // Show feedback
            if (successCount > 0) {
                toast(`Added ${successCount} label${successCount > 1 ? 's' : ''}`);
                input.value = ''; // Clear input on success
                // Refresh the labels display in dialog
                refreshLabelsDisplay();
                // Trigger board refresh to show new labels
                postAsync("board.refresh", {});
            }

            if (failedLabels.length > 0) {
                toast(`Failed to add: ${failedLabels.join(', ')}`);
            }
        }

        // Keep dialog open for adding more labels
    };
    }

    // Initialize remove handlers for existing labels
    refreshLabelsDisplay();

    async function refreshRelationshipsFromBoard() {
        if (!card.id) return;
        try {
            // Use issue.getFull to get the complete card with relationships
            const response = await postAsync("issue.getFull", { id: card.id }, "Refreshing relationships...");
            const updated = response?.payload?.card;
            if (updated) {
                card.parent = updated.parent;
                card.children = updated.children;
                card.blocks = updated.blocks;
                card.blocked_by = updated.blocked_by;
            }
        } catch (err) {
            console.error("Error refreshing relationships:", err);
        }
        refreshStructureSection();
    }

    function refreshStructureSection() {
        refreshStaticFormRelationships(form, card);
        ["#newParentId", "#newBlockerId", "#newChildId"].forEach((sel) => {
            const input = form.querySelector(sel);
            if (input) input.value = "";
        });
        // Re-rendering the lists drops the .remove-blocker / .remove-child handlers.
        bindStructureEvents();
    }

    function bindStructureEvents() {
        const btnSetParent = form.querySelector("#btnSetParent");
        if (btnSetParent) {
            btnSetParent.onclick = async (e) => {
                e.preventDefault();
                const parentId = form.querySelector("#newParentId").value.trim();
                if (!parentId) return;

                // Validate: prevent self-reference
                if (parentId === card.id) {
                    toast("Error: An issue cannot be its own parent");
                    return;
                }

                // Validate: check if parent issue exists
                if (!cardCache.has(parentId)) {
                    toast(`Error: Parent issue '${parentId}' does not exist`);
                    return;
                }

                // Validate: check if parent is already set
                if (card.parent && card.parent.id === parentId) {
                    toast("This parent is already set");
                    return;
                }

                if (isCreateMode) {
                    // In create mode, store parent locally
                    card.parent = { id: parentId, title: parentId }; // We'll display just the ID
                    form.querySelector("#newParentId").value = "";
                    toast("Parent set (will be applied on save)");
                    refreshStructureSection();
                } else {
                    // In edit mode, call API
                    try {
                        await postAsync("issue.addDependency", { id: card.id, otherId: parentId, type: 'parent-child' }, "Adding parent...");
                        toast("Parent set");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to set parent: ${err.message}`);
                    }
                }
            };
        }

        const removeParentBtn = form.querySelector("#removeParent");
        if (removeParentBtn) {
            removeParentBtn.onclick = async (e) => {
                if (isCreateMode) {
                    // In create mode, just remove from local object
                    card.parent = null;
                    toast("Parent unlinked");
                    refreshStructureSection();
                } else {
                    // In edit mode, call API
                    try {
                        await postAsync("issue.removeDependency", { id: card.id, otherId: card.parent.id, type: 'parent-child' }, "Removing parent...");
                        toast("Parent unlinked");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to remove parent: ${err.message}`);
                    }
                }
            };
        }

        const btnAddBlocker = form.querySelector("#btnAddBlocker");
        if (btnAddBlocker) {
            btnAddBlocker.onclick = async (e) => {
                e.preventDefault();
                const blockerId = form.querySelector("#newBlockerId").value.trim();
                if (!blockerId) return;

                // Validate: prevent self-reference
                if (blockerId === card.id) {
                    toast("Error: An issue cannot block itself");
                    return;
                }

                // Validate: check if blocker issue exists
                if (!cardCache.has(blockerId)) {
                    toast(`Error: Blocker issue '${blockerId}' does not exist`);
                    return;
                }

                if (isCreateMode) {
                    // In create mode, add to local array
                    if (!card.blocked_by) card.blocked_by = [];
                    if (!card.blocked_by.find(b => b.id === blockerId)) {
                        card.blocked_by.push({ id: blockerId, title: blockerId });
                        form.querySelector("#newBlockerId").value = "";
                        toast("Blocker added (will be applied on save)");
                        refreshStructureSection();
                    } else {
                        toast("Blocker already added");
                    }
                } else {
                    // Validate: check if blocker already exists in edit mode
                    if (card.blocked_by && card.blocked_by.find(b => b.id === blockerId)) {
                        toast("This blocker is already added");
                        return;
                    }

                    // In edit mode, call API
                    try {
                        await postAsync("issue.addDependency", { id: card.id, otherId: blockerId, type: 'blocks' }, "Adding blocker...");
                        toast("Blocker added");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to add blocker: ${err.message}`);
                    }
                }
            };
        }

        form.querySelectorAll(".remove-blocker").forEach(btn => {
            btn.onclick = async (e) => {
                const blockerId = e.target.dataset.id;
                
                if (isCreateMode) {
                    // In create mode, remove from local array
                    card.blocked_by = (card.blocked_by || []).filter(b => b.id !== blockerId);
                    toast("Blocker removed");
                    refreshStructureSection();
                } else {
                    // In edit mode, call API
                    try {
                        await postAsync("issue.removeDependency", { id: card.id, otherId: blockerId, type: 'blocks' }, "Removing blocker...");
                        toast("Blocker removed");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to remove blocker: ${err.message}`);
                    }
                }
            };
        });

        const btnAddChild = form.querySelector("#btnAddChild");
        if (btnAddChild) {
            btnAddChild.onclick = async (e) => {
                e.preventDefault();
                const childId = form.querySelector("#newChildId").value.trim();
                if (!childId) return;

                // Validate: prevent self-reference
                if (childId === card.id) {
                    toast("Error: An issue cannot be its own child");
                    return;
                }

                // Validate: check if child issue exists
                if (!cardCache.has(childId)) {
                    toast(`Error: Child issue '${childId}' does not exist`);
                    return;
                }

                if (isCreateMode) {
                    // In create mode, add to local array
                    if (!card.children) card.children = [];
                    if (!card.children.find(c => c.id === childId)) {
                        card.children.push({ id: childId, title: childId });
                        form.querySelector("#newChildId").value = "";
                        toast("Child added (will be applied on save)");
                        refreshStructureSection();
                    } else {
                        toast("Child already added");
                    }
                } else {
                    // Validate: check if child already exists in edit mode
                    if (card.children && card.children.find(c => c.id === childId)) {
                        toast("This child is already added");
                        return;
                    }

                    // In edit mode, call API
                    // Note: To add a child from the parent side, we set the parent on the child
                    try {
                        await postAsync("issue.addDependency", { id: childId, otherId: card.id, type: 'parent-child' }, "Adding child...");
                        toast("Child added");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to add child: ${err.message}`);
                    }
                }
            };
        }

        form.querySelectorAll(".remove-child").forEach(btn => {
            btn.onclick = async (e) => {
                const childId = e.target.dataset.id;
                
                if (isCreateMode) {
                    // In create mode, remove from local array
                    card.children = (card.children || []).filter(c => c.id !== childId);
                    toast("Child removed");
                    refreshStructureSection();
                } else {
                    // In edit mode, call API
                    // To remove a child, we remove the parent relationship from the child
                    try {
                        await postAsync("issue.removeDependency", { id: childId, otherId: card.id, type: 'parent-child' }, "Removing child...");
                        toast("Child removed");
                        await refreshRelationshipsFromBoard();
                    } catch (err) {
        
                        toast(`Failed to remove child: ${err.message}`);
                    }
                }
            };
        });
    }

    bindStructureEvents();

    // Context Helpers
    function getContext() {
        return `Issue: ${card.title}
ID: ${card.id}
Status: ${card.status}
Priority: P${card.priority}
Type: ${card.issue_type}
Assignee: ${card.assignee || 'Unassigned'}
Description:
${card.description || 'No description'}
Acceptance Criteria:
${card.acceptance_criteria || 'None'}
Design:
${card.design || 'None'}
`;
    }

    form.querySelector("#btnChat").onclick = (e) => {
        e.preventDefault();
        post("issue.addToChat", { text: getContext() });
        toast("Added to Chat input");
    };

    form.querySelector("#btnCopy").onclick = (e) => {
        e.preventDefault();
        post("issue.copyToClipboard", { text: getContext() });
        toast("Copying...");
    };

    // Bind Toggle Events
    form.querySelectorAll(".toggle-preview").forEach(btn => {
        btn.onclick = (e) => {
            const targetId = e.target.dataset.target;
            const textarea = form.querySelector(`#${targetId}`);
            const preview = form.querySelector(`#${targetId}-preview`);

            if (!textarea.classList.contains("hidden")) {
                // Switch to Preview
                preview.innerHTML = safeRenderMarkdown(textarea.value);
                textarea.classList.add("hidden");
                preview.classList.remove("hidden");
                e.target.textContent = "Edit";
            } else {
                // Switch to Edit
                textarea.classList.remove("hidden");
                preview.classList.add("hidden");
                e.target.textContent = "Preview";
            }
        };
    });

    // Datetime inputs use native browser datepicker (no custom Save/Cancel buttons)

    detDialog.showModal();
    // Both .dialogForm and its .edit-form-container child are scrollable:
    // .dialogForm has overflow-y: auto, and .edit-form-container's
    // `overflow-x: hidden` promotes its unset overflow-y to `auto` per CSS
    // spec. The static dialog markup is reused across opens, so any retained
    // scrollTop carries forward. Reset both so every open lands at the top.
    form.scrollTop = 0;
    const editFormContainer = form.querySelector('.edit-form-container');
    if (editFormContainer) {
        editFormContainer.scrollTop = 0;
    }
}


post("board.loadMinimal");
