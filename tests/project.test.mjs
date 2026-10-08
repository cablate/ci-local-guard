import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSetup } from '../src/readiness.mjs';

import { assessProtection, assessPushObligations, cleanGitEnvironment, formatPlan, git, parsePushUpdates, planEventContext, preflightConfiguration, projectPreflight, validatePreflightConfiguration, validateProjectPlan, validateProjectReceipt, ZERO_SHA } from '../src/project.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('read-only setup uses committed configuration without executing adapters or certifying dependencies', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-setup-'));
  const commit = () => { git(root, ['add', '.']); git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']); };
  try {
    git(root, ['init', '-q']);
    writeFileSync(path.join(root, 'entry.mjs'), 'throw new Error("must not execute")');
    commit();
    assert.equal(checkSetup(root).outcome, 'unconfigured');
    writeFileSync(path.join(root, '.ci-local-guard.json'), JSON.stringify({ schemaVersion: 'ci-local-guard/project/v1',
      preflight: { entrypoint: 'entry.mjs', dependencies: 'none', receipt: 'guard-v1' } }));
    assert.equal(checkSetup(root).outcome, 'unconfigured');
    commit();
    const before = git(root, ['status', '--porcelain']);
    const report = checkSetup(root);
    assert.equal(report.outcome, 'configured');
    assert.equal(report.dependencies.status, 'unknown');
    assert.equal(report.externalTools.gh.authentication, 'unverified');
    assert.equal(git(root, ['status', '--porcelain']), before);
    writeFileSync(path.join(root, '.ci-local-guard.json'), '{}');
    assert.equal(checkSetup(root).outcome, 'configured');
    commit();
    assert.equal(checkSetup(root).outcome, 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local push policy requires exact owner/check IDs, fresh receipt and selected applicability; never certifies Hosted CI', async () => {
  const { validatePushPolicy, assessLocalPushPolicy } = await import('../src/project.mjs');
  const policy = { schemaVersion: 'ci-local-guard/local-push-policy/v1', scope: 'project-declared-local-gates',
    targetRefs: ['refs/heads/main'], bindings: [{ job: 'ci', owner: 'release', checkIds: ['full:release'] }] };
  const identity = { base: A, head: B, event: 'push', mode: 'committed' };
  const plan = { identity, eventContext: { ref: 'refs/heads/main' }, needsReview: false,
    jobs: [{ id: 'ci', selected: true, owners: ['release'] }] };
  const product = { status: 'ran', result: 'success', checkoutObservation: { status: 'matched' },
    projectReceipt: { status: 'validated', receipt: { identity, checks: [
      { id: 'full:release', owner: 'release', status: 'ran', result: 'success' },
    ] } } };
  const assess = (p = policy, model = plan, receipt = product, ref = 'refs/heads/main') => assessLocalPushPolicy(p, model, receipt, identity, ref);
  assert.equal(assess().status, 'local-policy-satisfied');
  assert.equal(assess().completenessVerified, false);
  assert.equal(assess().hostedPolicyStatus, 'unverified');
  assert.equal(assess(policy, plan, product, 'refs/heads/dev').status, 'blocked');
  assert.equal(assess(policy, { ...plan, needsReview: true }).status, 'blocked');
  assert.equal(assess(policy, { ...plan, jobs: [{ ...plan.jobs[0], selected: false }] }).status, 'blocked');
  assert.equal(assess(policy, plan, { ...product, status: 'cached' }).status, 'blocked');
  assert.equal(assess(policy, plan, { ...product, result: 'failure' }).status, 'blocked');
  for (const check of [
    { id: 'selective', owner: 'release', status: 'ran', result: 'success' },
    { id: 'full:release', owner: 'another-owner', status: 'ran', result: 'success' },
    { id: 'full:release', owner: 'release', status: 'external-owner', result: null },
  ]) assert.equal(assess(policy, plan, { ...product, projectReceipt: { status: 'validated', receipt: { identity, checks: [check] } } }).status, 'blocked');
  assert.equal(assess({ ...policy, bindings: [...policy.bindings, { job: 'missing', owner: 'other', checkIds: ['id'] }] }).status, 'blocked');
  assert.equal(assess(policy, { ...plan, jobs: [...plan.jobs, { id: 'new', selected: false, owners: ['other'] }] }).status, 'blocked');
  for (const mutate of [x => { x.scope = 'complete-ci'; }, x => { x.targetRefs = []; }, x => { x.targetRefs = ['refs/tags/v1']; },
    x => { x.bindings[0].checkIds = []; }, x => { x.bindings.push(x.bindings[0]); }, x => { x.bindings[0].approved = true; }]) {
    const invalid = structuredClone(policy); mutate(invalid);
    assert.throws(() => validatePushPolicy(invalid), /Invalid/);
  }
});

test('plan obligations reveal undeclared owners even when selective receipt checks succeeded', async () => {
  const { assessPlanObligations } = await import('../src/project.mjs');
  const identity = { base: A, head: B, event: 'push', mode: 'committed' };
  const plan = { identity, needsReview: false, jobs: [
    { id: 'verify', selected: true, owners: ['release', 'database'] },
    { id: 'other', selected: true, owners: ['release'] },
    { id: 'skip', selected: false, owners: ['browser'] },
  ] };
  const product = { status: 'ran', checkoutObservation: { status: 'matched' }, projectReceipt: { status: 'validated',
    receipt: { identity, checks: [{ id: 'unit', owner: 'release', status: 'ran', result: 'success' }] } } };
  const report = assessPlanObligations(plan, product, identity);
  assert.equal(report.status, 'unresolved');
  assert.deepEqual(report.missing, ['database']);
  assert.deepEqual(report.owners[0].jobs, ['verify', 'other']);
  assert.deepEqual(report.evidenceBlockers, []);
  assert.deepEqual(report.owners[0].evidenceBlockers, []);
  assert.deepEqual(report.owners[1].evidenceBlockers, ['owner-check-missing']);
  assert.equal(report.completenessVerified, false);
  product.projectReceipt.receipt.checks.push({ id: 'db', owner: 'database', status: 'external-owner', result: null });
  assert.equal(assessPlanObligations(plan, product, identity).owners[1].status, 'unresolved');
  assert.deepEqual(assessPlanObligations(plan, product, identity).owners[1].evidenceBlockers, ['external-owner-evidence-not-accepted']);
  product.projectReceipt.receipt.checks[1] = { id: 'db', owner: 'database', status: 'ran', result: 'success' };
  assert.equal(assessPlanObligations(plan, product, identity).status, 'no-declared-missing');
  assert.equal(assessPlanObligations({ ...plan, needsReview: true }, product, identity).status, 'needs-review');
  for (const invalid of [
    { ...product, status: 'cached' },
    { ...product, checkoutObservation: { status: 'drifted' } },
    { ...product, projectReceipt: { status: 'unavailable' } },
    { ...product, projectReceipt: { status: 'validated', receipt: { identity: { ...identity, event: 'pull_request' }, checks: [] } } },
  ]) assert.equal(assessPlanObligations(plan, invalid, identity).status, 'unverified');
  assert.equal(assessPlanObligations({ ...plan, identity: { ...identity, head: C } }, product, identity).status, 'unverified');
});

test('plan evidence blockers distinguish stale execution, identity drift and unresolved checks without trusting supplied approval', async () => {
  const { assessPlanObligations } = await import('../src/project.mjs');
  const identity = { base: A, head: B, event: 'push', mode: 'committed' };
  const plan = { identity, needsReview: false, jobs: [{ id: 'ci', selected: true, owners: ['release'] }] };
  const product = { status: 'cached', checkoutObservation: { status: 'drifted' },
    projectReceipt: { status: 'unavailable' }, approved: true, evidenceBlockers: [] };
  const blocked = assessPlanObligations(plan, product, identity);
  assert.deepEqual(blocked.evidenceBlockers, ['fresh-product-execution-missing', 'exact-checkout-match-missing', 'validated-project-receipt-missing']);
  assert.deepEqual(blocked.owners[0].evidenceBlockers, blocked.evidenceBlockers);
  assert.equal(blocked.status, 'unverified');
  assert.equal(blocked.completenessVerified, false);
  product.status = 'ran'; product.checkoutObservation.status = 'matched';
  product.projectReceipt = { status: 'validated', receipt: { identity: { ...identity, head: C }, checks: [] } };
  assert.deepEqual(assessPlanObligations(plan, product, identity).evidenceBlockers, ['receipt-identity-mismatch-or-missing']);
  assert.deepEqual(assessPlanObligations({ ...plan, identity: null }, product, identity).evidenceBlockers, ['plan-identity-mismatch-or-missing']);
  product.projectReceipt.receipt.identity = identity;
  product.projectReceipt.receipt.checks = [
    { id: 'remote', owner: 'release', status: 'external-owner', result: null, approved: true },
    { id: 'offline', owner: 'release', status: 'unavailable', result: null },
    { id: 'failed', owner: 'release', status: 'ran', result: 'failure' },
  ];
  const unresolved = assessPlanObligations(plan, product, identity);
  assert.deepEqual(unresolved.owners[0].evidenceBlockers, ['external-owner-evidence-not-accepted', 'owner-check-unavailable', 'owner-check-not-successful']);
  assert.equal(unresolved.status, 'unresolved');
  assert.equal(unresolved.completenessVerified, false);
});

test('community-derived event/ref case never conflates pull request target with push ref or supplied context with verified provenance', () => {
  // act #2478 (historical event confusion); act usage requires explicit PR ref data.
  const identity = { base: A, head: B, event: 'pull_request', mode: 'committed' };
  const context = planEventContext(identity.event, { baseRef: 'main', headRef: 'feature/ci' });
  const data = { schemaVersion: 'ci-local-guard/project-plan/v1', identity, eventContext: context,
    changedFiles: ['deleted.txt'], jobs: [{ id: 'ci.verify', selected: true, reason: 'PR owner', owners: ['release'] }], needsReview: false };
  assert.deepEqual(validateProjectPlan(data, identity, data.changedFiles, context).eventContext, context);
  for (const eventContext of [undefined, { ...context, event: 'push' }, { ...context, baseRef: 'dev' },
    { ...context, headRef: 'another-feature' }, { ...context, approved: true }]) {
    assert.throws(() => validateProjectPlan({ ...data, eventContext }, identity, data.changedFiles, context), /Invalid/);
  }
  for (const input of [{ ref: 'refs/heads/main' }, { baseRef: '../main' }, { headRef: 'feature/.private' }]) {
    assert.throws(() => planEventContext('pull_request', input), /Invalid/);
  }
  assert.throws(() => planEventContext('push', { baseRef: 'main' }), /Invalid/);
  assert.throws(() => planEventContext('push', { ref: 'main' }), /Invalid/);
  assert.equal(planEventContext('push', { ref: 'refs/heads/main' }).ref, 'refs/heads/main');
});

test('PR action/fork context keeps unknown distinct from false and rejects omitted or fabricated echoes', () => {
  const identity = { base: A, head: B, event: 'pull_request', mode: 'committed' };
  const context = planEventContext('pull_request', { prAction: 'synchronize', prFork: false });
  assert.equal(context.prFork, false);
  assert.equal(Object.hasOwn(planEventContext('pull_request'), 'prFork'), false);
  const data = { schemaVersion: 'ci-local-guard/project-plan/v1', identity, eventContext: context,
    changedFiles: [], jobs: [{ id: 'ci', selected: true, reason: 'conditional prediction', owners: ['release'] }], needsReview: true };
  assert.deepEqual(validateProjectPlan(data, identity, [], context).eventContext, context);
  for (const mutate of [x => { delete x.eventContext; }, x => { delete x.eventContext.prFork; },
    x => { x.eventContext.prFork = true; }, x => { x.eventContext.prFork = 'false'; },
    x => { x.eventContext.prAction = 'closed'; }, x => { delete x.eventContext.prAction; }]) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => validateProjectPlan(invalid, identity, [], context), /Invalid/);
  }
  assert.throws(() => validateProjectPlan(data, identity, [], planEventContext('pull_request')), /Invalid/);
  for (const input of [{ prFork: 'false' }, { prFork: 0 }, { prAction: '' }, { prAction: '../opened' }, { prAction: 'a'.repeat(65) }]) {
    assert.throws(() => planEventContext('pull_request', input), /Invalid/);
  }
  for (const event of ['push', 'workflow_dispatch']) {
    assert.throws(() => planEventContext(event, { prFork: false }), /Invalid/);
    assert.throws(() => planEventContext(event, { prAction: 'opened' }), /Invalid/);
  }
  assert.equal(planEventContext('pull_request', { prAction: 'future_activity' }).prAction, 'future_activity');
});

