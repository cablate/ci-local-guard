import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanGitEnvironment, projectPreflight } from '../src/project.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-guard-hooks-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanGitEnvironment() });
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', path.join(root, '.no-hooks'));
  return { root, git };
}

test('Git actually executes the installed shell pre-commit hook and blocks whitespace before committing', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    fixture.git('config', '--unset', 'core.hooksPath');
    const installed = invoke(fixture, candidate, 'install-hook');
    assert.equal(installed.status, 0, installed.stderr);
    const hookEnv = cleanGitEnvironment();
    const searchPath = Object.entries(hookEnv).find(([key]) => /^path$/i.test(key))?.[1] || '';
    for (const key of Object.keys(hookEnv)) if (/^path$/i.test(key)) delete hookEnv[key];
    hookEnv.PATH = `${path.dirname(process.execPath)}${path.delimiter}${searchPath}`;
    const commit = () => spawnSync('git', ['-C', fixture.root, 'commit', '-m', 'hook integration'], {
      encoding: 'utf8', env: hookEnv, input: '', windowsHide: true, timeout: 15000,
    });
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'bad whitespace  \n');
    fixture.git('add', 'src/input.txt');
    const rejected = commit();
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /whitespace errors/);
    assert.equal(fixture.git('rev-parse', 'HEAD').trim(), candidate.head);
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'clean input\n');
    fixture.git('add', 'src/input.txt');
    const accepted = commit();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.notEqual(fixture.git('rev-parse', 'HEAD').trim(), candidate.head);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

function seedPreflightFixture(fixture, { preflight = true, review = false, fail = false, receipt = 'valid', protection } = {}) {
  const { root, git } = fixture;
  const write = (name, content) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  write('package-lock.json', '{}\n');
  write('package.json', '{}');
  write('.gitignore', 'node_modules/\nruns.txt\n');
  write('src/input.txt', 'base\n');
  if (preflight) write('.ci-local-guard.json', JSON.stringify({ schemaVersion: 'ci-local-guard/project/v1',
    preflight: { entrypoint: 'quality/preflight.mjs', dependencies: 'none', receipt: receipt === 'none' ? 'none' : 'guard-v1' },
    plan: { entrypoint: 'quality/plan.mjs', dependencies: 'none' },
    ...(!receipt.startsWith('generic') && preflight && receipt !== 'none' ? { pushPolicy: {
      schemaVersion: 'ci-local-guard/local-push-policy/v1', scope: 'project-declared-local-gates',
      targetRefs: ['refs/heads/main','refs/heads/dev','refs/heads/feature'],
      bindings: [{ job: 'fixture', owner: 'fixture', checkIds: ['0:fixture'] }] } } : {}),
    ...(protection ? { protection } : {}) }));
  write('quality/plan.mjs', `
    import { execFileSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const option = flag => process.argv[process.argv.indexOf(flag) + 1];
    const base = option('--base'), head = option('--head'), event = option('--event');
    const changedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', base, head], { encoding: 'utf8' }).trim().split(/\\r?\\n/).filter(Boolean);
    console.log(JSON.stringify({ schemaVersion: 'ci-local-guard/project-plan/v1', identity:{base,head,event,mode:'committed'},
      changedFiles, eventContext: JSON.parse(process.env.CI_LOCAL_GUARD_EVENT_CONTEXT),
      jobs: [{ id: 'fixture', selected: true, reason: 'declared fixture check', owners: ['fixture'] }], needsReview: ${review} }));
    process.exitCode = ${review ? 2 : 0};
  `);
  if (preflight) write('quality/preflight.mjs', `
    import { execFileSync } from 'node:child_process';
    import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    if (readFileSync('src/input.txt', 'utf8') !== 'committed\\n') throw new Error('wrong content');
    const event = process.argv[process.argv.indexOf('--event') + 1];
    if (process.env.GUARD_TEST_EXPECT_EVENT && ((process.env.GUARD_TEST_EXPECT_EVENT !== 'from-argument' && event !== process.env.GUARD_TEST_EXPECT_EVENT)
      || process.env.CI_LOCAL_GUARD_EVENT !== event)) throw new Error('event not forwarded');
    appendFileSync(process.env.GUARD_TEST_MARKER, process.cwd() + '\\n');
    mkdirSync('tmp/preflight', { recursive: true });
    writeFileSync('tmp/preflight/full-check.log', 'inner-only-diagnostic ' + (process.env.GUARD_TEST_SECRET || 'no-secret'));
    if (!['none', 'generic-missing-receipt'].includes(${JSON.stringify(receipt)})) {
      const option = (flag) => process.argv[process.argv.indexOf(flag) + 1];
      const failed = ${fail} || process.env.GUARD_TEST_FAIL === '1';
      writeFileSync('tmp/preflight/project-report.json', JSON.stringify({ schemaVersion: ${JSON.stringify(receipt === 'generic-wrong-schema' ? 'wrong-preflight/v1' : 'ci-local-guard/project-preflight/v1')},
        identity: { base: option('--base'), head: ${JSON.stringify(receipt)} === 'wrong-head' ? '0'.repeat(40) : option('--head'), event, mode: 'committed' },
        changedFiles: ['src/input.txt'], checks: [{ id: '0:fixture', owner: 'fixture', why: 'fixture only ' + (process.env.GUARD_TEST_SECRET || ''), status: 'ran',
          result: failed ? 'failure' : 'success', durationMs: 1, log: 'full-check.log', blockedBy: null },
          ...(${JSON.stringify(receipt)} === 'external' ? [{ id: '1:database', owner: 'database-baseline', why: 'migration requires isolated database replay',
            status: 'external-owner', result: null, durationMs: null, log: null, blockedBy: null }] : [])],
        outcome: failed ? 'failed' : 'incomplete', unverified: ['browser', 'database', 'hosted'] }));
    }
    console.log('fixture product stdout');
    console.log('fixture product event ' + event);
    console.error('fixture product stderr ' + (process.env.GUARD_TEST_SECRET || 'no-secret'));
    if (process.env.GUARD_TEST_MUTATE_SOURCE === 'tracked') writeFileSync('src/input.txt', 'mutated during check\\n');
    if (process.env.GUARD_TEST_MUTATE_SOURCE === 'head') execFileSync('git', ['checkout', '--detach', process.argv[process.argv.indexOf('--base') + 1]], { stdio: 'ignore' });
    process.exitCode = ${fail ? 1 : 0} || (process.env.GUARD_TEST_FAIL === '1' ? 1 : 0);
  `);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  write('src/input.txt', 'committed\n');
  git('add', 'src/input.txt');
  git('commit', '-qm', 'candidate');
  const head = git('rev-parse', 'HEAD').trim();
  // Avoid npm/network in the fixture; exact checkout links matching lock dependencies.
  return { base, head, marker: path.join(root, 'runs.txt') };
}

