import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayCi, replayOptions, parseActLog, summarizeReplay } from '../src/ci-replay.mjs';
import { actContainerName } from '../src/workflow-model.mjs';
import { readEvidence } from '../src/evidence.mjs';

const WORKFLOW = `name: Tests
on:
  push:
  pull_request:
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - run: node --test tests/*.test.mjs
`;
const JCN = actContainerName('act', 'Tests/test');

function fixture(t, workflow = WORKFLOW) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-replay-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(root, '.github/workflows/ci.yml'), workflow);
  git('add', '.'); git('commit', '-m', 'fixture');
  return { root, head: git('rev-parse', 'HEAD'), logs: path.join(root, 'logs') };
}

// Fake Docker daemon with the same CLI surface docker-resources uses.
function daemon(initial = []) {
  const resources = initial.map(r => ({ labels: {}, ...r, id: r.kind === 'volume' ? r.name : `${r.name}-id` }));
  const calls = [];
  const docker = async (binary, args) => {
    args = args.slice(2); calls.push(args);
    const [kind, verb] = args;
    if (verb === 'ls') {
      const filter = args.includes('--filter') ? args.at(-1) : null;
      return resources.filter(r => r.kind === kind && (!filter || filter === `label=ci-local-guard.run=${(r.labels || {})['ci-local-guard.run']}`))
        .map(r => `${r.id} ${r.name}`).join('\n');
    }
    const resource = resources.find(r => r.id === args.at(-1));
    if (verb === 'inspect') return JSON.stringify([{ Id: resource.id, Name: kind === 'container' ? `/${resource.name}` : resource.name, Labels: resource.labels || {}, Config: { Labels: resource.labels || {} } }]);
    if (verb === 'rm') { resources.splice(resources.indexOf(resource), 1); return ''; }
    if (verb === 'create') { resources.push({ kind, name: args.at(-1), id: `${args.at(-1)}-id`, labels: { 'ci-local-guard.run': args[args.indexOf('--label') + 1].split('=')[1] } }); return ''; }
    throw new Error('unexpected');
  };
  return { docker, resources, calls };
}

const line = entry => JSON.stringify({ job: 'Tests/test', jobID: 'test', matrix: { os: 'ubuntu-latest' }, level: 'info', ...entry }) + '\n';
function actLog({ fail = false } = {}) {
  return '[ci-local-guard] stage: ci-replay\n'
    + line({ msg: 'Set up job', step: 'Set up job', stepid: ['--setup-job'] })
    + line({ msg: 'Run Main node --test', stage: 'Main', step: 'node --test tests/*.test.mjs', stepID: ['1'] })
    + line({ msg: 'ok 1 - parses\n', raw_output: true, stage: 'Main', step: 'node --test tests/*.test.mjs', stepID: ['1'] })
    + (fail ? line({ msg: 'not ok 2 - rejects bad input\n', raw_output: true, stage: 'Main', step: 'node --test tests/*.test.mjs', stepID: ['1'] }) : '')
    + line({ msg: fail ? 'Failure' : 'Success', stage: 'Main', step: 'node --test tests/*.test.mjs', stepID: ['1'], stepResult: fail ? 'failure' : 'success' })
    + 'time="x" level=info msg="plain runner text"\n'
    + line({ msg: fail ? 'Job failed' : 'Job succeeded', jobResult: fail ? 'failure' : 'success' });
}

function deps(f, d, { execute, probes = {} } = {}) {
  const runs = [];
  return { runs, deps: {
    docker: d.docker, endpoint: () => 'npipe:////./pipe/test',
    exactCheckout: async (repo, sha, action, options) => { assert.equal(options.linkDependencies, false); return action(path.join(f.root, 'checkout')); },
    probeTool: (binary, args) => {
      if (args[0] === '--version') return probes.act ?? 'act version 0.2.89';
      if (args.includes('version')) return probes.os ?? 'linux';
      if (args.includes('image')) return probes.image === undefined ? 'sha256:abc' : probes.image;
      return null;
    },
    executeTool: async (command, args, cwd, opts) => {
      runs.push({ command, args, cwd, opts });
      mkdirSync(f.logs, { recursive: true });
      const logFile = path.join(f.logs, `replay-${runs.length}.log`);
      return execute(logFile, args);
    },
  } };
}

const options = (f, extra = []) => replayOptions(['--repo', f.root, '--workflow', '.github/workflows/ci.yml', '--job', 'test',
  '--matrix', 'os:ubuntu-latest', '--platform', 'ubuntu-latest=node:22', ...extra]);

