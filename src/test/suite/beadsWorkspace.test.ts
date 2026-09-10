import * as assert from 'assert';
import * as path from 'path';
import {
    resolveBeadsRoot,
    describeResolution,
    BEADS_MARKER_ENTRIES,
    DEFAULT_MAX_ASCEND
} from '../../beadsWorkspace';

// The extension used to assume workspaceFolders[0]. These cases pin the
// replacement: an explicit picker choice outranks discovery, a direct hit in
// any root outranks an ancestor hit above any other root, and the fallback
// never behaves worse than the old index-0 assumption.

const probe = (withBeads: string[]) => {
    const set = new Set(withBeads);
    return (repoRoot: string) => set.has(repoRoot);
};

const ROOT_A = path.join(path.sep, 'work', 'alpha');
const ROOT_B = path.join(path.sep, 'work', 'beta');
const NESTED = path.join(ROOT_A, 'src', 'webview');

suite('resolveBeadsRoot', () => {
    test('no workspace folders yields no root', () => {
        const result = resolveBeadsRoot({ roots: [], hasBeadsDir: probe([]) });

        assert.strictEqual(result.kind, 'none');
        assert.strictEqual(result.root, null);
    });

    test('a single root containing .beads resolves directly', () => {
        const result = resolveBeadsRoot({ roots: [ROOT_A], hasBeadsDir: probe([ROOT_A]) });

        assert.strictEqual(result.kind, 'direct');
        assert.strictEqual(result.root, ROOT_A);
    });

    test('finds .beads in the second root - the original defect', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A, ROOT_B],
            hasBeadsDir: probe([ROOT_B])
        });

        assert.strictEqual(result.kind, 'direct');
        assert.strictEqual(result.root, ROOT_B);
    });

    test('several roots with .beads: first wins, all are reported', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A, ROOT_B],
            hasBeadsDir: probe([ROOT_A, ROOT_B])
        });

        assert.strictEqual(result.kind, 'direct');
        assert.strictEqual(result.root, ROOT_A);
        assert.deepStrictEqual(result.candidates, [ROOT_A, ROOT_B]);
    });

    test('walks upward when no root contains .beads', () => {
        const result = resolveBeadsRoot({ roots: [NESTED], hasBeadsDir: probe([ROOT_A]) });

        assert.strictEqual(result.kind, 'ancestor');
        assert.strictEqual(result.root, ROOT_A);
    });

    test('a direct hit in root B beats an ancestor hit above root A', () => {
        // The two passes exist for exactly this case: a single-pass loop over
        // roots would adopt ROOT_A's parent before ever testing ROOT_B.
        const result = resolveBeadsRoot({
            roots: [NESTED, ROOT_B],
            hasBeadsDir: probe([ROOT_A, ROOT_B])
        });

        assert.strictEqual(result.kind, 'direct');
        assert.strictEqual(result.root, ROOT_B);
    });

    test('the upward walk is bounded by maxAscend', () => {
        const deep = path.join(ROOT_A, 'a', 'b', 'c', 'd', 'e', 'f', 'g');

        assert.strictEqual(
            resolveBeadsRoot({ roots: [deep], hasBeadsDir: probe([ROOT_A]), maxAscend: 2 }).kind,
            'none'
        );
        assert.strictEqual(
            resolveBeadsRoot({ roots: [deep], hasBeadsDir: probe([ROOT_A]), maxAscend: 20 }).kind,
            'ancestor'
        );
    });

    test('the upward walk terminates at the filesystem root', () => {
        // Would hang or throw if the dirname fixed point were not handled.
        const result = resolveBeadsRoot({
            roots: [path.sep],
            hasBeadsDir: probe([]),
            maxAscend: DEFAULT_MAX_ASCEND
        });

        assert.strictEqual(result.kind, 'none');
        assert.strictEqual(result.root, path.sep);
    });

    test('a valid persisted choice outranks discovery', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A],
            persisted: ROOT_B,
            hasBeadsDir: probe([ROOT_A, ROOT_B])
        });

        assert.strictEqual(result.kind, 'persisted');
        assert.strictEqual(result.root, ROOT_B);
    });

    test('a stale persisted choice is ignored', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A],
            persisted: path.join(path.sep, 'gone'),
            hasBeadsDir: probe([ROOT_A])
        });

        assert.strictEqual(result.kind, 'direct');
        assert.strictEqual(result.root, ROOT_A);
    });

    test('an empty persisted value is ignored', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A],
            persisted: '',
            hasBeadsDir: probe([ROOT_A])
        });

        assert.strictEqual(result.kind, 'direct');
    });

    test('falls back to the first root, never worse than the old behaviour', () => {
        const result = resolveBeadsRoot({
            roots: [ROOT_A, ROOT_B],
            hasBeadsDir: probe([])
        });

        assert.strictEqual(result.kind, 'none');
        assert.strictEqual(result.root, ROOT_A);
    });

    // bd keeps global state at ~/.beads on some machines. Climbing into it
    // makes every command fail against a repository that does not exist, and
    // the marker check alone does not cover it: a global bd install can leave
    // a genuine-looking .beads there.
    suite('the upward walk refuses $HOME', () => {
        const HOME = path.join(path.sep, 'Users', 'someone');
        const UNDER_HOME = path.join(HOME, 'scratch', 'notes');

        test('does not adopt $HOME even when it probes positive', () => {
            const result = resolveBeadsRoot({
                roots: [UNDER_HOME],
                hasBeadsDir: probe([HOME]),
                homeDir: HOME
            });

            assert.strictEqual(result.kind, 'none');
            assert.strictEqual(result.root, UNDER_HOME);
        });

        test('a trailing separator on homeDir still matches', () => {
            const result = resolveBeadsRoot({
                roots: [UNDER_HOME],
                hasBeadsDir: probe([HOME]),
                homeDir: HOME + path.sep
            });

            assert.strictEqual(result.kind, 'none');
        });

        test('the walk continues past $HOME rather than stopping at it', () => {
            const above = path.join(path.sep, 'Users');
            const result = resolveBeadsRoot({
                roots: [UNDER_HOME],
                hasBeadsDir: probe([above]),
                homeDir: HOME
            });

            assert.strictEqual(result.kind, 'ancestor');
            assert.strictEqual(result.root, above);
        });

        test('$HOME opened as a workspace root still resolves directly', () => {
            // Refusing it here would break anyone who genuinely keeps a
            // repository at $HOME; only the climb is untrustworthy.
            const result = resolveBeadsRoot({
                roots: [HOME],
                hasBeadsDir: probe([HOME]),
                homeDir: HOME
            });

            assert.strictEqual(result.kind, 'direct');
            assert.strictEqual(result.root, HOME);
        });

        test('$HOME chosen through the picker still resolves', () => {
            const result = resolveBeadsRoot({
                roots: [ROOT_A],
                persisted: HOME,
                hasBeadsDir: probe([HOME]),
                homeDir: HOME
            });

            assert.strictEqual(result.kind, 'persisted');
            assert.strictEqual(result.root, HOME);
        });

        test('an absent homeDir leaves the walk unrestricted', () => {
            const result = resolveBeadsRoot({
                roots: [UNDER_HOME],
                hasBeadsDir: probe([HOME])
            });

            assert.strictEqual(result.kind, 'ancestor');
            assert.strictEqual(result.root, HOME);
        });
    });
});

