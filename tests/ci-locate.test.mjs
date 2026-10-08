import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaredStep, locateCi, locateOptions, readSection, stepSection } from '../src/ci-locate.mjs';

const at = s => `2026-10-01T00:00:${String(s).padStart(2, '0')}`;
const line = (s, text) => `${at(s)}.1234567Z ${text}`;
const log = [
  line(1, '##[group]Run actions/checkout@v5'), line(2, 'checked out'),
  line(3, '##[group]Run ./.github/actions/setup'), line(3, '##[group]Run npm ci'), line(4, 'installed'),
  line(5, '##[group]Run npm test'), line(6, 'not ok 1 - adds totals'), line(6, '  ---'), line(6, '  duration_ms: 3'),
  line(6, "  location: '/home/runner/work/shop/shop/tests/cart.test.mjs:12:3'"), line(6, '  error: |-'),
  line(6, '    Expected values to be strictly equal:'), line(6, '    '), line(6, "    + 'a'"), line(6, "  code: 'ERR_ASSERTION'"),
  line(6, '  stack: |-'), line(6, '    TestContext.<anonymous> (file:///home/runner/work/shop/shop/tests/cart.test.mjs:15:9)'), line(6, '  ...'),
  line(6, '# Subtest: passes'), line(6, 'ok 3 - passes'),
  line(7, 'not ok 2 - rejects negatives # TODO later'), line(7, "  location: 'D:\\\\a\\\\shop\\\\shop\\\\tests\\\\neg.test.mjs:4:1'"),
  line(7, "  error: 'boom'"), line(8, '# fail 2'), line(8, '##[error]Process completed with exit code 1.'),
  line(8, 'Post job cleanup.'), line(9, 'cleanup'),
].join('\n') + '\n';
const lines = (() => {
  const out = [];
  let offset = 0;
  for (const raw of log.split('\n').slice(0, -1)) {
    const text = raw.replace(/^\S+Z /, '');
    out.push({ start: offset, end: offset + Buffer.byteLength(raw) + 1, seconds: Date.parse(`${raw.slice(0, 19)}Z`) / 1000, text });
    offset += Buffer.byteLength(raw) + 1;
  }
  return out;
})();
const step = (number, name, start, end, conclusion = 'success') => ({ number, name, conclusion, status: 'completed',
  started_at: `${at(start)}Z`, completed_at: `${at(end)}Z` });

test('a step section ends at the next top-level header, not at headers printed inside a composite action', () => {
  const composite = stepSection(lines, step(3, 'Run ./.github/actions/setup', 3, 4));
  assert.deepEqual([lines[composite.first].text, lines[composite.last].text], ['##[group]Run ./.github/actions/setup', '##[group]Run npm test']);
  const failed = stepSection(lines, step(4, 'Run npm test', 5, 8, 'failure'));
  assert.equal(lines[failed.last].text, 'Post job cleanup.');
  const named = stepSection(lines, step(4, 'Unit tests', 5, 8, 'failure'));
  assert.equal(named.first, failed.first, 'a named step is found by its start time');
});

test('failed tests carry their workspace-relative location and first error line', () => {
  const seen = readSection(lines, stepSection(lines, step(4, 'Run npm test', 5, 8, 'failure')));
  assert.deepEqual(seen.tests.map(({ name, location, failedAt, message }) => ({ name, location, failedAt, message })), [
    { name: 'adds totals', location: { file: 'tests/cart.test.mjs', line: 12 }, failedAt: { file: 'tests/cart.test.mjs', line: 15 },
      message: ['Expected values to be strictly equal:', "+ 'a'"] },
    { name: 'rejects negatives', location: { file: 'tests/neg.test.mjs', line: 4 }, failedAt: null, message: ['boom'] }]);
  const block = lines.findIndex(l => l.text === '  ...');
  assert.equal(seen.tests[0].endByte, lines[block].end, 'the evidence of a test ends with its own YAML block');
  assert.deepEqual(seen.errors, ['Process completed with exit code 1.']);
  assert.equal(seen.tail.at(-1), '# fail 2');
});

test('workflow steps are matched by name, run line or action, never by a guess', () => {
  const job = { steps: [{ name: 'Test on ${{ matrix.os }}', run: 'npm test', line: 9 }, { run: 'npm run lint\nnpm run x', line: 11 },
    { uses: 'actions/checkout@v5', line: 5 }, { run: 'echo hi', line: 13 }, { run: 'echo hi', line: 14 }] };
  assert.equal(declaredStep(job, { os: 'ubuntu' }, 'Test on ubuntu').line, 9);
  assert.equal(declaredStep(job, {}, 'Run npm run lint').line, 11);
  assert.equal(declaredStep(job, {}, 'Run actions/checkout@v5').line, 5);
  assert.equal(declaredStep(job, {}, 'Run echo hi'), null, 'two identical steps are ambiguous');
});

