import assert from 'node:assert/strict';
import test from 'node:test';
import { auditRuns, collectRun, collectRuns, compareRuns, githubGet, inspectRuns } from '../src/ci-runs.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function fixture() {
  const run = { id: 1, run_attempt: 1, head_sha: 'a'.repeat(40), event: 'pull_request',
    head_branch: 'feature/example', head_repository: { full_name: 'example/project' },
    status: 'completed', conclusion: 'success', created_at: '2026-10-01T00:00:00Z',
    run_started_at: '2026-10-01T00:00:02Z', updated_at: '2026-10-01T01:00:00Z' };
  const job = (id, start, end) => ({ id, run_id: 1, run_attempt: 1, head_sha: run.head_sha,
    name: `job-${id}`, status: 'completed', conclusion: 'success',
    started_at: `2026-10-01T00:00:${start}Z`, completed_at: `2026-10-01T00:00:${end}Z`, labels: ['ubuntu-latest'] });
  return { schemaVersion: 'ci-local-guard/github-export/v1', repository: 'example/project',
    runs: [{ run, jobs: { total_count: 2, jobs: [job(11, '05', '15'), job(12, '05', '25')] } }] };
}

test('reference diagnostic JSON examples obey the public contracts and do not assert real coverage', () => {
  const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) => JSON.parse(match[1]));
  const exported = examples.find((item) => item.schemaVersion === 'ci-local-guard/github-export/v1');
  assert.ok(exported, 'reference needs a runnable empty export');
  const report = inspectRuns(exported);
  assert.equal(report.schemaVersion, 'ci-local-guard/run-inspection/v1');
  assert.deepEqual(report.runs, []);

});

