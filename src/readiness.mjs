import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { git, preflightConfiguration } from './project.mjs';
import { ACTIONLINT_VERSION } from './actionlint.mjs';

// No adapter execution, downloads, authentication or working-tree writes.
export function checkSetup(directory) {
  const probe = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    return result.status === 0 ? String(result.stdout).trim() : null;
  };
  const node = /^22\.(\d+)\./.exec(process.versions.node);
  const report = { schemaVersion: 'ci-local-guard/setup-report/v1', outcome: 'blocked', repo: null, head: null,
    node: { version: process.versions.node, supported: Boolean(node && Number(node[1]) >= 13) },
    git: { available: Boolean(probe('git', ['--version'])) },
    descriptor: { source: 'HEAD', status: 'unavailable' }, entrypoint: { status: 'unavailable' },
    dependencies: { status: 'unknown', owner: 'project' },
    externalTools: {
      gh: { available: Boolean(probe('gh', ['--version'])), authentication: 'unverified', requiredFor: 'collect-run(s)' },
      actionlint: { matchingVersion: probe(process.env.ACTIONLINT_BIN || 'actionlint', ['-version'])?.split(/\s+/)[0] === ACTIONLINT_VERSION,
        requiredFor: 'project-declared workflow lint only', cacheSearched: false },
    },
    limitation: 'Static committed configuration only; dependencies, assertions, hosted protection and execution remain unverified.',
    nextAction: 'Resolve missing runtime or repository prerequisites; do not execute untrusted project code.' };
  if (!report.node.supported || !report.git.available) return report;
  try {
    report.repo = git(path.resolve(directory), ['rev-parse', '--show-toplevel']);
    report.head = git(report.repo, ['rev-parse', '--verify', 'HEAD']);
    const config = preflightConfiguration(report.repo);
    if (config.source === 'unconfigured') {
      report.outcome = 'unconfigured';
      report.descriptor.status = 'missing';
      report.nextAction = 'Ask the project agent to map existing checks and commit a project-owned descriptor and adapter; see README adoption guide.';
      return report;
    }
    report.descriptor.status = 'valid';
    const entries = [config.entrypoint, ...(config.plan ? [config.plan.entrypoint] : [])];
    if (entries.some(entry => !/^100(?:644|755) blob /.test(git(report.repo, ['ls-tree', 'HEAD', '--', entry])))) {
      throw new Error('Committed adapter must be a regular repository file');
    }
    report.entrypoint = { status: 'present', paths: entries };
    report.outcome = 'configured';
    report.nextAction = 'Confirm trust and prepare project dependencies; then use explicit base/head for preflight. Configured does not mean checks passed.';
  } catch {
    report.outcome = 'blocked';
    report.nextAction = 'Inspect the repository and committed descriptor/entrypoints; correct invalid or missing inputs before execution.';
  }
  return report;
}
