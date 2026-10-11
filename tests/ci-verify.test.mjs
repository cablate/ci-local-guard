import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCi } from '../src/ci-discovery.mjs';
import { hostExecutableLegs, planTargets, verifyCi, verifyOptions, summarizeVerify } from '../src/ci-verify.mjs';

const CI = `name: CI
on:
  push:
    branches: [main, "feature/**"]
    paths-ignore: ["docs/**"]
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{run: npm run build}]
  test:
    needs: build
    strategy: {matrix: {os: [ubuntu-latest, windows-latest]}}
    runs-on: \${{ matrix.os }}
    steps: [{run: npm test}]
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    environment: production
    runs-on: ubuntu-latest
    steps: [{run: ./deploy.sh}]
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: curl -H "\${{ secrets.HOOK }}" x
  shared:
    uses: ./.github/workflows/lint.yml
`;
const LINT = 'on: workflow_call\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps: [{run: npm run lint}]\n';
const RELEASE = 'on:\n  push:\n    tags: [v*]\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps: [{run: npm publish}]\n';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.email', 'f@example.invalid'); git('config', 'user.name', 'F');
  const write = (name, value) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), value); };
  write('.github/workflows/ci.yml', CI); write('.github/workflows/lint.yml', LINT); write('.github/workflows/release.yml', RELEASE);
  write('src/a.js', '1'); write('docs/a.md', 'x');
  git('add', '.'); git('commit', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/x');
  return { root, git, write };
}
const tools = { actionlint: 'available', act: 'available', docker: 'linux-engine', zizmor: 'missing', gh: 'missing' };
const discover = args => ({ ...discoverCi(args), tools });
const passCheck = async () => ({ outcome: 'passed', findings: [], issues: [] });

test('targets: needs are replayed through their dependants; secrets, environments and Windows stay hosted', t => {
  const f = fixture(t);
  const inventory = discoverCi({ repo: f.root });
  const triggers = inventory.workflows.map(wf => ({ workflow: wf.path, status: wf.path.endsWith('release.yml') ? 'not-triggered' : 'triggered' }));
  const plan = planTargets(inventory.workflows, triggers);
  assert.deepEqual(plan.targets.map(x => `${x.workflow.slice(18)}/${x.job}/${x.matrix.os || ''}`).sort(), ['ci.yml/test/ubuntu-latest', 'lint.yml/lint/']);
  assert.deepEqual(plan.hostedOnly.map(x => x.job).sort(), ['deploy', 'notify', 'test']);
  assert.equal(plan.hostedOnly.find(x => x.job === 'test').matrix.os, 'windows-latest');
});

test('a docs-only push is not triggered and nothing is replayed', async t => {
  const f = fixture(t);
  f.write('docs/a.md', 'changed'); f.git('commit', '-qam', 'docs');
  const replays = [];
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--base', 'main']), { discover, check: passCheck,
    replay: async opts => { replays.push(opts); return { outcome: 'passed', jobs: [], failures: [], issues: [], nextActions: [] }; } });
  assert.equal(report.triggers.find(x => x.workflow.endsWith('ci.yml')).status, 'not-triggered');
  assert.match(report.triggers.find(x => x.workflow.endsWith('ci.yml')).reasons.at(-1), /paths-ignore/);
  assert.equal(replays.length, 0);
  assert.equal(report.outcome, 'clear-locally');
  assert.deepEqual(report.identity.changedFiles.files, ['docs/a.md']);
});