test('public reference offline demo works through the CLI without provider access', () => {
  const readme = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
  const script = readme.match(/node --input-type=module -e "([^"\r\n]*writeFileSync\('demo-runs\.json'[^"\r\n]*)"/)?.[1];
  assert.ok(script, 'reference must contain the copyable non-empty demo');
  assert.doesNotMatch(readme, /尚未公開|有 private repo 存取權者|私下漏洞回報管道尚未確認/);
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-readme-demo-'));
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  // Deliberately no gh on PATH: this is a no-login, offline user journey.
  const options = { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' } };
  try {
    const generated = spawnSync(process.execPath, ['--input-type=module', '-e', script], options);
    assert.equal(generated.status, 0, generated.stderr);
    const inspect = spawnSync(process.execPath, [cli, 'inspect-runs', '--input', 'demo-runs.json'], options);
    assert.equal(inspect.status, 0, inspect.stderr);
    const report = JSON.parse(inspect.stdout);
    assert.equal(report.runs[0].executionWallSeconds, 60);
    assert.equal(report.runs[0].jobSumSeconds, 80);
    assert.deepEqual(report.runs[0].jobs.map((job) => job.durationSeconds), [20, 60]);
    assert.equal(report.savings, null);
    const audit = spawnSync(process.execPath, [cli, 'audit-runs', '--input', 'demo-runs.json'], options);
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).savings, null);
    assert.deepEqual(JSON.parse(audit.stdout).automaticChanges, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function collectorFixture({ attempt = 1, count = 2 } = {}) {
  const input = fixture();
  const run = { ...input.runs[0].run, run_attempt: attempt, workflow_id: 42,
    repository: { full_name: input.repository }, actor: { secret: 'discard-provider-private-payload' } };
  const jobs = Array.from({ length: count }, (_, index) => ({ ...input.runs[0].jobs.jobs[0], id: index + 11,
    run_attempt: attempt, secret: run.actor.secret }));
  return { run, jobs };
}

function withSteps() {
  const input = fixture();
  input.runs[0].jobs.jobs[0].steps = [
    { number: 1, name: 'Setup', status: 'completed', conclusion: 'success',
      started_at: '2026-09-30T17:00:05.000-07:00', completed_at: '2026-09-30T17:00:08.000-07:00' },
    { number: 2, name: 'Test', status: 'completed', conclusion: 'success',
      started_at: '2026-10-01T00:00:08Z', completed_at: '2026-10-01T00:00:14Z' },
    { number: 3, name: 'Skipped', status: 'completed', conclusion: 'skipped' },
  ];
  return input;
}

function comparisonFixture() {
  const cohort = (ids) => {
    const input = fixture();
    input.runs = ids.map((id) => {
      const entry = structuredClone(fixture().runs[0]);
      entry.run.id = id; entry.run.workflow_id = 42;
      for (const job of entry.jobs.jobs) {
        job.run_id = id; job.id += id * 100;
        job.steps = [{ number: 1, name: 'Protected tests', status: 'completed', conclusion: 'success',
          started_at: job.started_at, completed_at: job.completed_at }];
      }
      return entry;
    });
    return input;
  };
  return { schemaVersion: 'ci-local-guard/run-comparison-input/v1', before: cohort([1, 2]), after: cohort([3, 4]) };
}

test('comparison reports separate descriptive wall/job-sum changes, never attributable savings', () => {
  const input = comparisonFixture();
  for (const entry of input.after.runs) entry.jobs.jobs[1].completed_at = '2026-10-01T00:00:35Z';
  const result = compareRuns(input);
  assert.equal(result.comparisonStatus, 'observed-context-matched');
  assert.equal(result.before.metrics.executionWallSeconds.mean, 23);
  assert.equal(result.before.metrics.jobSumSeconds.mean, 30);
  assert.deepEqual(result.observedDeltaAfterMinusBefore.executionWallSeconds, { mean: 10, median: 10 });
  assert.deepEqual(result.observedDeltaAfterMinusBefore.jobSumSeconds, { mean: 10, median: 10 });
  assert.equal(result.attributionStatus, 'unverified');
  assert.equal(result.savings, null);
  assert.deepEqual(result.automaticChanges, []);
});

test('comparison requires source branch and repository and refuses cross-branch or same-name fork cohorts', () => {
  for (const mode of ['branch', 'fork', 'mixed-branch', 'missing-branch', 'missing-repository', 'null-source']) {
    const input = comparisonFixture();
    for (const [index, entry] of input.after.runs.entries()) {
      if (mode === 'branch' || (mode === 'mixed-branch' && index === 0)) entry.run.head_branch = 'main';
      if (mode === 'fork') entry.run.head_repository.full_name = 'another/project';
      if (mode === 'missing-branch') delete entry.run.head_branch;
      if (mode === 'missing-repository') delete entry.run.head_repository;
      if (mode === 'null-source') { entry.run.head_branch = null; entry.run.head_repository = null; }
    }
    const report = compareRuns(input);
    assert.equal(report.comparisonStatus, 'blocked', mode);
    assert.equal(report.observedDeltaAfterMinusBefore, null, mode);
    assert.equal(report.savings, null, mode);
    assert.ok(report.blockers.some((value) => /branch|repository/.test(value)), mode);
  }
  const legacy = fixture(); delete legacy.runs[0].run.head_branch; delete legacy.runs[0].run.head_repository;
  const inspected = inspectRuns(legacy);
  assert.equal(inspected.runs[0].headBranch, null);
  assert.equal(inspected.runs[0].headRepository, null);
  assert.ok(inspected.runs[0].warnings.some((value) => /metadata is missing/.test(value)));
  const same = comparisonFixture();
  for (const entry of same.after.runs) entry.run.head_repository.full_name = 'EXAMPLE/Project';
  assert.equal(compareRuns(same).comparisonStatus, 'observed-context-matched');
  assert.equal(compareRuns(same).after.evidence[0].headBranch, 'feature/example');
  assert.equal(compareRuns(same).after.evidence[0].headRepository, 'example/project');
});

test('source metadata is bounded, rejects malformed types without echoing payload, and detects duplicate conflicts', () => {
  for (const patch of [{ head_branch: {} }, { head_branch: '' }, { head_branch: 'private\nvalue' },
    { head_branch: 'a'.repeat(1025) }, { head_repository: {} }, { head_repository: 'private-invalid-value' },
    { head_repository: { full_name: '../project' } }, { head_repository: { full_name: 'a'.repeat(513) + '/repo' } }]) {
    const input = fixture(); Object.assign(input.runs[0].run, patch);
    assert.throws(() => inspectRuns(input), /^Error: Invalid run source metadata$/);
  }
  const input = fixture(); input.runs.push(structuredClone(input.runs[0])); input.runs[1].run.head_branch = 'main';
  assert.throws(() => inspectRuns(input), /Conflicting run attempt/);
  input.runs.pop(); input.runs[0].run.head_branch = 'feature/中文';
  assert.equal(inspectRuns(input).runs[0].headBranch, 'feature/中文');
});

test('comparison blocks profile drift, missing identities, rerun bias and overlapping evidence', () => {
  for (const mode of ['event', 'workflow', 'runner', 'scope', 'missing', 'overlap', 'cross-rerun', 'rerun', 'one']) {
    const input = comparisonFixture();
    const entry = input.after.runs[0];
    if (mode === 'event') entry.run.event = 'push';
    if (mode === 'workflow') entry.run.workflow_id = 99;
    if (mode === 'runner') entry.jobs.jobs[0].labels = ['windows-latest'];
    if (mode === 'scope') entry.jobs.jobs[0].conclusion = 'skipped';
    if (mode === 'missing') delete entry.run.workflow_id;
    if (mode === 'overlap') input.after.runs[0] = structuredClone(input.before.runs[0]);
    if (mode === 'cross-rerun') {
      entry.run.id = input.before.runs[0].run.id; entry.run.run_attempt = 2;
      for (const job of entry.jobs.jobs) { job.run_id = entry.run.id; job.run_attempt = 2; }
    }
    if (mode === 'rerun') {
      input.after.runs[1].run.id = entry.run.id; input.after.runs[1].run.run_attempt = 2;
      for (const job of input.after.runs[1].jobs.jobs) { job.run_id = entry.run.id; job.run_attempt = 2; }
    }
    if (mode === 'one') input.after.runs.pop();
    const result = compareRuns(input);
    assert.equal(result.comparisonStatus, 'blocked', mode);
    assert.ok(result.blockers.length > 0, mode);
    assert.equal(result.observedDeltaAfterMinusBefore, null, mode);
  }
});

// https://github.com/fullsend-ai/agents/issues/388: a green rollup can hide skipped protection.
test('comparison blocks hidden step-scope changes and incomplete or unsuccessful execution behind green runs', () => {
  for (const mode of ['removed', 'renamed', 'skipped', 'missing', 'empty', 'active', 'neutral', 'failed-step', 'failed-job', 'invalid-timing']) {
    const input = comparisonFixture();
    // Mutate both candidate runs: within-cohort consistency must not hide drift across cohorts.
    for (const entry of input.after.runs) {
      const job = entry.jobs.jobs[0];
      if (mode === 'removed' || mode === 'empty') job.steps = [];
      if (mode === 'renamed') job.steps[0].name = 'Only lint, tests removed';
      if (mode === 'skipped') { job.steps[0].conclusion = 'skipped'; delete job.steps[0].started_at; delete job.steps[0].completed_at; }
      if (mode === 'missing') delete job.steps;
      if (mode === 'active') { job.steps[0].status = 'in_progress'; job.steps[0].conclusion = null; }
      if (mode === 'neutral') job.steps[0].conclusion = 'neutral';
      if (mode === 'failed-step') job.steps[0].conclusion = 'failure';
      if (mode === 'failed-job') job.conclusion = 'failure';
      if (mode === 'invalid-timing') job.steps[0].completed_at = '2026-10-01T00:00:35Z';
    }
    const report = compareRuns(input);
    assert.equal(report.comparisonStatus, 'blocked', mode);
    assert.equal(report.observedDeltaAfterMinusBefore, null, mode);
    assert.equal(report.savings, null);
    assert.ok(report.blockers.some((blocker) => /step|executed-job/.test(blocker)), mode);
  }
  const missingBoth = comparisonFixture();
  for (const entry of [...missingBoth.before.runs, ...missingBoth.after.runs]) {
    for (const job of entry.jobs.jobs) delete job.steps;
  }
  const missingReport = compareRuns(missingBoth);
  assert.equal(missingReport.comparisonStatus, 'blocked');
  assert.equal(missingReport.before.invalidExecutionEvidence.length, 4);
  assert.equal(missingReport.after.invalidExecutionEvidence.length, 4);
  assert.equal(missingReport.observedDeltaAfterMinusBefore, null);
});

test('comparison uses ordered observed step identities, not input array order or duration as protection proof', () => {
  const input = comparisonFixture();
  for (const entry of [...input.before.runs, ...input.after.runs]) for (const job of entry.jobs.jobs) {
    job.steps.push({ number: 2, name: 'Intentionally unused optional step', status: 'completed', conclusion: 'skipped' });
  }
  for (const entry of input.after.runs) for (const job of entry.jobs.jobs) {
    job.steps.reverse();
    job.steps.find((step) => step.number === 1).completed_at = '2026-10-01T00:00:10Z';
  }
  const report = compareRuns(input);
  assert.equal(report.comparisonStatus, 'observed-context-matched');
  assert.equal(report.attributionStatus, 'unverified');
  assert.ok(report.missingEvidence.includes('step names/statuses do not establish commands or assertions'));
  assert.equal(report.savings, null);
});

test('comparison preserves failed/partial samples as unknown and rejects cross-repository inputs', () => {
  for (const mode of ['failure', 'cancelled', 'partial', 'empty']) {
    const input = comparisonFixture();
    if (mode === 'failure' || mode === 'cancelled') input.after.runs[0].run.conclusion = mode;
    if (mode === 'partial') input.after.runs[0].jobs.total_count = 3;
    if (mode === 'empty') input.after.runs = [];
    const result = compareRuns(input);
    assert.equal(result.after.metrics, null, mode);
    assert.equal(result.after.attempts, mode === 'empty' ? 0 : 2);
    assert.equal(result.observedDeltaAfterMinusBefore, null);
  }
  const input = comparisonFixture(); input.after.repository = 'another/repo';
  assert.throws(() => compareRuns(input), /repositories differ/);
});

test('step metadata measures explicit setup/test durations and leaves job gaps unattributed', () => {
  const input = withSteps();
  const result = inspectRuns(input).runs[0];
  assert.equal(result.jobSumSeconds, 30);
  assert.equal(result.jobs[0].stepTiming, 'observed');
  assert.equal(result.jobs[0].stepSumSeconds, 9);
  assert.equal(result.jobs[0].unattributedJobSeconds, 1);
  assert.equal(result.jobs[1].steps, null);
  const audit = auditRuns(input);
  assert.deepEqual(audit.stepRanking.map((step) => step.knownStepSeconds), [6, 3]);
  assert.equal(audit.stepRanking[0].samples[0].stepNumber, 2);
  assert.deepEqual(audit.stepEvidence, { observedJobs: 1, unmeasuredJobs: 1 });
  assert.equal(audit.savings, null);
  assert.equal(result.jobs[0].cacheState, 'unknown');
});

test('partial, overlapping, out-of-job and invalid-calendar step timings never produce measured step ranking', () => {
  for (const mode of ['active', 'missing', 'overlap', 'outside', 'calendar', 'empty']) {
    const input = withSteps();
    const job = input.runs[0].jobs.jobs[0];
    if (mode === 'active') job.steps[0].status = 'in_progress';
    if (mode === 'missing') delete job.steps[0].completed_at;
    if (mode === 'overlap') job.steps[1].started_at = '2026-10-01T00:00:07Z';
    if (mode === 'outside') job.steps[1].completed_at = '2026-10-01T00:00:16Z';
    if (mode === 'calendar') job.steps[0].started_at = '2026-02-30T17:00:05.000-07:00';
    if (mode === 'empty') job.steps = [];
    const result = inspectRuns(input).runs[0];
    assert.equal(result.jobs[0].stepSumSeconds, null, mode);
    assert.equal(result.jobs[0].unattributedJobSeconds, null, mode);
    assert.equal(result.jobSumSeconds, 30, 'step evidence must not erase valid job evidence');
    assert.deepEqual(auditRuns(input).stepRanking, [], mode);
  }
});

test('step identity and payload shape fail closed without reflecting private data', () => {
  for (const mode of ['duplicate', 'payload', 'oversized']) {
    const input = withSteps();
    const job = input.runs[0].jobs.jobs[0];
    if (mode === 'duplicate') job.steps[1].number = 1;
    if (mode === 'payload') job.steps[0].conclusion = { secret: 'private-step-value' };
    if (mode === 'oversized') job.steps = Array(1001).fill(job.steps[0]);
    assert.throws(() => inspectRuns(input), (error) => /step/.test(error.message) && !error.message.includes('private-step-value'));
  }
});

test('collector retains only bounded step timing fields and no arbitrary provider step payload', () => {
  const { run, jobs } = collectorFixture();
  jobs[0].steps = withSteps().runs[0].jobs.jobs[0].steps;
  jobs[0].steps[0].secret = 'private-step-value';
  const exported = collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) => {
    if (endpoint.includes('/workflows/')) return { workflow_runs: [run] };
    return endpoint.includes('/jobs?') ? { total_count: 2, jobs } : run;
  } });
  assert.equal(exported.runs[0].run.workflow_id, 42);
  assert.equal(exported.runs[0].jobs.jobs[0].steps.length, 3);
  assert.ok(!JSON.stringify(exported).includes('private-step-value'));
  assert.equal(auditRuns(exported).stepRanking.length, 2);
});

test('audit ranks observed execution with linked evidence, not savings or billing', () => {
  const input = fixture();
  input.runs.push(structuredClone(input.runs[0]));
  const result = auditRuns(input);
  assert.deepEqual(result.sample, { attempts: 1, measuredAttempts: 1, excludedAttempts: 0 });
  assert.equal(result.knownJobSeconds, 30);
  assert.deepEqual(result.ranking.map((group) => group.knownJobSeconds), [20, 10]);
  assert.equal(result.ranking[0].meanJobSeconds, 20);
  assert.equal(result.ranking[0].shareOfMeasuredJobSeconds, 2 / 3);
  assert.equal(result.ranking[0].samples[0].jobId, 12);
  assert.equal(result.ranking[0].workflowId, null);
  assert.equal(result.savings, null);
  assert.deepEqual(result.automaticChanges, []);
  assert.equal(result.comparisonStatus, 'insufficient-evidence');
});

test('audit excludes active and partial attempts without substituting zero', () => {
  for (const mode of ['active', 'partial', 'empty']) {
    const input = fixture();
    if (mode === 'active') input.runs[0].run.status = 'in_progress';
    if (mode === 'partial') input.runs[0].jobs.total_count = 3;
    if (mode === 'empty') input.runs = [];
    const result = auditRuns(input);
    assert.equal(result.knownJobSeconds, null);
    assert.deepEqual(result.ranking, []);
    assert.equal(result.excludedEvidence.length, mode === 'empty' ? 0 : 1);
  }
  const skipped = fixture();
  for (const job of skipped.runs[0].jobs.jobs) job.conclusion = 'skipped';
  assert.equal(auditRuns(skipped).knownJobSeconds, 0);
  assert.deepEqual(auditRuns(skipped).ranking, []);
});

test('audit separates contexts and flags same-SHA triggers without claiming redundant protection', () => {
  const input = fixture();
  const second = structuredClone(input.runs[0]);
  second.run.id = 2; second.run.event = 'push'; second.run.workflow_id = 42;
  second.run.conclusion = 'failure';
  for (const job of second.jobs.jobs) {
    job.run_id = 2; job.id += 100; job.labels = ['windows-latest']; job.conclusion = 'failure';
  }
  input.runs.push(second);
  const result = auditRuns(input);
  assert.equal(result.ranking.length, 4);
  assert.equal(result.knownJobSeconds, 60);
  assert.deepEqual(result.observations.map((item) => item.kind), ['non-success-attempt', 'same-sha-multiple-runs']);
  assert.equal(result.observations[0].knownJobSeconds, 30);
  assert.deepEqual(result.observations[1].events, ['pull_request', 'push']);
  assert.match(result.observations[1].nextAction, /does not prove/);
  second.run.id = 1; second.run.run_attempt = 2;
  for (const job of second.jobs.jobs) { job.run_id = 1; job.run_attempt = 2; }
  assert.ok(!auditRuns(input).observations.some((item) => item.kind === 'same-sha-multiple-runs'));
});

test('inspection rejects nested timing/conclusion payloads and invalid workflow identities safely', () => {
  for (const [owner, field] of [['run', 'conclusion'], ['run', 'created_at'], ['run', 'workflow_id'],
    ['job', 'conclusion'], ['job', 'completed_at']]) {
    const input = fixture();
    const target = owner === 'run' ? input.runs[0].run : input.runs[0].jobs.jobs[0];
    target[field] = { secret: 'private-payload' };
    assert.throws(() => auditRuns(input), (error) => /Invalid/.test(error.message) && !error.message.includes('private-payload'));
  }
});

test('collector uses fixed GET host, bounded transport and safe errors without provider payload', () => {
  let called;
  const result = githubGet('repos/example/project/actions/workflows/ci.yml/runs?status=completed&per_page=1&page=1', { execute: (...args) => {
    called = args;
    return { status: 0, stdout: '{"workflow_runs":[]}' };
  } });
  assert.deepEqual(result, { workflow_runs: [] });
  assert.equal(called[0], 'gh');
  assert.ok(called[1].includes('GET'));
  assert.equal(called[1][called[1].indexOf('--hostname') + 1], 'github.com');
  assert.equal(called[2].shell, false);
  assert.equal(called[2].timeout, 15000);
  for (const response of [{ status: 1, stderr: 'private-provider-error' }, { status: 0, stdout: 'private-malformed-body' }]) {
    assert.throws(() => githubGet('repos/example/project/actions/runs/1/attempts/1', { execute: () => response }), (error) => !/private/.test(error.message));
  }
  assert.throws(() => githubGet('https://evil.invalid/'), /Invalid/);
  for (const route of ['repos/../project/actions/runs/1/attempts/1', 'repos/example/project/actions/../../user',
    'repos/example/project/actions/runs/1/attempts/1/jobs?per_page=100&page=11']) {
    assert.throws(() => githubGet(route), /Invalid/);
  }
});

test('collector retains complete multi-page jobs, drops extra provider fields and replays offline', () => {
  const { run, jobs } = collectorFixture({ count: 101 });
  const requests = [];
  const exported = collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) => {
    requests.push(endpoint);
    if (endpoint.includes('/workflows/')) return { workflow_runs: [run] };
    if (!endpoint.includes('/jobs?')) return run;
    return { total_count: jobs.length, jobs: endpoint.endsWith('page=1') ? jobs.slice(0, 100) : jobs.slice(100) };
  } });
  assert.equal(exported.runs[0].jobs.jobs.length, 101);
  assert.equal(exported.collection.requests, 4);
  assert.ok(requests[2].includes('/attempts/1/jobs?'));
  assert.ok(!JSON.stringify(exported).includes('discard-provider-private-payload'));
  assert.deepEqual(exported.runs[0].run.head_repository, { full_name: 'example/project' });
  assert.equal(inspectRuns(exported).runs[0].headBranch, 'feature/example');
  assert.equal(inspectRuns(exported).runs[0].warnings.length, 0);
});

