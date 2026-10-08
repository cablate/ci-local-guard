import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanGitEnvironment, projectPreflight } from '../src/project.mjs';
import { cli, fixtureRepo, seedPreflightFixture, invoke, assertTiming, pushInput } from './support/hooks-fixtures.mjs';

test('agent summary persists full success/failure evidence and refuses overwrite before executing checks', () => {
  const fixture = fixtureRepo();
  try {
    const candidate = seedPreflightFixture(fixture, { receipt: 'generic' });
    const output = path.join(fixture.root, 'success-report.json');
    const result = invoke(fixture, candidate, 'preflight', { args: ['--summary', '--output', output] });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    const full = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(summary.schemaVersion, 'ci-local-guard/agent-summary/v1');
    assert.equal(full.schemaVersion, 'ci-local-guard/preflight-report/v1');
    assert.equal(summary.reportId, full.reportId);
    assert.equal(summary.identity.head, candidate.head);
    assert.equal(summary.outcome, 'incomplete');
    assert.equal(summary.execution.result, 'success');
    assert.equal(full.product.projectReceipt.status, 'validated');
    const marker = readFileSync(candidate.marker, 'utf8');
    const repeat = invoke(fixture, candidate, 'preflight', { args: ['--summary', '--output', output] });
    assert.equal(repeat.status, 1);
    assert.equal(JSON.parse(repeat.stdout).nextActions[0].reason, 'output-exists');
    assert.equal(readFileSync(candidate.marker, 'utf8'), marker, 'existing output refuses before executing');
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), full);
    const failureFile = path.join(fixture.root, 'failure-report.json');
    const failure = invoke(fixture, candidate, 'preflight', { args: ['--summary', '--output', failureFile], env: { GUARD_TEST_FAIL: '1' } });
    assert.equal(failure.status, 1);
    const failed = JSON.parse(failure.stdout);
    assert.equal(failed.execution.result, 'failure');
    assert.equal(failed.nextActions[0].kind, 'read-evidence');
    assert.ok(existsSync(failed.evidence[0].path));
    assert.equal(JSON.parse(readFileSync(failureFile, 'utf8')).outcome, 'failed');
    const badOutput = invoke(fixture, candidate, 'preflight', { args: ['--output', path.join(fixture.root, 'missing', 'report.json')] });
    assert.equal(badOutput.status, 1);
    assert.equal(JSON.parse(badOutput.stdout).outcome, 'failed');
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