test('a code push replays each selected leg; one failure makes the whole verdict expected-to-fail', async t => {
  const f = fixture(t);
  f.write('src/a.js', '2'); f.git('commit', '-qam', 'code');
  const replays = [];
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--base', 'main', '--platform', 'ubuntu-latest=node:22']), { discover, check: passCheck,
    replay: async opts => {
      replays.push(opts);
      if (opts.job === 'lint') return { outcome: 'passed', jobs: [{ job: 'lint', result: 'success' }], failures: [], issues: [], nextActions: [], evidence: [] };
      return { outcome: 'failed', jobs: [{ job: 'build', result: 'success' }, { job: 'test', result: 'failure' }], issues: [], evidence: [{ path: 'log' }],
        failures: [{ job: 'test', step: { name: 'npm test' }, workflowLocation: { path: '.github/workflows/ci.yml', line: 15 }, command: 'npm test',
          observed: { failedTests: ['adds'], lastLines: ['not ok 1 - adds'] }, evidence: { reader: { command: 'read-evidence', args: ['--file', 'log'] } } }],
        nextActions: [{ kind: 'read-failed-step-log' }] };
    } });
  assert.equal(report.outcome, 'expected-to-fail');
  assert.deepEqual(replays.map(r => [r.job, r.matrix, r.event, r.ref, r.platform['ubuntu-latest']]),
    [['test', { os: 'ubuntu-latest' }, 'push', 'refs/heads/feature/x', 'node:22']]);
  // A workflow_call-only reusable workflow cannot be replayed yet: listed, never counted as passed.
  assert.match(report.notVerified.find(x => x.job === 'shared').reason, /runs reusable workflow \.github\/workflows\/lint\.yml/);
  assert.equal(report.triggers.find(x => x.workflow.endsWith('lint.yml')).status, 'called');
  assert.match(report.verdict, /1 expected failure\(s\): ci\.yml\/test \(ubuntu-latest\) step "npm test" \(adds\)/);
  assert.match(report.verdict, /0 job leg\(s\) passed locally; 1 not verified locally/);
  assert.match(report.verdict, /hosted-only/);
  assert.deepEqual(report.nextActions.slice(0, 2).map(a => a.kind), ['read-failed-step-log', 'reproduce-in-working-tree']);
  assert.equal(report.notTriggered[0].workflow, '.github/workflows/release.yml');
  assert.equal(summarizeVerify(report).expectedFailures[0].failures[0].reader, undefined);
});

test('blocked replays and unknown changes are incomplete, never clear', async t => {
  const f = fixture(t);
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--base', 'does-not-exist']), { discover, check: passCheck,
    replay: async () => ({ outcome: 'blocked', jobs: [], failures: [], issues: [{ code: 'act-unavailable' }], nextActions: [{ kind: 'provide-act' }] }) });
  assert.equal(report.identity.changedFiles.count, null);
  assert.equal(report.outcome, 'incomplete');
  assert.ok(report.notVerified.some(x => x.reason === 'act-unavailable'));
  assert.ok(report.nextActions.some(a => a.kind === 'declare-base'));
  const noLint = await verifyCi(verifyOptions(['--repo', f.root, '--static-only']), { discover: args => ({ ...discoverCi(args), tools: { ...tools, actionlint: 'missing' } }) });
  assert.equal(noLint.outcome, 'incomplete');
  assert.equal(noLint.staticCheck.outcome, 'not-run');
  assert.throws(() => verifyOptions(['--event', 'schedule']), /unsupported-event/);
  assert.throws(() => verifyOptions(['--base', '--upload-pack=x']), /invalid-verify-options/);
});

test('a --platform mapping turns third-party runner legs into replay targets, not hosted-only', async t => {
  const f = fixture(t);
  f.write('.github/workflows/bs.yml', 'on: pull_request\njobs:\n  bs:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps: [{run: node --test}]\n');
  f.git('add', '.'); f.git('commit', '-qm', 'bs');
  const seen = [];
  const spyDiscover = args => { seen.push(args); return { ...discoverCi(args), tools }; };
  const base = { discover: spyDiscover, check: passCheck,
    replay: async opts => ({ outcome: 'passed', jobs: [{ job: opts.job, result: 'success' }], failures: [], issues: [], nextActions: [] }) };
  const opts = ['--repo', f.root, '--event', 'pull_request', '--static-only',
    '--platform', 'blacksmith-2vcpu-ubuntu-2404=catthehacker/ubuntu:act-22.04'];
  const mapped = await verifyCi(verifyOptions(opts), base);
  assert.deepEqual(seen[0].platform, { 'blacksmith-2vcpu-ubuntu-2404': 'catthehacker/ubuntu:act-22.04' });
  assert.ok(mapped.hostedOnly.every(x => x.workflow !== '.github/workflows/bs.yml'));
  assert.ok(mapped.notVerified.some(x => x.workflow === '.github/workflows/bs.yml' && x.stage === 'replay' && x.reason === 'skipped-by-static-only'));
  const unmapped = await verifyCi(verifyOptions(opts.slice(0, -2)), { ...base, discover: spyDiscover });
  assert.ok(unmapped.hostedOnly.some(x => x.workflow === '.github/workflows/bs.yml' && /blacksmith-2vcpu-ubuntu-2404/.test(x.reason)));
  assert.ok(!unmapped.notVerified.some(x => x.workflow === '.github/workflows/bs.yml'));
});