test('collector rejects listing-to-attempt source drift and strips head repository private payload', () => {
  for (const mode of ['branch', 'repository', 'removed']) {
    const { run, jobs } = collectorFixture();
    const changed = structuredClone(run);
    if (mode === 'branch') changed.head_branch = 'main';
    if (mode === 'repository') changed.head_repository.full_name = 'fork/project';
    if (mode === 'removed') changed.head_repository = null;
    assert.throws(() => collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) => {
      if (endpoint.includes('/workflows/')) return { workflow_runs: [run] };
      if (!endpoint.includes('/jobs?')) return changed;
      return { total_count: jobs.length, jobs };
    } }), /^Error: Run attempt source identity changed from listing$/);
  }
  const { run, jobs } = collectorFixture(); run.head_repository.owner = { secret: 'private-head-owner-payload' };
  const exported = collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) =>
    endpoint.includes('/workflows/') ? { workflow_runs: [run] }
      : endpoint.includes('/jobs?') ? { total_count: jobs.length, jobs } : run });
  assert.doesNotMatch(JSON.stringify(exported), /private-head-owner-payload/);
});

test('history collector fetches exact earlier attempts, bounded by total returned attempts', () => {
  const latest = collectorFixture({ attempt: 2 });
  const first = collectorFixture(); first.run.conclusion = 'failure';
  const exported = collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 2, attempts: 'history' }, { get: (endpoint) => {
    if (endpoint.includes('/workflows/')) return { workflow_runs: [latest.run] };
    const item = endpoint.includes('/attempts/2') ? latest : first;
    return endpoint.includes('/jobs?') ? { total_count: 2, jobs: item.jobs } : item.run;
  } });
  assert.deepEqual(inspectRuns(exported).runs.map(({ attempt }) => attempt), [2, 1]);
  assert.deepEqual(exported.runs.map(({ run }) => run.conclusion), ['success', 'failure']);
  assert.equal(exported.collection.returnedAttempts, 2);
});

