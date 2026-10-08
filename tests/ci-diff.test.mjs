import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function repoWith(edit) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-diff-'));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  mkdirSync(path.join(repo, 'docs'));
  writeFileSync(path.join(repo, 'docs', 'guide.md'), 'x');
  writeFileSync(path.join(repo, 'index.js'), 'x');
  writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), BASE);
  git('add', '.'); git('commit', '-qm', 'base');
  writeFileSync(path.join(repo, '.github', 'workflows', 'ci.yml'), edit(BASE));
  git('commit', '-qam', 'edit');
  return repo;
}

async function diff(name) {
  const repo = repoWith(variants[name]);
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

test('options fail closed', () => {
  assert.throws(() => diffOptions(['--base']), /invalid-diff-options/);
  assert.throws(() => diffOptions(['--x', 'y']), /invalid-diff-options/);
});
