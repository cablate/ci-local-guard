import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFailedTests, formatFailedTest } from '../src/test-reports.mjs';

const playwrightSummary = [
  '  2 failed',
  '    tests/e2e/spa/scale-distribution-layout.spec.mjs:8:1 › keeps a 1–10 presenter distribution ...',
  '    tests/e2e/spa/student-workflow.spec.mjs:766:5 › 1. join ... › traffic baseline ...',
  '  1 flaky',
  '    tests/e2e/spa/flaky.spec.mjs:3:1 › retries until green',
  '  210 passed (4:32)',
].join('\n');

test('a Playwright summary block lists the failed tests, never the flaky ones', () => {
  assert.deepEqual(extractFailedTests(playwrightSummary), [
    { name: 'keeps a 1–10 presenter distribution ...', location: { file: 'tests/e2e/spa/scale-distribution-layout.spec.mjs', line: 8, column: 1 }, source: 'playwright' },
    { name: '1. join ... › traffic baseline ...', location: { file: 'tests/e2e/spa/student-workflow.spec.mjs', line: 766, column: 5 }, source: 'playwright' }]);
});

test('the entry list ends at a blank line, a shallower line or another summary line', () => {
  const ended = ['  1 failed', '    a.spec.ts:1:2 › first failure', '    a.spec.ts:1:2 › first failure',
    '', '    b.spec.ts:9:9 › after a blank line', '  1 flaky', '    c.spec.ts:3:4 › flaky is not a failure',
    'a line at a shallower indent', '    d.spec.ts:4:5 › after a shallower line'].join('\n');
  const tests = extractFailedTests(ended);
  assert.deepEqual(tests.map(entry => entry.name), ['first failure'], 'duplicates collapse and later blocks are not entries');
});

test('Vitest FAIL lines become name-only entries and repeat lines are deduplicated', () => {
  const vitest = ['RUN v2.1.9 D:/repo', ' FAIL  tests/unit/cart.test.ts > pricing > applies the discount',
    'FAIL tests/unit/cart.test.ts > pricing > applies the discount', 'FAIL tests/unit/io.test.ts > writes the file',
    '', ' Test Files  2 failed (2)'].join('\n');
  assert.deepEqual(extractFailedTests(vitest), [
    { name: 'tests/unit/cart.test.ts > pricing > applies the discount', location: null, source: 'vitest' },
    { name: 'tests/unit/io.test.ts > writes the file', location: null, source: 'vitest' }]);
});

test('leading GitHub job-log timestamps are tolerated', () => {
  const stamped = ['2026-10-01T00:00:06.1234567Z   1 failed', '2026-10-01T00:00:06.1234567Z     a.spec.ts:5:6 › stamped',
    '2026-10-01T00:00:06.1234567Z  FAIL tests/unit/stamped.test.ts > suite > case'].join('\n');
  assert.deepEqual(extractFailedTests(stamped).map(({ name, source }) => ({ name, source })), [
    { name: 'stamped', source: 'playwright' }, { name: 'tests/unit/stamped.test.ts > suite > case', source: 'vitest' }]);
});

test('at most 20 failed tests are returned', () => {
  const many = ['  25 failed', ...Array.from({ length: 25 }, (_, index) => `    tests/gen/a${index}.spec.ts:${index + 1}:1 › generated ${index}`)].join('\n');
  const tests = extractFailedTests(many);
  assert.equal(tests.length, 20);
  assert.equal(tests[0].name, 'generated 0');
  assert.equal(tests.at(-1).name, 'generated 19');
});

test('formatFailedTest renders file:line with the title, or the title alone, cut at 300 characters', () => {
  assert.equal(formatFailedTest({ name: '1. join ... › traffic baseline ...',
    location: { file: 'tests/e2e/spa/student-workflow.spec.mjs', line: 766, column: 5 } }),
  'tests/e2e/spa/student-workflow.spec.mjs:766 › 1. join ... › traffic baseline ...');
  assert.equal(formatFailedTest({ name: 'tests/unit/io.test.ts > writes the file', location: null }),
    'tests/unit/io.test.ts > writes the file');
  const long = formatFailedTest({ name: 't'.repeat(400), location: { file: 'a.spec.ts', line: 12, column: 3 } });
  assert.equal(long.length, 300);
  assert.ok(long.startsWith('a.spec.ts:12 › tttt'));
  assert.equal(formatFailedTest({ name: 'plain', location: undefined }).length, 5);
});