test('exact collector binds run attempt workflow and SHA without latest listing and retains all job pages', () => {
  const { run, jobs } = collectorFixture({ attempt: 2, count: 101 });
  run.head_repository.owner = { secret: 'private-exact-run-owner' };
  const requests = [];
  const exported = collectRun({ repository: 'example/project', runId: 1, attempt: 2, workflowId: 42, head: run.head_sha,
    verified: true, approved: true }, { get: (endpoint) => {
    requests.push(endpoint);
    if (!endpoint.includes('/jobs?')) return run;
    return { total_count: 101, jobs: endpoint.endsWith('page=1') ? jobs.slice(0, 100) : jobs.slice(100) };
  } });
  assert.deepEqual(requests, ['repos/example/project/actions/runs/1/attempts/2',
    'repos/example/project/actions/runs/1/attempts/2/jobs?per_page=100&page=1',
    'repos/example/project/actions/runs/1/attempts/2/jobs?per_page=100&page=2']);
  assert.equal(exported.collection.selection, 'exact-run-attempt');
  assert.equal(exported.collection.identityCheck, 'api-request-matched');
  assert.equal(exported.collection.requests, 3);
  assert.equal(exported.collection.completedListingOnly, false);
  assert.deepEqual(exported.collection.expected, { runId: 1, attempt: 2, head: run.head_sha, workflowId: 42 });
  assert.equal(exported.collection.checkoutIdentity, 'unverified');
  assert.equal(exported.collection.hostedPolicyStatus, 'unverified');
  assert.equal(inspectRuns(exported).runs[0].attempt, 2);
  assert.equal(exported.runs[0].jobs.jobs.length, 101);
  assert.doesNotMatch(JSON.stringify(exported), /private-exact-run-owner|discard-provider-private-payload|approved/);
});

