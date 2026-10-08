import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCi, parseFindings } from '../src/ci-check.mjs';
import { runLogged } from '../src/run-log.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-static-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'on: push\njobs: {}\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  return { root, git };
}

test('finding parsers normalize locations, reject mismatched paths and do not trust exit zero', () => {
  const root = path.resolve(os.tmpdir(), 'guard-fixture');
  const files = ['.github/workflows/ci.yml'];
  const action = { filepath: files[0], kind: 'syntax-check', message: 'invalid syntax', line: 1, column: 0, snippet: 'PRIVATE_SNIPPET' };
  const findings = parseFindings('actionlint', JSON.stringify([action]), 0, root, files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].location.column, null);
  assert.ok(!JSON.stringify(findings).includes('PRIVATE_SNIPPET'));
  assert.throws(() => parseFindings('actionlint', '[]', 1, root, files));
  assert.throws(() => parseFindings('actionlint', JSON.stringify([{ ...action, filepath: '../escape.yml' }]), 1, root, files));
  assert.throws(() => parseFindings('actionlint', '{}', 0, root, files));
  const z = { ident: 'template-injection', desc: 'injection', determinations: { severity: 'High' },
    locations: [{ symbolic: { kind: 'Primary', key: { Local: { verbatim_path: files[0] } } },
      concrete: { location: { start_point: { row: 8, column: 3 } }, feature: 'PRIVATE_SNIPPET' } }] };
  assert.deepEqual(parseFindings('zizmor', JSON.stringify([z]), 14, root, files)[0].location,
    { path: files[0], line: 9, column: 4 });
  assert.throws(() => parseFindings('zizmor', '[]', 3, root, files));
});

test('static baseline uses committed blobs, no checkout hooks, no ambient token and cleans its snapshot', async t => {
  const { root, git } = fixture(t);
  git('config', 'core.hooksPath', 'do-not-run-hooks');
  writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'dirty version');
  let snapshot;
  const report = await checkCi({ repo: root, binary: process.execPath }, { executeTool: async (binary, args, cwd, opts) => {
    assert.equal(opts.env.GH_TOKEN, undefined);
    assert.equal(opts.env.NODE_OPTIONS, undefined);
    assert.ok(opts.timeoutMs > 0 && opts.timeoutMs <= 30000);
    if (args[0] === '-version') return { stdout: '1.7.12\n', logFile: null };
    snapshot = cwd;
    assert.equal(existsSync(path.join(cwd, '.git')), false);
    assert.equal(readFileSync(path.join(cwd, '.github/workflows/ci.yml'), 'utf8'), 'on: push\njobs: {}\n');
    assert.ok(args.includes('-shellcheck='));
    return { stdout: '[]\n', logFile: null };
  } });
  assert.equal(report.outcome, 'passed');
  assert.equal(report.coverage.projectTests, 'not-run');
  assert.equal(existsSync(snapshot), false);
  assert.equal(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'), 'dirty version');
});

test('version drift, malformed output, source mutation and tool crashes never become static PASS', async t => {
  const { root } = fixture(t);
  for (const mode of ['version', 'malformed', 'mutation', 'crash']) {
    const r = await checkCi({ repo: root, binary: process.execPath }, { executeTool: async (_, args, cwd) => {
      if (args[0] === '-version') return { stdout: mode === 'version' ? '999.0.0' : '1.7.12', logFile: null };
      if (mode === 'mutation') writeFileSync(path.join(cwd, '.github/workflows/ci.yml'), 'changed');
      if (mode === 'crash') throw new Error('PRIVATE_TOOL_STDERR');
      return { stdout: mode === 'malformed' ? 'PRIVATE_TOOL_OUTPUT' : '[]', logFile: null };
    } });
    assert.notEqual(r.outcome, 'passed');
    assert.ok(!JSON.stringify(r).includes('PRIVATE_TOOL'));
  }
  const missing = await checkCi({ repo: root, binary: path.join(root, 'missing.exe') });
  assert.equal(missing.outcome, 'blocked');
  assert.equal(missing.execution.status, 'not-run');
});

test('stdout capture is opt-in, redacted, separate from stderr and retained on nonzero exit', async t => {
  const { root } = fixture(t);
  const env = { ...process.env, TEST_SECRET_TOKEN: 'capture-secret-12345' };
  const r = await runLogged(process.execPath, ['-e', 'console.log(process.env.TEST_SECRET_TOKEN); console.error("stderr-only")'], root,
    { env, captureStdout: true });
  assert.equal(r.stdout.trim(), '[REDACTED]');
  const ordinary = await runLogged(process.execPath, ['-e', 'console.log("ordinary")'], root);
  assert.equal(Object.hasOwn(ordinary, 'stdout'), false);
  await assert.rejects(runLogged(process.execPath, ['-e', 'console.log("[]"); process.exitCode=14'], root,
    { captureStdout: true }), e => e.stdout.trim() === '[]' && e.executionFailure.exitCode === 14);
});
