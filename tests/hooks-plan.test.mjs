import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanGitEnvironment, projectPreflight } from '../src/project.mjs';
import { cli, fixtureRepo, seedPreflightFixture, invoke, assertTiming, pushInput } from './support/hooks-fixtures.mjs';

test('with-plan uses fresh receipts and exposes missing selected owners, retaining review and incomplete semantics', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'generic' });
    const descriptor = path.join(fixture.root, '.ci-local-guard.json');
    const config = JSON.parse(readFileSync(descriptor, 'utf8'));
    config.plan = { entrypoint: 'quality/plan.mjs', dependencies: 'none' };
    writeFileSync(descriptor, JSON.stringify(config));
    writeFileSync(path.join(fixture.root, 'quality/plan.mjs'), `
      const option = flag => process.argv[process.argv.indexOf(flag) + 1];
      const eventContext = JSON.parse(process.env.CI_LOCAL_GUARD_EVENT_CONTEXT);
      const review = eventContext.ref === null;
      console.log(JSON.stringify({ schemaVersion: 'ci-local-guard/project-plan/v1',
        identity: { base: option('--base'), head: option('--head'), event: option('--event'), mode: 'committed' },
        eventContext, changedFiles: ['src/input.txt'], needsReview: review,
        jobs: [{ id: 'verify', selected: true, reason: 'declared owner', owners: ['fixture', 'release'] }] }));
      process.exitCode = review ? 2 : 0;
    `);
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'base\n');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'plan contract');
    candidate.base = fixture.git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'committed\n');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'candidate');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    assert.equal(invoke(fixture, candidate, 'preflight').status, 0);
    const args = ['--json', '--with-plan', '--event', 'push', '--ref', 'refs/heads/main'];
    const result = invoke(fixture, candidate, 'preflight', { args });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.product.status, 'ran');
    assert.equal(report.product.result, 'success');
    assert.equal(report.outcome, 'incomplete');
    assert.equal(report.planObligations.status, 'unresolved');
    assert.deepEqual(report.planObligations.missing, ['release']);
    assert.equal(report.eventContext.verified, false);
    assert.equal(report.timing.phases.planSelection.status, 'completed');
    const review = invoke(fixture, candidate, 'preflight', { args: args.slice(0, -2) });
    assert.equal(review.status, 2, review.stderr);
    assert.equal(JSON.parse(review.stdout).outcome, 'needs-review');
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 3);
    const next = invoke(fixture, candidate, 'preflight');
    assert.match(next.stdout, /ran.*PASS/);
    const invalid = invoke(fixture, candidate, 'preflight', { args: ['--ref', 'refs/heads/main'] });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /preflight --with-plan/);
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('committed generic plan adapter predicts exact event and diff without Synora files, while generic push remains blocked', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'generic' });
    const descriptor = path.join(fixture.root, '.ci-local-guard.json');
    const config = JSON.parse(readFileSync(descriptor, 'utf8'));
    config.plan = { entrypoint: 'quality/plan.mjs', dependencies: 'none' };
    writeFileSync(descriptor, JSON.stringify(config));
    mkdirSync(path.join(fixture.root, 'quality'), { recursive: true });
    writeFileSync(path.join(fixture.root, 'quality/plan.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      if (readFileSync('src/input.txt', 'utf8') !== 'committed\\n') throw Error('wrong input');
      const option = flag => process.argv[process.argv.indexOf(flag) + 1];
      const base = option('--base'), head = option('--head'), event = option('--event');
      const changedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', base, head], {encoding:'utf8'}).trim().split(/\\r?\\n/).filter(Boolean);
      const needsReview = process.env.GUARD_TEST_PLAN_REVIEW === '1';
      const eventContext = JSON.parse(process.env.CI_LOCAL_GUARD_EVENT_CONTEXT);
      if (process.env.GUARD_TEST_PLAN_WRONG_REF) eventContext.ref = 'refs/heads/wrong';
      if (process.env.GUARD_TEST_PLAN_WRONG_PR) eventContext.prFork = !eventContext.prFork;
      console.log(JSON.stringify({schemaVersion:'ci-local-guard/project-plan/v1', identity:{base,head:process.env.GUARD_TEST_PLAN_BAD ? '0'.repeat(40) : head,event,mode:'committed'},changedFiles,eventContext,
        jobs:[{id:'ci.verify',selected:true,reason:'full verification retained',owners:['release']}],needsReview}));
      process.exitCode = needsReview ? 2 : 0;
    `);
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'generic plan owner');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    writeFileSync(descriptor, '{dirty descriptor must not override');
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'dirty user input');
    const args = ['--head', candidate.head, '--event', 'push', '--ref', 'refs/heads/main', '--json'];
    const result = invoke(fixture, candidate, 'plan', { args });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'predicted');
    assert.equal(report.prediction.identity.head, candidate.head);
    assert.equal(report.prediction.eventName, 'push');
    assert.equal(report.prediction.eventContext.ref, 'refs/heads/main');
    assert.equal(report.eventContext.verified, false);
    const prArgs = ['--head', candidate.head, '--event', 'pull_request', '--pr-action', 'synchronize', '--pr-fork', 'false', '--json'];
    const pr = invoke(fixture, candidate, 'plan', { args: prArgs });
    assert.equal(pr.status, 0, pr.stderr);
    assert.equal(JSON.parse(pr.stdout).prediction.eventContext.prFork, false);
    assert.equal(JSON.parse(pr.stdout).prediction.eventContext.prAction, 'synchronize');
    const wrongPr = invoke(fixture, candidate, 'plan', { args: prArgs, env: { GUARD_TEST_PLAN_WRONG_PR: '1' } });
    assert.equal(wrongPr.status, 1);
    assert.equal(JSON.parse(wrongPr.stdout).prediction, null);
    const malformed = invoke(fixture, candidate, 'plan', { args: [...prArgs.slice(0, -2), 'False', '--json'] });
    assert.equal(malformed.status, 1);
    assert.match(malformed.stderr, /requires true or false/);
    const wrongRef = invoke(fixture, candidate, 'plan', { args, env: { GUARD_TEST_PLAN_WRONG_REF: '1' } });
    assert.equal(wrongRef.status, 1);
    assert.equal(JSON.parse(wrongRef.stdout).prediction, null);
    assert.deepEqual(report.prediction.jobs[0].owners, ['release']);
    assert.equal(Object.hasOwn(report, 'downstream'), false);
    assert.equal(report.completenessVerified, false);
    assert.equal(report.checksExecuted, false);
    const bad = invoke(fixture, candidate, 'plan', { args, env: { GUARD_TEST_PLAN_BAD: '1' } });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).prediction, null);
    assert.match(bad.stderr, /inconsistent project CI plan/);
    const review = invoke(fixture, candidate, 'plan', { args, env: { GUARD_TEST_PLAN_REVIEW: '1' } });
    assert.equal(review.status, 2);
    assert.equal(JSON.parse(review.stdout).outcome, 'needs-review');
    const mutable = invoke(fixture, candidate, 'plan', { args: ['--json'] });
    assert.equal(mutable.status, 1);
    assert.match(mutable.stderr, /explicit --head/);
    const push = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(push.status, 1);
    assert.match(push.stderr, /generic pre-push is not supported/);
    assert.equal(existsSync(candidate.marker), false);
    assert.equal(readFileSync(path.join(fixture.root, 'src/input.txt'), 'utf8'), 'dirty user input');
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('plan exact head uses committed rules rather than dirty simulator and provides one Agent JSON report', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    const source = path.join(fixture.root, 'quality/plan.mjs');
    writeFileSync(source, 'throw new Error("dirty rules must not execute");\n');
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'user dirty source\n');
    const text = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.head] });
    assert.equal(text.status, 0, text.stderr);
    const result = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.head, '--json'] });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 'ci-local-guard/plan-report/v1');
    assert.equal(report.outcome, 'predicted');
    assert.equal(report.identity.head, candidate.head);
    assert.equal(report.identity.base, candidate.base);
    assert.equal(report.policy.head, candidate.head);
    assert.equal(report.policy.source, 'exact-checkout');
    assert.equal(report.policy.observation, 'matched');
    assert.equal(report.completenessVerified, false);
    assert.equal(report.checksExecuted, false);
    assert.deepEqual(report.changedFiles, ['src/input.txt']);
    assert.match(result.stderr, /jobs:/);
    assert.match(readFileSync(source, 'utf8'), /dirty rules must not execute/);
    assert.equal(fixture.git('rev-parse', 'HEAD').trim(), candidate.head);
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    assert.equal(existsSync(candidate.marker), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('failed plan output stays out of diagnostics for every plan caller and output stream', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    const control = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.head, '--json'] });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(JSON.parse(control.stdout).outcome, 'predicted');
    writeFileSync(path.join(fixture.root, 'quality/plan.mjs'), `
      process[process.env.GUARD_TEST_STREAM].write(process.env.GUARD_TEST_SECRET);
      process.exitCode = 1;
    `);
    fixture.git('add', 'quality/plan.mjs');
    fixture.git('commit', '-qm', 'failing plan fixture');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    for (const stream of ['stderr', 'stdout']) {
      for (const verb of ['plan', 'preflight', 'pre-push']) {
        const result = invoke(fixture, candidate, verb, {
          args: ['--json', ...(verb === 'pre-push' ? [] : ['--head', candidate.head]),
            ...(verb === 'preflight' ? ['--with-plan'] : [])],
          input: verb === 'pre-push' ? pushInput(candidate) : undefined,
          env: { GUARD_TEST_STREAM: stream, GUARD_TEST_SECRET: 'synthetic-plan-private-sentinel' },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(result.stdout + result.stderr, /synthetic-plan-private-sentinel/);
        assert.match(result.stderr, /Project CI simulator failed \(1\)/);
        const report = JSON.parse(result.stdout);
        assert.equal(report.outcome, verb === 'pre-push' ? 'blocked' : 'failed');
        if (verb === 'plan') assert.equal(report.prediction, null);
        assert.equal(existsSync(candidate.marker), false, 'plan failure must prevent product execution');
        assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
      }
    }
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('plan JSON distinguishes review, unchanged input and invalid or contradictory identities', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { review: true });
    const review = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.head, '--json'] });
    assert.equal(review.status, 2, review.stderr);
    assert.equal(JSON.parse(review.stdout).outcome, 'needs-review');
    const empty = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.base, '--json'] });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).outcome, 'no-changes');
    assert.equal(JSON.parse(empty.stdout).prediction, null);
    for (const args of [['--head', 'absent-ref'], ['--head', candidate.head, '--worktree']]) {
      const result = invoke(fixture, candidate, 'plan', { args: [...args, '--json'] });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).schemaVersion, 'ci-local-guard/plan-report/v1');
      assert.equal(JSON.parse(result.stdout).outcome, 'failed');
      assert.equal(JSON.parse(result.stdout).checksExecuted, false);
    }
    assert.equal(existsSync(candidate.marker), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('exact plan rejects rule checkout drift and cleans its isolated worktree', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    const planFile = path.join(fixture.root, 'quality/plan.mjs');
    const planSource = readFileSync(planFile, 'utf8');
    writeFileSync(planFile, planSource.replace('console.log(', "writeFileSync('src/input.txt', 'mutated policy input'); console.log("));
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'mutating fixture rules');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    const result = invoke(fixture, candidate, 'plan', { args: ['--head', candidate.head, '--json'] });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcome, 'failed');
    assert.equal(JSON.parse(result.stdout).policy.observation, 'drifted');
    assert.match(result.stderr, /policy checkout changed/);
    assert.equal(readFileSync(path.join(fixture.root, 'src/input.txt'), 'utf8'), 'committed\n');
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