test('generic plan contract binds exact identity/diff and bounded owner declarations, never accepts approval', () => {
  const identity = { base: A, head: B, event: 'push', mode: 'committed' };
  const data = { schemaVersion: 'ci-local-guard/project-plan/v1', identity, changedFiles: ['a.txt', 'deleted.txt'],
    jobs: [{ id: 'ci.verify', selected: true, reason: 'full owner remains required', owners: ['release'] }], needsReview: false };
  assert.equal(validateProjectPlan(data, identity, ['deleted.txt', 'a.txt']).jobs[0].owners[0], 'release');
  for (const mutate of [
    x => { x.identity.head = C; }, x => { x.identity.event = 'pull_request'; }, x => { x.identity.mode = 'working-tree'; },
    x => { x.changedFiles.pop(); }, x => { x.changedFiles.push('a.txt'); }, x => { x.jobs = []; },
    x => { x.jobs.push(x.jobs[0]); }, x => { x.jobs[0].selected = 'true'; }, x => { x.jobs[0].owners = []; },
    x => { x.jobs[0].owners.push('release'); }, x => { x.jobs[0].reason = ''; }, x => { x.approved = true; },
    x => { x.jobs[0].command = 'skip tests'; }, x => { x.needsReview = 'false'; },
  ]) {
    const invalid = structuredClone(data); mutate(invalid);
    assert.throws(() => validateProjectPlan(invalid, identity, data.changedFiles), /Invalid/);
  }
  const config = { schemaVersion: 'ci-local-guard/project/v1', preflight: { entrypoint: 'quality/check.mjs', dependencies: 'none', receipt: 'none' },
    plan: { entrypoint: 'quality/plan.mjs', dependencies: 'none' } };
  assert.deepEqual(validatePreflightConfiguration(config).plan, config.plan);
  for (const plan of [null, {}, { ...config.plan, dependencies: 'npm-ci' }, { ...config.plan, entrypoint: '../outside.mjs' },
    { ...config.plan, entrypoint: '.git/config.js' }, { ...config.plan, approved: true }]) {
    assert.throws(() => validatePreflightConfiguration({ ...config, plan }), /Invalid/);
  }
});

