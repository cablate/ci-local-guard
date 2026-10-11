import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizeCi } from '../src/ci-optimize.mjs';

const sha = 'a'.repeat(40);
const wf = (path, blob, triggers, jobs) => ({ path, blob, analysis: 'parsed', triggers, jobs });
const job = (id, line, steps, extra = {}) => ({ id, name: null, line, runsOn: 'ubuntu-latest', needs: [], steps,
  localReplay: { replayable: [], hostedOnly: [], unknown: [] }, ...extra });
const discover = (workflows, repository = null) => () => ({ identity: { repo: '/x', head: sha, repository }, workflows });

const badYaml = `name: Bad
on:
  push:
    branches: ['**']
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm test
`;
const badWf = wf('.github/workflows/bad.yml', 'b1',
  [{ event: 'push', filters: { branches: ['**'] } }, { event: 'pull_request', filters: {} }],
  [job('build', 7, [{ line: 10, run: 'npm ci' }, { line: 11, run: 'npm test' }])]);

test('a workflow without timeout, concurrency or install caching yields three static findings with lines', () => {
  const report = optimizeCi({}, { discover: discover([badWf]), read: () => badYaml });
  assert.equal(report.outcome, 'candidates');
  assert.deepEqual(report.findings.map(f => [f.code, f.job ?? null, f.line]), [
    ['missing-timeout-minutes', 'build', 7],
    ['missing-concurrency-cancel', null, 2],
    ['uncached-dependency-install', 'build', 10],
  ]);
  assert.ok(report.findings.every(f => ['risk', 'total-minutes', 'wait'].includes(f.impact)));
  assert.equal(report.findings.find(f => f.code === 'missing-timeout-minutes').impact, 'risk');
  assert.match(report.findings.find(f => f.code === 'missing-timeout-minutes').suggestion, /360/);
  assert.equal(report.findings.find(f => f.code === 'uncached-dependency-install').step, 'Run npm ci');
  assert.equal(report.coverage.history, 'static-only');
  assert.ok(report.nextActions.some(action => action.kind === 'edit-workflow-yaml'));
});