suite('BEADS_MARKER_ENTRIES', () => {
    // The probe must answer "bd can read this", not "something bd-related
    // touched this". Both excluded names identify a directory bd 1.x cannot
    // open, which is the failure the marker check exists to prevent.
    test('excludes the legacy SQLite database', () => {
        assert.ok(
            !BEADS_MARKER_ENTRIES.includes('beads.db'),
            'bd 1.x reports Dolt as the only supported backend; a SQLite .beads is unreadable'
        );
    });

    test('excludes the JSONL export', () => {
        assert.ok(
            !BEADS_MARKER_ENTRIES.includes('issues.jsonl'),
            'issues.jsonl is an optional export for interchange, so alone it marks a copied artifact'
        );
    });

    test('covers Windows client mode, which has no local dolt directory', () => {
        const withoutDolt = BEADS_MARKER_ENTRIES.filter(
            (entry) => entry !== 'dolt' && entry !== 'embeddeddolt'
        );
        assert.ok(
            withoutDolt.length > 0,
            'a client-mode checkout must still be recognised without dolt/ present'
        );
        assert.ok(withoutDolt.includes('metadata.json'));
    });
});

suite('describeResolution', () => {
    test('names the chosen root for every kind', () => {
        const kinds = [
            resolveBeadsRoot({ roots: [ROOT_A], hasBeadsDir: probe([ROOT_A]) }),
            resolveBeadsRoot({ roots: [ROOT_A, ROOT_B], hasBeadsDir: probe([ROOT_A, ROOT_B]) }),
            resolveBeadsRoot({ roots: [NESTED], hasBeadsDir: probe([ROOT_A]) }),
            resolveBeadsRoot({ roots: [ROOT_A], persisted: ROOT_B, hasBeadsDir: probe([ROOT_B]) })
        ];

        for (const resolution of kinds) {
            assert.ok(describeResolution(resolution).includes(resolution.root as string));
        }
    });

    test('says so when nothing is open', () => {
        const described = describeResolution(resolveBeadsRoot({ roots: [], hasBeadsDir: probe([]) }));

        assert.ok(described.length > 0);
        assert.ok(!described.includes('null'));
    });
});