test('exact collector fails before GET for invalid identities and stops on mismatched provider identity', () => {
  const request = { repository: 'example/project', runId: 1, attempt: 1, workflowId: 42, head: 'a'.repeat(40) };
  let calls = 0;
  for (const patch of [{ repository: '../project' }, { runId: 0 }, { runId: '1' }, { runId: Number.MAX_SAFE_INTEGER + 1 },
    { attempt: -1 }, { attempt: 1.5 }, { workflowId: null }, { head: 'A'.repeat(40) }, { head: 'private-invalid-sha' }]) {
    assert.throws(() => collectRun({ ...request, ...patch }, { get: () => { calls++; } }), /Use repository/);
  }
  assert.equal(calls, 0);
  for (const patch of [{ id: 2 }, { run_attempt: 2 }, { workflow_id: 43 }, { head_sha: 'b'.repeat(40) },
    { repository: { full_name: 'private-wrong/repository' } }]) {
    const { run } = collectorFixture(); calls = 0;
    assert.throws(() => collectRun(request, { get: () => { calls++; return { ...run, ...patch }; } }),
      /^Error: Exact run attempt does not match requested repository\/run\/attempt\/workflow\/SHA$/);
    assert.equal(calls, 1, 'wrong identity must stop before fetching job pages');
  }
  let tick = 0;
  calls = 0;
  assert.throws(() => collectRun(request, { now: () => tick++ === 0 ? 0 : 120001,
    get: () => { calls++; } }), /budget/);
  assert.equal(calls, 0);
});