const staticFinding = (file, rule, message) => ({ provider: 'actionlint', rule, severity: 'error', message, location: { path: file, line: 3, column: 1 } });
const envFailure = step => ({ job: 'build', step: { id: '1', name: step, stage: 'Main' }, workflowLocation: { path: '.github/workflows/ci.yml', line: 9 },
  command: step, action: null,
  observed: { lastLines: ['chrome-headless-shell: error while loading shared libraries: libnspr4.so'], failedTests: [],
    environmentMismatch: { kind: 'missing-shared-library', detail: 'libnspr4.so', meaning: 'image gap' } },
  evidence: { reader: { command: 'read-evidence', args: [] } } });
const realFailure = step => ({ ...envFailure(step), observed: { lastLines: ['AssertionError'], failedTests: ['rejects bad input'] } });
const passedReplay = async () => ({ outcome: 'passed', jobs: [], failures: [], issues: [], nextActions: [] });

test('static findings of workflows this event does not trigger stay visible but are not failures', async t => {
  const f = fixture(t);
  f.write('.github/workflows/canary.yml', 'on: workflow_dispatch\njobs:\n  canary:\n    runs-on: ubuntu-latest\n    steps: [{run: ./canary.sh}]\n');
  f.git('add', '.'); f.git('commit', '-qm', 'canary');
  const seen = [];
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--event', 'pull_request', '--static-only']), {
    discover, replay: passedReplay,
    check: async opts => { seen.push(opts); return { outcome: 'findings', issues: [],
      findings: [staticFinding('.github/workflows/canary.yml', 'expr', 'broken expression')] }; } });
  assert.deepEqual(seen.at(-1).runnerLabels, []);
  assert.equal(report.staticOutsideTrigger.length, 1);
  assert.equal(report.staticOutsideTrigger[0].workflow, '.github/workflows/canary.yml');
  assert.equal(report.staticOutsideTrigger[0].finding.rule, 'expr');
  assert.equal(report.expectedFailures.length, 0);
  assert.equal(report.outcome, 'incomplete');
  assert.match(report.verdict, /1 static finding\(s\) outside the event/);
});

test('a runner-label finding for a label the caller mapped is a coverage note, not a failure', async t => {
  const f = fixture(t);
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--event', 'push', '--static-only',
    '--platform', 'blacksmith-2vcpu-ubuntu-2404=catthehacker/ubuntu:act-24.04']), {
    discover, replay: passedReplay,
    check: async () => ({ outcome: 'findings', issues: [], findings: [
      staticFinding('.github/workflows/ci.yml', 'runner-label', 'label "blacksmith-2vcpu-ubuntu-2404" is unknown. available labels are "ubuntu-latest"'),
      staticFinding('.github/workflows/ci.yml', 'expression', 'unreadable expression')] }) });
  assert.deepEqual(report.expectedFailures.map(item => item.rule), ['expression']);
  assert.equal(report.staticCheck.mappedRunnerLabels, 1);
});

test('replay failures caused by image gaps are environment notes, not expected failures', async t => {
  const f = fixture(t);
  const base = { discover, check: passCheck };
  const only = await verifyCi(verifyOptions(['--repo', f.root, '--event', 'push']), { ...base,
    replay: async () => ({ outcome: 'failed', jobs: [{ job: 'build', result: 'failure' }], issues: [], nextActions: [],
      failures: [envFailure('npm run check')] }) });
  assert.equal(only.expectedFailures.length, 0);
  const gap = only.notVerified.find(item => item.stage === 'replay-environment');
  assert.ok(gap && gap.failures[0].environmentMismatch.kind === 'missing-shared-library');
  assert.equal(only.outcome, 'incomplete');
  assert.match(only.verdict, /replay environment gap\(s\)/);
  const mixed = await verifyCi(verifyOptions(['--repo', f.root, '--event', 'push']), { ...base,
    replay: async () => ({ outcome: 'failed', jobs: [{ job: 'build', result: 'failure' }], issues: [], nextActions: [],
      failures: [envFailure('npm run check'), realFailure('npm run build')] }) });
  assert.equal(mixed.expectedFailures.length, 1);
  assert.equal(mixed.expectedFailures[0].failures[0].step, 'npm run build');
  assert.equal(mixed.expectedFailures[0].environmentFailures, 1);
});

