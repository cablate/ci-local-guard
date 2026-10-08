import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCi } from '../src/ci-discovery.mjs';
import { planTargets, verifyCi, verifyOptions, summarizeVerify } from '../src/ci-verify.mjs';

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
