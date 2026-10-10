import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffCi, diffOptions } from '../src/ci-diff.mjs';

const BASE = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
  test:
    needs: lint
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - run: npm test
      - run: npm run typecheck
`;

// Each variant is the base workflow with one edit.
const variants = {
  'matrix OS removed': s => s.replace('[ubuntu-latest, windows-latest]', '[ubuntu-latest]'),
  'wrong branch filter': s => s.replace('branches: [main]', 'branches: [mian]'),
  'required job disabled': s => s.replace('  lint:\n    runs-on', '  lint:\n    if: false\n    runs-on'),
  'check command deleted': s => s.replace('      - run: npm run typecheck\n', ''),
  'failures tolerated': s => s.replace('  test:\n    needs: lint', '  test:\n    needs: lint\n    continue-on-error: true'),
  'step failures tolerated': s => s.replace('      - run: npm test', '      - run: npm test\n        continue-on-error: true'),
  'docs ignored': s => s.replace('  pull_request:\n', "  pull_request:\n    paths-ignore: ['docs/**']\n"),
  'job renamed': s => s.replace('  lint:\n', '  static-checks:\n').replace('needs: lint', 'needs: static-checks'),
  'job split': s => s.replace('      - run: npm run typecheck\n', '') + '  types:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run typecheck\n',
  'action bumped': s => s.replaceAll('actions/checkout@v4', 'actions/checkout@v5'),
  'condition expression': s => s.replace('  lint:\n    runs-on', "  lint:\n    if: github.actor != 'bot'\n    runs-on"),
};

function repoWith(edit, workflow = BASE, files = ['docs/guide.md', 'index.js']) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-diff-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  for (const file of files) {
    mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(repo, file), 'x');
  }
  writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), workflow);
  git('add', '.'); git('commit', '-qm', 'base');
  writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), edit(workflow));
  git('commit', '-qam', 'edit');
  return repo;
}

async function diff(name) {
  const repo = repoWith(variants[name]);
  try { return await diffCi(diffOptions(['--repo', repo, '--base', 'HEAD~1', '--head', 'HEAD'])); }
  finally { rmSync(repo, { recursive: true, force: true }); }
}

async function diffEdit(workflow, edit, files) {
  const repo = repoWith(edit, workflow, files);
  try { return await diffCi(diffOptions(['--repo', repo, '--base', 'HEAD~1', '--head', 'HEAD'])); }
  finally { rmSync(repo, { recursive: true, force: true }); }
}
const kinds = (report, effect) => report.changes.filter(c => c.effect === effect).map(c => c.kind);

test('every deliberate coverage reduction is flagged with its location', async () => {
  const expected = { 'matrix OS removed': 'legs-removed', 'wrong branch filter': 'trigger-narrowed', 'required job disabled': 'job-disabled',
    'check command deleted': 'command-removed', 'failures tolerated': 'job-failures-tolerated', 'step failures tolerated': 'step-failures-tolerated',
    'docs ignored': 'trigger-narrowed' };
  for (const [name, kind] of Object.entries(expected)) {
    const report = await diff(name);
    assert.equal(report.outcome, 'reduced', name);
    assert.ok(kinds(report, 'reduced').includes(kind), `${name}: ${JSON.stringify(report.changes)}`);
  }
  const legs = (await diff('matrix OS removed')).changes.find(c => c.kind === 'legs-removed');
  assert.deepEqual(legs.legs, [{ leg: 'windows-latest', runsOn: ['windows-latest'] }]);
  const docs = (await diff('docs ignored')).changes.find(c => c.kind === 'trigger-narrowed');
  assert.deepEqual([docs.scenario, docs.files, docs.examples], ['pull_request into main', 1, ['docs/guide.md']]);
  const branch = (await diff('wrong branch filter')).changes.filter(c => c.kind === 'trigger-narrowed').map(c => c.scenario);
  assert.deepEqual(branch, ['push to main'], 'pushes to other branches were never triggered');
  const removed = (await diff('check command deleted')).changes.find(c => c.kind === 'command-removed');
  assert.deepEqual([removed.command, removed.baseLine], ['npm run typecheck', 21]);
});

test('renames, splits and action bumps are not reductions', async () => {
  for (const name of ['job renamed', 'job split', 'action bumped']) {
    const report = await diff(name);
    assert.equal(report.outcome, 'no-reduction', `${name}: ${JSON.stringify(report.changes)}`);
  }
  assert.ok(kinds(await diff('job renamed'), 'neutral').includes('job-renamed'));
  const split = await diff('job split');
  assert.deepEqual(split.changes.find(c => c.kind === 'command-moved').to.map(t => t.job), ['types']);
});

test('an unevaluated condition is undetermined, never equivalent', async () => {
  const report = await diff('condition expression');
  assert.equal(report.outcome, 'undetermined');
  assert.deepEqual(kinds(report, 'unknown'), ['job-condition-changed']);
});

// Neither the default branch nor the probe branch matches branches: [dev], so
// paths filters scoped to such a workflow need a probe on the named branch.
const devWorkflow = filter => `name: CI
on:
  push:
    branches: [dev]
    ${filter}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