test('exact collector preserves failure and active unknowns, rejects partial pages and wrong job attempt', () => {
  const request = { repository: 'example/project', runId: 1, attempt: 1, workflowId: 42, head: 'a'.repeat(40) };
  for (const mode of ['failure', 'active', 'empty', 'partial', 'wrong-job-attempt']) {
    const { run, jobs } = collectorFixture();
    if (mode === 'failure') { run.conclusion = 'failure'; jobs[0].conclusion = 'failure'; }
    if (mode === 'active') { run.status = 'in_progress'; run.conclusion = null; jobs[0].status = 'in_progress'; jobs[0].conclusion = null; }
    if (mode === 'wrong-job-attempt') jobs[0].run_attempt = 2;
    const collect = () => collectRun(request, { get: (endpoint) => endpoint.includes('/jobs?')
      ? { total_count: mode === 'partial' ? 3 : mode === 'empty' ? 0 : 2, jobs: mode === 'empty' ? [] : jobs } : run });
    if (mode === 'partial' || mode === 'wrong-job-attempt') {
      assert.throws(collect, /pagination|identity/);
      continue;
    }
    const report = inspectRuns(collect());
    assert.equal(report.runs.length, 1);
    if (mode === 'failure') assert.equal(report.runs[0].conclusion, 'failure');
    if (mode === 'active' || mode === 'empty') assert.equal(report.runs[0].jobSumSeconds, null);
    assert.equal(report.savings, null);
  }
});

