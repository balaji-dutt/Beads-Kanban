// Markup builders for the toolbar filter dropdowns and the edit-dialog
// Priority/Type selects. Two callers render these blocks: the shipped webview
// (src/webview.ts) and the standalone visual test server
// (scripts/visual-test-server.js). Both must build them from here.
//
// A dropdown that falls behind ./filterUniverse fails silently rather than
// loudly: initFilterDefaults() writes a selection for checkboxes that do not
// exist, readSelectedStrings() reads back a smaller set, and the board shows
// "N selected" with cards missing instead of "All".
//
// Stays free of `vscode`, `zod` and the DOM so the harness can load it. Every
// value comes from a compile-time constant in ./filterUniverse, so none of it
// needs escaping.

import {
  STATUS_ALL_VALUES,
  STATUS_ACTIVE_VALUES,
  PRIORITY_ALL_VALUES,
  TYPE_ALL_VALUES
} from './filterUniverse';
import {
  formatStatusValue,
  formatTypeValue,
  formatPriorityValue
} from './webview/filterStateMachine';

function filterOption(value: string, label: string, checked: boolean): string {
  return `<label class="status-option"><input type="checkbox" value="${value}"${checked ? ' checked' : ''} /> ${label}</label>`;
}

function presetOption(preset: string, label: string, checked: boolean): string {
  return `<label class="status-option"><input type="checkbox" value="" data-preset="${preset}"${checked ? ' checked' : ''} /> ${label}</label>`;
}

function selectOption(value: string, label: string): string {
  return `<option value="${value}">${label}</option>`;
}

// The caller supplies the first row's indent from its own template; this joins
// the rest to match.
function renderRows(rows: string[], indent: string): string {
  return rows.join(`\n${indent}`);
}

export function buildPriorityFilterRows(indent: string): string {
  return renderRows([
    presetOption('all', 'All', true),
    ...PRIORITY_ALL_VALUES.map(v => filterOption(v, formatPriorityValue(v), true))
  ], indent);
}

export function buildTypeFilterRows(indent: string): string {
  return renderRows([
    presetOption('all', 'All', true),
    ...TYPE_ALL_VALUES.map(v => filterOption(v, formatTypeValue(v), true))
  ], indent);
}

// Status boots at the "Active" preset, mirroring `bd list`, so only the active
// values start checked.
export function buildStatusFilterRows(indent: string): string {
  return renderRows([
    presetOption('all', 'All', false),
    presetOption('active', 'Active', true),
    ...STATUS_ALL_VALUES.map(v => filterOption(
      v,
      formatStatusValue(v),
      (STATUS_ACTIVE_VALUES as readonly string[]).includes(v)
    ))
  ], indent);
}

export function buildEditPriorityOptions(indent: string): string {
  return renderRows(
    PRIORITY_ALL_VALUES.map(v => selectOption(v, formatPriorityValue(v))),
    indent
  );
}

export function buildEditTypeOptions(indent: string): string {
  return renderRows(
    TYPE_ALL_VALUES.map(v => selectOption(v, v)),
    indent
  );
}
