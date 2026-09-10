import * as assert from 'assert';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../webview';
import {
    STATUS_ALL_VALUES,
    STATUS_ACTIVE_VALUES,
    PRIORITY_ALL_VALUES,
    TYPE_ALL_VALUES
} from '../../filterUniverse';

suite('Webview Security Tests', () => {
    let mockWebview: vscode.Webview;
    let mockUri: vscode.Uri;

    setup(() => {
        // Create mock webview
        const panel = vscode.window.createWebviewPanel(
            'test',
            'Test',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        mockWebview = panel.webview;
        mockUri = vscode.Uri.file(__dirname);
        panel.dispose();
    });

    test('CSP: Has strict default-src none', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        assert.ok(html.includes("default-src 'none'"), 'CSP should have default-src none');
    });

    test('CSP: No unsafe-inline in script-src', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        const cspMatch = html.match(/script-src ([^;]+)/);
        assert.ok(cspMatch, 'CSP should have script-src directive');
        assert.ok(!cspMatch[1].includes('unsafe-inline'), 'script-src should not allow unsafe-inline');
    });

    test('CSP: Has nonce-based script execution', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        const cspMatch = html.match(/script-src ([^;]+)/);
        assert.ok(cspMatch, 'CSP should have script-src directive');
        assert.ok(cspMatch[1].includes("'nonce-"), 'script-src should use nonce');
    });

    test('CSP: Restricts img-src to webview context only', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        const cspMatch = html.match(/img-src ([^;]+)/);
        assert.ok(cspMatch, 'CSP should have img-src directive');
        // VS Code's webview.cspSource may include scoped https domains (e.g., https://*.vscode-cdn.net)
        // We want to ensure it's not unrestricted (just "https:" by itself)
        const imgSrc = cspMatch[1].trim();
        // Check it's not just "https:" which would allow any https URL
        assert.ok(!imgSrc.match(/\bhttps:\s*(?:;|$)/), 'img-src should not allow unrestricted https');
        // Should include webview source or data: URIs
        assert.ok(imgSrc.includes('data:') || imgSrc.includes('vscode') || imgSrc.includes('https://'),
                 'img-src should allow data: URIs or webview resources');
    });

    test('CSP: Has base-uri none', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        assert.ok(html.includes("base-uri 'none'"), 'CSP should restrict base-uri');
    });

    test('CSP: Has form-action none', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        assert.ok(html.includes("form-action 'none'"), 'CSP should restrict form actions');
    });

    test('Nonce: Generated uniquely per request', () => {
        const html1 = getWebviewHtml(mockWebview, mockUri);
        const html2 = getWebviewHtml(mockWebview, mockUri);

        const nonce1 = html1.match(/nonce-([a-f0-9]+)/)?.[1];
        const nonce2 = html2.match(/nonce-([a-f0-9]+)/)?.[1];

        assert.ok(nonce1, 'First HTML should have nonce');
        assert.ok(nonce2, 'Second HTML should have nonce');
        assert.notStrictEqual(nonce1, nonce2, 'Nonces should be unique per request');
        assert.ok(nonce1.length >= 16, 'Nonce should be at least 16 characters (cryptographically secure)');
    });

    test('DOMPurify: Script is included for sanitization', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        assert.ok(html.includes('purify'), 'HTML should include DOMPurify library');
    });

    // Replaces a test skipped since v0.0.3 because it looked for an input id
    // ("newTitle") that no longer exists anywhere in the source - so un-skipping
    // it would only have failed on a missing element. The concern it was written
    // for is real: an input that accepts more than the schema allows becomes a
    // save-time validation failure, which is exactly how the unbounded estimate
    // field bit us.
    //
    // Bounds are asserted only on short single-line inputs. The markdown
    // textareas are deliberately left unbounded: maxlength truncates a paste
    // silently, and quietly losing part of a pasted plan document is worse than
    // a clear "Too big" message on save.
    test('Field bounds: capped text inputs carry a matching maxlength', () => {
        const html = getWebviewHtml(mockWebview, mockUri);

        const bounded: Array<[string, number]> = [
            ['editTitle', 500],      // IssueUpdateSchema: title max 500
            ['editAssignee', 100],   // assignee max 100
            ['editExtRef', 200]      // external_ref max 200
        ];

        for (const [id, cap] of bounded) {
            const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
            assert.ok(input, `Should have an input with id="${id}"`);
            assert.ok(
                input![0].includes(`maxlength="${cap}"`),
                `#${id} should carry maxlength="${cap}" to match the schema, got: ${input![0]}`
            );
        }
    });

    test('Field bounds: the estimate input cannot go negative', () => {
        const html = getWebviewHtml(mockWebview, mockUri);
        const input = html.match(/<input[^>]*id="editEst"[^>]*>/);

        assert.ok(input, 'Should have an input with id="editEst"');
        assert.ok(
            input![0].includes('min="0"'),
            `#editEst should carry min="0"; the schema rejects negatives, got: ${input![0]}`
        );
    });

    // A value present in a universe but missing from its dropdown cannot be
    // selected, and under inclusive-multiselect every card carrying it is then
    // filtered out of all four views with no way to select it back in. These
    // assert the rendered markup covers each universe, so hardcoding the rows
    // again would fail here rather than in a user's board.
    suite('Filter markup tracks the universes', () => {
        function dropdownRows(html: string, id: string): string {
            const block = html.match(
                new RegExp(`<div id="${id}" class="status-dropdown hidden">([\\s\\S]*?)</div>`)
            );
            assert.ok(block, `Should have a dropdown with id="${id}"`);
            return block![1];
        }

        function selectOptions(html: string, id: string): string {
            const block = html.match(
                new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`)
            );
            assert.ok(block, `Should have a select with id="${id}"`);
            return block![1];
        }

        const cases: Array<[string, string, readonly string[]]> = [
            ['filterPriorityDropdown', 'priority', PRIORITY_ALL_VALUES],
            ['filterTypeDropdown', 'type', TYPE_ALL_VALUES],
            ['filterStatusDropdown', 'status', STATUS_ALL_VALUES]
        ];

        for (const [dropdownId, label, universe] of cases) {
            test(`the ${label} dropdown has a checkbox for every universe value`, () => {
                const rows = dropdownRows(getWebviewHtml(mockWebview, mockUri), dropdownId);
                for (const value of universe) {
                    assert.ok(
                        rows.includes(`<input type="checkbox" value="${value}"`),
                        `#${dropdownId} is missing a row for "${value}"`
                    );
                }
                // Preset rows carry value="" and a data-preset attribute, so the
                // value rows are exactly the universe and nothing else.
                const valueRows = rows.match(/<input type="checkbox" value="[^"]+"/g) || [];
                assert.strictEqual(
                    valueRows.length,
                    universe.length,
                    `#${dropdownId} should have exactly ${universe.length} value rows`
                );
            });
        }

        test('the status dropdown checks exactly the active values by default', () => {
            const rows = dropdownRows(getWebviewHtml(mockWebview, mockUri), 'filterStatusDropdown');
            for (const value of STATUS_ALL_VALUES) {
                const row = rows.match(
                    new RegExp(`<input type="checkbox" value="${value}"[^>]*>`)
                );
                assert.ok(row, `Should have a status row for "${value}"`);
                const active = (STATUS_ACTIVE_VALUES as readonly string[]).includes(value);
                assert.strictEqual(
                    row![0].includes(' checked'),
                    active,
                    `"${value}" should ${active ? '' : 'not '}start checked`
                );
            }
        });

        test('the edit dialog Priority select offers every priority', () => {
            const options = selectOptions(getWebviewHtml(mockWebview, mockUri), 'editPriority');
            for (const value of PRIORITY_ALL_VALUES) {
                assert.ok(
                    options.includes(`<option value="${value}">`),
                    `#editPriority is missing an option for "${value}"`
                );
            }
        });

        test('the edit dialog Type select offers every type', () => {
            const options = selectOptions(getWebviewHtml(mockWebview, mockUri), 'editType');
            for (const value of TYPE_ALL_VALUES) {
                assert.ok(
                    options.includes(`<option value="${value}">`),
                    `#editType is missing an option for "${value}"`
                );
            }
        });
    });
});
