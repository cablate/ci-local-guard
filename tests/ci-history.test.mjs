import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, collectHistory, historyCi, historyOptions, measure, tapDurations, testTiming } from '../src/ci-history.mjs';

const sha = 'a'.repeat(40);
const at = s => new Date(Date.UTC(2026, 9, 1, 0, 0, s)).toISOString();
const job = (name, conclusion, start, end, labels = ['ubuntu-latest'], failedStep) => ({ name, conclusion, started_at: at(start), completed_at: at(end), labels,
  steps: failedStep ? [{ name: failedStep, conclusion: 'failure' }] : [] });
const entry = (id, attempt, conclusion, jobs, extra = {}) => ({ run: { id, run_attempt: attempt, head_sha: sha, head_branch: 'main', event: 'push',
  conclusion, created_at: at(0), run_started_at: at(0), ...extra }, jobs: { total_count: jobs.length, jobs } });

test('wait time ends at the last job; billable minutes round each job up', () => {
  const m = measure(entry(1, 1, 'success', [job('a', 'success', 5, 65), job('b', 'success', 5, 6)]));
  assert.equal(m.waitSeconds, 65);
  assert.equal(m.jobSeconds, 61);
  assert.equal(m.billableMinutes, 2, '60s -> 1 min, 1s -> 1 min');
  assert.equal(m.timingComplete, true);
});

test('skipped jobs are not billed and are counted separately', () => {
  const neverStarted = { name: 'gate', conclusion: 'skipped', labels: [], steps: [] };
  const m = measure(entry(1, 1, 'success', [job('build', 'success', 0, 60), job('matrix (skip-me)', 'skipped', 0, 0), neverStarted]));
  assert.equal(m.billableMinutes, 1, 'GitHub does not bill skipped or never-started jobs');
  assert.equal(m.skippedJobs, 2);
  assert.equal(m.jobSeconds, 60, 'a skipped job contributes no seconds');
  assert.equal(m.timingComplete, false, 'the never-started job still has no timing');
});

const workflowPath = '.github/workflows/ci.yml';
const names = new Map([['test (ubuntu-latest)', { job: 'test', matrix: { os: 'ubuntu-latest' } }],
  ['test (windows-latest)', { job: 'test', matrix: { os: 'windows-latest' } }], ['build', { job: 'build', matrix: {} }]]);
const failed = { jobs: [{ name: 'test (ubuntu-latest)', conclusion: 'failure', failedSteps: ['npm test'] },
  { name: 'test (windows-latest)', conclusion: 'failure', failedSteps: [] }, { name: 'build', conclusion: 'failure', failedSteps: [] },
  { name: 'renamed', conclusion: 'failure', failedSteps: [] }, { name: 'lint', conclusion: 'success', failedSteps: [] }] };

test('each failed hosted job is compared with the local verify of the same commit', () => {
  const verify = { outcome: 'expected-to-fail', notVerified: [],
    expectedFailures: [{ kind: 'replay', workflow: workflowPath, job: 'test', matrix: { os: 'ubuntu-latest' }, jobs: [{ job: 'build', result: 'success' }, { job: 'test', result: 'failure' }],
      failures: [{ step: 'npm test', failedTests: ['adds'] }] }],
    passedLocally: [], hostedOnly: [{ workflow: workflowPath, job: 'test', matrix: { os: 'windows-latest' }, reason: 'runner windows-latest has no local Linux stand-in' }] };
  const result = Object.fromEntries(classify(failed, verify, workflowPath, names).map(item => [item.name, item.class]));
  assert.deepEqual(result, { 'test (ubuntu-latest)': 'reproduced-locally', 'test (windows-latest)': 'outside-local-coverage',
    build: 'passed-locally', renamed: 'undetermined' }, 'build passed inside the replay of test; renamed jobs are never guessed');
  const blocked = classify({ jobs: [failed.jobs[0]] }, { outcome: 'incomplete', expectedFailures: [], passedLocally: [], hostedOnly: [],
    notVerified: [{ workflow: workflowPath, job: 'test', matrix: { os: 'ubuntu-latest' }, reason: 'act-unavailable' }] }, workflowPath, names);
  assert.deepEqual([blocked[0].class, blocked[0].reason], ['undetermined', 'act-unavailable']);
});

