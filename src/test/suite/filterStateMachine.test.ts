import * as assert from 'assert';
import {
    nextFilterSelection,
    computeFilterLabel,
    isPresetChecked,
    selectionEquals,
    formatStatusValue,
    formatTypeValue,
    formatPriorityValue,
    FilterUniverse
} from '../../webview/filterStateMachine';
import {
    STATUS_ALL_VALUES,
    STATUS_ACTIVE_VALUES,
    PRIORITY_ALL_VALUES,
    TYPE_ALL_VALUES
} from '../../filterUniverse';

const STATUS_ALL: readonly string[] = STATUS_ALL_VALUES;
const STATUS_ACTIVE: readonly string[] = STATUS_ACTIVE_VALUES;
const PRIORITY_ALL: readonly string[] = PRIORITY_ALL_VALUES;
const TYPE_ALL: readonly string[] = TYPE_ALL_VALUES;

const STATUS: FilterUniverse = {
    prefix: 'Status',
    allValues: STATUS_ALL,
    activeValues: STATUS_ACTIVE,
    formatValue: formatStatusValue
};
const PRIORITY: FilterUniverse = {
    prefix: 'Priority',
    allValues: PRIORITY_ALL,
    formatValue: formatPriorityValue
};
const TYPE: FilterUniverse = {
    prefix: 'Type',
    allValues: TYPE_ALL,
    formatValue: formatTypeValue
};

suite('selectionEquals', () => {
    test('equal arrays return true regardless of order', () => {
        assert.ok(selectionEquals(['a', 'b', 'c'], ['c', 'a', 'b']));
    });

    test('different sizes return false', () => {
        assert.ok(!selectionEquals(['a', 'b'], ['a', 'b', 'c']));
    });

    test('disjoint sets return false', () => {
        assert.ok(!selectionEquals(['a'], ['b']));
    });

    test('empty arrays are equal', () => {
        assert.ok(selectionEquals([], []));
    });
});

suite('nextFilterSelection — Status (preset:active)', () => {
    test('Click Active while unchecked → ACTIVE set', () => {
        const out = nextFilterSelection([...STATUS_ALL], { kind: 'preset', preset: 'active' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ACTIVE));
    });

    test('Click Active while already Active → switches to All', () => {
        const out = nextFilterSelection([...STATUS_ACTIVE], { kind: 'preset', preset: 'active' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ALL));
    });

    test('Click Active from empty (None) → ACTIVE set', () => {
        const out = nextFilterSelection([], { kind: 'preset', preset: 'active' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ACTIVE));
    });

    test('Click Active from arbitrary subset → ACTIVE set', () => {
        const out = nextFilterSelection(['open', 'closed'], { kind: 'preset', preset: 'active' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ACTIVE));
    });
});

suite('nextFilterSelection — Status (preset:all)', () => {
    test('Click All while unchecked (None) → ALL set', () => {
        const out = nextFilterSelection([], { kind: 'preset', preset: 'all' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ALL));
    });

    test('Click All while already All → clears to []', () => {
        const out = nextFilterSelection([...STATUS_ALL], { kind: 'preset', preset: 'all' }, STATUS);
        assert.deepStrictEqual(out, []);
    });

    test('Click All from Active subset → ALL set', () => {
        const out = nextFilterSelection([...STATUS_ACTIVE], { kind: 'preset', preset: 'all' }, STATUS);
        assert.ok(selectionEquals(out, STATUS_ALL));
    });
});

suite('nextFilterSelection — individual toggles', () => {
    test('Toggle a value not in current → adds it', () => {
        const out = nextFilterSelection(['open'], { kind: 'individual', value: 'blocked' }, STATUS);
        assert.ok(selectionEquals(out, ['open', 'blocked']));
    });

    test('Toggle a value already in current → removes it', () => {
        const out = nextFilterSelection(['open', 'blocked'], { kind: 'individual', value: 'blocked' }, STATUS);
        assert.ok(selectionEquals(out, ['open']));
    });

    test('Toggle the only value → empties to []', () => {
        const out = nextFilterSelection(['open'], { kind: 'individual', value: 'open' }, STATUS);
        assert.deepStrictEqual(out, []);
    });

    test('Result order follows universe order (deterministic)', () => {
        const out = nextFilterSelection(['closed', 'open'], { kind: 'individual', value: 'blocked' }, STATUS);
        // universe order: open, in_progress, blocked, deferred, closed, tombstone, pinned
        assert.deepStrictEqual(out, ['open', 'blocked', 'closed']);
    });
});