function invoke(fixture, candidate, verb, { input, env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [cli, verb, '--repo', fixture.root, '--base', candidate.base, ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...cleanGitEnvironment(), GUARD_TEST_MARKER: candidate.marker, ...env },
  });
}

test('generic committed local push policy gates exact check IDs, runs fresh product and executes through a real Git hook', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'generic' });
    const descriptor = path.join(fixture.root, '.ci-local-guard.json');
    const config = JSON.parse(readFileSync(descriptor, 'utf8'));
    config.plan = { entrypoint: 'quality/plan.mjs', dependencies: 'none' };
    config.pushPolicy = { schemaVersion: 'ci-local-guard/local-push-policy/v1', scope: 'project-declared-local-gates',
      targetRefs: ['refs/heads/main'], bindings: [{ job: 'ci', owner: 'fixture', checkIds: ['0:fixture'] }] };
    writeFileSync(descriptor, JSON.stringify(config));
    writeFileSync(path.join(fixture.root, 'quality/plan.mjs'), `
      const option = flag => process.argv[process.argv.indexOf(flag)+1];
      const eventContext = JSON.parse(process.env.CI_LOCAL_GUARD_EVENT_CONTEXT);
      const needsReview = process.env.GUARD_TEST_PLAN_REVIEW === '1';
      console.log(JSON.stringify({schemaVersion:'ci-local-guard/project-plan/v1',
        identity:{base:option('--base'),head:option('--head'),event:option('--event'),mode:'committed'},
        eventContext,changedFiles:['src/input.txt'],needsReview,
        jobs:[{id:'ci',selected:true,reason:'local declared gate',owners:['fixture']}]}));
      process.exitCode=needsReview ? 2 : 0;
    `);
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'base\n');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'local policy');
    candidate.base = fixture.git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'committed\n');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'candidate');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    assert.equal(invoke(fixture, candidate, 'preflight').status, 0);
    writeFileSync(descriptor, '{dirty policy must not override');
    const result = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate, 'main') });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /local-policy-satisfied/);
    assert.match(result.stdout, /Hosted\/PR\/merge protection.*unverified/);
    assert.doesNotMatch(result.stdout, /cached PASS/);
    const json = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate, 'main'), args: ['--json'] });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(json.stdout.trim().split(/\r?\n/).length, 1);
    assert.equal(report.schemaVersion, 'ci-local-guard/push-report/v1');
    assert.equal(report.outcome, 'local-policy-satisfied');
    assert.equal(report.completenessVerified, false);
    assert.equal(report.updates[0].product.projectReceipt.status, 'validated');
    assert.match(json.stderr, /Running project preflight/);
    const batch = invoke(fixture, candidate, 'pre-push', {
      input: pushInput(candidate, 'main') + pushInput(candidate, 'dev') + pushInput(candidate, 'main'), args: ['--json'],
    });
    assert.equal(batch.status, 1, batch.stderr);
    const partial = JSON.parse(batch.stdout);
    assert.equal(partial.outcome, 'blocked');
    assert.equal(partial.failure.code, 'target-outside-policy');
    assert.deepEqual(partial.updates.map(update => update.status), ['local-policy-satisfied', 'blocked', 'not-run']);
    const failed = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate, 'main'), args: ['--json'],
      env: { GUARD_TEST_FAIL: '1', GUARD_TEST_SECRET: 'push-json-fixture-private-value' } });
    assert.equal(failed.status, 1, failed.stderr);
    const failure = JSON.parse(failed.stdout);
    assert.equal(failure.outcome, 'blocked');
    assert.equal(failure.updates[0].product.status, 'failed');
    assert.equal(failure.updates[0].product.projectReceipt.status, 'validated');
    assert.equal(failure.updates[0].product.projectReceipt.receipt.checks[0].result, 'failure');
    const observed = failure.updates[0].product.executionFailure;
    assert.equal(observed.exitCode, 1);
    assert.deepEqual(observed.causes, ['child-exit-nonzero']);
    const declared = failure.updates[0].product.projectReceipt.receipt.checks[0];
    assert.deepEqual(observed.failedChecks, [{ id: declared.id, owner: declared.owner }]);
    assert.match(failure.nextAction, /Do not retry to green/);
    assert.ok(existsSync(failure.failure.logFile));
    assert.doesNotMatch(failed.stdout, /push-json-fixture-private-value/);
    const markerBeforeRejectedInput = readFileSync(candidate.marker, 'utf8');
    for (const [input, code] of [['private-malformed-generic-input', 'invalid-push-input'],
      ['private-oversized-generic-input\n' + 'x'.repeat(1024 * 1024), 'push-input-too-large']]) {
      const rejectedInput = invoke(fixture, candidate, 'pre-push', { args: ['--json'], input });
      assert.equal(rejectedInput.status, 1, rejectedInput.stderr);
      const blockedInput = JSON.parse(rejectedInput.stdout);
      assert.equal(blockedInput.failure.code, code);
      assert.deepEqual(blockedInput.updates, []);
      assert.doesNotMatch(rejectedInput.stdout + rejectedInput.stderr, /private-malformed-generic-input|private-oversized-generic-input/);
      assert.equal(readFileSync(candidate.marker, 'utf8'), markerBeforeRejectedInput);
    }
    const review = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate, 'main'), env: { GUARD_TEST_PLAN_REVIEW: '1' } });
    assert.equal(review.status, 1); assert.match(review.stderr, /manual review/);
    const outside = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate, 'dev') });
    assert.equal(outside.status, 1); assert.match(outside.stderr, /outside declared/);
    const newRef = invoke(fixture, candidate, 'pre-push', { input: pushInput({ ...candidate, base: '0'.repeat(40) }, 'main') });
    assert.equal(newRef.status, 1); assert.match(newRef.stderr, /new remote refs require review/);
    const remote = path.join(fixture.root, 'remote.git');
    fixture.git('init', '--bare', '-q', remote);
    fixture.git('push', '-q', remote, `${candidate.base}:refs/heads/main`);
    fixture.git('update-ref', 'refs/heads/main', candidate.head);
    fixture.git('config', '--unset', 'core.hooksPath');
    assert.equal(invoke(fixture, candidate, 'install-hook').status, 0);
    const env = { ...cleanGitEnvironment(), GUARD_TEST_MARKER: candidate.marker };
    const searchPath = Object.entries(env).find(([key]) => /^path$/i.test(key))?.[1] || '';
    for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${searchPath}`;
    const rejected = spawnSync('git', ['-C', fixture.root, 'push', remote, 'main'], {
      encoding: 'utf8', env: { ...env, GUARD_TEST_PLAN_REVIEW: '1' }, timeout: 30000, windowsHide: true,
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /manual review/);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), candidate.base);
    const pushed = spawnSync('git', ['-C', fixture.root, 'push', remote, 'main'], { encoding: 'utf8', env, timeout: 30000, windowsHide: true });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stdout, /local-policy-satisfied/);
    assert.equal(execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), candidate.head);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 6);
    assert.equal(readFileSync(descriptor, 'utf8'), '{dirty policy must not override');
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    assert.equal(invoke(fixture, candidate, 'uninstall-hook').status, 0);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('explicit push JSON reports review, fresh receipt and malformed input without inventing complete coverage', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'valid' });
    const options = { input: pushInput(candidate), args: ['--json'] };
    const fresh = invoke(fixture, candidate, 'pre-push', options);
    assert.equal(fresh.status, 0, fresh.stderr);
    const report = JSON.parse(fresh.stdout);
    assert.equal(report.outcome, 'local-policy-satisfied');
    assert.equal(report.updates[0].product.status, 'ran');
    assert.equal(report.updates[0].product.projectReceipt.status, 'validated');
    assert.equal(report.completenessVerified, false);
    const repeated = invoke(fixture, candidate, 'pre-push', options);
    assert.equal(repeated.status, 0, repeated.stderr);
    const previous = JSON.parse(repeated.stdout).updates[0].product;
    assert.equal(previous.status, 'ran');
    assert.equal(previous.projectReceipt.status, 'validated');
    const malformed = invoke(fixture, candidate, 'pre-push', { args: ['--json'], input: 'private-invalid-input' });
    assert.equal(malformed.status, 1);
    assert.equal(JSON.parse(malformed.stdout).outcome, 'blocked');
    assert.doesNotMatch(malformed.stdout, /private-invalid-input/);
    assert.doesNotMatch(malformed.stderr, /private-invalid-input/);
    assert.equal(JSON.parse(malformed.stdout).failure.code, 'invalid-push-input');
    const empty = invoke(fixture, candidate, 'pre-push', { args: ['--json'], input: '' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).outcome, 'no-gates-executed');
    const deletion = invoke(fixture, candidate, 'pre-push', { args: ['--json'], input: pushInput({ ...candidate, head: '0'.repeat(40) }) });
    assert.equal(deletion.status, 0, deletion.stderr);
    assert.equal(JSON.parse(deletion.stdout).outcome, 'no-gates-executed');
    assert.equal(JSON.parse(deletion.stdout).updates[0].status, 'ignored-deletion');
    const oversized = invoke(fixture, candidate, 'pre-push', { args: ['--json'], input: pushInput(candidate).repeat(129) });
    assert.equal(oversized.status, 1);
    assert.equal(JSON.parse(oversized.stdout).failure.code, 'too-many-updates');
    assert.deepEqual(JSON.parse(oversized.stdout).updates, []);
    const markerBefore = readFileSync(candidate.marker, 'utf8');
    for (const args of [['--json'], []]) {
      const tooLarge = invoke(fixture, candidate, 'pre-push', { args,
        input: 'private-push-input-secret\n' + 'x'.repeat(1024 * 1024) });
      assert.equal(tooLarge.status, 1, tooLarge.stderr);
      assert.doesNotMatch(tooLarge.stderr, /private-push-input-secret/);
      if (args.length) {
        const blocked = JSON.parse(tooLarge.stdout);
        assert.equal(blocked.failure.code, 'push-input-too-large');
        assert.deepEqual(blocked.updates, []);
        assert.doesNotMatch(tooLarge.stdout, /private-push-input-secret/);
      } else assert.equal(tooLarge.stdout, '');
      assert.equal(readFileSync(candidate.marker, 'utf8'), markerBefore, 'no product execution on rejected input');
    }
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('explicit push JSON preserves manual review and does not execute product checks', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { review: true });
    const result = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate), args: ['--json'] });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.outcome, 'blocked');
    assert.equal(report.failure.code, 'plan-review');
    assert.equal(report.updates[0].prediction.needsReview, true);
    assert.equal(report.updates[0].product, null);
    assert.equal(existsSync(candidate.marker), false);
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

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

test('explicit external owner prevents reusable PASS and stops push despite successful product checks', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'external' });
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'unrelated dirty work\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.outcome, 'incomplete');
      assert.equal(report.product.status, 'ran');
      assert.equal(report.product.pushObligations.status, 'unresolved');
      assert.equal(report.product.pushObligations.completenessVerified, false);
      assert.equal(report.product.pushObligations.missing[0].owner, 'database-baseline');
      assert.doesNotMatch(result.stderr, /cached PASS/);
    }
    const result = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /local gates unresolved; push stopped/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 3);
    assert.equal(fixture.git('rev-parse', 'HEAD').trim(), candidate.head);
    assert.equal(readFileSync(path.join(fixture.root, 'src/input.txt'), 'utf8'), 'unrelated dirty work\n');
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('committed custom standalone entrypoint runs exact content without Synora or npm; generic push stays blocked', () => {
  const fixture = fixtureRepo();
  try {
    const descriptor = path.join(fixture.root, '.ci-local-guard.json');
    mkdirSync(path.join(fixture.root, 'quality'), { recursive: true });
    writeFileSync(descriptor, JSON.stringify({ schemaVersion: 'ci-local-guard/project/v1', preflight: {
      entrypoint: 'quality/check.mjs', dependencies: 'none', receipt: 'none' } }));
    writeFileSync(path.join(fixture.root, 'quality/check.mjs'), `
      import {readFileSync} from 'node:fs';
      if(readFileSync('input.txt','utf8') !== 'candidate') throw new Error('wrong exact content');
      if(!process.argv.includes('--head') || process.env.CI_LOCAL_GUARD_EVENT !== 'push') throw new Error('missing identity');
      console.log('CUSTOM-CHECK-EXECUTED');
    `);
    writeFileSync(path.join(fixture.root, 'input.txt'), 'base');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'base');
    const base = fixture.git('rev-parse', 'HEAD').trim();
    writeFileSync(path.join(fixture.root, 'input.txt'), 'candidate');
    fixture.git('add', '.'); fixture.git('commit', '-qm', 'candidate');
    const candidate = { base, head: fixture.git('rev-parse', 'HEAD').trim() };
    writeFileSync(descriptor, '{malformed dirty override');
    writeFileSync(path.join(fixture.root, 'input.txt'), 'dirty content');
    const result = invoke(fixture, candidate, 'preflight', { args: ['--json', '--event', 'push'],
      env: { CI_LOCAL_GUARD_KEEP_LOGS: '1' } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.product.adapter, 'committed-descriptor');
    assert.equal(report.product.entrypoint, 'quality/check.mjs');
    assert.equal(report.product.projectReceipt.status, 'unavailable');
    assert.equal(report.outcome, 'incomplete');
    assert.match(readFileSync(report.product.logFile, 'utf8'), /CUSTOM-CHECK-EXECUTED/);
    assert.equal(readFileSync(path.join(fixture.root, 'input.txt'), 'utf8'), 'dirty content');
    assert.equal(existsSync(path.join(fixture.root, 'node_modules')), false);
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    const push = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(push.status, 1, push.stderr);
    assert.match(push.stderr, /push-policy contract/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('preflight honors the requested exact head instead of silently executing current HEAD', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, {});
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'later wrong content\n');
    fixture.git('add', 'src/input.txt');
    fixture.git('commit', '-qm', 'later unrelated head');
    const result = invoke(fixture, candidate, 'preflight', { args: ['--head', candidate.head] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ran.*PASS/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

function assertTiming(report) {
  assert.equal(report.timing.schemaVersion, 'ci-local-guard/preflight-timing/v1');
  assert.equal(report.timing.clock, 'monotonic');
  assert.ok(Number.isInteger(report.timing.totalMs) && report.timing.totalMs >= 0);
  let measured = 0;
  for (const phase of Object.values(report.timing.phases)) {
    if (phase.status === 'not-run') assert.equal(phase.durationMs, null);
    else {
      assert.ok(['completed', 'failed'].includes(phase.status));
      assert.ok(Number.isInteger(phase.durationMs) && phase.durationMs >= 0);
      measured += phase.durationMs;
    }
  }
  assert.equal(report.timing.unattributedMs, report.timing.totalMs - measured);
  assert.ok(report.timing.unattributedMs >= 0);
}

test('JSON preflight reports product execution without claiming complete CI coverage', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, {});
    const result = invoke(fixture, candidate, 'preflight', { args: ['--json', '--head', candidate.head] });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 'ci-local-guard/preflight-report/v1');
    assert.equal(report.outcome, 'incomplete');
    assert.equal(report.identity.head, candidate.head);
    assert.equal(report.identity.base, candidate.base);
    assert.equal(report.product.status, 'ran');
    assert.equal(report.product.result, 'success');
    assertTiming(report);
    for (const phase of ['repository', 'identity', 'checkout', 'projectPreparation', 'product', 'cleanup']) {
      assert.equal(report.timing.phases[phase].status, 'completed');
    }
    assert.ok(report.timing.phases.product.durationMs + 1 >= report.product.durationMs);
    assert.equal(report.product.checkoutObservation.status, 'matched');
    assert.equal(report.product.checkoutObservation.before.head, candidate.head);
    assert.equal(report.product.checkoutObservation.after.head, candidate.head);
    assert.equal(report.product.checkoutObservation.before.tree, fixture.git('rev-parse', `${candidate.head}^{tree}`).trim());
    assert.equal(report.product.checkoutObservation.after.trackedDirty, false);
    assert.ok(report.unverified.includes('ci-policy'));
    assert.ok(report.unverified.includes('browser'));
    assert.match(result.stderr, /ran.*PASS/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('product checkout drift fails even after child exit zero and retains logs', () => {
  for (const mutation of ['tracked', 'head']) {
    const fixture = fixtureRepo();
    try {
      const candidate = seedPreflightFixture(fixture);
      const result = invoke(fixture, candidate, 'preflight', { args: ['--json'], env: { GUARD_TEST_MUTATE_SOURCE: mutation } });
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.product.checkoutObservation.status, 'drifted');
      assert.equal(report.product.executionFailure.exitCode, 0);
      assert.ok(report.product.executionFailure.causes.includes('post-execution-validation-failed'));
      assert.deepEqual(report.product.executionFailure.failedChecks, []);
      assert.match(report.nextAction, /Restore and review/);
      assert.equal(report.outcome, 'failed');
      assert.ok(existsSync(report.product.logFile));
      assert.match(readFileSync(report.product.logFile, 'utf8'), /fixture product stdout/);
      assert.equal(existsSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')) &&
        readdirSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')).length > 0, false);
      assert.equal(fixture.git('rev-parse', 'HEAD').trim(), candidate.head);
      assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('invalid requested commit reports failed identity timing without fabricated execution or cleanup', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    const result = invoke(fixture, candidate, 'preflight', { args: ['--json', '--head', 'missing-commit'] });
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assertTiming(report);
    assert.equal(report.identity, null);
    assert.equal(report.timing.phases.identity.status, 'failed');
    for (const phase of ['checkout', 'dependencies', 'product', 'cleanup']) {
      assert.equal(report.timing.phases[phase].status, 'not-run');
    }
    assert.equal(existsSync(candidate.marker), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('JSON unavailable and failed reports are parseable and retain distinct exit codes', () => {
  for (const [settings, exit, status] of [[{ preflight: false }, 2, 'unavailable'], [{ fail: true }, 1, 'failed']]) {
    const fixture = fixtureRepo();
    try {
      const candidate = seedPreflightFixture(fixture, settings);
      const result = invoke(fixture, candidate, 'preflight', { args: ['--json'], env: { GUARD_TEST_SECRET: 'receipt-private-fixture-value' } });
      assert.equal(result.status, exit, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.doesNotMatch(result.stdout, /receipt-private-fixture-value/);
      assert.equal(report.product.status, status);
      assert.equal(report.outcome, exit === 1 ? 'failed' : 'incomplete');
      assertTiming(report);
      assert.equal(report.timing.phases.cleanup.status, 'completed');
      assert.equal(report.timing.phases.product.status, exit === 1 ? 'failed' : 'not-run');
      if (exit === 1) {
        assert.ok(Number.isFinite(report.product.durationMs) && report.product.durationMs >= 0);
        assert.ok(report.product.logFile);
        assert.equal(existsSync(report.product.logFile), true);
      }
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('JSON protection mapping is HEAD-owned and fresh on every invocation, still incomplete', () => {
  const fixture = fixtureRepo();
  const protection = { schemaVersion: 'ci-local-guard/protection-manifest/v1', completeness: 'partial', items: [
    { id: 'unit', local: { scope: 'selective', owners: ['fixture'] }, hosted: { workflow: 'ci.yml', job: 'unit' } },
    { id: 'browser', local: { scope: 'none', owners: [] }, hosted: { workflow: 'ci.yml', job: 'browser' } },
  ] };
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'generic', protection });
    writeFileSync(path.join(fixture.root, '.ci-local-guard.json'), '{dirty invalid override');
    const first = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.outcome, 'incomplete');
    assert.equal(report.product.protection.status, 'declared-unverified');
    assert.equal(report.product.protection.items[0].local.evidence, 'observed-success');
    assert.equal(report.product.protection.items[1].hosted.status, 'unverified');
    const second = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
    assert.equal(second.status, 0, second.stderr);
    const fresh = JSON.parse(second.stdout).product;
    assert.equal(fresh.status, 'ran');
    assert.equal(fresh.protection.items[0].local.evidence, 'observed-success');
    assert.equal(readFileSync(path.join(fixture.root, '.ci-local-guard.json'), 'utf8'), '{dirty invalid override');
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('JSON repeated preflights run fresh and unsupported modes fail before execution', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    const first = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).product.status, 'ran');
    const second = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
    assert.equal(second.status, 0, second.stderr);
    const report = JSON.parse(second.stdout);
    assert.equal(report.product.status, 'ran');
    assertTiming(report);
    assert.equal(report.timing.phases.product.status, 'completed');
    assert.equal(report.timing.phases.dependencies.status, 'not-run');
    assert.equal(report.product.checkoutObservation.status, 'matched');
    assert.equal(report.product.result, 'success');
    assert.equal(report.product.passedAt, undefined);
    assert.equal(report.outcome, 'incomplete');
    const rejected = invoke(fixture, candidate, 'preflight', { args: ['--json', '--worktree'] });
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).identity, null);
    assert.match(rejected.stderr, /not supported/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 2);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

function pushInput(candidate, branch = 'feature') {
  return `refs/heads/${branch} ${candidate.head} refs/heads/${branch} ${candidate.base}\n`;
}

test('Guard keeps validated project receipt after cleanup, including failed checks; wrong SHA or schema fails validation', () => {
  for (const [receipt, fail, exit] of [['valid', false, 0], ['valid', true, 1], ['wrong-head', false, 1], ['generic', false, 0], ['generic-wrong-schema', false, 1], ['generic-missing-receipt', false, 1]]) {
    const fixture = fixtureRepo();
    try {
      const candidate = seedPreflightFixture(fixture, { receipt, fail });
      const result = invoke(fixture, candidate, 'preflight', { args: ['--json'], env: { GUARD_TEST_SECRET: 'receipt-private-fixture-value' } });
      assert.equal(result.status, exit, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.doesNotMatch(result.stdout, /receipt-private-fixture-value/);
      const valid = ['valid', 'generic'].includes(receipt);
      assert.equal(report.product.projectReceipt.status, valid ? 'validated' : receipt === 'generic-missing-receipt' ? 'unavailable' : 'invalid');
      if (valid) {
        assert.equal(report.product.projectReceipt.redactedMetadata, true);
        assert.match(report.product.projectReceipt.receipt.checks[0].why, /\[REDACTED\]/);
        assert.equal(report.product.projectReceipt.receipt.identity.head, candidate.head);
        assert.equal(report.product.projectReceipt.receipt.checks[0].result, fail ? 'failure' : 'success');
      }
      if (exit === 1) {
        assert.ok(report.product.logFile);
        assert.equal(existsSync(report.product.logFile), true);
        assert.equal(existsSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')) &&
          readdirSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')).length > 0, false);
      }
      assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test('preflight forwards event and runs fresh for both PR and push', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, {});
    const env = { GUARD_TEST_EXPECT_EVENT: 'from-argument', CI_LOCAL_GUARD_KEEP_LOGS: '1' };
    const first = invoke(fixture, candidate, 'preflight', { env, args: ['--json'] });
    assert.equal(first.status, 0, first.stderr);
    const push = invoke(fixture, candidate, 'preflight', { env, args: ['--json', '--event', 'push'] });
    assert.equal(push.status, 0, push.stderr);
    assert.equal(JSON.parse(push.stdout).identity.event, 'push');
    assert.equal(JSON.parse(push.stdout).product.status, 'ran');
    assert.match(readFileSync(JSON.parse(push.stdout).product.logFile, 'utf8'), /fixture product event push/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 2);
    const protectedPush = invoke(fixture, candidate, 'pre-push', {
      env: env, input: pushInput(candidate, 'dev'),
    });
    assert.equal(protectedPush.status, 0, protectedPush.stderr);
    const logPath = protectedPush.stdout.match(/; log: ([^\r\n]+)\.\r?$/m)?.[1];
    assert.ok(logPath, protectedPush.stdout);
    assert.match(readFileSync(logPath, 'utf8'), /fixture product event push/);
    const invalid = invoke(fixture, candidate, 'preflight', { args: ['--json', '--event', 'typo'] });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Unsupported.*event/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('standalone preflight without project checks reports unavailable, never PASS or a cache record', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { preflight: false });
    const result = invoke(fixture, candidate, 'preflight');
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /unavailable/);
    assert.doesNotMatch(result.stdout, /PASS|CI plan was checked/);
    assert.equal(existsSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('preflight and push each execute committed content, preserving dirty source', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    writeFileSync(path.join(fixture.root, 'src/input.txt'), 'dirty\n');
    const first = invoke(fixture, candidate, 'preflight');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /ran.*PASS/);
    const pushed = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.match(pushed.stdout, /ran.*PASS/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 2);
    assert.equal(readFileSync(path.join(fixture.root, 'src/input.txt'), 'utf8'), 'dirty\n');
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('failed preflight blocks push, records no PASS and cleans the isolated checkout', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { fail: true });
    const result = invoke(fixture, candidate, 'pre-push', {
      input: pushInput(candidate), env: { GUARD_TEST_SECRET: 'fixture-only-sensitive-value' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /preflight failed/);
    const match = result.stderr.match(/log: (.+)/);
    assert.ok(match, result.stderr);
    const log = readFileSync(match[1].trim(), 'utf8');
    assert.match(log, /fixture product stdout/);
    assert.match(log, /fixture product stderr \[REDACTED\]/);
    assert.match(log, /inner-only-diagnostic \[REDACTED\]/);
    assert.doesNotMatch(result.stdout + result.stderr + log, /fixture-only-sensitive-value/);
    assert.doesNotMatch(result.stdout, /PASS/);
    assert.equal(existsSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')), false);
    assert.equal(fixture.git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('legacy cache opt-in and old cache files cannot skip execution or conceal a new failure', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, {});
    writeFileSync(path.join(fixture.root, 'package.json'), JSON.stringify({ ciLocalGuard: { preflightCache: {
      version: 1, inputs: 'git-and-env-only', ttlSeconds: 900,
    } } }));
    const storage = path.join(fixture.root, '.git/ci-local-guard/preflight-pass');
    mkdirSync(storage, { recursive: true });
    const old = path.join(storage, 'legacy-success.json');
    writeFileSync(old, '{"status":"passed","result":"success"}');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = invoke(fixture, candidate, 'preflight');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ran.*PASS/);
      assert.doesNotMatch(result.stdout, /cached PASS/);
    }
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 2);
    const failed = invoke(fixture, candidate, 'preflight', { env: { GUARD_TEST_FAIL: '1' } });
    assert.equal(failed.status, 1, failed.stderr);
    assert.doesNotMatch(failed.stdout, /PASS/);
    assert.equal(readFileSync(old, 'utf8'), '{"status":"passed","result":"success"}');
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 3);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('a later failure cannot reuse an earlier success; a subsequent call executes again', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    assert.equal(invoke(fixture, candidate, 'preflight').status, 0);
    const forced = invoke(fixture, candidate, 'preflight', {
      env: { GUARD_TEST_FAIL: '1' },
    });
    assert.equal(forced.status, 1, forced.stderr);
    assert.doesNotMatch(forced.stdout, /cached PASS/);
    const retried = invoke(fixture, candidate, 'preflight');
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /ran.*PASS/);
    assert.doesNotMatch(retried.stdout, /cached PASS/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 3);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('manual CI review still blocks push after an earlier product success', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { review: true });
    assert.equal(invoke(fixture, candidate, 'preflight').status, 0);
    const result = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual review/);
    assert.equal(readFileSync(candidate.marker, 'utf8').trim().split(/\r?\n/).length, 1);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('push without project configuration blocks without inventing a PASS', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { preflight: false });
    const result = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate) });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /explicit committed policy/);
    assert.doesNotMatch(result.stdout, /PASS/);
    assert.equal(existsSync(path.join(fixture.root, '.git/ci-local-guard/preflight-pass')), false);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test('pre-commit stops staged whitespace errors and allows clean commits', () => {
  const { root, git } = fixtureRepo();
  const preCommit = () => spawnSync(process.execPath, [cli, 'pre-commit', '--repo', root], {
    encoding: 'utf8', env: cleanGitEnvironment(),
  });
  try {
    writeFileSync(path.join(root, 'a.txt'), 'clean\n');
    git('add', 'a.txt');
    assert.equal(preCommit().status, 0);
    writeFileSync(path.join(root, 'a.txt'), 'trailing   \n');
    git('add', 'a.txt');
    const blocked = preCommit();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /whitespace errors/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unconfigured repository ignores default-named scripts and external model settings; push fails closed', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture);
    fixture.git('rm', '.ci-local-guard.json'); fixture.git('commit', '-qm', 'remove explicit configuration');
    candidate.head = fixture.git('rev-parse', 'HEAD').trim();
    fixture.git('config', 'ci-local-guard.modelCheckout', fixture.root);
    assert.equal(projectPreflight(fixture.root), null);
    const preflight = invoke(fixture, candidate, 'preflight', { args: ['--json'] });
    assert.equal(preflight.status, 2, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).product.status, 'unavailable');
    const pushed = invoke(fixture, candidate, 'pre-push', { input: pushInput(candidate), args: ['--json'] });
    assert.equal(pushed.status, 1);
    assert.equal(JSON.parse(pushed.stdout).failure.code, 'unconfigured-policy');
    assert.equal(existsSync(candidate.marker), false);
    const installed = invoke(fixture, candidate, 'install-hook');
    assert.equal(installed.status, 1);
    assert.match(installed.stderr, /explicit committed/);
    assert.equal(fixture.git('config', '--get', 'core.hooksPath').trim(), path.join(fixture.root, '.no-hooks'));
    const removedCommand = invoke(fixture, candidate, 'check');
    assert.equal(removedCommand.status, 1);
    assert.match(removedCommand.stderr, /Usage:/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
