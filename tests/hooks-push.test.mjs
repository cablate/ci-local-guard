import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanGitEnvironment, projectPreflight } from '../src/project.mjs';
import { cli, fixtureRepo, seedPreflightFixture, invoke, assertTiming, pushInput } from './support/hooks-fixtures.mjs';

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