test('a timeout, no install command and no concurrency report only the concurrency risk', () => {
  const yaml = `name: Tests
on:
  push:
    branches: ['**']
  pull_request:
  workflow_call:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
        with:
          persist-credentials: false
      - run: node --test tests/*.test.mjs
`;
  const workflow = wf('.github/workflows/ci.yml', 'c1',
    [{ event: 'push', filters: { branches: ['**'] } }, { event: 'pull_request', filters: {} }, { event: 'workflow_call', filters: {} }],
    [job('test', 10, [{ line: 14, uses: 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09' }, { line: 17, run: 'node --test tests/*.test.mjs' }])]);
  const report = optimizeCi({}, { discover: discover([workflow]), read: () => yaml });
  assert.deepEqual(report.findings.map(f => f.code), ['missing-concurrency-cancel']);
  assert.equal(report.findings[0].line, 2);
});

test('a tag-only workflow is never reported for a missing concurrency group', () => {
  const yaml = `name: Release
on:
  push:
    tags: ['v*']
jobs:
  ship:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: make publish
`;
  const workflow = wf('.github/workflows/release.yml', 'r1',
    [{ event: 'push', filters: { tags: ['v*'] } }],
    [job('ship', 6, [{ line: 9, run: 'make publish' }])]);
  const report = optimizeCi({}, { discover: discover([workflow]), read: () => yaml });
  assert.deepEqual(report.findings, []);
  assert.equal(report.outcome, 'clear');
});

test('an unfiltered push also re-fires per branch and is reported; job-level or top-level concurrency suppresses it', () => {
  const bare = `name: Bare
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;
  const bareWf = wf('.github/workflows/bare.yml', 'ba1', [{ event: 'push', filters: {} }],
    [job('a', 4, [{ line: 7, run: 'echo hi' }])]);
  const reported = optimizeCi({}, { discover: discover([bareWf]), read: () => bare });
  assert.deepEqual(reported.findings.map(f => f.code), ['missing-concurrency-cancel']);

  const topLevel = `name: Grouped
on:
  push:
    branches: ['**']
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`;
  const grouped = wf('.github/workflows/grouped.yml', 'g1', [{ event: 'push', filters: { branches: ['**'] } }],
    [job('a', 9, [{ line: 12, run: 'echo hi' }])]);
  const top = optimizeCi({}, { discover: discover([grouped]), read: () => topLevel });
  assert.deepEqual(top.findings, [], 'top-level concurrency is enough');

  const jobLevel = `name: JobGroup
on:
  push:
    branches: ['**']
jobs:
  a:
    runs-on: ubuntu-latest
    concurrency:
      group: per-job
    steps:
      - run: echo hi
`;
  const jobGrouped = wf('.github/workflows/job-grouped.yml', 'j1', [{ event: 'push', filters: { branches: ['**'] } }],
    [job('a', 4, [{ line: 9, run: 'echo hi' }])]);
  const jobLevelReport = optimizeCi({}, { discover: discover([jobGrouped]), read: () => jobLevel });
  assert.ok(!jobLevelReport.findings.some(f => f.code === 'missing-concurrency-cancel'), 'job-level concurrency also counts');
});

test('setup-node with cache:, actions/cache or no install command suppresses the install finding', () => {
  const withCache = `name: Cached
on:
  push:
    branches: ['main']
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
`;
  const cacheWf = wf('.github/workflows/cached.yml', 'ca1', [{ event: 'push', filters: { branches: ['main'] } }],
    [job('build', 5, [{ line: 8, uses: 'actions/setup-node@v5' }, { line: 12, run: 'npm ci' }])]);
  const setupCache = optimizeCi({}, { discover: discover([cacheWf]), read: () => withCache });
  assert.ok(!setupCache.findings.some(f => f.code === 'uncached-dependency-install'));

  const withActionCache = `name: AC
on:
  push:
    branches: ['main']
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: npm-\${{ hashFiles('package-lock.json') }}
      - run: npm ci
`;
  const acWf = wf('.github/workflows/ac.yml', 'ac1', [{ event: 'push', filters: { branches: ['main'] } }],
    [job('build', 5, [{ line: 8, uses: 'actions/cache@v4' }, { line: 12, run: 'npm ci' }])]);
  const actionCache = optimizeCi({}, { discover: discover([acWf]), read: () => withActionCache });
  assert.ok(!actionCache.findings.some(f => f.code === 'uncached-dependency-install'));
});

// Hosted history fixtures: measure() reads these straight from the export.
const at = seconds => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString();
const hjob = (name, start, end, steps = []) => ({ name, conclusion: 'success', started_at: at(start), completed_at: at(end),
  labels: ['ubuntu-latest'], steps: steps.map(([stepName, s, e]) => ({ name: stepName, started_at: at(s), completed_at: at(e) })) });
const entry = (id, jobs, conclusion = 'success') => ({ run: { id, run_attempt: 1, head_sha: sha, head_branch: 'main', event: 'push',
  conclusion, created_at: at(0), run_started_at: at(0) }, jobs: { total_count: jobs.length, jobs } });
const collect = runs => () => ({ schemaVersion: 'ci-local-guard/github-export/v1', repository: 'o/r', runs, collection: {} });

const matrixYaml = `name: CI
on:
  push:
    branches: ['**']
concurrency:
  group: ci
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: node --test
`;
const matrixWf = wf('.github/workflows/ci.yml', 'm1', [{ event: 'push', filters: { branches: ['**'] } }],
  [job('test', 7, [{ line: 10, run: 'node --test' }], { localReplay: {
    replayable: [{ matrix: { os: 'windows-latest' } }, { matrix: { os: 'ubuntu-latest' } }], hostedOnly: [], unknown: [] } })]);

test('a step holding exactly 60% of the critical job is reported; 59% is not', () => {
  const runs = stepEnd => [entry(1, [hjob('test (windows-latest)', 0, 100, [['Run actions/checkout@v5', 0, 5], ['Run tests', 10, stepEnd]]), hjob('test (ubuntu-latest)', 0, 20)]),
    entry(2, [hjob('test (windows-latest)', 0, 100, [['Run actions/checkout@v5', 0, 5], ['Run tests', 10, stepEnd]]), hjob('test (ubuntu-latest)', 0, 20)])];
  const at60 = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, collect: collect(runs(70)) });
  const dominant = at60.findings.find(f => f.code === 'dominant-step-on-critical-path');
  assert.equal(dominant.step, 'Run tests');
  assert.equal(dominant.job, 'test');
  assert.equal(dominant.line, 7);
  assert.equal(dominant.impact, 'wait');
  assert.equal(dominant.evidence.seconds, 60);
  assert.equal(dominant.evidence.samples, 2);
  assert.equal(dominant.evidence.shareOfJob, 0.6);
  assert.equal(at60.coverage.history, 'observed');
  assert.ok(at60.nextActions.some(action => action.kind === 'verify-a-split-with-replay'));

  const below = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, collect: collect(runs(69)) });
  assert.ok(!below.findings.some(f => f.code === 'dominant-step-on-critical-path'), '59% stays below the threshold');
});

test('legs differing by exactly 1.5x are reported; less is not', () => {
  const legs = (windows, ubuntu) => collect([entry(1, [hjob('test (windows-latest)', 0, windows), hjob('test (ubuntu-latest)', 0, ubuntu)])]);
  const spread = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, collect: legs(30, 20) });
  const found = spread.findings.find(f => f.code === 'matrix-leg-spread');
  assert.equal(found.job, 'test');
  assert.equal(found.impact, 'wait');
  assert.deepEqual(found.evidence.legs.map(leg => [leg.name, leg.medianSeconds]), [['test (windows-latest)', 30], ['test (ubuntu-latest)', 20]]);

  const tighter = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, collect: legs(29, 20) });
  assert.ok(!tighter.findings.some(f => f.code === 'matrix-leg-spread'), '1.45x stays below the threshold');
});

const twoJobsYaml = `name: CI
on:
  push:
    branches: ['**']
concurrency:
  group: ci
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: node --test
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: node lint
`;
const twoJobsWf = wf('.github/workflows/ci.yml', 't1', [{ event: 'push', filters: { branches: ['**'] } }],
  [job('test', 6, [{ line: 9, run: 'node --test' }]), job('lint', 11, [{ line: 14, run: 'node lint' }])]);

test('repeated setup steps totaling exactly 30s in a second job are reported; 29s or a single job is not', () => {
  const runs = checkoutEnd => [entry(1, [
    hjob('test', 0, 100, [['Run actions/checkout@v5', 0, 5], ['Run tests', 10, 100]]),
    hjob('lint', 0, 40, [['Run actions/checkout@v5', 0, checkoutEnd]])])];
  const at30 = optimizeCi({}, { discover: discover([twoJobsWf], 'o/r'), read: () => twoJobsYaml, collect: collect(runs(30)) });
  const duplicate = at30.findings.find(f => f.code === 'duplicate-setup');
  assert.equal(duplicate.job, 'lint');
  assert.equal(duplicate.line, 11);
  assert.equal(duplicate.impact, 'total-minutes');
  assert.equal(duplicate.evidence.seconds, 30);
  assert.equal(duplicate.evidence.setup[0].presentInJobs, 2);
  assert.ok(!at30.findings.some(f => f.code === 'duplicate-setup' && f.job === 'test'), 'the critical job itself is not reported');

  const below = optimizeCi({}, { discover: discover([twoJobsWf], 'o/r'), read: () => twoJobsYaml, collect: collect(runs(29)) });
  assert.ok(!below.findings.some(f => f.code === 'duplicate-setup'), '29s stays below the threshold');

  const alone = collect([entry(1, [
    hjob('test', 0, 100, [['Run actions/checkout@v5', 0, 5], ['Run tests', 10, 100]]),
    hjob('lint', 0, 40, [['Run actions/setup-node@v5', 0, 30]])])]);
  const single = optimizeCi({}, { discover: discover([twoJobsWf], 'o/r'), read: () => twoJobsYaml, collect: alone });
  assert.ok(!single.findings.some(f => f.code === 'duplicate-setup'), 'a setup step present in only one job is not duplicate');
});

test('an install step with history carries its median seconds in the static finding', () => {
  const runs = [entry(1, [hjob('build', 0, 90, [['Run npm ci', 0, 60], ['Run npm test', 60, 90]])]),
    entry(2, [hjob('build', 0, 90, [['Run npm ci', 0, 60], ['Run npm test', 60, 90]])])];
  const report = optimizeCi({}, { discover: discover([badWf], 'o/r'), read: () => badYaml, collect: collect(runs) });
  const uncached = report.findings.find(f => f.code === 'uncached-dependency-install');
  assert.deepEqual({ kind: uncached.evidence.kind, seconds: uncached.evidence.seconds, samples: uncached.evidence.samples },
    { kind: 'history', seconds: 60, samples: 2 });
});

test('a failing gh collection degrades to static-only without blocking or inventing history findings', () => {
  const report = optimizeCi({}, { discover: discover([badWf], 'o/r'), read: () => badYaml,
    collect: () => { throw new Error('GitHub metadata GET failed; check gh installation, authentication, Actions read access or rate limits'); } });
  assert.equal(report.outcome, 'candidates');
  assert.equal(report.coverage.history, 'static-only');
  assert.ok(report.findings.every(f => f.evidence.kind === 'static'));
  assert.ok(report.issues.some(issue => issue.code === 'history-unavailable' && issue.reason === 'github-metadata-unavailable'));
  assert.match(report.limitation, /static-only/);
  assert.ok(report.nextActions.some(action => action.kind === 'check-hosted-history-access'));
});

test('invalid options fail closed with specific codes', () => {
  assert.deepEqual(optimizeCi({ workflow: '../evil.yml' }, { discover: discover([badWf]), read: () => badYaml }).issues,
    [{ code: 'invalid-workflow-file' }]);
  assert.deepEqual(optimizeCi({ workflow: 'missing.yml' }, { discover: discover([badWf]), read: () => badYaml }).issues,
    [{ code: 'workflow-not-found' }]);
  assert.deepEqual(optimizeCi({}, { discover: discover([]), read: () => badYaml }).issues, [{ code: 'no-github-workflows' }]);
  const blocked = optimizeCi({}, { discover: () => { throw new Error('git-read-unavailable-or-limit'); }, read: () => badYaml });
  assert.equal(blocked.outcome, 'blocked');
  assert.deepEqual(blocked.issues, [{ code: 'git-read-unavailable-or-limit' }]);
});

test('a reusable call job cannot set timeout-minutes; bounded by the called workflow', () => {
  const releaseYaml = `name: Release
on:
  push:
    tags: [v*]
jobs:
  verify:
    uses: ./.github/workflows/ci.yml
`;
  const releaseWf = wf('.github/workflows/release.yml', 'r1', [{ event: 'push', filters: { tags: ['v*'] } }],
    [job('verify', 5, [], { uses: './.github/workflows/ci.yml' })]);
  const boundedCi = `name: Tests
on:
  push:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: node --test
`;
  const ciWf = wf('.github/workflows/ci.yml', 'c1', [{ event: 'push', filters: { branches: ['**'] } }],
    [job('test', 8, [{ line: 10, run: 'node --test' }])]);
  const sources = { r1: releaseYaml, c1: boundedCi };
  const bounded = optimizeCi({}, { discover: discover([releaseWf, ciWf]), read: (_repo, blob) => sources[blob] });
  assert.ok(!bounded.findings.some(f => f.code === 'missing-timeout-minutes'), 'the called workflow bounds the call job');
  const unboundedSources = { r1: releaseYaml, c1: boundedCi.replace('    timeout-minutes: 10\n', '') };
  const unbounded = optimizeCi({}, { discover: discover([releaseWf, ciWf]), read: (_repo, blob) => unboundedSources[blob] });
  const finding = unbounded.findings.find(f => f.code === 'missing-timeout-minutes' && f.job === 'verify');
  assert.ok(finding, 'an unbounded call job is still reported');
  assert.match(finding.suggestion, /cannot set timeout-minutes itself/);
  assert.match(finding.suggestion, /\.github\/workflows\/ci\.yml/);
});

// Two-file fixture: release.yml calls ci.yml, whose only job is bounded.
const callerYaml = `name: Release
on:
  push:
    tags: [v*]
jobs:
  verify:
    uses: ./.github/workflows/ci.yml
`;
const calledYaml = `name: Tests
on:
  push:
    branches: ['**']
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - run: node --test
`;
const callerWf = wf('.github/workflows/release.yml', 'r1', [{ event: 'push', filters: { tags: ['v*'] } }],
  [job('verify', 6, [], { uses: './.github/workflows/ci.yml' })]);
const calledWf = wf('.github/workflows/ci.yml', 'c1', [{ event: 'push', filters: { branches: ['**'] } }],
  [job('test', 9, [{ line: 15, run: 'node --test' }], { localReplay: {
    replayable: [{ matrix: { shard: 1 } }, { matrix: { shard: 2 } }], hostedOnly: [], unknown: [] } })]);
const twoFileSources = { r1: callerYaml, c1: calledYaml };

test('--workflow on the caller still sees that the called workflow bounds the call job', () => {
  const report = optimizeCi({ workflow: 'release.yml' }, { discover: discover([callerWf, calledWf]), read: (_repo, blob) => twoFileSources[blob] });
  assert.deepEqual(report.identity.workflows, ['.github/workflows/release.yml']);
  assert.ok(!report.findings.some(f => f.code === 'missing-timeout-minutes'), 'the unselected ci.yml still bounds verify');
});

test('leg spread compares legs on the same runner family only', () => {
  const leg = (name, end, label) => ({ ...hjob(name, 0, end), labels: [label] });
  const crossOs = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, progress: () => {},
    collect: collect([entry(1, [leg('test (windows-latest)', 120, 'windows-latest'), leg('test (ubuntu-latest)', 20, 'ubuntu-latest')])]) });
  assert.ok(!crossOs.findings.some(f => f.code === 'matrix-leg-spread'), 'an OS matrix spread is the platform, not a rebalancing target');
  const shards = optimizeCi({}, { discover: discover([matrixWf], 'o/r'), read: () => matrixYaml, progress: () => {},
    collect: collect([entry(1, [leg('test (1)', 60, 'ubuntu-latest'), leg('test (2)', 20, 'ubuntu-latest'), leg('test (3)', 200, 'windows-latest')])]) });
  const found = shards.findings.filter(f => f.code === 'matrix-leg-spread');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].evidence.legs.map(item => item.name), ['test (1)', 'test (2)']);
});

test('history through a reusable call is reported once, or attributed to the caller line', () => {
  const leg = (name, end) => hjob(name, 0, end);
  const histories = {
    'release.yml': collect([entry(1, [leg('verify / test (1)', 60), leg('verify / test (2)', 20)])]),
    'ci.yml': collect([entry(2, [leg('test (1)', 60), leg('test (2)', 20)])]),
  };
  const collectBy = (opts, deps) => histories[opts.workflow](opts, deps);
  const both = optimizeCi({}, { discover: discover([callerWf, calledWf], 'o/r'), read: (_repo, blob) => twoFileSources[blob],
    collect: collectBy, progress: () => {} });
  const spreads = both.findings.filter(f => f.code === 'matrix-leg-spread');
  assert.deepEqual(spreads.map(f => [f.workflow, f.job, f.line]), [['.github/workflows/ci.yml', 'test', 9]], 'no release.yml copy with line null');
  const callerOnly = optimizeCi({ workflow: 'release.yml' }, { discover: discover([callerWf, calledWf], 'o/r'),
    read: (_repo, blob) => twoFileSources[blob], collect: collectBy, progress: () => {} });
  const attributed = callerOnly.findings.find(f => f.code === 'matrix-leg-spread');
  assert.deepEqual([attributed.workflow, attributed.job, attributed.line, attributed.via],
    ['.github/workflows/release.yml', 'verify', 6, '.github/workflows/ci.yml']);
});

test('a pull request group that only queues is reported; a push-only deploy lock and an expression are not', () => {
  const yaml = (trigger, concurrency) => `name: X
on:
${trigger}
${concurrency}
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: make
`;
  const run = (trigger, concurrency, triggers) => optimizeCi({}, { discover: discover([wf('.github/workflows/x.yml', 'x1', triggers,
    [job('build', 7, [{ line: 10, run: 'make' }])])]), read: () => yaml(trigger, concurrency) });
  const pr = [{ event: 'pull_request', filters: {} }];
  const queued = run('  pull_request:', 'concurrency:\n  group: pr-${{ github.ref }}', pr);
  assert.equal(queued.findings.find(f => f.code === 'missing-concurrency-cancel').evidence.concurrency, 'queues-without-cancel');
  assert.ok(run('  pull_request:', 'concurrency: pr-group', pr).findings.some(f => f.code === 'missing-concurrency-cancel'), 'a bare group name queues too');
  const deployLock = run('  push:\n    branches: [main]', 'concurrency:\n  group: deploy', [{ event: 'push', filters: { branches: ['main'] } }]);
  assert.ok(!deployLock.findings.some(f => f.code === 'missing-concurrency-cancel'), 'a push-only lock queues on purpose');
  const expression = run('  pull_request:', "concurrency:\n  group: g\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}", pr);
  assert.ok(!expression.findings.some(f => f.code === 'missing-concurrency-cancel'), 'an expression is not judged');
  assert.equal(run('  pull_request:', 'concurrency:\n  group: g\n  cancel-in-progress: true', pr).findings.length, 0);
});

test('global tool installs are not dependency installs; lockfile installs are', () => {
  const yaml = command => `name: X
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: ${command}
`;
  const reported = command => optimizeCi({}, { discover: discover([wf('.github/workflows/x.yml', 'x1', [{ event: 'workflow_dispatch', filters: {} }],
    [job('build', 4, [{ line: 8, run: command }])])]), read: () => yaml(command) })
    .findings.some(f => f.code === 'uncached-dependency-install');
  for (const command of ['npm install -g npm@11', 'npm i -g pnpm', 'pip install --user pipx', 'pip install --upgrade pip', 'npm install left-pad'])
    assert.equal(reported(command), false, command);
  for (const command of ['npm ci', 'npm install', 'npm install --no-audit', 'npm install --prefix app', 'pip install -r requirements.txt',
    'pip install -e .', 'python -m pip install -r req.txt', 'poetry install', 'pnpm install --frozen-lockfile', 'cd app && npm ci'])
    assert.equal(reported(command), true, command);
});

test('--limit bounds the runs read per workflow and progress goes out once per workflow', () => {
  const seen = [];
  const lines = [];
  const report = optimizeCi({ limit: '3' }, { discover: discover([callerWf, calledWf], 'o/r'), read: (_repo, blob) => twoFileSources[blob],
    collect: opts => { seen.push(opts.limit); return { runs: [] }; }, progress: text => lines.push(text) });
  assert.deepEqual(seen, [3, 3]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /1\/2 \.github\/workflows\/release\.yml \(up to 3 runs\)/);
  assert.equal(report.coverage.sampleLimit, 3);
  for (const bad of ['0', '51', 'x']) assert.equal(optimizeCi({ limit: bad }, { discover: discover([calledWf]) }).issues[0].code, 'invalid-limit');
});

test('a short gate job does not hide the dominant step of the job it waits for', () => {
  const gateYaml = `name: CI
on:
  push:
    branches: ['**']
concurrency:
  group: ci
  cancel-in-progress: true
jobs:
  browser:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - run: npm run test:browser
  verify:
    needs: [browser]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo ok
`;
  const gateWf = wf('.github/workflows/ci.yml', 'g1', [{ event: 'push', filters: { branches: ['**'] } }],
    [job('browser', 9, [{ line: 13, run: 'npm run test:browser' }]), job('verify', 14, [{ line: 19, run: 'echo ok' }], { needs: ['browser'] })]);
  const run = id => entry(id, [hjob('browser', 0, 578, [['Run actions/checkout@v5', 0, 5], ['Run npm run test:browser', 10, 570]]),
    hjob('verify', 580, 589, [['Run echo ok', 581, 582]])]);
  const report = optimizeCi({}, { discover: discover([gateWf], 'o/r'), read: () => gateYaml, collect: collect([run(1), run(2)]), progress: () => {} });
  const dominant = report.findings.find(f => f.code === 'dominant-step-on-critical-path');
  assert.deepEqual([dominant.job, dominant.step, dominant.line], ['browser', 'Run npm run test:browser', 9]);
});