test('push obligations keep missing receipt unknown and explicit external/unavailable owners unresolved', () => {
  assert.equal(assessPushObligations().status, 'unverified');
  assert.equal(assessPushObligations({ status: 'unavailable' }).status, 'unverified');
  const check = { id: '0:unit', owner: 'unit', status: 'ran', why: 'source', blockedBy: null };
  const observed = (checks) => assessPushObligations({ status: 'validated', receipt: { checks } });
  assert.equal(observed([check]).status, 'no-declared-missing');
  assert.equal(observed([check]).completenessVerified, false);
  for (const status of ['external-owner', 'unavailable']) {
    const report = observed([{ ...check, status }]);
    assert.equal(report.status, 'unresolved');
    assert.equal(report.missing[0].status, status);
    assert.equal(report.missing[0].owner, 'unit');
  }
});

test('candidate README preserves adoption boundaries without internal evidence identities', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  // Known internal identifiers only: this is not a comprehensive secret scanner.
  assert.doesNotMatch(readme, /[A-Z]:[\\/](?:Users|_CabLate_Agents)[\\/]|\b[0-9a-f]{40}\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i);
  assert.doesNotMatch(readme, /\b(?:run|job|artifact)\s*\**\s*[0-9]{10,}\b/i);
  assert.match(readme, /GitHub Release/);
  assert.match(readme, /distributed through GitHub, not the npm registry/);
  assert.match(readme, /scripts with your local permissions/);
  const intro = readme.slice(0, readme.indexOf('## Let your AI'));
  assert.match(intro, /existing checks/);
  assert.match(intro, /GitHub Actions still covers/);
  assert.equal((readme.match(/<details>/g) || []).length, (readme.match(/<\/details>/g) || []).length);
  const principles = readme.slice(readme.indexOf('<summary>PRINCIPLE'), readme.indexOf('</details>'));
  assert.equal((principles.match(/^\d+\. /gm) || []).length, 10);
  assert.match(readme, /\(docs\/reference\.md\)/);
  const reference = readFileSync(new URL('../docs/reference.md', import.meta.url), 'utf8');
  assert.match(reference, /Generic pre-push requires an explicit committed push policy, plan and receipt/);
  const examples = [...reference.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) => JSON.parse(match[1]));
  const descriptor = examples.find((item) => item.schemaVersion === 'ci-local-guard/project/v1');
  assert.equal(validatePreflightConfiguration(descriptor).entrypoint, 'quality/preflight.mjs');
});

