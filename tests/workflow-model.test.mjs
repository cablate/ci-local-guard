import test from 'node:test';
import assert from 'node:assert/strict';
import { actContainerName, actResourceNames, jobClosure, matrixLegs, parseWorkflow, runnerLabels } from '../src/workflow-model.mjs';

test('container names match act v0.2.89 as observed on a live Docker engine', () => {
  // Observed for workflow "Tests", job "test" with one selected matrix leg.
  assert.equal(actContainerName('act', 'Tests/test'), 'act-Tests-test-efaca9afe36619b200b3cfa9e5d34050817b306c4f3904a728db9dc8b724d71d');
  assert.ok(actContainerName('act', 'x'.repeat(200)).length <= 63 + 65);
});

test('parsing keeps on as an event key, locations and duplicate-key errors', () => {
  const wf = parseWorkflow('name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  b:\n    needs: a\n    runs-on: ubuntu-latest\n    steps: []\n', 'ci.yml');
  assert.deepEqual(wf.issues, []);
  assert.deepEqual(wf.triggers.map(t => t.event), ['push', 'pull_request']);
  assert.deepEqual(wf.triggers[0].filters, { branches: ['main'] });
  assert.equal(wf.jobs[0].steps[0].line, 10);
  assert.deepEqual(wf.jobs[1].needs, ['a']);
  assert.equal(parseWorkflow('on: push\non: pull_request\njobs: {}\n', 'x.yml').issues[0].code, 'duplicate-key');
  assert.equal(parseWorkflow('on: [push\n', 'x.yml').issues[0].code, 'yaml-syntax');
  assert.equal(parseWorkflow('- list\n', 'x.yml').issues[0].code, 'workflow-not-a-mapping');
});

test('static matrix legs follow include and exclude; expressions are dynamic', () => {
  assert.deepEqual(matrixLegs({ os: ['a', 'b'], node: [1, 2], exclude: [{ os: 'b', node: 2 }] }).legs,
    [{ os: 'a', node: 1 }, { os: 'a', node: 2 }, { os: 'b', node: 1 }]);
  assert.deepEqual(matrixLegs({ os: ['a'], include: [{ os: 'a', extra: 1 }, { os: 'c' }] }).legs, [{ os: 'a', extra: 1 }, { os: 'c' }]);
  assert.equal(matrixLegs('${{ fromJSON(needs.a.outputs.m) }}').kind, 'dynamic');
  assert.equal(matrixLegs({ os: '${{ inputs.os }}' }).kind, 'dynamic');
  assert.deepEqual(matrixLegs(undefined).legs, [{}]);
  const job = { runsOn: '${{ matrix.os }}' };
  assert.deepEqual(runnerLabels(job, { os: 'ubuntu-latest' }), ['ubuntu-latest']);
  assert.equal(runnerLabels(job, {}), null);
  assert.equal(runnerLabels({ runsOn: '${{ inputs.runner }}' }, {}), null);
});

test('job closure includes needs and rejects cycles and unknown jobs', () => {
  const wf = parseWorkflow('on: push\njobs:\n  a: {runs-on: x}\n  b: {runs-on: x, needs: a}\n  c: {runs-on: x, needs: [b]}\n', 'w.yml');
  assert.deepEqual(jobClosure(wf, 'c').map(j => j.id), ['a', 'b', 'c']);
  assert.throws(() => jobClosure(wf, 'zzz'), /unknown-job/);
  const cyclic = parseWorkflow('on: push\njobs:\n  a: {runs-on: x, needs: b}\n  b: {runs-on: x, needs: a}\n', 'w.yml');
  assert.throws(() => jobClosure(cyclic, 'a'), /cyclic/);
});

test('resource names cover services, networks, docker steps and matrix suffixes', () => {
  const wf = parseWorkflow('on: push\njobs:\n  t:\n    name: Test ${{ matrix.os }}\n    runs-on: ubuntu-latest\n    strategy: {matrix: {os: [a, b]}}\n    services: {db: {image: postgres}}\n    steps: [{run: x}, {id: build, uses: docker://alpine}]\n', 'ci.yml');
  const names = actResourceNames(wf, wf.jobs, { os: 'a' });
  const jcn = actContainerName('act', 'ci.yml/Test a');
  assert.ok(names.container.includes(jcn));
  assert.ok(names.container.includes(actContainerName(jcn, 'db')));
  assert.ok(names.container.includes(actContainerName(jcn, 'build')));
  assert.ok(names.volume.includes(`${jcn}-env`));
  assert.ok(names.network.includes(`${jcn}-t-network`));
  assert.ok(!names.container.includes(actContainerName('act', 'ci.yml/Test b')));
  const all = actResourceNames(wf, wf.jobs);
  assert.ok(all.container.includes(actContainerName('act', 'ci.yml/Test a-1')));
  const unknown = parseWorkflow('on: push\njobs:\n  t:\n    name: Run ${{ github.ref }}\n    runs-on: x\n    steps: []\n', 'w.yml');
  assert.equal(actResourceNames(unknown, unknown.jobs).unpredictable[0].reason, 'job-name-expression');
});
