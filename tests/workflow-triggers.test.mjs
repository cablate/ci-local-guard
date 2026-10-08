import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrigger, filterPattern, matchList } from '../src/workflow-triggers.mjs';
import { parseWorkflow } from '../src/workflow-model.mjs';

test('filter patterns follow the GitHub cheat sheet examples', () => {
  const cases = [
    ['*', 'README.md', true], ['*', 'docs/a.md', false], ['*.js', 'app.js', true], ['*.js', 'src/app.js', false],
    ['**.js', 'src/deep/app.js', true], ['docs/*', 'docs/a.md', true], ['docs/*', 'docs/x/a.md', false],
    ['docs/**', 'docs/x/a.md', true], ['**/docs/**', 'a/docs/b/c.md', true], ['**/README.md', 'a/b/README.md', true], ['**/README.md', 'README.md', true], ['src/**/*.md', 'src/a.md', true],
    ['*.jsx?', 'page.js', true], ['*.jsx?', 'page.jsx', true], ['feature/*', 'feature/x', true], ['feature/*', 'feature/x/y', false],
    ['v[12].*', 'v1.0', true], ['v[12].*', 'v3.0', false], ['releases/**-alpha', 'releases/beta/3-alpha', true],
  ];
  for (const [pattern, value, expected] of cases) assert.equal(filterPattern(pattern).test(value), expected, `${pattern} vs ${value}`);
  assert.equal(matchList('sub/a.js', ['**.js', '!sub/**']), false);
  assert.equal(matchList('sub/keep.js', ['**.js', '!sub/**', 'sub/keep.js']), true, 'later patterns win');
});

const wf = on => parseWorkflow(`on:\n${on}\njobs: {}\n`, 'w.yml');
const push = (workflow, ref, changedFiles = ['src/a.js']) => evaluateTrigger(workflow, { event: 'push', ref, changedFiles });

test('push: branch, tag and path filters decide triggered, not triggered or unknown', () => {
  assert.equal(push(wf('  push:'), 'refs/heads/x').status, 'triggered');
  assert.equal(push(wf('  pull_request:'), 'refs/heads/x').status, 'not-triggered');
  const tagsOnly = wf('  push:\n    tags: [v*]');
  assert.equal(push(tagsOnly, 'refs/heads/main').status, 'not-triggered');
  assert.equal(push(tagsOnly, 'refs/tags/v1.0').status, 'triggered');
  const branches = wf('  push:\n    branches: [main, "release/**"]');
  assert.equal(push(branches, 'refs/heads/release/1/x').status, 'triggered');
  assert.equal(push(branches, 'refs/heads/feature').status, 'not-triggered');
  assert.equal(push(wf('  push:\n    branches-ignore: ["wip/*"]'), 'refs/heads/wip/a').status, 'not-triggered');
  const docs = wf('  push:\n    paths-ignore: ["docs/**", "*.md"]');
  assert.equal(push(docs, 'refs/heads/x', ['docs/a.md', 'README.md']).status, 'not-triggered');
  assert.equal(push(docs, 'refs/heads/x', ['docs/a.md', 'src/a.js']).status, 'triggered');
  assert.equal(push(docs, 'refs/heads/x', null).status, 'unknown', 'missing change list is unknown, not skipped');
  const src = wf('  push:\n    paths: ["src/**", "!src/**/*.md"]');
  assert.equal(push(src, 'refs/heads/x', ['src/notes.md']).status, 'not-triggered');
  assert.equal(push(src, 'refs/heads/x', ['src/a.js']).reasons.at(-1), 'src/a.js matches on.push.paths');
});

test('pull_request: target branch and activity types', () => {
  const pr = wf('  pull_request:\n    branches: [main]');
  assert.equal(evaluateTrigger(pr, { event: 'pull_request', targetBranch: 'main', changedFiles: [] }).status, 'triggered');
  assert.equal(evaluateTrigger(pr, { event: 'pull_request', targetBranch: 'dev', changedFiles: [] }).status, 'not-triggered');
  assert.equal(evaluateTrigger(pr, { event: 'pull_request', targetBranch: null, changedFiles: [] }).status, 'unknown');
  const labeled = wf('  pull_request:\n    types: [labeled]');
  assert.equal(evaluateTrigger(labeled, { event: 'pull_request', targetBranch: 'main', changedFiles: [] }).status, 'unknown');
  assert.equal(evaluateTrigger(wf('  schedule:\n    - cron: "0 0 * * *"'), { event: 'schedule' }).status, 'unknown');
});
