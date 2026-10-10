import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCi } from '../src/ci-discovery.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-discover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  const write = (name, value) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), value); };
  write('README.md', 'fixture');
  for (const [name, value] of Object.entries(files)) write(name, value);
  git('add', '.'); git('commit', '-m', 'fixture');
  return { root, git, write, head: git('rev-parse', 'HEAD') };
}
function invoke(args) {
  const r = spawnSync(process.execPath, [cli, 'ci', ...args], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.stderr, '');
  return { ...r, report: JSON.parse(r.stdout) };
}

test('discovery needs no adapter, reads the exact commit and never executes or exposes scripts', t => {
  const f = fixture(t, { '.github/workflows/ci.yml': 'not even valid YAML: [', 'nx.json': '{}',
    'package.json': JSON.stringify({ scripts: { test: 'echo PRIVATE_SENTINEL > executed', build: 'echo build' } }) });
  f.write('package.json', 'broken dirty change');
  f.write('.github/workflows/untracked.yml', 'name: untracked');
  const r = discoverCi({ repo: f.root, head: f.head });
  assert.equal(r.outcome, 'inventoried');
  assert.equal(r.identity.head, f.head);
  assert.deepEqual(r.workflows.map(x => x.path), ['.github/workflows/ci.yml']);
  assert.deepEqual(r.scripts.names, ['build', 'test']);
  assert.equal(r.coverage.workflowSemantics, 'structure-only-expressions-unevaluated');
  assert.equal(r.workflows[0].analysis, 'parse-failed');
  assert.ok(r.nextActions.some(a => a.kind === 'fix-workflow-yaml'));
  assert.equal(r.descriptor.status, 'missing');
  assert.equal(r.engines[0].id, 'nx');
  assert.equal(existsSync(path.join(f.root, 'executed')), false);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
  const old = f.head;
  f.write('package.json', '{}'); f.write('turbo.json', '{}'); f.git('add', '.'); f.git('commit', '-m', 'next');
  assert.equal(discoverCi({ repo: f.root, head: old }).engines.some(e => e.id === 'turborepo'), false);
});

test('nonregular and nested workflows are incomplete, not silently scanned or followed', t => {
  const f = fixture(t, { '.github/workflows/nested/ci.yml': 'on: push' });
  const blob = f.git('hash-object', '-w', 'README.md');
  f.git('update-index', '--add', '--cacheinfo', `120000,${blob},.github/workflows/link.yml`);
  f.git('commit', '-m', 'symlink');
  const r = discoverCi({ repo: f.root });
  assert.equal(r.outcome, 'incomplete');
  assert.deepEqual(r.workflows, []);
  assert.ok(r.issues.some(x => x.code === 'non-regular-source'));
  assert.ok(r.issues.some(x => x.code === 'nested-workflow-not-selected'));
});

test('malformed or oversized package metadata is incomplete and its contents stay private', t => {
  for (const value of ['{PRIVATE_SENTINEL', JSON.stringify({ scripts: { test: 123 } }), 'x'.repeat(1024 * 1024 + 1)]) {
    const f = fixture(t, { 'package.json': value });
    const r = discoverCi({ repo: f.root });
    assert.equal(r.outcome, 'incomplete');
    assert.equal(r.scripts.status, 'invalid');
    assert.ok(!JSON.stringify(r).includes('PRIVATE_SENTINEL'));
  }
});

test('CLI always returns JSON, reserves output, rejects duplicate options and invalid revisions', t => {
  const f = fixture(t);
  const out = path.join(f.root, 'report.json');
  const r = invoke(['discover', '--repo', f.root, '--summary', '--output', out]);
  assert.equal(r.status, 0);
  assert.equal(r.report.outcome, 'inventoried');
  assert.equal(r.report.nextActions[0].kind, 'identify-project-checks');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).identity.head, f.head);
  const original = readFileSync(out, 'utf8');
  assert.equal(invoke(['discover', '--repo', f.root, '--output', out]).status, 2);
  assert.equal(readFileSync(out, 'utf8'), original);
  for (const args of [[], ['replay'], ['discover', '--repo', f.root, '--head', '--upload-pack=bad'],
    ['discover', '--repo', f.root, '--head', 'does-not-exist'], ['discover', '--repo', f.root, '--repo', f.root]]) {
    const failure = invoke(args);
    assert.equal(failure.status, 2);
    assert.equal(failure.report.outcome, 'blocked');
  }
});