suite('nextFilterSelection — Priority (no Active preset)', () => {
    test('Click All while All → clears to []', () => {
        const out = nextFilterSelection([...PRIORITY_ALL], { kind: 'preset', preset: 'all' }, PRIORITY);
        assert.deepStrictEqual(out, []);
    });

    test('Click All while None → ALL set', () => {
        const out = nextFilterSelection([], { kind: 'preset', preset: 'all' }, PRIORITY);
        assert.ok(selectionEquals(out, PRIORITY_ALL));
    });

    test('Click Active preset on Priority is a no-op (no activeValues defined)', () => {
        const out = nextFilterSelection(['0', '1'], { kind: 'preset', preset: 'active' }, PRIORITY);
        // Returns a fresh copy of the input rather than throwing.
        assert.ok(selectionEquals(out, ['0', '1']));
    });
});

suite('nextFilterSelection — purity', () => {
    test('Does not mutate the input array', () => {
        const input = [...STATUS_ACTIVE];
        const inputCopy = [...input];
        nextFilterSelection(input, { kind: 'preset', preset: 'all' }, STATUS);
        assert.deepStrictEqual(input, inputCopy);
    });

    test('Same input yields same output (deterministic)', () => {
        const a = nextFilterSelection(['open'], { kind: 'individual', value: 'closed' }, STATUS);
        const b = nextFilterSelection(['open'], { kind: 'individual', value: 'closed' }, STATUS);
        assert.deepStrictEqual(a, b);
    });
});

suite('computeFilterLabel — Status', () => {
    test('Empty selection → "Status: None"', () => {
        assert.strictEqual(computeFilterLabel([], STATUS), 'Status: None');
    });

    test('Active subset → "Status: Active"', () => {
        assert.strictEqual(computeFilterLabel([...STATUS_ACTIVE], STATUS), 'Status: Active');
    });

    test('Full universe → "Status: All"', () => {
        assert.strictEqual(computeFilterLabel([...STATUS_ALL], STATUS), 'Status: All');
    });

    test('Single value → "Status: <Pretty>"', () => {
        assert.strictEqual(computeFilterLabel(['in_progress'], STATUS), 'Status: In Progress');
        assert.strictEqual(computeFilterLabel(['open'], STATUS), 'Status: Open');
    });

    test('Arbitrary multi-subset → "Status: N selected"', () => {
        assert.strictEqual(computeFilterLabel(['open', 'closed'], STATUS), 'Status: 2 selected');
    });
});

suite('computeFilterLabel — Priority/Type (no Active row)', () => {
    test('Empty → "Priority: None"', () => {
        assert.strictEqual(computeFilterLabel([], PRIORITY), 'Priority: None');
    });

    test('Full universe → "Priority: All"', () => {
        assert.strictEqual(computeFilterLabel([...PRIORITY_ALL], PRIORITY), 'Priority: All');
    });

    test('Single → "Priority: P2"', () => {
        assert.strictEqual(computeFilterLabel(['2'], PRIORITY), 'Priority: P2');
    });

    test('Type single → title-cased', () => {
        assert.strictEqual(computeFilterLabel(['bug'], TYPE), 'Type: Bug');
    });

    test('Type N selected', () => {
        assert.strictEqual(computeFilterLabel(['bug', 'task'], TYPE), 'Type: 2 selected');
    });
});

suite('isPresetChecked', () => {
    test('All preset checked iff selection equals universe', () => {
        assert.ok(isPresetChecked([...STATUS_ALL], 'all', STATUS));
        assert.ok(!isPresetChecked([...STATUS_ACTIVE], 'all', STATUS));
        assert.ok(!isPresetChecked([], 'all', STATUS));
    });

    test('Active preset checked iff selection equals active subset', () => {
        assert.ok(isPresetChecked([...STATUS_ACTIVE], 'active', STATUS));
        assert.ok(!isPresetChecked([...STATUS_ALL], 'active', STATUS));
        assert.ok(!isPresetChecked([], 'active', STATUS));
    });

    test('Active preset never checked on universes without activeValues (Priority/Type)', () => {
        assert.ok(!isPresetChecked([...PRIORITY_ALL], 'active', PRIORITY));
        assert.ok(!isPresetChecked([], 'active', TYPE));
    });
});

suite('format helpers', () => {
    test('formatStatusValue handles underscores and casing', () => {
        assert.strictEqual(formatStatusValue('in_progress'), 'In Progress');
        assert.strictEqual(formatStatusValue('open'), 'Open');
        assert.strictEqual(formatStatusValue(''), '');
    });

    test('formatTypeValue title-cases', () => {
        assert.strictEqual(formatTypeValue('bug'), 'Bug');
        assert.strictEqual(formatTypeValue('chore'), 'Chore');
    });

    test('formatPriorityValue prefixes with P', () => {
        assert.strictEqual(formatPriorityValue('0'), 'P0');
        assert.strictEqual(formatPriorityValue('3'), 'P3');
    });
});
