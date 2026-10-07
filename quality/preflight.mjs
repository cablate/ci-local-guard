import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { git } from '../src/project.mjs';

// Project-owned adapter: invoke the existing package test command, not Guard.
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const identity = { mode: 'committed', base: option('--base'), head: option('--head'), event: option('--event') };
if (!['--base', '--head', '--event'].every(name => args.includes(name))
  || ![identity.base, identity.head].every(value => /^[a-f0-9]{40}$/.test(value || ''))
  || !['pull_request', 'push', 'workflow_dispatch'].includes(identity.event)) throw new Error('Explicit committed identity required');
const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
// Keep the runner and package command aligned rather than maintaining a second test list.
if (scripts.test !== 'node --test tests/*.test.mjs') throw new Error('Update project adapter for changed package test contract');
mkdirSync('tmp/preflight', { recursive: true });
const log = openSync('tmp/preflight/tests.log', 'w');
const start = performance.now();
let result;
try { result = spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { stdio: ['ignore', log, log], windowsHide: true }); }
finally { closeSync(log); }
const failed = result.status !== 0 || Boolean(result.error);
writeFileSync('tmp/preflight/project-report.json', JSON.stringify({
  schemaVersion: 'ci-local-guard/project-preflight/v1', identity,
  changedFiles: git(process.cwd(), ['diff', '--name-only', '-z', identity.base, identity.head]).split('\0').filter(Boolean),
  checks: [{ id: 'node-tests', owner: 'package:test', why: 'Full existing project test suite on the current OS',
    status: 'ran', result: failed ? 'failure' : 'success', durationMs: Math.round(performance.now() - start),
    log: 'tests.log', blockedBy: null }],
  outcome: failed ? 'failed' : 'incomplete', unverified: ['hosted', 'other-os'],
}));
process.exitCode = failed ? 1 : 0;
