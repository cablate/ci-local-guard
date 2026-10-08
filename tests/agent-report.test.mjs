import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { agentReport, reserveReportOutput, summarizeReport } from '../src/agent-report.mjs';
import { setupCapabilities } from '../src/readiness.mjs';

test('capabilities keep offline work independent of repository setup and do not imply readiness', () => {
  const input = { node: { supported: true }, git: { available: false }, externalTools: { gh: { available: false } }, outcome: 'blocked' };
  const byId = value => Object.fromEntries(setupCapabilities(value).map(item => [item.id, item]));
  const missing = byId(input);
  assert.equal(missing.analyze.status, 'prerequisites-detected');
  assert.equal(missing['read-evidence'].status, 'prerequisites-detected');
  assert.ok(missing.preflight.blockers.includes('git'));
  assert.deepEqual(missing.collect.blockers, ['gh']);
  const configured = byId({ ...input, git: { available: true }, repo: '/fixture', head: 'a'.repeat(40), outcome: 'configured', externalTools: { gh: { available: true } } });
  assert.equal(configured.preflight.status, 'prerequisites-detected');
  assert.ok(configured.preflight.unverified.includes('project-dependencies'));
  assert.deepEqual(configured.plan.blockers, ['committed-plan-adapter']);
  assert.ok(configured.collect.unverified.includes('authentication'));
  assert.ok(Object.values(configured).every(item => item.automatic === false));
  assert.ok(setupCapabilities({ ...input, node: { supported: false } }).every(item => item.blockers.includes('supported-node')));
});

test('agent projection preserves failed identity and distinguishes unknown applicability from declared missing checks', () => {
  const input = { schemaVersion: 'ci-local-guard/preflight-report/v1', identity: { head: 'a'.repeat(40) }, outcome: 'failed',
    unverified: ['browser', 'database', 'hosted'], planObligations: { status: 'unresolved', missing: ['release'] }, product: { status: 'failed', result: 'failure', logFile: '/example/failed.log',
      projectReceipt: { status: 'validated', receipt: { unverified: ['hosted'], checks: [
        { id: 'unit', owner: 'test', status: 'ran', result: 'failure', why: 'x'.repeat(20000) },
        { id: 'approval', owner: 'project', status: 'external-owner', blockedBy: null },
      ] } } } };
  const full = agentReport(input, '0.1.0');
  const short = summarizeReport(full);
  assert.equal(short.identity, input.identity);
  assert.equal(short.outcome, 'failed');
  assert.deepEqual(short.execution.failedChecks, [{ id: 'unit', owner: 'test' }]);
  assert.deepEqual(short.coverage.projectUnverified, ['hosted']);
  assert.deepEqual(short.coverage.planMissingOwners, ['release']);
  assert.deepEqual(short.coverage.unknownApplicability, ['browser', 'database']);
  assert.equal(short.coverage.declaredMissingChecks[0].id, 'approval');
  assert.equal(short.nextActions[0].evidenceId, short.evidence[0].id);
  assert.deepEqual(short.evidence[0].reader, { command: 'read-evidence', args: ['--file', '/example/failed.log'], automatic: false });
  assert.ok(short.nextActions.every(action => action.automatic === false));
  assert.ok(JSON.stringify(short).length < JSON.stringify(full).length / 2);
  assert.equal(input.nextActions, undefined, 'do not mutate caller report');
});

test('saved reports are exclusive full evidence; write failures remain visible without changing execution verdict', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-report-'));
  try {
    const file = path.join(root, 'report.json');
    const save = reserveReportOutput(file);
    assert.throws(() => reserveReportOutput(file), /EEXIST/);
    const report = agentReport({ schemaVersion: 'example/v1', outcome: 'incomplete', product: { status: 'ran', result: 'success' } }, '0.1.0');
    save(report);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), report);
    assert.throws(() => save(report), /already finalized/);
    const failed = agentReport({ outcome: 'incomplete', product: { status: 'ran', result: 'success' } }, '0.1.0');
    reserveReportOutput(path.join(root, 'broken.json'), { write: () => { throw new Error('simulated ENOSPC'); } })(failed);
    assert.equal(failed.reportStorage.status, 'failed');
    assert.equal(failed.product.result, 'success');
    assert.equal(failed.nextActions[0].kind, 'repair-report-storage');
    const closeFailure = agentReport({ outcome: 'incomplete' }, '0.1.0');
    reserveReportOutput(path.join(root, 'close-failed.json'), { close: fd => { closeSync(fd); throw new Error('simulated close failure'); } })(closeFailure);
    assert.equal(closeFailure.reportStorage.status, 'failed');
    assert.equal(closeFailure.nextActions[0].kind, 'repair-report-storage');
    assert.throws(() => reserveReportOutput(path.join(root, 'missing', 'report.json')), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor summary saves unconfigured and configured reports without running project code', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-doctor-report-'));
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
  const commit = () => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', 'commit', '--allow-empty', '-qm', 'fixture']);
  const invoke = name => spawnSync(process.execPath, [cli, 'doctor', '--check', '--repo', root, '--summary', '--output', path.join(root, '.git', name)], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try {
    git(['init', '-q']); commit();
    const missing = invoke('missing.json');
    assert.equal(missing.status, 2, missing.stderr);
    assert.equal(JSON.parse(missing.stdout).nextActions[0].kind, 'configure-project');
    assert.equal(JSON.parse(missing.stdout).capabilities.find(item => item.id === 'analyze').status, 'prerequisites-detected');
    writeFileSync(path.join(root, 'preflight.mjs'), 'throw new Error("must not execute")');
    writeFileSync(path.join(root, '.ci-local-guard.json'), JSON.stringify({ schemaVersion: 'ci-local-guard/project/v1', preflight: { entrypoint: 'preflight.mjs', dependencies: 'none', receipt: 'guard-v1' } }));
    git(['add', '.']); commit();
    const ready = invoke('configured.json');
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(JSON.parse(ready.stdout).execution.status, 'not-run');
    const saved = JSON.parse(readFileSync(path.join(root, '.git/configured.json'), 'utf8'));
    assert.equal(saved.descriptor.status, 'valid');
    assert.equal(saved.dependencies.status, 'unknown');
    assert.deepEqual(JSON.parse(ready.stdout).capabilities, saved.capabilities);
    assert.equal(saved.capabilities.find(item => item.id === 'plan').status, 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