test('collector rejects partial/changing jobs and wrong run identity instead of exporting a false baseline', () => {
  for (const mode of ['partial', 'duplicate', 'wrong-attempt', 'wrong-repository']) {
    const { run, jobs } = collectorFixture();
    assert.throws(() => collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) => {
      if (endpoint.includes('/workflows/')) return { workflow_runs: [run] };
      if (!endpoint.includes('/jobs?')) return mode === 'wrong-repository' ? { ...run, repository: { full_name: 'other/project' } } : run;
      if (mode === 'wrong-attempt') jobs[0].run_attempt = 2;
      if (mode === 'duplicate') jobs[1].id = jobs[0].id;
      return { total_count: mode === 'partial' ? 3 : 2, jobs };
    } }), /pagination|identity|Duplicate/);
  }
  let called = false;
  for (const patch of [{ repository: '../project' }, { workflow: '../ci.yml' }, { limit: 26 }, { attempts: 'all-unbounded' }]) {
    assert.throws(() => collectRuns({ repository: 'example/project', workflow: 'ci.yml', ...patch }, { get: () => { called = true; } }), /Use repository/);
  }
  assert.equal(called, false);
  let tick = 0;
  assert.throws(() => collectRuns({ repository: 'example/project', workflow: 'ci.yml' }, {
    now: () => tick++ === 0 ? 0 : 120001, get: () => { called = true; },
  }), /budget/);
  assert.equal(called, false);
  const many = collectorFixture({ count: 101 });
  assert.throws(() => collectRuns({ repository: 'example/project', workflow: 'ci.yml', limit: 1 }, { get: (endpoint) => {
    if (endpoint.includes('/workflows/')) return { workflow_runs: [many.run] };
    if (!endpoint.includes('/jobs?')) return many.run;
    return endpoint.endsWith('page=1') ? { total_count: 101, jobs: many.jobs.slice(0, 100) } : { total_count: 102, jobs: many.jobs.slice(100) };
  } }), /changing/);
});

test('parallel job-sum and execution wall are distinct; updated_at is not completion or billing', () => {
  const report = inspectRuns(fixture());
  const run = report.runs[0];
  assert.equal(run.jobSumSeconds, 30);
  assert.equal(run.executionWallSeconds, 23);
  assert.equal(run.initialDelaySeconds, 2);
  assert.equal(run.queueSeconds, null);
  assert.equal(run.cacheState, 'unknown');
  assert.equal(report.savings, null);
});

test('partial page, missing timestamps and active jobs remain unknown, never zero', () => {
  for (const mode of ['partial', 'missing', 'active']) {
    const input = fixture();
    if (mode === 'partial') input.runs[0].jobs.total_count = 3;
    if (mode === 'missing') input.runs[0].jobs.jobs[0].completed_at = null;
    if (mode === 'active') input.runs[0].jobs.jobs[0].status = 'in_progress';
    const run = inspectRuns(input).runs[0];
    assert.equal(run.jobSumSeconds, null, mode);
    assert.equal(run.executionWallSeconds, null, mode);
    assert.ok(run.warnings.length, mode);
  }
});

test('skipped jobs contribute no runner execution even with provider timestamps', () => {
  const input = fixture();
  input.runs[0].jobs.jobs[0].conclusion = 'skipped';
  const run = inspectRuns(input).runs[0];
  assert.equal(run.jobSumSeconds, 20);
  assert.equal(run.jobs[0].durationSeconds, 0);
});

test('different attempts are separated; identical imports deduplicate and conflicts reject', () => {
  const input = fixture();
  input.runs.push(structuredClone(input.runs[0]));
  assert.equal(inspectRuns(input).runs.length, 1);
  input.runs[1].run.conclusion = 'failure';
  assert.throws(() => inspectRuns(input), /Conflicting/);
  input.runs[1] = structuredClone(input.runs[0]);
  input.runs[1].run.run_attempt = 2;
  for (const job of input.runs[1].jobs.jobs) job.run_attempt = 2;
  assert.equal(inspectRuns(input).runs.length, 2);
});

test('wrong attempt, SHA, run identity, duplicate jobs and malformed inputs reject', () => {
  for (const field of ['run_id', 'run_attempt', 'head_sha']) {
    const input = fixture();
    input.runs[0].jobs.jobs[0][field] = field === 'head_sha' ? 'b'.repeat(40) : 99;
    assert.throws(() => inspectRuns(input), /identity/);
  }
  const input = fixture();
  input.runs[0].jobs.jobs.push(input.runs[0].jobs.jobs[0]);
  assert.throws(() => inspectRuns(input), /Duplicate/);
  assert.throws(() => inspectRuns({}), /export/);
  assert.throws(() => inspectRuns({ ...fixture(), repository: '../secret' }), /repository/);
});

test('invalid or reversed timestamps fail closed and output excludes unrelated input fields', () => {
  const input = fixture();
  input.secret = 'must-not-be-copied';
  input.runs[0].run.actor = { token: input.secret };
  input.runs[0].jobs.jobs[0].completed_at = '2026-10-01T00:00:01Z';
  assert.equal(inspectRuns(input).runs[0].jobSumSeconds, null);
  assert.ok(!JSON.stringify(inspectRuns(input)).includes(input.secret));
  input.runs[0].jobs.jobs[0].completed_at = 'not-a-date';
  assert.equal(inspectRuns(input).runs[0].jobSumSeconds, null);
});

