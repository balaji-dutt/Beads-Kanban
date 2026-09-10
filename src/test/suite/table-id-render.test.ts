import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Issue IDs must never be left-truncated for display: the tail is the least
// distinguishing part, so `mock-000001`.slice(-8) reads as `k-000001` and
// matches nothing the reader can search for. board.js is read as source text
// because these three render sites are string templates with no seam a unit
// test can call: the table view's ID column, its copy-confirmation toast, and
// the edit dialog's dependency lists.

const BOARD_JS_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'webview', 'board.js');

suite('Table ID rendering regression', () => {
    let source: string;

    suiteSetup(() => {
        source = fs.readFileSync(BOARD_JS_PATH, 'utf8');
    });

    test('table ID column render uses the full ID, not the last 8 characters', () => {
        const renderMatch = source.match(
            /render:\s*\(c\)\s*=>\s*`<span class="table-id copy-id"[^`]*`/
        );
        assert.ok(renderMatch, 'expected to find the table ID column render function');
        const rendered = renderMatch![0];
        assert.ok(
            !/c\.id\.slice\(-8\)/.test(rendered),
            'table ID render must not truncate via c.id.slice(-8)'
        );
        assert.ok(
            /\$\{escapeHtml\(c\.id\)\}<\/span>/.test(rendered),
            'table ID render must emit the escaped full ID inside the span'
        );
    });

    test('copy-to-clipboard toast reports the full ID, not the last 8 characters', () => {
        const toastMatch = source.match(
            /post\('issue\.copyToClipboard',\s*\{\s*text:\s*fullId\s*\}\);[\s\S]{0,200}?toast\(`Copied:[^`]*`\)/
        );
        assert.ok(toastMatch, 'expected to find the copy-id click handler');
        const handler = toastMatch![0];
        assert.ok(
            !/fullId\.slice\(-8\)/.test(handler),
            'copy toast must not truncate via fullId.slice(-8)'
        );
        assert.ok(
            /toast\(`Copied:\s*\$\{fullId\}`\)/.test(handler),
            'copy toast must report the full clipboard contents'
        );
    });

    test('dependency list render uses the full ID, not the last 20 characters', () => {
        const fnMatch = source.match(
            /function formatStaticFormDep\(dep\)\s*\{[\s\S]*?\n\}/
        );
        assert.ok(fnMatch, 'expected to find formatStaticFormDep');
        const fn = fnMatch![0];
        assert.ok(
            !/\.slice\(-20\)/.test(fn),
            'dependency render must not truncate via id.slice(-20)'
        );
        assert.ok(
            /<span class="dep-id">\$\{escapeHtml\(id\)\}<\/span>/.test(fn),
            'dependency render must emit the escaped full ID inside a .dep-id span'
        );
    });
});