test('a passing job is reported per leg, isolated from ambient config, and leaves no owned resources', async t => {
  const f = fixture(t);
  const d = daemon([{ kind: 'container', name: 'someone-elses-db' }]);
  const process_env = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'PRIVATE_TOKEN_VALUE';
  t.after(() => { if (process_env === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = process_env; });
  const x = deps(f, d, { execute: async (logFile, args) => {
    // act leaves its job container behind; cleanup must find it by label.
    const options = args[args.indexOf('--container-options') + 1].split(' ');
    assert.equal(options[0], '--init', 'orphaned processes are reaped like on a hosted VM');
    const label = options[2].split('=')[1];
    d.resources.push({ kind: 'container', name: JCN, id: 'job-id', labels: { 'ci-local-guard.run': label } });
    writeFileSync(logFile, actLog());
    return { logFile, durationMs: 5 };
  } });
  const report = await replayCi(options(f), x.deps);
  assert.equal(report.outcome, 'passed');
  assert.equal(report.identity.head.length, 40);
  assert.equal(report.identity.eventContext.ref, 'refs/heads/main');
  assert.deepEqual(report.jobs.map(j => [j.job, j.result]), [['test', 'success']]);
  assert.equal(report.resources.cleanup.outcome, 'cleaned');
  assert.deepEqual(d.resources.map(r => r.name), ['someone-elses-db']);
  assert.deepEqual(report.coverage.notSelected.map(l => l.matrix.os), ['windows-latest']);
  assert.ok(report.nextActions.some(a => a.kind === 'verify-legs-on-hosted-ci'));
  const run = x.runs[0];
  assert.notEqual(run.cwd, path.join(f.root, 'checkout'), 'act must not start in the checkout (no project .actrc)');
  for (const flag of ['--secret-file', '--env-file', '--var-file', '--input-file', '--no-cache-server']) assert.ok(run.args.includes(flag));
  assert.equal(run.args[run.args.indexOf('--container-daemon-socket') + 1], '-');
  assert.equal(run.opts.env.GH_TOKEN, undefined);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_TOKEN_VALUE'));
});

test('a failing step names the job, step, command, failed test and a readable log range', async t => {
  const f = fixture(t);
  const d = daemon();
  const x = deps(f, d, { execute: async logFile => {
    writeFileSync(logFile, actLog({ fail: true }));
    throw Object.assign(new Error('exit'), { logFile, durationMs: 9,
      executionFailure: { exitCode: 1, causes: ['child-exit-nonzero'] } });
  } });
  const report = await replayCi(options(f), x.deps);
  assert.equal(report.outcome, 'failed');
  const failure = report.failures[0];
  assert.equal(failure.job, 'test');
  assert.equal(failure.command, 'node --test tests/*.test.mjs');
  assert.deepEqual(failure.workflowLocation, { path: '.github/workflows/ci.yml', line: 13 });
  assert.deepEqual(failure.observed.failedTests, ['rejects bad input']);
  const page = readEvidence(failure.evidence.reader.args);
  assert.equal(page.status, 'available');
  assert.match(page.text, /not ok 2 - rejects bad input/);
  assert.ok(!page.text.includes('Set up job'), 'range starts at the failed step');
  assert.deepEqual(report.nextActions.slice(0, 3).map(a => a.kind), ['read-failed-step-log', 'inspect-workflow-step', 'reproduce-step-command']);
  assert.ok(report.runnerOutput.some(text => text.includes('plain runner text')));
  const summary = summarizeReplay(report);
  assert.deepEqual(summary.jobs[0].failedSteps, ['node --test tests/*.test.mjs']);
});

test('a timeout is incomplete, and leftover containers of this run are removed while others survive', async t => {
  const f = fixture(t);
  const d = daemon([{ kind: 'container', name: 'unrelated-sentinel' }]);
  const x = deps(f, d, { execute: async logFile => {
    // Service-style leftovers without our label, claimed by exact act name.
    d.resources.push({ kind: 'container', name: JCN, id: 'leftover' }, { kind: 'volume', name: `${JCN}-env`, id: `${JCN}-env` });
    writeFileSync(logFile, line({ msg: 'Download from https://example.test/tool.tgz', stage: 'Main', step: 'actions/setup-python@v5', stepID: ['1'],
      time: new Date(Date.now() - 600000).toISOString() }));
    throw Object.assign(new Error('timeout'), { logFile, durationMs: 1000,
      executionFailure: { exitCode: null, causes: ['execution-timeout', 'process-terminated'] } });
  } });
  const report = await replayCi(options(f, ['--timeout', '60']), x.deps);
  assert.equal(report.outcome, 'incomplete');
  assert.equal(report.resources.cleanup.outcome, 'cleaned');
  assert.deepEqual(d.resources.map(r => r.name), ['unrelated-sentinel']);
  const longer = report.nextActions.find(a => a.kind === 'replay-with-longer-timeout');
  assert.equal(longer.args[longer.args.indexOf('--timeout') + 1], '120');
  const stalled = report.nextActions.find(a => a.kind === 'inspect-stalled-step');
  assert.equal(stalled.step, 'actions/setup-python@v5');
  assert.ok(stalled.silentSeconds >= 590, 'the step was silent for ten minutes before the stop');
});

test('unconfirmed termination skips Docker cleanup and is never success', async t => {
  const f = fixture(t);
  const d = daemon();
  const x = deps(f, d, { execute: async logFile => {
    writeFileSync(logFile, actLog());
    throw Object.assign(new Error('drain'), { logFile, preserveCheckout: true,
      executionFailure: { exitCode: null, causes: ['process-drain-timeout'] } });
  } });
  const report = await replayCi(options(f), x.deps);
  assert.equal(report.outcome, 'incomplete');
  assert.deepEqual(report.resources.cleanup.reasons, ['producer-termination-unconfirmed']);
  assert.ok(!d.calls.some(args => args[1] === 'rm'));
});

test('blocked before running: collisions, missing image, wrong act, non-linux engine', async t => {
  const f = fixture(t);
  const never = async () => { throw new Error('must not run act'); };
  const collision = await replayCi(options(f), deps(f, daemon([{ kind: 'container', name: JCN }]), { execute: never }).deps);
  assert.equal(collision.outcome, 'blocked');
  assert.equal(collision.issues[0].code, 'docker-resource-collision');
  const image = await replayCi(options(f), deps(f, daemon(), { execute: never, probes: { image: null } }).deps);
  assert.equal(image.issues[0].code, 'image-not-present');
  const pull = image.nextActions.find(a => a.kind === 'allow-image-pull');
  assert.ok(pull.args.includes('--pull') && pull.args.includes('ubuntu-latest=node:22'));
  const act = await replayCi(options(f), deps(f, daemon(), { execute: never, probes: { act: 'act version 0.2.80' } }).deps);
  assert.equal(act.issues[0].code, 'unsupported-act-version');
  const engine = await replayCi(options(f), deps(f, daemon(), { execute: never, probes: { os: 'windows' } }).deps);
  assert.equal(engine.issues[0].code, 'linux-docker-engine-required');
});

test('input problems are blocked with a concrete choice, never guessed', async t => {
  const f = fixture(t);
  const never = async () => { throw new Error('must not run act'); };
  const x = deps(f, daemon(), { execute: never }).deps;
  const windows = await replayCi(replayOptions(['--repo', f.root, '--workflow', '.github/workflows/ci.yml', '--job', 'test', '--matrix', 'os:windows-latest']), x);
  assert.equal(windows.issues[0].code, 'no-replayable-leg');
  const event = await replayCi(replayOptions(['--repo', f.root, '--workflow', '.github/workflows/ci.yml', '--job', 'test', '--event', 'workflow_dispatch']), x);
  assert.deepEqual(event.issues[0].declared, ['push', 'pull_request']);
  const job = await replayCi(replayOptions(['--repo', f.root, '--workflow', '.github/workflows/ci.yml', '--job', 'nope']), x);
  assert.deepEqual(job.nextActions[0].jobs, ['test']);
  assert.throws(() => replayOptions(['--workflow', 'x']), /workflow-and-job-required/);
  assert.throws(() => replayOptions(['--workflow', 'x', '--job', 'y', '--bogus', '1']), /invalid-replay-options/);
  assert.throws(() => replayOptions(['--workflow', 'x', '--job', 'y', '--event', 'schedule']), /unsupported-event/);
  const dynamic = fixture(t, 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    services: {db: {image: postgres}}\n    name: T ${{ github.sha }}\n    steps: [{run: x}]\n');
  const names = await replayCi(replayOptions(['--repo', dynamic.root, '--workflow', '.github/workflows/ci.yml', '--job', 't']), deps(dynamic, daemon(), { execute: never }).deps);
  assert.equal(names.issues[0].code, 'resource-names-unpredictable');
});

test('act JSON log parsing tolerates non-JSON lines and bounds excerpts', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'guard-actlog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.log');
  const many = Array.from({ length: 100 }, (_, i) => line({ msg: `line ${i}\n`, raw_output: true, stage: 'Main', step: 's', stepID: ['0'] })).join('');
  writeFileSync(file, '{not json\n' + many + line({ stepID: ['0'], stage: 'Main', stepResult: 'failure', step: 's' }));
  const parsed = parseActLog(file);
  assert.equal(parsed.legs[0].steps[0].tail.length, 30);
  assert.equal(parsed.legs[0].steps[0].result, 'failure');
  assert.equal(parsed.runner[0], '{not json');
});

test('a job that fails before any workflow step is an environment problem, not a project failure', async t => {
  const f = fixture(t);
  const x = deps(f, daemon(), { execute: async logFile => {
    writeFileSync(logFile, 'Error: failed to create container: network problem\n' + line({ msg: 'Job failed', jobResult: 'failure' }));
    throw Object.assign(new Error('exit'), { logFile, executionFailure: { exitCode: 1, causes: ['child-exit-nonzero'] } });
  } });
  const report = await replayCi(options(f), x.deps);
  assert.equal(report.outcome, 'incomplete');
  assert.ok(report.issues.some(i => i.code === 'job-failed-outside-workflow-steps'));
  assert.ok(report.runnerOutput[0].includes('failed to create container'));
  assert.equal(report.nextActions.at(-1).kind, 'read-runner-output');
  assert.equal(report.resources.cleanup.outcome, 'cleaned', 'the run-owned network is removed too');
});
