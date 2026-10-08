// Shared fixtures for the hooks/preflight/plan CLI tests. Not a test file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanGitEnvironment, projectPreflight } from '../../src/project.mjs';

export const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.mjs');

export function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-guard-hooks-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: cleanGitEnvironment() });
  git('init', '-q', '-b', 'dev');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', path.join(root, '.no-hooks'));
  return { root, git };
}

export function seedPreflightFixture(fixture, { preflight = true, review = false, fail = false, receipt = 'valid', protection } = {}) {
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

export function invoke(fixture, candidate, verb, { input, env = {}, args = [] } = {}) {
  return spawnSync(process.execPath, [cli, verb, '--repo', fixture.root, '--base', candidate.base, ...args], {
    encoding: 'utf8', input, timeout: 30_000,
    env: { ...cleanGitEnvironment(), GUARD_TEST_MARKER: candidate.marker, ...env },
  });
}

export function assertTiming(report) {
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

export function pushInput(candidate, branch = 'feature') {
  return `refs/heads/${branch} ${candidate.head} refs/heads/${branch} ${candidate.base}\n`;
}