const sha = 'a'.repeat(40);
const workflow = { path: '.github/workflows/ci.yml', analysis: 'parsed', jobs: [
  { id: 'test', name: null, steps: [{ name: 'Unit tests', run: 'npm test', line: 20 }],
    localReplay: { replayable: [{ os: 'ubuntu-latest' }], hostedOnly: [{ matrix: { os: 'windows-latest' }, labels: ['windows-latest'] }], unknown: [] } }] };
const run = { id: 7, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure',
  path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, workflow_id: 3 };
const job = (id, name, conclusion, steps, status = 'completed') => ({ id, name, status, conclusion, labels: [name.includes('windows') ? 'windows-latest' : 'ubuntu-latest'], steps });

function fixture(jobs, logs) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-locate-'));
  execFileSync('git', ['init', '-q', repo]);
  process.env.CI_LOCAL_GUARD_LOG_DIR = path.join(repo, 'logs');
  const deps = {
    discover: () => ({ identity: { repo, head: sha, repository: 'o/r' }, workflows: [workflow] }),
    get: endpoint => endpoint.endsWith('/runs/7') ? run : endpoint.includes('/jobs?') ? { total_count: jobs.length, jobs } : run,
    fetchLog: (repository, id) => { if (!logs[id]) throw new Error('expired'); return logs[id]; },
    platform: 'linux',
  };
  return { repo, deps, done: () => { delete process.env.CI_LOCAL_GUARD_LOG_DIR; rmSync(repo, { recursive: true, force: true }); } };
}

test('a failed run is located to job, workflow step and tests, with reproduce and replay next steps', async () => {
  const { repo, deps, done } = fixture([job(1, 'test (ubuntu-latest)', 'failure', [step(1, 'Set up job', 0, 1), step(2, 'Unit tests', 5, 8, 'failure')]),
    job(2, 'test (windows-latest)', 'success', [])], { 1: log });
  try {
    const report = await locateCi(locateOptions(['--repo', repo, '--run', '7']), deps);
    assert.equal(report.outcome, 'located');
    const [failure] = report.failures;
    assert.deepEqual([failure.workflowJob, failure.workflowLocation, failure.command], [{ id: 'test', matrix: { os: 'ubuntu-latest' } },
      { path: '.github/workflows/ci.yml', line: 20 }, 'npm test']);
    assert.deepEqual(failure.observed.failedTests.map(t => t.name), ['adds totals', 'rejects negatives']);
    assert.deepEqual(failure.local, { headMatches: true, replayable: true, sameOsAsRunner: true });
    const kinds = report.nextActions.map(a => a.kind);
    for (const kind of ['read-failed-test', 'inspect-workflow-step', 'reproduce-step-command', 'replay-failed-job', 'verify-before-next-push']) assert.ok(kinds.includes(kind), kind);
    assert.ok(report.nextActions.find(a => a.kind === 'replay-failed-job').args.includes(sha));
    const again = await locateCi(locateOptions(['--repo', repo, '--run', '7']), { ...deps, fetchLog: () => { throw new Error('not refetched'); } });
    assert.equal(again.failures[0].evidence.reused, true, 'a saved log of a completed job is reused');
  } finally { done(); }
});

test('a missing log, a runner setup failure and running jobs are reported, never as located or passed', async () => {
  const { repo, deps, done } = fixture([job(1, 'test (ubuntu-latest)', 'failure', [step(2, 'Unit tests', 5, 8, 'failure')]),
    job(2, 'test (windows-latest)', 'failure', [step(1, 'Set up job', 0, 1, 'failure')]), job(3, 'lint', null, [], 'in_progress')], {});
  try {
    const report = await locateCi(locateOptions(['--repo', repo, '--run', '7']), deps);
    assert.equal(report.outcome, 'incomplete');
    assert.deepEqual(report.issues.map(i => i.code).sort(), ['hosted-log-missing', 'hosted-log-missing', 'run-still-in-progress']);
    assert.equal(report.failures[1].stepKind, 'runner-setup');
    assert.deepEqual(report.pending, [{ runId: 7, job: 'lint', status: 'in_progress' }]);
  } finally { done(); }
});

test('options fail closed', () => {
  assert.throws(() => locateOptions(['--attempt', '2']), /attempt-requires-run/);
  assert.throws(() => locateOptions(['--run', '1', '--head', 'HEAD']), /choose-run-or-head/);
  assert.throws(() => locateOptions(['--run', '0']), /invalid-locate-options/);
  assert.throws(() => locateOptions(['--workflow', '../x.yml']), /workflow-file-name-required/);
});