test('committed descriptor is discovered but never executed or claimed valid', t => {
  const f = fixture(t, { '.ci-local-guard.json': '{invalid', 'package.json': '{}',
    '.gitlab-ci.yml': 'stages: [test]', 'Earthfile': 'VERSION 0.8' });
  const r = discoverCi({ repo: f.root });
  assert.equal(r.descriptor.status, 'present-not-validated');
  assert.equal(r.coverage.execution, 'not-run');
  assert.deepEqual(new Set(r.engines.map(x => x.id)), new Set(['gitlab', 'earthly']));
});

test('parsed workflows tell an agent which commands CI runs and what can be replayed locally', t => {
  const ci = 'name: CI\non: [push, pull_request]\njobs:\n  test:\n    strategy: {matrix: {os: [ubuntu-latest, windows-latest]}}\n'
    + '    runs-on: ${{ matrix.os }}\n    steps:\n      - uses: actions/checkout@v5\n      - run: npm ci\n      - run: npm run lint\n      - run: |\n          npm test\n          echo "$RUNNER_TEMP"\n';
  const release = 'on: {push: {tags: [v*]}}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: [{run: npm publish}]\n';
  const f = fixture(t, { '.github/workflows/ci.yml': ci, '.github/workflows/release.yml': release,
    'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'node --test' } }) });
  const r = discoverCi({ repo: f.root });
  const wf = r.workflows.find(w => w.path.endsWith('ci.yml'));
  assert.equal(wf.analysis, 'parsed');
  assert.deepEqual(wf.jobs[0].localReplay.replayable, [{ matrix: { os: 'ubuntu-latest' }, labels: ['ubuntu-latest'],
    image: 'catthehacker/ubuntu:act-latest', imageSource: 'guard-default' }]);
  assert.deepEqual(wf.jobs[0].localReplay.hostedOnly.map(l => l.labels), [['windows-latest']]);
  assert.deepEqual(r.ciCommands.find(c => c.command === 'npm run lint').scripts, ['lint']);
  const multi = r.ciCommands.find(c => c.lines === 2);
  assert.deepEqual(multi.scripts, ['test']);
  const replays = r.nextActions.filter(a => a.kind === 'replay-job-locally');
  assert.equal(replays.length, 1, 'release workflows are not suggested for replay');
  assert.deepEqual(replays[0].args.slice(-5), ['--job', 'test', '--matrix', 'os:ubuntu-latest', '--summary']);
  assert.ok(r.nextActions.some(a => a.kind === 'rely-on-hosted-ci-for'));
  assert.equal(r.tools, null, 'tool probing only when requested');
  const edit = r.nextActions.find(a => a.kind === 'run-ci-commands-for-uncommitted-edits').commands;
  assert.ok(!edit.some(c => c.command.includes('npm publish')), 'tag/release workflows are not edit-time checks');
  assert.equal(edit.find(c => c.command.includes('RUNNER_TEMP')).needsRunnerEnvironment, true);
  assert.equal(r.identity.workingTree.status, 'clean');
  f.write('package.json', '{}');
  assert.equal(discoverCi({ repo: f.root }).identity.workingTree.status, 'uncommitted-changes');
});

test('local reusable workflows and composite actions are read from the same commit', t => {
  const caller = 'on: pull_request\njobs:\n  verify:\n    uses: ./.github/workflows/checks.yml\n  remote:\n    uses: org/repo/.github/workflows/x.yml@v1\n'
    + '  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/setup\n      - uses: ./.github/actions/node-action\n      - uses: ./.github/actions/missing\n      - uses: ./../outside\n';
  const checks = 'on: workflow_call\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps: [{run: npm run lint}]\n';
  const composite = 'name: setup\nruns:\n  using: composite\n  steps:\n    - run: npm ci\n      shell: bash\n    - run: npm run build\n      shell: bash\n';
  const f = fixture(t, { '.github/workflows/ci.yml': caller, '.github/workflows/checks.yml': checks,
    '.github/actions/setup/action.yml': composite, '.github/actions/node-action/action.yaml': 'runs:\n  using: node20\n  main: index.js\n' });
  f.write('.github/actions/setup/action.yml', 'runs: {using: composite, steps: [{run: PRIVATE_DIRTY}]}');
  const r = discoverCi({ repo: f.root });
  const jobs = r.workflows.find(w => w.path.endsWith('ci.yml')).jobs;
  assert.deepEqual(jobs[0].calls, { path: '.github/workflows/checks.yml', status: 'resolved', jobs: ['lint'] });
  assert.equal(jobs[0].localReplay.unknown[0].replayInstead, '.github/workflows/checks.yml');
  assert.equal(jobs[1].calls.status, 'remote-not-inspected');
  const actions = jobs[2].steps.map(step => step.localAction);
  assert.deepEqual(actions[0].steps.map(step => step.run), ['npm ci', 'npm run build']);
  assert.deepEqual(actions[1], { path: '.github/actions/node-action', status: 'resolved', using: 'node20' });
  assert.equal(actions[2].status, 'missing');
  assert.equal(actions[3].status, 'missing', 'paths outside the repository are never read');
  const build = r.ciCommands.find(c => c.command === 'npm run build');
  assert.deepEqual(build.scripts, ['build']);
  assert.equal(build.where[0].viaAction, '.github/actions/setup');
  assert.ok(!JSON.stringify(r).includes('PRIVATE_DIRTY'), 'committed version only');
});


test('Docker daemon jobs and dependent jobs are not advertised for isolated replay', t => {
  const f = fixture(t, { '.github/workflows/ci.yml': `name: CI
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - run: docker run scanner
  test:
    needs: scan
    runs-on: ubuntu-latest
    steps:
      - run: node --test
` });
  const report = discoverCi({ repo: f.root });
  for (const job of report.workflows[0].jobs) {
    assert.equal(job.localReplay.replayable.length, 0);
    assert.equal(job.localReplay.unknown[0].reason, 'docker-daemon-unavailable-in-replay');
  }
});

test('caller platform mappings make third-party runner labels locally replayable', t => {
  const ci = 'name: CI\non: [pull_request]\njobs:\n  build:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps: [{run: npm test}]\n';
  const f = fixture(t, { '.github/workflows/ci.yml': ci });
  const unmapped = discoverCi({ repo: f.root });
  assert.deepEqual(unmapped.workflows[0].jobs[0].localReplay.hostedOnly.map(l => l.labels), [['blacksmith-2vcpu-ubuntu-2404']]);
  assert.equal(unmapped.workflows[0].jobs[0].localReplay.replayable.length, 0);
  const mapped = discoverCi({ repo: f.root, platform: { 'blacksmith-2vcpu-ubuntu-2404': 'catthehacker/ubuntu:act-24.04' } });
  assert.deepEqual(mapped.workflows[0].jobs[0].localReplay.replayable, [{ matrix: {}, labels: ['blacksmith-2vcpu-ubuntu-2404'],
    image: 'catthehacker/ubuntu:act-24.04', imageSource: 'caller-mapped' }]);
  assert.equal(mapped.workflows[0].jobs[0].localReplay.hostedOnly.length, 0);
  assert.throws(() => discoverCi({ repo: f.root, platform: { 'bad label': 'image' } }), /invalid-platform-mapping/);
});

test('a repo with zero workflows says so in the discover report, without becoming incomplete', t => {
  const f = fixture(t, { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const r = discoverCi({ repo: f.root });
  assert.equal(r.outcome, 'inventoried');
  assert.deepEqual(r.workflows, []);
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.notes.map(note => note.code), ['no-github-workflows']);
  const withWorkflows = fixture(t, { '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n' });
  assert.equal('notes' in discoverCi({ repo: withWorkflows.root }), false);
});

// Stubbed git plus a fake clock: timing policy without real sleeps.
function stubbedGit({ workflows = 1, perCallMs = 0, onCall } = {}) {
  let clock = 0;
  const files = new Map();
  for (let i = 0; i < workflows; i++) files.set(`.github/workflows/w${i}.yml`, 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n');
  const blobOf = new Map([...files].map(([file], i) => [file, `${(i + 1).toString(16).padStart(2, '0')}${'a'.repeat(38)}`]));
  const byBlob = new Map([...blobOf].map(([file, blob]) => [blob, files.get(file)]));
  const spawn = (binary, args, opts = {}) => {
    const injected = onCall?.(args, opts, clock);
    if (injected) { clock += injected.advance || 0; return injected.result; }
    clock += perCallMs;
    const command = args[2];
    if (command === 'rev-parse') return { status: 0, stdout: args[3] === '--show-toplevel' ? 'X:/fake/repo\n' : `${'f'.repeat(40)}\n` };
    if (command === 'ls-tree') return { status: 0, stdout: [...blobOf].map(([file, blob]) => `100644 blob ${blob}\t${file}`).join('\0') + '\0' };
    if (command === 'cat-file') return args[3] === '-s'
      ? { status: 0, stdout: `${Buffer.byteLength(byBlob.get(args[4]) ?? '')}\n` }
      : { status: 0, stdout: byBlob.get(args[4]) ?? '' };
    if (command === 'status') return { status: 0, stdout: '' };
    return { status: 1, stdout: '' };
  };
  return { spawn, now: () => clock };
}
const timedOut = { status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) };

test('the discovery budget scales with inventory instead of a fixed 15s wall', () => {
  // 123 git calls at 200ms each: ~24.6s of work, past the old fixed 15s budget.
  const git = stubbedGit({ workflows: 60, perCallMs: 200 });
  const report = discoverCi({ repo: 'X:/fake/repo', spawn: git.spawn, now: git.now });
  assert.equal(report.outcome, 'inventoried');
  assert.equal(report.workflows.length, 60);
  assert.equal(report.workflows[0].analysis, 'parsed');
});

test('one timed-out git read is retried, not reported as broken git', () => {
  let injected = false;
  const git = stubbedGit({ workflows: 1, onCall: (args, opts) => {
    if (!injected && args[2] === 'cat-file' && args[3] === 'blob') {
      injected = true;
      return { advance: opts.timeout, result: timedOut };
    }
    return undefined;
  } });
  const report = discoverCi({ repo: 'X:/fake/repo', spawn: git.spawn, now: git.now });
  assert.equal(injected, true);
  assert.equal(report.workflows[0].analysis, 'parsed');
});

test('a git read timing out twice with budget left is a timeout, not unavailable git', () => {
  const git = stubbedGit({ workflows: 60, onCall: (args, opts) => (
    args[2] === 'cat-file' && args[3] === 'blob' ? { advance: opts.timeout, result: timedOut } : undefined) });
  assert.throws(() => discoverCi({ repo: 'X:/fake/repo', spawn: git.spawn, now: git.now }), /git-call-timeout/);
});

test('nonzero git exit stays git-read-unavailable-or-limit; exhaustion stays discovery-deadline', () => {
  const broken = stubbedGit({ onCall: args => (args[2] === 'ls-tree' ? { result: { status: 128, stdout: '' } } : undefined) });
  assert.throws(() => discoverCi({ repo: 'X:/fake/repo', spawn: broken.spawn, now: broken.now }), /git-read-unavailable-or-limit/);
  const slow = stubbedGit({ workflows: 1, perCallMs: 8000 });
  assert.throws(() => discoverCi({ repo: 'X:/fake/repo', spawn: slow.spawn, now: slow.now }), /discovery-deadline/);
});