const devFiles = ['CHANGELOG.md', 'src/app.js', 'docs/guide.md'];

test('paths filters on a custom branch are probed on that branch', async () => {
  const narrowed = await diffEdit(devWorkflow("paths: ['src/**', 'CHANGELOG.md']"),
    s => s.replace("'src/**', 'CHANGELOG.md'", "'src/**'"), devFiles);
  const n = narrowed.changes.find(c => c.kind === 'trigger-narrowed');
  assert.deepEqual([n.scenario, n.files, n.examples], ['push to dev', 1, ['CHANGELOG.md']],
    'dropping a path stops CHANGELOG.md pushes to dev from triggering');

  const widened = await diffEdit(devWorkflow("paths-ignore: ['docs/**', 'CHANGELOG.md']"),
    s => s.replace("'docs/**', 'CHANGELOG.md'", "'docs/**'"), devFiles);
  const w = widened.changes.find(c => c.kind === 'trigger-widened');
  assert.deepEqual([w.scenario, w.files, w.examples], ['push to dev', 1, ['CHANGELOG.md']],
    'dropping a paths-ignore entry starts triggering CHANGELOG.md pushes to dev');
  assert.equal(widened.outcome, 'no-reduction');
});

test('when both usual branch probes are ignored, a representative that is not ignored is probed', async () => {
  const ignored = `name: CI
on:
  push:
    branches-ignore: ['main', 'guard-probe/**']
    paths: ['src/**', 'CHANGELOG.md']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
  const report = await diffEdit(ignored, s => s.replace("'src/**', 'CHANGELOG.md'", "'src/**'"), devFiles);
  const n = report.changes.find(c => c.kind === 'trigger-narrowed');
  assert.equal(n.scenario, 'push to guard-probe-branch', 'main and guard-probe/feature are both ignored');
  assert.deepEqual(n.examples, ['CHANGELOG.md']);
});

test('tag probes cover a name that the built-in probe tag does not reach', async () => {
  const report = await diffEdit(`name: CI
on:
  push:
    tags-ignore: ['v*']
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`, s => s.replace("tags-ignore: ['v*']", "tags: ['v*']"), []);
  const n = report.changes.find(c => c.kind === 'trigger-narrowed');
  assert.deepEqual([n.scenario, n.files], ['push of tag guard-probe-tag', 'every tag push'],
    'the built-in v0.0.0-guard-probe matches v* on both sides; only the representative sees the switch to an include list');
});

test('options fail closed', () => {
  assert.throws(() => diffOptions(['--base']), /invalid-diff-options/);
  assert.throws(() => diffOptions(['--x', 'y']), /invalid-diff-options/);
  assert.deepEqual(diffOptions(['--json']), { summary: false, json: true }, '--json is accepted like the other ci commands');
  assert.throws(() => diffOptions(['--bogus', 'y']),
    error => error.diffCode === 'invalid-diff-options' && error.detail === '--bogus',
    'the rejection names the unsupported option in its detail');
});

test('a blocked diff option names the unsupported flag in the CLI report', t => {
  const repo = repoWith(workflow => `${workflow}# probe\n`, 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{run: npm test}]\n', ['index.js']);
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'ci', 'diff', '--repo', repo, '--bogus'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.stderr, '');
  const report = JSON.parse(r.stdout);
  assert.equal(report.outcome, 'blocked');
  assert.equal(report.issues[0].code, 'invalid-diff-options');
  assert.equal(report.issues[0].detail, '--bogus');
});