test('offline CLI needs no project checkout or credentials and invalid input exits nonzero', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-run-inspection-'));
  try {
    const file = path.join(root, 'export.json');
    const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
    writeFileSync(file, JSON.stringify(fixture()));
    const call = (verb = 'inspect-runs') => spawnSync(process.execPath, [cli, verb, '--input', file], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    const result = call();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runs[0].jobSumSeconds, 30);
    const audit = call('audit-runs');
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).schemaVersion, 'ci-local-guard/run-audit/v1');
    assert.equal(JSON.parse(audit.stdout).knownJobSeconds, 30);
    const comparison = path.join(root, 'comparison.json');
    writeFileSync(comparison, JSON.stringify(comparisonFixture()));
    const compared = spawnSync(process.execPath, [cli, 'compare-runs', '--input', comparison], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(compared.status, 0, compared.stderr);
    assert.equal(JSON.parse(compared.stdout).comparisonStatus, 'observed-context-matched');
    const noExecutables = { ...process.env };
    for (const key of Object.keys(noExecutables)) if (/^path$/i.test(key)) delete noExecutables[key];
    noExecutables.PATH = root;
    const help = spawnSync(process.execPath, [cli, '--help'], {
      cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /compare-runs/);
    assert.match(help.stdout, /not CI coverage or savings proved/);
    for (const [verb, args] of [
      ['inspect-runs', ['--input', file]], ['audit-runs', ['--input', file]],
      ['compare-runs', ['--input', comparison]],
    ]) {
      const offline = spawnSync(process.execPath, [cli, verb, ...args], {
        cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(offline.status, 0, `${verb} should need only Node: ${offline.stderr}`);
      assert.ok(JSON.parse(offline.stdout).schemaVersion.startsWith('ci-local-guard/'));
    }
    const unavailableGit = spawnSync(process.execPath, [cli, 'preflight', '--repo', root, '--json'], {
      cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(unavailableGit.status, 1);
    assert.doesNotMatch(unavailableGit.stdout, /PASS/);
    assert.match(unavailableGit.stderr, /git .* failed/);
    const unavailableGh = spawnSync(process.execPath, [cli, 'collect-runs', '--repository', 'example/project', '--workflow', 'ci.yml', '--limit', '1'], {
      cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(unavailableGh.status, 1);
    assert.equal(unavailableGh.stdout, '');
    assert.match(unavailableGh.stderr, /metadata GET failed/);
    const exactArgs = ['collect-run', '--repository', 'example/project', '--run-id', '1', '--attempt', '1', '--workflow-id', '42', '--head', 'a'.repeat(40)];
    const unavailableExact = spawnSync(process.execPath, [cli, ...exactArgs], { cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000 });
    assert.equal(unavailableExact.status, 1);
    assert.equal(unavailableExact.stdout, '');
    assert.match(unavailableExact.stderr, /metadata GET failed/);
    for (const args of [exactArgs.slice(0, -2), [...exactArgs, '--attempt', '2'], [...exactArgs, '--execute'],
      [...exactArgs.slice(0, 4), '1e3', ...exactArgs.slice(5)], [...exactArgs, '--head', 'private-invalid-value']]) {
      const rejected = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: noExecutables, encoding: 'utf8', timeout: 10000 });
      assert.equal(rejected.status, 1);
      assert.equal(rejected.stdout, '');
      assert.doesNotMatch(rejected.stderr, /metadata GET failed|private-invalid-value/);
    }
    writeFileSync(file, 'private-invalid-export-value');
    const invalid = call();
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.ok(!invalid.stderr.includes('private-invalid-export-value'));
    const invalidAudit = call('audit-runs');
    assert.equal(invalidAudit.status, 1);
    assert.equal(invalidAudit.stdout, '');
    assert.ok(!invalidAudit.stderr.includes('private-invalid-export-value'));
    const invalidCompare = call('compare-runs');
    assert.equal(invalidCompare.status, 1);
    assert.equal(invalidCompare.stdout, '');
    assert.ok(!invalidCompare.stderr.includes('private-invalid-export-value'));
    for (const args of [
      ['--repository', '../invalid', '--workflow', 'ci.yml'],
      ['--repository', 'example/project', '--workflow', 'ci.yml', '--limit', '26'],
      ['--repository', 'example/project', '--repository', 'other/project', '--workflow', 'ci.yml'],
      ['--repository', 'example/project', '--workflow', 'ci.yml', '--method', 'POST'],
    ]) {
      const rejected = spawnSync(process.execPath, [cli, 'collect-runs', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.equal(rejected.stdout, '');
      assert.doesNotMatch(rejected.stderr, /metadata GET failed/); // Reject before network/authentication.
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('removed advanced commands reject before project or network execution and disappear from help', () => {
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(help.status, 0, help.stderr);
  for (const verb of ['collect-check', 'collect-policy', 'observe-runtime', 'inspect-checkout-log', 'collect-job', 'inspect-programmatic', 'propose-programmatic']) {
    assert.ok(!help.stdout.includes(verb));
    const rejected = spawnSync(process.execPath, [cli, verb, '--repo', '/does-not-exist'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /Usage:/);
  }
  for (const route of ['repos/example/project/check-runs/1', 'repos/example/project/pulls/1',
    'repos/example/project/actions/jobs/1', 'repos/example/project/branches/main/protection']) {
    assert.throws(() => githubGet(route, { execute: () => { throw Error('must not execute'); } }), /Invalid GitHub metadata endpoint/);
  }
});