test('public package allowlist excludes evidence/fixtures and installs a usable local bin offline', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-guard-package-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const stage = path.join(root, 'source'), consumer = path.join(root, 'consumer');
  mkdirSync(stage); mkdirSync(consumer);
  try {
    const copyFile = (name) => writeFileSync(path.join(stage, name), readFileSync(path.join(source, name)));
    for (const name of ['cli.mjs', 'README.md', 'README.zh-TW.md', 'package.json', 'LICENSE', 'CONTRIBUTING.md', 'CHANGELOG.md', 'CHANGELOG.zh-TW.md']) copyFile(name);
    for (const directory of ['src', 'hooks', 'docs']) {
      mkdirSync(path.join(stage, directory));
      for (const file of readdirSync(path.join(source, directory))) copyFile(`${directory}/${file}`);
    }
    writeFileSync(path.join(stage, 'private-note.env'), 'synthetic-private-marker');
    mkdirSync(path.join(stage, 'evidence')); writeFileSync(path.join(stage, 'evidence/raw.json'), '{}');
    mkdirSync(path.join(stage, 'tests')); writeFileSync(path.join(stage, 'tests/fixture.json'), '{}');
    const manifest = JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8'));
    assert.equal(manifest.private, true);
    assert.equal(manifest.publishConfig, undefined);
    assert.equal(manifest.license, 'MIT');
    assert.deepEqual(Object.keys(manifest.dependencies || {}), []);
    assert.ok(['preinstall', 'install', 'postinstall', 'prepare'].every(name => !manifest.scripts?.[name]));
    assert.deepEqual(manifest.bin, { 'ci-local-guard': 'cli.mjs' });
    const npm = (args, cwd) => {
      // Standard POSIX Node distributions keep npm outside dirname(node)/node_modules.
      // Mirror the production adapter's executable fallback; do not skip packaging verification.
      const command = existsSync(npmCli) ? process.execPath : 'npm';
      if (command === 'npm' && process.platform === 'win32') throw new Error('Standard Node/npm distribution required');
      return execFileSync(command, [...(command === process.execPath ? [npmCli] : []), '--offline', '--ignore-scripts', ...args], {
        cwd, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    };
    const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', root], stage))[0];
    const isolated = path.join(root, 'npx-consumer'); mkdirSync(isolated);
    const runNpx = args => npm(['exec', '--yes', '--offline', '--ignore-scripts', '--cache', path.join(root, 'isolated-cache'),
      '--package', path.join(root, packed.filename), '--', 'ci-local-guard', ...args], isolated);
    assert.equal(runNpx(['--version']).trim(), manifest.version);
    assert.match(runNpx(['--help']), /public-experimental/);
    const page = path.join(isolated, 'check.log'); writeFileSync(page, 'npx evidence');
    assert.equal(JSON.parse(runNpx(['read-evidence', '--file', page])).text, 'npx evidence');
    assert.ok(packed.files.every(({ path: file }) => ['README.md', 'README.zh-TW.md', 'docs/reference.md', 'docs/reference.zh-TW.md', 'cli.mjs', 'package.json', 'LICENSE', 'CHANGELOG.md', 'CHANGELOG.zh-TW.md'].includes(file) || /^(src\/[^/]+\.mjs|hooks\/pre-(commit|push))$/.test(file)));
    assert.ok(packed.files.some(({ path: file }) => file === 'src/ci-runs.mjs'));
    for (const file of ['LICENSE', 'README.md', 'README.zh-TW.md', 'docs/reference.md', 'docs/reference.zh-TW.md', 'CHANGELOG.md', 'hooks/pre-commit', 'hooks/pre-push']) {
      assert.ok(packed.files.some((entry) => entry.path === file), `package needs ${file}`);
    }
    npm(['install', path.join(root, packed.filename), '--no-audit', '--no-fund', '--package-lock=false'], consumer);
    // Inspect installed archive bytes, not just the npm file list. These are narrow release regressions, not a secret scanner.
    for (const entry of packed.files) {
      const bytes = readFileSync(path.join(consumer, 'node_modules', 'ci-local-guard', entry.path));
      assert.ok(bytes.equals(readFileSync(path.join(stage, entry.path))), `archive bytes differ: ${entry.path}`);
      const content = bytes.toString('utf8');
      assert.doesNotMatch(content, /synthetic-private-marker|[A-Z]:[\\/]_CabLate_Agents[\\/]|[A-Z]:[\\/]Users[\\/][^\s"']+/i, entry.path);
      assert.doesNotMatch(content, /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b/, entry.path);
    }
    assert.equal(readFileSync(path.join(consumer, 'node_modules/ci-local-guard/LICENSE'), 'utf8'), readFileSync(path.join(source, 'LICENSE'), 'utf8'));
    const bin = path.join(consumer, 'node_modules/.bin/ci-local-guard');
    assert.ok(existsSync(process.platform === 'win32' ? `${bin}.cmd` : bin));
    const output = process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'node_modules\\.bin\\ci-local-guard.cmd --help'], { cwd: consumer, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 10000 })
      : execFileSync(bin, ['--help'], { cwd: consumer, encoding: 'utf8', timeout: 10000 });
    assert.match(output, /public-experimental/);
    assert.match(output, /compare-runs/);
    const guidePath = output.match(/^AI guide: (.+)$/m)?.[1].trim();
    assert.equal(guidePath, path.join(consumer, 'node_modules', 'ci-local-guard', 'README.md'));
    assert.match(readFileSync(guidePath, 'utf8'), /## AI entry point/);
    assert.match(readFileSync(path.join(path.dirname(guidePath), 'docs/reference.md'), 'utf8'), /ci-local-guard\/project\/v1/);
    // Installed platform bin must run a committed generic project, not only display help.
    const project = path.join(root, 'project'); mkdirSync(project); mkdirSync(path.join(project, 'quality'));
    const gitEnv = cleanGitEnvironment();
    const projectGit = args => execFileSync('git', ['-C', project, ...args], { env: gitEnv, encoding: 'utf8', timeout: 10000 }).trim();
    projectGit(['init', '-q', '-b', 'main']); projectGit(['config', 'user.name', 'Package Fixture']);
    projectGit(['config', 'user.email', 'fixture@example.invalid']); projectGit(['config', 'core.autocrlf', 'false']);
    projectGit(['config', 'core.hooksPath', path.join(project, '.no-hooks')]);
    writeFileSync(path.join(project, '.ci-local-guard.json'), JSON.stringify({ schemaVersion: 'ci-local-guard/project/v1',
      preflight: { entrypoint: 'quality/preflight.mjs', dependencies: 'none', receipt: 'guard-v1' } }));
    writeFileSync(path.join(project, 'input.txt'), 'base\n');
    writeFileSync(path.join(project, 'quality/preflight.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      const option = flag => process.argv[process.argv.indexOf(flag) + 1];
      const base = option('--base'), head = option('--head'), event = option('--event');
      if (readFileSync('input.txt', 'utf8') !== 'committed\\n') throw Error('Wrong checkout content');
      const changedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', base, head], { encoding: 'utf8' }).trim().split(/\\r?\\n/).filter(Boolean);
      const failed = process.env.GUARD_INSTALLED_FAIL === '1';
      mkdirSync('tmp/preflight', { recursive: true }); writeFileSync('tmp/preflight/check.log', 'fixture only');
      writeFileSync('tmp/preflight/project-report.json', JSON.stringify({ schemaVersion: 'ci-local-guard/project-preflight/v1',
        identity: { base, head, event, mode: 'committed' }, changedFiles,
        checks: [{ id: '0:fixture', owner: 'package-fixture', why: 'Exact committed fixture only', status: 'ran', result: failed ? 'failure' : 'success', durationMs: 1, log: 'check.log', blockedBy: null }],
        outcome: failed ? 'failed' : 'incomplete', unverified: ['hosted'] }));
      console.log('PASS text is not exit evidence'); process.exitCode = failed ? 1 : 0;
    `);
    projectGit(['add', '.']); projectGit(['commit', '-qm', 'base']); const base = projectGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(project, 'input.txt'), 'committed\n'); projectGit(['add', 'input.txt']);
    projectGit(['commit', '-qm', 'candidate']); const head = projectGit(['rev-parse', 'HEAD']);
    writeFileSync(path.join(project, 'input.txt'), 'dirty source must remain\n');
    const commandArgs = ['preflight', '--repo', project, '--base', base, '--head', head, '--event', 'push', '--json'];
    const callInstalled = failed => {
      const env = { ...gitEnv, GUARD_INSTALLED_FAIL: failed ? '1' : '0' };
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = path.dirname(process.execPath) + path.delimiter + (env[pathKey] || '');
      return process.platform === 'win32'
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'node_modules\\.bin\\ci-local-guard.cmd ' + commandArgs.map(arg => `"${arg}"`).join(' ')],
          { cwd: consumer, env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 30000 })
        : spawnSync(bin, commandArgs, { cwd: consumer, env, encoding: 'utf8', timeout: 30000 });
    };
    for (const failed of [false, true]) {
      const result = callInstalled(failed); assert.equal(result.status, failed ? 1 : 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.product.result, failed ? 'failure' : 'success');
      assert.equal(report.outcome, failed ? 'failed' : 'incomplete');
      assert.equal(report.product.projectReceipt.status, 'validated');
      assert.equal(report.product.checkoutObservation.status, 'matched');
      assert.equal(projectGit(['rev-parse', 'HEAD']), head);
      assert.equal(readFileSync(path.join(project, 'input.txt'), 'utf8'), 'dirty source must remain\n');
      assert.equal((projectGit(['worktree', 'list', '--porcelain']).match(/^worktree /gm) || []).length, 1);
    }
    // First-use failure must guide the consumer to its installed docs, not the source checkout.
    projectGit(['rm', '.ci-local-guard.json']); projectGit(['commit', '-qm', 'unconfigured candidate']);
    commandArgs[commandArgs.indexOf('--head') + 1] = projectGit(['rev-parse', 'HEAD']);
    const unavailable = callInstalled(false);
    assert.equal(unavailable.status, 2, unavailable.stderr);
    const missing = JSON.parse(unavailable.stdout);
    assert.equal(missing.product.status, 'unavailable');
    assert.match(missing.nextAction, /No checks ran/);
    assert.ok(missing.nextAction.includes(guidePath));
    assert.ok(missing.nextAction.includes('existing CI/scripts') && missing.nextAction.includes('.ci-local-guard.json'));
    assert.equal(readFileSync(path.join(project, 'input.txt'), 'utf8'), 'dirty source must remain\n');
    assert.equal((projectGit(['worktree', 'list', '--porcelain']).match(/^worktree /gm) || []).length, 1);
    const input = path.join(consumer, 'empty-export.json');
    writeFileSync(input, JSON.stringify({ schemaVersion: 'ci-local-guard/github-export/v1', repository: 'example/project', runs: [] }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
    env.PATH = consumer;
    const report = JSON.parse(execFileSync(process.execPath, [path.join(consumer, 'node_modules/ci-local-guard/cli.mjs'), 'inspect-runs', '--input', input], {
      cwd: consumer, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
    }));
    assert.equal(report.schemaVersion, 'ci-local-guard/run-inspection/v1');
    assert.equal(report.repository, 'example/project');
    assert.deepEqual(report.runs, []);
    npm(['uninstall', 'ci-local-guard', '--no-audit', '--no-fund'], consumer);
    assert.equal(existsSync(path.join(consumer, 'node_modules/ci-local-guard')), false);
    assert.equal(existsSync(process.platform === 'win32' ? `${bin}.cmd` : bin), false);
    assert.ok(existsSync(input), 'uninstall preserves consumer input files');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('standalone descriptor rejects unknown contracts, shell commands and escaping paths', () => {
  const config = { schemaVersion: 'ci-local-guard/project/v1', preflight: {
    entrypoint: 'quality/preflight.mjs', dependencies: 'none', receipt: 'none' } };
  assert.equal(validatePreflightConfiguration(config).entrypoint, 'quality/preflight.mjs');
  for (const entrypoint of ['../outside.mjs', '/absolute.mjs', 'C:/outside.mjs', 'a//b.mjs', '.git/run.mjs', 'echo hi;node.mjs', 'a\\b.mjs']) {
    assert.throws(() => validatePreflightConfiguration({ ...config, preflight: { ...config.preflight, entrypoint } }), /Invalid/);
  }
  for (const invalid of [{ ...config, schemaVersion: 'v2' }, { ...config, extra: true },
    { ...config, preflight: { ...config.preflight, dependencies: 'npm-ci' } },
    { ...config, preflight: { ...config.preflight, receipt: 'unknown' } }]) {
    assert.throws(() => validatePreflightConfiguration(invalid), /Invalid/);
  }
});

test('committed protection manifest is explicit bounded data, never an executable or verified policy', () => {
  const protection = { schemaVersion: 'ci-local-guard/protection-manifest/v1', completeness: 'partial', items: [
    { id: 'unit', local: { scope: 'selective', owners: ['unit'] }, hosted: { workflow: 'ci.yml', job: 'unit' } },
    { id: 'browser', local: { scope: 'none', owners: [] }, hosted: { workflow: 'ci.yml', job: 'browser' } },
  ] };
  const config = { schemaVersion: 'ci-local-guard/project/v1', preflight: {
    entrypoint: 'quality/preflight.mjs', dependencies: 'none', receipt: 'guard-v1' }, protection };
  assert.deepEqual(validatePreflightConfiguration(config).protection, protection);
  for (const invalid of [null, { ...protection, completeness: 'verified' }, { ...protection, approved: true },
    { ...protection, items: [] }, { ...protection, items: [...protection.items, protection.items[0]] },
    { ...protection, items: [{ ...protection.items[0], command: 'skip tests' }] },
    { ...protection, items: [{ ...protection.items[0], hosted: { workflow: '../ci.yml', job: 'unit' } }] },
    { ...protection, items: [{ ...protection.items[1], local: { scope: 'none', owners: ['unit'] } }] },
    { ...protection, items: [{ ...protection.items[0], local: { scope: 'selective', owners: [] } }] },
  ]) assert.throws(() => validatePreflightConfiguration({ ...config, protection: invalid }), /protection manifest/);
});

// Motivated by https://github.com/fullsend-ai/agents/issues/626:
// an approved gate or green rollup does not imply the protected tests actually ran.
test('protection mapping never promotes missing, external, cached or selective checks into full coverage', () => {
  const manifest = { schemaVersion: 'ci-local-guard/protection-manifest/v1', completeness: 'declared-complete', items: [
    { id: 'unit', local: { scope: 'selective', owners: ['unit', 'static'] }, hosted: { workflow: 'ci.yml', job: 'Unit tests' } },
    { id: 'browser', local: { scope: 'none', owners: [] }, hosted: { workflow: 'ci.yml', job: 'Functional Tests' } },
  ] };
  const check = (id, owner, status = 'ran', result = 'success') => ({ id, owner, status, result });
  const receipt = (checks) => ({ status: 'validated', receipt: { checks } });
  const matched = { status: 'matched' };
  const success = assessProtection(manifest, receipt([check('0', 'unit'), check('1', 'static'), check('2', 'other')]), matched);
  assert.equal(success.status, 'declared-unverified');
  assert.equal(success.completenessVerified, false);
  assert.equal(success.items[0].local.evidence, 'observed-success');
  assert.equal(success.items[0].local.declaredScope, 'selective');
  assert.deepEqual(success.unmappedChecks, ['2']);
  assert.equal(success.items[1].local.evidence, 'not-configured');
  assert.equal(success.items[1].hosted.status, 'unverified');
  const missing = assessProtection(manifest, receipt([check('0', 'unit')]), matched);
  assert.deepEqual(missing.items[0].local.missingOwners, ['static']);
  assert.equal(missing.items[0].local.evidence, 'unverified');
  for (const status of ['unavailable', 'external-owner']) {
    const result = assessProtection(manifest, receipt([check('0', 'unit'), check('1', 'static', status, null)]), matched);
    assert.equal(result.items[0].local.evidence, 'unverified');
  }
  const failed = assessProtection(manifest, receipt([check('0', 'unit', 'ran', 'failure')]), matched);
  assert.equal(failed.items[0].local.evidence, 'observed-failure');
  // A second check sharing an owner must not be hidden by a successful first check.
  const mixed = assessProtection(manifest, receipt([check('0', 'unit'), check('1', 'static'), check('2', 'unit', 'ran', 'failure')]), matched);
  assert.equal(mixed.items[0].local.evidence, 'observed-failure');
  for (const state of [{ status: 'drifted' }, undefined]) {
    assert.equal(assessProtection(manifest, receipt([check('0', 'unit'), check('1', 'static')]), state).items[0].local.evidence, 'unverified');
  }
  assert.equal(assessProtection(manifest, { status: 'unavailable' }).items[0].local.evidence, 'unverified');
  assert.equal(assessProtection().status, 'unavailable');
});

test('descriptor belongs to HEAD, not a dirty, untracked or staged working-copy version', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-descriptor-'));
  const descriptor = path.join(root, '.ci-local-guard.json');
  const config = { schemaVersion: 'ci-local-guard/project/v1', preflight: {
    entrypoint: 'quality/preflight.mjs', dependencies: 'none', receipt: 'none' } };
  try {
    execFileSync('git', ['init', '-q', root], { env: cleanGitEnvironment() });
    writeFileSync(descriptor, JSON.stringify(config));
    assert.equal(preflightConfiguration(root).source, 'unconfigured');
    git(root, ['add', '.']);
    assert.equal(preflightConfiguration(root).source, 'unconfigured');
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', 'commit', '-qm', 'descriptor']);
    writeFileSync(descriptor, '{private malformed payload');
    assert.equal(preflightConfiguration(root).entrypoint, 'quality/preflight.mjs');
    unlinkSync(descriptor);
    git(root, ['add', '-u']);
    assert.equal(preflightConfiguration(root).entrypoint, 'quality/preflight.mjs');
    writeFileSync(descriptor, '{private malformed payload');
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', 'commit', '-qm', 'malformed']);
    assert.throws(() => preflightConfiguration(root), /not valid JSON/);
    writeFileSync(descriptor, ' '.repeat(65537));
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', 'commit', '-qm', 'oversized']);
    assert.throws(() => preflightConfiguration(root), /64 KiB/);
    writeFileSync(descriptor, JSON.stringify(config));
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=.no-hooks', 'commit', '-qm', 'restore config']);
    assert.throws(() => projectPreflight(root), /ENOENT/);
    mkdirSync(path.join(root, 'outside'));
    writeFileSync(path.join(root, 'outside/preflight.mjs'), 'throw new Error("must not run");');
    symlinkSync(path.join(root, 'outside'), path.join(root, 'quality'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => projectPreflight(root), /not a link/);
    unlinkSync(path.join(root, 'quality'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('receipt validation binds identity and exit, and never promotes selective coverage to complete', () => {
  const identity = { base: A, head: B, event: 'push' };
  const data = { schemaVersion: 'ci-local-guard/project-preflight/v1', identity: { ...identity, mode: 'committed' },
    changedFiles: ['src/input.txt'], checks: [{ id: '0:unit', owner: 'unit', why: 'changed source', status: 'ran',
      result: 'success', durationMs: 10, log: '0-unit.log', blockedBy: null }],
    outcome: 'incomplete', unverified: ['browser', 'hosted'], privateExtra: 'must-not-leak' };
  const report = validateProjectReceipt(data, identity, 0);
  assert.equal(report.outcome, 'incomplete');
  const generic = { ...data, schemaVersion: 'ci-local-guard/project-preflight/v1' };
  assert.equal(validateProjectReceipt(generic, identity, 0, generic.schemaVersion).schemaVersion, generic.schemaVersion);
  assert.throws(() => validateProjectReceipt({ ...generic, schemaVersion: 'foreign-preflight/v1' }, identity, 0), /Invalid/);
  assert.throws(() => validateProjectReceipt(data, identity, 0, 'foreign-preflight/v1'), /Invalid/);
  assert.doesNotMatch(JSON.stringify(report), /must-not-leak/);
  for (const mutate of [
    (input) => { input.identity.head = C; },
    (input) => { input.identity.event = 'pull_request'; },
    (input) => { input.identity.mode = 'working-tree'; },
    (input) => { input.checks[0].result = 'failure'; input.outcome = 'failed'; },
    (input) => { input.checks[0].log = '../outside.log'; },
    (input) => { input.checks.push(input.checks[0]); },
    (input) => { input.outcome = 'local-complete'; },
    (input) => { input.checks[0].status = 'external-owner'; },
  ]) {
    const invalid = structuredClone(data);
    mutate(invalid);
    assert.throws(() => validateProjectReceipt(invalid, identity, 0), /Invalid/);
  }
  assert.throws(() => validateProjectReceipt(data, identity, 1), /Invalid/);
});

test('nested Git and CI fixture processes do not inherit the pushed repository', () => {
  const env = cleanGitEnvironment({
    PATH: 'preserved', ACTIONLINT_BIN: 'preserved', GIT_DIR: '/wrong/repository',
    GIT_WORK_TREE: '/wrong/worktree', GIT_INDEX_FILE: '/wrong/index',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true',
  });
  assert.equal(env.PATH, 'preserved');
  assert.equal(env.ACTIONLINT_BIN, 'preserved');
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT']) {
    assert.equal(env[name], undefined);
  }
});

test('Git lookup targets the requested repo even when a hook exports a different GIT_DIR', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-local-guard-git-env-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const original = process.env.GIT_DIR;
  try {
    execFileSync('git', ['init', '-q', source], { env: cleanGitEnvironment() });
    execFileSync('git', ['init', '-q', target], { env: cleanGitEnvironment() });
    process.env.GIT_DIR = path.join(source, '.git');
    assert.equal(realpathSync.native(git(target, ['rev-parse', '--show-toplevel'])), realpathSync.native(target));
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('parses Git pre-push records and rejects incomplete ones', () => {
  assert.deepEqual(parsePushUpdates(`refs/heads/feature ${A} refs/heads/feature ${B}\n`), [{
    localRef: 'refs/heads/feature', localSha: A,
    remoteRef: 'refs/heads/feature', remoteSha: B,
  }]);
  assert.throws(() => parsePushUpdates(`refs/heads/feature ${A} refs/heads/feature`), /Invalid/);
});

test('push input rejects byte/count excess and malformed records without echoing input or coercing objects', async () => {
  const { MAX_PUSH_INPUT_BYTES } = await import('../src/project.mjs');
  const record = `refs/heads/feature ${A} refs/heads/feature ${B}`;
  assert.equal(parsePushUpdates(`${record}\n`.repeat(128)).length, 128);
  const boundary = record + ' '.repeat(MAX_PUSH_INPUT_BYTES - Buffer.byteLength(record) - 1) + '\n';
  assert.equal(Buffer.byteLength(boundary), MAX_PUSH_INPUT_BYTES);
  assert.equal(parsePushUpdates(boundary).length, 1);
  for (const [input, code] of [[`${record}\n`.repeat(129), 'too-many-updates'],
    [boundary + 'x', 'push-input-too-large'], ['中'.repeat(Math.ceil(MAX_PUSH_INPUT_BYTES / 3)), 'push-input-too-large'],
    ['private-input-secret\n' + record, 'invalid-push-input'],
    [{ toString: () => { throw new Error('private-coercion-must-not-run'); } }, 'invalid-push-input']]) {
    assert.throws(() => parsePushUpdates(input), (error) => {
      assert.equal(error.pushCode, code);
      assert.doesNotMatch(error.message, /private-input-secret|private-coercion|refs\/heads/);
      return true;
    });
  }
});

test('plan summary distinguishes selected jobs, estimate and review', () => {
  assert.equal(formatPlan({
    jobs: [{ id: 'scope', selected: true }, { id: 'full-verify', selected: false }],
    estimate: { consumptionSeconds: 19 },
    needsReview: false,
  }), 'jobs: scope; indicative runner time 1 min; review: no');
});