test('collection lists completed runs across pages and reads every attempt, so reruns do not hide failures', () => {
  const calls = [];
  const runs = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, run_attempt: i === 0 ? 2 : 1, head_sha: sha }));
  const get = endpoint => {
    calls.push(endpoint);
    if (endpoint.includes('/workflows/')) return { workflow_runs: endpoint.endsWith('page=1') ? runs.slice(0, 2) : runs.slice(2) };
    const [, id, attempt] = /runs\/(\d+)\/attempts\/(\d+)/.exec(endpoint).map(Number);
    if (endpoint.includes('/jobs')) return { total_count: 1, jobs: [{ id: 9, name: 'a', conclusion: attempt === 1 && id === 1 ? 'failure' : 'success', started_at: at(1), completed_at: at(2) }] };
    return { id, run_attempt: attempt, head_sha: sha, head_branch: 'main', event: 'push', conclusion: attempt === 1 && id === 1 ? 'failure' : 'success', workflow_id: 5,
      repository: { full_name: 'o/r' }, run_started_at: at(0) };
  };
  const exported = collectHistory({ repository: 'o/r', workflow: 'ci.yml', limit: 3 }, { get: endpoint => {
    // per_page caps at the limit, so a 3-run request pages by 3 here; force two pages with a smaller listing.
    return get(endpoint.replace('per_page=3', 'per_page=3'));
  } });
  assert.deepEqual(exported.runs.map(x => [x.run.id, x.run.run_attempt, x.run.conclusion]), [[1, 2, 'success'], [1, 1, 'failure'], [2, 1, 'success']]);
  assert.ok(calls.every(endpoint => endpoint.startsWith('repos/o/r/actions/')));
  assert.throws(() => collectHistory({ repository: 'o/r', workflow: 'ci.yml', limit: 1 }, { get: endpoint => endpoint.includes('/workflows/')
    ? { workflow_runs: [{ id: 1, run_attempt: 1, head_sha: sha }] } : { id: 1, run_attempt: 1, head_sha: 'b'.repeat(40) } }), /identity/);
});

test('TAP durations are read from timestamped GitHub logs, nested tests included', () => {
  const log = ['2026-10-01T00:00:01.0000000Z # Subtest: outer', '2026-10-01T00:00:01.1Z     ok 1 - inner', '2026-10-01T00:00:01.2Z       duration_ms: 12.5',
    '2026-10-01T00:00:01.3Z ok 1 - outer', '2026-10-01T00:00:01.4Z   ---', '2026-10-01T00:00:01.5Z   duration_ms: 40.25',
    'not ok 2 - broken # TODO later', '  duration_ms: 3', 'ok 3 - no duration', 'ok 4 - other', '  duration_ms: 7'].join('\n');
  // "no duration" has no YAML block; the next duration belongs to "other".
  assert.deepEqual([...tapDurations(log)], [['inner', 12.5], ['outer', 40.25], ['broken', 3], ['other', 7]]);
});

test('test timing compares two legs over sampled successful attempts and reports parallelism', () => {
  const attempt = (id, steps) => measure(entry(id, 1, 'success', [
    { ...job('test (windows)', 'success', 0, 100, ['windows-latest']), id: id * 10, steps: [{ name: 'Run tests', started_at: at(0), completed_at: at(steps) }] },
    { ...job('test (ubuntu)', 'success', 0, 20), id: id * 10 + 1, steps: [] }]));
  const measured = [attempt(1, 80), attempt(2, 100), attempt(3, 90)];
  const logs = { 10: 'ok 1 - slow\n  duration_ms: 60000\nok 2 - quick\n  duration_ms: 1000', 20: 'ok 1 - slow\n  duration_ms: 70000',
    11: 'ok 1 - slow\n  duration_ms: 6000', 21: 'ok 1 - slow\n  duration_ms: 8000' };
  const result = testTiming(measured, { job: 'test (windows)', compare: 'test (ubuntu)', samples: 3, repository: 'o/r' }, (repo, id) => {
    if (!logs[id]) throw new Error('expired');
    return logs[id];
  });
  assert.equal(result.status, 'measured');
  assert.deepEqual(result.slowest[0], { test: 'slow', medianMs: 60000, compareMedianMs: 6000, ratio: 10 });
  assert.equal(result.sources.find(s => s.jobId === 30).status, 'log-unavailable');
  assert.deepEqual(result.longestStep, { name: 'Run tests', seconds: 90 });
  assert.equal(result.parallelism, 0.7);
  const none = testTiming(measured, { job: 'test (windows)', samples: 1, repository: 'o/r' }, () => 'plain output without TAP');
  assert.equal(none.status, 'no-test-durations');
});