test('--runner-label is repeatable and reaches the static check', async t => {
  const f = fixture(t);
  const seen = [];
  await verifyCi(verifyOptions(['--repo', f.root, '--event', 'push', '--static-only',
    '--runner-label', 'blacksmith-2vcpu-ubuntu-2404', '--runner-label', 'blacksmith-2vcpu-ubuntu-2204']),
    { discover, replay: passedReplay, check: async opts => { seen.push(opts); return { outcome: 'passed', findings: [], issues: [] }; } });
  assert.deepEqual(seen[0].runnerLabels, ['blacksmith-2vcpu-ubuntu-2404', 'blacksmith-2vcpu-ubuntu-2204']);
  assert.throws(() => verifyOptions(['--runner-label']), /invalid-verify-options/);
  assert.throws(() => verifyOptions(['--runner-label', 'bad label']), /invalid-verify-options/);
});

test('hosted-only legs whose runner family matches the machine get working-tree commands', t => {
  const f = fixture(t);
  const inventory = discoverCi({ repo: f.root });
  const triggers = inventory.workflows.map(wf => ({ workflow: wf.path, status: wf.path.endsWith('release.yml') ? 'not-triggered' : 'triggered' }));
  const plan = planTargets(inventory.workflows, triggers);
  const windows = plan.hostedOnly.find(x => x.job === 'test');
  assert.deepEqual(windows.labels, ['windows-latest'], 'plan keeps runner labels');
  const parsed = inventory.workflows.filter(wf => wf.analysis === 'parsed');
  const onWindows = hostExecutableLegs(plan.hostedOnly, parsed, 'win32');
  assert.equal(onWindows.length, 1);
  assert.equal(onWindows[0].job, 'test');
  assert.equal(onWindows[0].matrix.os, 'windows-latest');
  const testStep = inventory.workflows.find(wf => wf.path === '.github/workflows/ci.yml').jobs.find(job => job.id === 'test').steps[0];
  assert.deepEqual(onWindows[0].commands, [{ line: testStep.line, run: 'npm test' }]);
  assert.match(onWindows[0].limitation, /not isolated/);
  assert.deepEqual(hostExecutableLegs(plan.hostedOnly, parsed, 'linux'), [], 'a Linux host replay covers these; a mac family does not match either');
  assert.deepEqual(hostExecutableLegs(plan.hostedOnly, parsed, 'darwin'), []);
});

test('verify suggests host-executable commands without changing the outcome', async t => {
  const f = fixture(t);
  f.write('src/a.js', '3'); f.git('commit', '-qam', 'code');
  const report = await verifyCi(verifyOptions(['--repo', f.root, '--base', 'main', '--static-only', '--platform', 'ubuntu-latest=node:22']),
    { discover, check: passCheck, replay: async () => ({ outcome: 'passed', jobs: [], failures: [], issues: [], nextActions: [] }), hostPlatform: 'win32' });
  assert.equal(report.outcome, 'incomplete', 'static-only keeps replays not-verified; hostExecutable never flips the outcome');
  assert.equal(report.hostExecutable.length, 1);
  assert.equal(report.hostExecutable[0].job, 'test');
  const action = report.nextActions.find(item => item.kind === 'run-host-commands');
  assert.ok(action, 'a run-host-commands suggestion exists');
  assert.equal(action.legs[0].job, 'test');
  assert.equal(action.legs[0].commands[0].run, 'npm test');
  assert.match(action.note, /not isolated/);
  const summary = summarizeVerify(report);
  assert.equal(summary.hostExecutable[0].commands[0].run, 'npm test');
});
