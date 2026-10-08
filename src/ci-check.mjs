import { existsSync, writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { discoverCi } from './ci-discovery.mjs';
import { runLogged } from './run-log.mjs';
import { ACTIONLINT_VERSION } from './actionlint.mjs';

const versions = { actionlint: ACTIONLINT_VERSION, zizmor: '1.30.1' };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;

export function parseFindings(provider, stdout, exitCode, checkout, workflows) {
  const data = JSON.parse(stdout);
  if (!Array.isArray(data) || data.length > 1000) throw new Error('invalid-provider-output');
  const allowed = provider === 'actionlint' ? [0, 1] : [0, 11, 12, 13, 14];
  if (!allowed.includes(exitCode) || (exitCode !== 0 && data.length === 0)) throw new Error('inconsistent-provider-exit');
  return data.map(item => {
    const primary = provider === 'zizmor' ? item.locations?.find(x => x.symbolic?.kind === 'Primary') || item.locations?.[0] : null;
    const source = provider === 'actionlint' ? item.filepath : primary?.symbolic?.key?.Local?.verbatim_path;
    const rule = provider === 'actionlint' ? item.kind : item.ident;
    const message = provider === 'actionlint' ? item.message : item.desc;
    const line = provider === 'actionlint' ? item.line : primary?.concrete?.location?.start_point?.row + 1;
    const column = provider === 'actionlint' ? item.column : primary?.concrete?.location?.start_point?.column + 1;
    if (![source, rule, message].every(text) || !Number.isSafeInteger(line) || line < 1
      || !Number.isSafeInteger(column) || column < 0) throw new Error('invalid-provider-finding');
    const file = path.relative(checkout, path.resolve(checkout, source)).replaceAll('\\', '/');
    if (!workflows.includes(file)) throw new Error('provider-source-mismatch');
    const severity = provider === 'actionlint' ? 'error' : item.determinations?.severity?.toLowerCase();
    if (!['error', 'informational', 'low', 'medium', 'high'].includes(severity)) throw new Error('invalid-provider-severity');
    return { provider, rule, severity, message, location: { path: file, line, column: column || null } };
  });
}

export async function checkCi({ repo, head, provider = 'actionlint', binary } = {}, { executeTool = runLogged } = {}) {
  if (!Object.hasOwn(versions, provider)) throw new Error('unsupported-ci-provider');
  const inventory = discoverCi({ repo, head });
  const report = { schemaVersion: 'ci-local-guard/ci-check/v1', command: 'ci check', identity: inventory.identity,
    scope: 'top-level-github-workflow-static-baseline', outcome: 'blocked', provider: { id: provider, expectedVersion: versions[provider] },
    execution: { status: 'not-run' }, findings: [], issues: [...inventory.issues],
    workflows: inventory.workflows.map(({ path: file, blob, analysis }) => ({ path: file, blob, analysis })),
    coverage: { projectTests: 'not-run', workflowExecution: 'not-run', hosted: 'unverified',
      onlineAudits: 'not-run', shellcheck: 'not-run', pyflakes: 'not-run',
      policy: 'tool-baseline-project-config-not-loaded', inlineSuppressions: provider === 'zizmor' ? 'disabled' : 'not-supported' },
    evidence: [], nextActions: [],
  };
  report.coverage.localActionMetadata = 'not-copied';
  if (inventory.outcome !== 'inventoried' || !inventory.workflows.length || inventory.workflows.length > 128) {
    report.issues.push({ code: 'complete-workflow-inventory-required' });
    return report;
  }
  binary ||= provider === 'actionlint' ? process.env.ACTIONLINT_BIN || path.join(process.env.CI_LOCAL_GUARD_CACHE
    || path.join(os.homedir(), '.cache', 'ci-local-guard'), `actionlint-${ACTIONLINT_VERSION}-${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'actionlint.exe' : 'actionlint') : process.env.ZIZMOR_BIN;
  if (!binary || !path.isAbsolute(binary) || !existsSync(binary)) {
    report.issues.push({ code: 'verified-provider-binary-required' });
    report.nextActions.push({ kind: 'provide-trusted-binary', provider, version: versions[provider], automatic: false });
    return report;
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp)$/i.test(key)));
  env.CI_LOCAL_GUARD_KEEP_LOGS = '1';
  const deadline = performance.now() + 30000;
  const execute = async (args, cwd, stage) => {
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs <= 0) throw new Error('static-check-deadline');
    try {
      const result = await executeTool(binary, args, cwd, { logRepo: inventory.identity.repo, env,
        timeoutMs, maxBytes: 1024 * 1024, stage, captureStdout: true });
      report.evidence.push({ kind: 'log', path: result.logFile });
      return { stdout: result.stdout, exitCode: 0 };
    } catch (error) {
      if (error.logFile) report.evidence.push({ kind: 'log', path: error.logFile });
      const failure = error.executionFailure;
      if (stage === 'ci-static' && failure?.causes.length === 1 && failure.causes[0] === 'child-exit-nonzero') {
        return { stdout: error.stdout, exitCode: failure.exitCode };
      }
      throw error;
    }
  };
  let snapshot;
  let keepSnapshot = false;
  try {
    // Probe outside the consumer directory; provider paths come only from the caller.
    const probe = await execute([provider === 'actionlint' ? '-version' : '--version'], os.tmpdir(), 'ci-version');
    const found = provider === 'actionlint' ? probe.stdout.trim().split(/\s+/)[0]
      : /^zizmor ([0-9.]+)\s*$/.exec(probe.stdout.trim())?.[1];
    if (found !== versions[provider]) throw new Error('unsupported-provider-version');
    report.provider.version = found;
    // Copy Git blobs, never git checkout: checkout can invoke project hooks or
    // smudge filters. No dependency links, credentials or project tool configs.
    snapshot = mkdtempSync(path.join(os.tmpdir(), 'guard-static-'));
    const checkout = snapshot;
    mkdirSync(path.join(checkout, '.github/workflows'), { recursive: true });
    let copiedBytes = 0;
    const hashes = [];
    for (const file of inventory.workflows) {
      const timeout = Math.floor(deadline - performance.now());
      if (timeout <= 0) throw new Error('static-check-deadline');
      const content = execFileSync('git', ['-C', inventory.identity.repo, 'cat-file', 'blob', file.blob],
        { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      copiedBytes += content.length;
      if (copiedBytes > 8 * 1024 * 1024) throw new Error('workflow-input-budget');
      writeFileSync(path.join(checkout, file.path), content, { flag: 'wx' });
      hashes.push([file.path, createHash('sha256').update(content).digest('hex')]);
    }
    const files = inventory.workflows.map(x => x.path);
    // Fixed baseline policy avoids hidden user/project tool configuration.
    const config = path.join(checkout, `.guard-actionlint-${process.pid}.yml`);
    if (provider === 'actionlint') writeFileSync(config, '{}\n', { flag: 'wx', mode: 0o600 });
    const args = provider === 'actionlint'
      ? ['-config-file', config, '-shellcheck=', '-pyflakes=', '-no-color', '-format', '{{json .}}', ...files]
      : ['--offline', '--no-config', '--no-ignores', '--strict-collection', '--format=json-v1', '--no-progress', ...files];
    report.execution.status = 'running';
    const result = await execute(args, checkout, 'ci-static');
    for (const [file, hash] of hashes) {
      const filename = path.join(checkout, file);
      if (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()
        || createHash('sha256').update(readFileSync(filename)).digest('hex') !== hash) throw new Error('snapshot-drift');
    }
    report.findings = parseFindings(provider, result.stdout, result.exitCode, checkout, files);
    report.execution = { status: 'completed', exitCode: result.exitCode };
    report.outcome = report.findings.length ? 'findings' : 'passed';
  } catch (error) {
    report.outcome = error.executionFailure || error.retainedCheckout ? 'incomplete' : 'blocked';
    report.execution.status = 'failed';
    report.issues.push({ code: /^[a-z-]+$/.test(error.message) ? error.message : 'provider-execution-or-output-failed',
      causes: error.executionFailure?.causes || [] });
    if (error.retainedCheckout) report.retainedCheckout = error.retainedCheckout;
    if (error.cleanupFailure) report.cleanupFailure = error.cleanupFailure;
    keepSnapshot = Boolean(error.preserveCheckout);
    if (keepSnapshot) { report.retainedCheckout = snapshot; report.outcome = 'incomplete'; }
  } finally {
    if (snapshot && !keepSnapshot) {
      try { rmSync(snapshot, { recursive: true, force: true }); }
      catch { report.retainedCheckout = snapshot; report.cleanupFailure = 'static-snapshot-cleanup-failed'; report.outcome = 'incomplete'; }
    }
  }
  report.nextActions.push({ kind: report.outcome === 'passed' ? 'review-unverified-scope' : 'review-static-check-evidence', automatic: false });
  return report;
}