test('options and inputs fail closed with specific codes', async () => {
  assert.throws(() => historyOptions(['--limit', '5']), /workflow-file-name-required/);
  assert.throws(() => historyOptions(['--workflow', 'ci.yml', '--limit', '500']), /invalid-limit/);
  assert.throws(() => historyOptions(['--workflow', '../x.yml']), /workflow-file-name-required/);
  const opts = historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']);
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [] });
  const unreadable = await historyCi(opts, { discover, readExport: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(unreadable.issues, [{ code: 'input-unreadable' }]);
  const invalid = await historyCi(opts, { discover, readExport: () => ({ schemaVersion: 'other' }) });
  assert.deepEqual(invalid.issues, [{ code: 'invalid-export' }]);
  const offline = await historyCi(opts, { discover, readExport: () => ({ schemaVersion: 'ci-local-guard/github-export/v1',
    runs: [entry(1, 1, 'success', [job('a', 'success', 0, 30)]), entry(2, 1, 'failure', [job('a', 'failure', 0, 90, ['windows-latest'], 'npm test'), job('b', 'skipped', 0, 0)])] }) });
  assert.equal(offline.outcome, 'measured');
  assert.deepEqual([offline.failures.count, offline.failures.billableMinutes, offline.baseline.success.waitSeconds.median], [1, 2, 30]);
  assert.equal(offline.failures.attempts[0].skippedJobs, 1);
  assert.equal(offline.nextActions[0].kind, 'classify-failures-locally');
});

test('skipped jobs stay out of per-job timing statistics', async () => {
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [] });
  const report = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']), { discover,
    readExport: () => ({ schemaVersion: 'ci-local-guard/github-export/v1',
      runs: [entry(1, 1, 'success', [job('a', 'success', 0, 30)]), entry(2, 1, 'success', [job('a', 'skipped', 0, 0)])] }) });
  const a = report.baseline.jobs.find(item => item.name === 'a');
  assert.deepEqual([a.runs, a.medianSeconds], [1, 30], 'the attempt where the job was skipped does not dilute its median');
});

// Gate fixture (issue #10 item 1): `verify` needs every other job, runs 9 s,
// and finishes last; the wait is set by the 578 s browser suite it waits for.
const gateWorkflow = { path: '.github/workflows/ci.yml', analysis: 'parsed', jobs: [
  { id: 'unit', name: null, needs: [], localReplay: { replayable: [{ matrix: {} }], hostedOnly: [], unknown: [] } },
  { id: 'browser', name: null, needs: [], localReplay: { replayable: [{ matrix: {} }], hostedOnly: [], unknown: [] } },
  { id: 'verify', name: null, needs: ['unit', 'browser'], localReplay: { replayable: [{ matrix: {} }], hostedOnly: [], unknown: [] } }] };
const gateRun = (id, conclusion, browser = 'success') => entry(id, 1, conclusion, [job('unit', 'success', 0, 120),
  job('browser', browser, 0, 578, ['ubuntu-latest'], browser === 'failure' ? 'npm run test:browser' : undefined),
  job('verify', conclusion, 580, 589)]);

test('a short gate job that only waits hands the critical path to the job it waited on', async () => {
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [gateWorkflow] });
  const report = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']), { discover,
    readExport: () => ({ schemaVersion: 'ci-local-guard/github-export/v1', runs: [gateRun(1, 'success'), gateRun(2, 'success'), gateRun(3, 'failure', 'failure')] }) });
  const critical = report.baseline.speedLeads.find(lead => lead.kind === 'critical-job');
  assert.deepEqual([critical.job, critical.finishedLastIn, critical.medianSeconds], ['browser', '2/2', 578]);
  assert.deepEqual(critical.gateJobs, [{ name: 'verify', medianSeconds: 9, gateIn: '2/2' }]);
  assert.match(critical.meaning, /verify finishes after it but only waits for it/);
  assert.deepEqual(report.failures.byJob, [{ name: 'browser', count: 1 }], 'the gate echo is not a second failure');
  assert.deepEqual(report.failures.downstreamOfFailedNeeds, [{ name: 'verify', count: 1 }]);
});

test('without a mapped workflow the gate is found from timing: it started after the job it waited on finished', async () => {
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [] });
  const report = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']), { discover,
    readExport: () => ({ schemaVersion: 'ci-local-guard/github-export/v1', runs: [gateRun(1, 'success')] }) });
  assert.equal(report.baseline.speedLeads.find(lead => lead.kind === 'critical-job').job, 'browser');
  const longLast = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']), { discover,
    readExport: () => ({ schemaVersion: 'ci-local-guard/github-export/v1',
      runs: [entry(1, 1, 'success', [job('build', 'success', 0, 100), job('deploy', 'success', 101, 400)])] }) });
  assert.equal(longLast.baseline.speedLeads.find(lead => lead.kind === 'critical-job').job, 'deploy', 'a long last job is real work, not a gate');
});

