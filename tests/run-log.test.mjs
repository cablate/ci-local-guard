import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanGitEnvironment } from '../src/project.mjs';
import { createRedactor, runLogged } from '../src/run-log.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-log-test-'));
  execFileSync('git', ['init', '-q', root], { env: cleanGitEnvironment() });
  return root;
}

test('redactor masks literal overlapping and multiline secrets at every chunk boundary', () => {
  const secret = 'fixture.*[sensitive]$value\nsecond-line';
  const input = `prefix ${secret} suffix`;
  for (let split = 0; split <= input.length; split += 1) {
    let output = '';
    const redact = createRedactor({ API_TOKEN: secret, PASSWORD: 'fixture' }, (text) => { output += text; });
    redact(input.slice(0, split));
    redact(input.slice(split));
    redact('', true);
    assert.equal(output, 'prefix [REDACTED] suffix', `split ${split}`);
  }
});

test('successful stage drops its log by default but can retain it for diagnosis', async () => {
  const root = fixture();
  try {
    const result = await runLogged(process.execPath, ['-e', 'console.log("success output")'], root);
    assert.equal(result.logFile, null);
    assert.ok(result.durationMs >= 0);
    assert.deepEqual(readdirSync(path.join(root, '.git/ci-local-guard/logs')), []);
    const kept = await runLogged(process.execPath, ['-e', 'console.log(process.env.API_TOKEN)'], root, {
      env: { ...process.env, CI_LOCAL_GUARD_KEEP_LOGS: '1', API_TOKEN: 'fixture-only-sensitive-value' },
    });
    assert.match(readFileSync(kept.logFile, 'utf8'), /\[REDACTED\]/);
    assert.doesNotMatch(readFileSync(kept.logFile, 'utf8'), /fixture-only-sensitive-value/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed concurrent stages retain unique stdout and stderr logs', async () => {
  const root = fixture();
  try {
    const results = await Promise.allSettled([0, 1].map((id) => runLogged(process.execPath,
      ['-e', `console.log('stdout ${id}'); console.error('stderr ${id}'); process.exit(1)`], root, { stage: 'preflight' })));
    assert.ok(results.every((result) => result.status === 'rejected'));
    const files = readdirSync(path.join(root, '.git/ci-local-guard/logs'));
    assert.equal(files.length, 2);
    for (const result of results) assert.match(result.reason.message, /preflight failed.*log:/);
    for (const result of results) {
      assert.equal(result.reason.executionFailure.exitCode, 1);
      assert.equal(result.reason.executionFailure.signal, null);
      assert.deepEqual(result.reason.executionFailure.causes, ['child-exit-nonzero']);
      assert.deepEqual(result.reason.executionFailure.failedChecks, []);
    }
    const contents = files.map((name) => readFileSync(path.join(root, '.git/ci-local-guard/logs', name), 'utf8')).join('\n');
    assert.match(contents, /stdout 0/);
    assert.match(contents, /stderr 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('post-execution validation retains successful child logs and preserves original failures', async () => {
  const root = fixture();
  try {
    for (const code of [0, 1]) {
      let validations = 0;
      let failure;
      try {
        await runLogged(process.execPath, ['-e', `console.log('child evidence'); process.exit(${code})`], root, {
          validateAfter: () => { validations += 1; throw new Error('checkout drift'); },
        });
      } catch (error) { failure = error; }
      assert.equal(validations, 1);
      assert.ok(failure);
      assert.match(failure.message, code === 0 ? /checkout drift/ : /failed/);
      if (code === 1) assert.doesNotMatch(failure.message, /checkout drift/);
      assert.equal(failure.executionFailure.exitCode, code);
      assert.deepEqual(failure.executionFailure.causes, code === 0
        ? ['post-execution-validation-failed'] : ['child-exit-nonzero', 'post-execution-validation-failed']);
      const log = readFileSync(failure.logFile, 'utf8');
      assert.match(log, /child evidence/);
      assert.match(log, /post-execution validation failed/);
    }
    await assert.rejects(runLogged(process.execPath, ['-e', ''], root, { validateAfter: true }), /Invalid post-execution validator/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('process start errors and excessive output fail closed with a retained log', async () => {
  const root = fixture();
  try {
    await assert.rejects(runLogged(path.join(root, 'missing-executable'), [], root), (error) => {
      assert.match(error.message, /could not start.*log:/);
      assert.equal(error.executionFailure.exitCode, null);
      assert.equal(error.executionFailure.processStarted, false);
      assert.deepEqual(error.executionFailure.causes, ['process-start-failed']);
      return true;
    });
    await assert.rejects(runLogged(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], root,
      { maxBytes: 256 }), /log size limit exceeded.*log:/);
    const marker = path.join(root, 'must-not-run');
    await assert.rejects(runLogged(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], root,
      { maxBytes: 1 }), /log size limit exceeded.*log:/);
    assert.equal(existsSync(marker), false);
    const files = readdirSync(path.join(root, '.git/ci-local-guard/logs'));
    assert.equal(files.length, 3);
    assert.ok(files.every((name) => existsSync(path.join(root, '.git/ci-local-guard/logs', name))));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Regression scenario motivated by https://github.com/openai/codex/issues/9506:
// an Agent's truncated terminal view must not be the only failure evidence.
test('noisy failed checks retain early and late diagnostics outside the bounded error summary', async () => {
  const root = fixture();
  try {
    let error;
    try {
      await runLogged(process.execPath, ['-e', `
        console.error('EARLY-FAILURE-EVIDENCE');
        process.stdout.write('ordinary output\\n'.repeat(20000));
        console.error('LATE-FAILURE-EVIDENCE');
        process.exitCode = 1;
      `], root);
    } catch (caught) { error = caught; }
    assert.ok(error);
    assert.ok(error.message.length < 1024);
    assert.doesNotMatch(error.message, /ordinary output/);
    const log = readFileSync(error.logFile, 'utf8');
    assert.match(log, /EARLY-FAILURE-EVIDENCE/);
    assert.match(log, /LATE-FAILURE-EVIDENCE/);
    assert.equal(log.match(/ordinary output/g).length, 20000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('full child logs survive failure and source cleanup with sensitive values masked', async () => {
  const root = fixture();
  try {
    let error;
    try {
      await runLogged(process.execPath, ['-e', `const fs=require('node:fs');fs.mkdirSync('tmp/preflight',{recursive:true});fs.writeFileSync('tmp/preflight/typecheck.log','full-inner-evidence '+process.env.API_TOKEN);process.exit(1)`], root, {
        collectDirectory: 'tmp/preflight', env: { ...process.env, API_TOKEN: 'inner-private-fixture-value' },
      });
    } catch (caught) { error = caught; }
    assert.ok(error);
    rmSync(path.join(root, 'tmp'), { recursive: true, force: true });
    const log = readFileSync(error.logFile, 'utf8');
    assert.match(log, /full-inner-evidence \[REDACTED\]/);
    assert.doesNotMatch(log, /inner-private-fixture-value/);
    assert.equal(error.collectedLogs.status, 'captured');
    assert.equal(error.collectedLogs.count, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing child logs are explicit and excessive child logs cannot produce PASS', async () => {
  const root = fixture();
  try {
    const missing = await runLogged(process.execPath, ['-e', ''], root, { collectDirectory: 'tmp/preflight' });
    assert.equal(missing.collectedLogs.status, 'unavailable');
    await assert.rejects(runLogged(process.execPath, ['-e', `const fs=require('node:fs');fs.mkdirSync('tmp/preflight',{recursive:true});fs.writeFileSync('tmp/preflight/build.log','x'.repeat(4096))`], root,
      { collectDirectory: 'tmp/preflight', maxBytes: 256 }), /log size limit exceeded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('collection refuses linked directories and never reads their outside contents', async () => {
  const root = fixture();
  try {
    const outside = path.join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.log'), 'outside-private-marker');
    symlinkSync(outside, path.join(root, 'tmp'), process.platform === 'win32' ? 'junction' : 'dir');
    let failure;
    try { await runLogged(process.execPath, ['-e', ''], root, { collectDirectory: 'tmp/preflight' }); }
    catch (error) { failure = error; }
    assert.ok(failure);
    assert.match(failure.message, /Unsafe child log directory/);
    assert.equal(failure.executionFailure.exitCode, 0);
    assert.deepEqual(failure.executionFailure.causes, ['child-log-collection-failed']);
    assert.doesNotMatch(readFileSync(failure.logFile, 'utf8'), /outside-private-marker/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('structured failure keeps simultaneous child, receipt and post-validation issues without parsing logs or exposing payload', async () => {
  const root = fixture();
  const identity = { base: 'a'.repeat(40), head: 'b'.repeat(40), event: 'push' };
  try {
    for (const code of [0, 13]) {
      let failure;
      try {
        await runLogged(process.execPath, ['-e', `const fs=require('node:fs');
          fs.mkdirSync('tmp/preflight',{recursive:true}); fs.writeFileSync('tmp/preflight/project-report.json','private-invalid-receipt');
          console.log('PASS misleading-message'); process.exit(${code})`], root, {
          receiptIdentity: identity, requireReceipt: true,
          validateAfter: () => { throw new Error('private-post-validation-error'); },
        });
      } catch (error) { failure = error; }
      assert.ok(failure);
      assert.equal(failure.executionFailure.schemaVersion, 'ci-local-guard/execution-failure/v1');
      assert.equal(failure.executionFailure.exitCode, code);
      assert.equal(failure.executionFailure.processStarted, true);
      assert.deepEqual(failure.executionFailure.causes, [...(code ? ['child-exit-nonzero'] : []), 'receipt-invalid', 'post-execution-validation-failed']);
      assert.equal(failure.executionFailure.receiptStatus, 'invalid');
      assert.deepEqual(failure.executionFailure.failedChecks, []);
      assert.doesNotMatch(JSON.stringify(failure.executionFailure), /private-|misleading-message/);
    }
    rmSync(path.join(root, 'tmp'), { recursive: true, force: true });
    await assert.rejects(runLogged(process.execPath, ['-e', ''], root, { receiptIdentity: identity, requireReceipt: true }), (error) => {
      assert.equal(error.executionFailure.exitCode, 0);
      assert.deepEqual(error.executionFailure.causes, ['receipt-unavailable']);
      assert.equal(error.executionFailure.receiptStatus, 'unavailable');
      return true;
    });
    await assert.rejects(runLogged(process.execPath, ['-e', 'process.stdout.write("large-log".repeat(1000))'], root, { maxBytes: 128 }), (error) => {
      assert.ok(error.executionFailure.causes.includes('log-budget-exceeded'));
      assert.deepEqual(error.executionFailure.failedChecks, []);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('redaction tails do not splice stdout and stderr evidence lines', async () => {
  const root = fixture();
  try {
    let failure;
    try {
      await runLogged(process.execPath, ['-e', 'console.log("complete stdout evidence"); console.error("complete stderr evidence"); process.exitCode=1'], root, {
        env: { ...process.env, API_TOKEN: 'synthetic-token-long-tail' },
      });
    } catch (error) { failure = error; }
    assert.ok(failure);
    const log = readFileSync(failure.logFile, 'utf8');
    assert.match(log, /complete stdout evidence\n/);
    assert.match(log, /complete stderr evidence\n/);
    assert.equal(failure.executionFailure.exitCode, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