// Issue #10 item 2: 7 failed attempts, 6 of them passed later on the same commit.
const shaOf = n => n.toString(16).padStart(40, '0');
const flakyExport = () => {
  const runs = [];
  for (let i = 1; i <= 6; i++) {
    runs.push(entry(i, 1, 'failure', [job('e2e', 'failure', 0, 300, ['ubuntu-latest'], 'npm run e2e')], { head_sha: shaOf(i), run_started_at: at(i * 1000) }));
    runs.push(entry(i, 2, 'success', [job('e2e', 'success', 0, 280)], { head_sha: shaOf(i), run_started_at: at(i * 1000 + 500) }));
  }
  runs.push(entry(7, 1, 'failure', [job('e2e', 'failure', 0, 290, ['ubuntu-latest'], 'npm run e2e')], { head_sha: shaOf(7), run_started_at: at(9000) }));
  // A success that happened BEFORE a failure on the same commit does not make it flaky.
  runs.push(entry(8, 1, 'success', [job('e2e', 'success', 0, 280)], { head_sha: shaOf(8), run_started_at: at(9500) }));
  runs.push(entry(9, 1, 'failure', [job('e2e', 'failure', 0, 290, ['ubuntu-latest'], 'npm run e2e')], { head_sha: shaOf(8), run_started_at: at(9800) }));
  return { schemaVersion: 'ci-local-guard/github-export/v1', runs };
};

test('a failure that passes later on the same commit is flaky, from hosted data alone', async () => {
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [] });
  const report = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json']), { discover, readExport: flakyExport, progress: () => {} });
  assert.equal(report.failures.count, 8);
  assert.deepEqual([report.failures.flaky.attempts, report.failures.persistent.attempts], [6, 2]);
  assert.equal(report.failures.flaky.billableMinutes, 30, '6 attempts x 5 started minutes');
  assert.deepEqual(report.failures.attempts.filter(item => item.flaky).map(item => item.runId), [1, 2, 3, 4, 5, 6]);
  assert.match(report.verdict, /6 flaky: passed later on the same commit/);
  const flaky = report.nextActions.find(action => action.kind === 'investigate-flaky-failures');
  assert.deepEqual([flaky.count, flaky.jobs], [6, ['e2e']]);
  assert.ok(report.nextActions.some(action => action.kind === 'classify-failures-locally'), 'two persistent failures still deserve a local check');
});

test('--reproduce skips flaky commits, estimates from hosted job time and reports progress per commit', async () => {
  const discover = () => ({ identity: { repo: '.', repository: 'o/r' }, workflows: [{ path: '.github/workflows/ci.yml', analysis: 'parsed', jobs: [] }] });
  const replayed = [];
  const lines = [];
  const verify = async opts => { replayed.push(opts.head); return { outcome: 'clear-locally', verdict: 'ok', expectedFailures: [], passedLocally: [], hostedOnly: [], notVerified: [] }; };
  const report = await historyCi(historyOptions(['--workflow', 'ci.yml', '--input', 'x.json', '--reproduce']),
    { discover, readExport: flakyExport, verify, progress: text => lines.push(text) });
  assert.deepEqual(replayed, [shaOf(7), shaOf(8)], 'only the two commits that never passed afterwards are replayed');
  assert.equal(report.reproduction.items.filter(item => item.runClass === 'flaky').length, 6);
  assert.deepEqual([report.reproduction.estimate.commits, report.reproduction.estimate.hostedJobSeconds], [2, 580]);
  assert.equal(report.avoidable.flaky.attempts, 6);
  assert.match(lines[0], /2 commit\(s\) to replay, 6 flaky attempt\(s\) skipped/);
  assert.match(lines[1], /commit 1\/2 0{12}/);
  assert.equal(lines.length, 3);
});

test('test timing samples only jobs whose own conclusion is success', () => {
  const attempt = (id, conclusion) => measure(entry(id, 1, 'success', [{ ...job('e2e', conclusion, 0, conclusion === 'skipped' ? 0 : 50), id: id * 10, steps: [] }]));
  const fetched = [];
  const result = testTiming([attempt(1, 'skipped'), attempt(2, 'success')], { job: 'e2e', samples: 2, repository: 'o/r' },
    (repo, id) => { fetched.push(id); return 'ok 1 - a\n  duration_ms: 10'; });
  assert.deepEqual(fetched, [20], 'the skipped job has no log and is not sampled');
  assert.ok(!result.sources.some(source => source.status === 'log-unavailable'));
});
