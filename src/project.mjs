import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ZERO_SHA = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
let gitLocalEnvVars;

export function cleanGitEnvironment(env = process.env) {
  // Offline telemetry commands import this adapter but do not require Git.
  gitLocalEnvVars ??= execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8', windowsHide: true,
  }).trim().split(/\r?\n/).filter(Boolean);
  const clean = { ...env };
  for (const variable of gitLocalEnvVars) delete clean[variable];
  return clean;
}

export function git(repo, args, { allowMissing = false } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanGitEnvironment(),
    }).trim();
  } catch (error) {
    if (allowMissing && error.status === 1) return '';
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

/** The project's own pre-push checks for a commit, or null when it has none. */
export function projectPreflight(repo, config = preflightConfiguration(repo)) {
  if (config.source !== 'committed-descriptor') return null;
  const file = path.join(repo, config.entrypoint);
  if (config.source === 'committed-descriptor') {
    let cursor = repo;
    for (const part of config.entrypoint.split('/')) {
      cursor = path.join(cursor, part);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || (cursor === file ? !info.isFile() : !info.isDirectory())) {
        throw new Error('Configured preflight must be a regular repository file, not a link');
      }
    }
  }
  return existsSync(file) ? file : null;
}

export function validateProtectionManifest(data) {
  const invalid = () => { throw new Error('Invalid CI Local Guard protection manifest'); };
  const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
  const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
  if (!object(data, ['schemaVersion', 'completeness', 'items'])
    || data.schemaVersion !== 'ci-local-guard/protection-manifest/v1'
    || !['partial', 'declared-complete'].includes(data.completeness)
    || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 128) invalid();
  const ids = new Set();
  const items = data.items.map((item) => {
    if (!object(item, ['id', 'local', 'hosted']) || typeof item.id !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/.test(item.id) || ids.has(item.id)
      || !object(item.local, ['scope', 'owners']) || !['full', 'selective', 'none'].includes(item.local.scope)
      || !Array.isArray(item.local.owners) || item.local.owners.length > 64 || !item.local.owners.every(text)
      || new Set(item.local.owners).size !== item.local.owners.length
      || (item.local.scope === 'none') !== (item.local.owners.length === 0)
      || (item.hosted !== null && (!object(item.hosted, ['workflow', 'job'])
        || !/^[\w.-]+\.ya?ml$/.test(item.hosted.workflow || '') || !text(item.hosted.job)))) invalid();
    ids.add(item.id);
    return { id: item.id, local: { scope: item.local.scope, owners: [...item.local.owners] },
      hosted: item.hosted === null ? null : { workflow: item.hosted.workflow, job: item.hosted.job } };
  });
  return { schemaVersion: data.schemaVersion, completeness: data.completeness, items };
}

// Match local transport evidence to declared responsibilities, never certify assertions or hosted policy.
export function assessProtection(manifest, projectReceipt, checkoutObservation) {
  const report = { schemaVersion: 'ci-local-guard/protection-report/v1', status: 'unavailable',
    manifestCompleteness: null, completenessVerified: false, hostedPolicyStatus: 'unverified',
    items: [], unmappedChecks: [],
    limitation: 'Committed declarations and local receipt matching only; assertion sufficiency, full scope, applicability and hosted protection are not verified.' };
  if (!manifest) return report;
  const contract = validateProtectionManifest(manifest);
  const checks = projectReceipt?.status === 'validated' ? projectReceipt.receipt.checks : [];
  const observed = checkoutObservation?.status === 'matched';
  const mapped = new Set();
  report.status = 'declared-unverified';
  report.manifestCompleteness = contract.completeness;
  report.items = contract.items.map((item) => {
    const matching = checks.filter((check) => item.local.owners.includes(check.owner));
    for (const check of matching) mapped.add(check.id);
    const missingOwners = item.local.owners.filter((owner) => !matching.some((check) => check.owner === owner));
    let evidence = item.local.scope === 'none' ? 'not-configured' : 'unverified';
    if (observed && matching.some((check) => check.status === 'ran' && check.result === 'failure')) evidence = 'observed-failure';
    else if (observed && matching.length > 0 && missingOwners.length === 0
      && matching.every((check) => check.status === 'ran' && check.result === 'success')) evidence = 'observed-success';
    return { id: item.id, local: { declaredScope: item.local.scope, evidence,
      checks: matching.map((check) => check.id), missingOwners },
      hosted: { reference: item.hosted, status: 'unverified' } };
  });
  report.unmappedChecks = checks.filter((check) => !mapped.has(check.id)).map((check) => check.id);
  return report;
}

export function validatePreflightConfiguration(data) {
  const invalid = () => { throw new Error('Invalid CI Local Guard project descriptor'); };
  if (!data || data.schemaVersion !== 'ci-local-guard/project/v1'
    || Object.keys(data).some((key) => !['schemaVersion', 'preflight', 'protection', 'plan', 'pushPolicy'].includes(key))
    || !data.preflight || Object.keys(data.preflight).some((key) => !['entrypoint', 'dependencies', 'receipt'].includes(key))) invalid();
  const { entrypoint, dependencies, receipt } = data.preflight;
  if (typeof entrypoint !== 'string' || entrypoint.length > 512
    || !/^[\w./-]+\.(?:mjs|cjs|js)$/.test(entrypoint)
    || entrypoint.startsWith('/') || entrypoint.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))
    || dependencies !== 'none' || !['none', 'guard-v1'].includes(receipt)) invalid();
  let plan;
  if (Object.hasOwn(data, 'plan')) {
    if (!data.plan || Array.isArray(data.plan) || Object.keys(data.plan).some((key) => !['entrypoint', 'dependencies'].includes(key))) invalid();
    const checked = validatePreflightConfiguration({ schemaVersion: data.schemaVersion,
      preflight: { ...data.plan, receipt: 'none' } });
    plan = { entrypoint: checked.entrypoint, dependencies: checked.dependencies };
  }
  return { entrypoint, dependencies, receipt, source: 'committed-descriptor', ...(plan ? { plan } : {}),
    ...(Object.hasOwn(data, 'pushPolicy') ? { pushPolicy: validatePushPolicy(data.pushPolicy) } : {}),
    ...(Object.hasOwn(data, 'protection') ? { protection: validateProtectionManifest(data.protection) } : {}) };
}

export function validatePushPolicy(data) {
  const invalid = () => { throw new Error('Invalid project-declared local push policy'); };
  const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
  if (!data || Array.isArray(data) || Object.keys(data).some(key => !['schemaVersion', 'scope', 'targetRefs', 'bindings'].includes(key))
    || data.schemaVersion !== 'ci-local-guard/local-push-policy/v1' || data.scope !== 'project-declared-local-gates'
    || !Array.isArray(data.targetRefs) || !data.targetRefs.length || data.targetRefs.length > 32
    || new Set(data.targetRefs).size !== data.targetRefs.length
    || !Array.isArray(data.bindings) || !data.bindings.length || data.bindings.length > 512) invalid();
  for (const ref of data.targetRefs) {
    if (!text(ref)) invalid();
    try { planEventContext('push', { ref }); } catch { invalid(); }
  }
  const pairs = new Set();
  const bindings = data.bindings.map(binding => {
    if (!binding || Array.isArray(binding) || Object.keys(binding).some(key => !['job', 'owner', 'checkIds'].includes(key))
      || !text(binding.job) || !/^[a-zA-Z0-9_.-]+$/.test(binding.job) || !text(binding.owner)
      || !Array.isArray(binding.checkIds) || !binding.checkIds.length || binding.checkIds.length > 64
      || !binding.checkIds.every(text) || new Set(binding.checkIds).size !== binding.checkIds.length) invalid();
    const pair = JSON.stringify([binding.job, binding.owner]);
    if (pairs.has(pair)) invalid();
    pairs.add(pair);
    return { job: binding.job, owner: binding.owner, checkIds: [...binding.checkIds] };
  });
  return { schemaVersion: data.schemaVersion, scope: data.scope, targetRefs: [...data.targetRefs], bindings };
}

export function assessLocalPushPolicy(policy, plan, product, identity, targetRef) {
  const contract = validatePushPolicy(policy);
  const report = { schemaVersion: 'ci-local-guard/local-push-report/v1', status: 'blocked', targetRef,
    completenessVerified: false, hostedPolicyStatus: 'unverified', blockers: [], bindings: [],
    limitation: 'Committed project-declared local policy only; assertion sufficiency, undeclared workflows, PR/merge protection and hosted required checks remain unverified.' };
  if (!contract.targetRefs.includes(targetRef)) report.blockers.push('target ref is outside declared policy');
  if (identity.event !== 'push' || identity.mode !== 'committed' || plan.eventContext?.ref !== targetRef) report.blockers.push('actual push context does not match plan');
  const obligations = assessPlanObligations(plan, product, identity);
  if (product?.result !== 'success') report.blockers.push('product command did not succeed');
  if (obligations.status !== 'no-declared-missing') report.blockers.push(`plan owner evidence is ${obligations.status}`);
  if (!plan.jobs.some(job => job.selected)) report.blockers.push('no selected gated jobs; review applicability instead of inferring a safe skip');
  const pairs = new Map(contract.bindings.map(binding => [JSON.stringify([binding.job, binding.owner]), binding]));
  const modelPairs = new Set();
  const checks = product?.projectReceipt?.status === 'validated' ? product.projectReceipt.receipt.checks : [];
  for (const job of plan.jobs) for (const owner of job.owners) {
    const pair = JSON.stringify([job.id, owner]);
    modelPairs.add(pair);
    const binding = pairs.get(pair);
    if (!binding) { report.blockers.push(`missing policy binding for ${job.id}/${owner}`); continue; }
    if (!job.selected) continue;
    const missing = binding.checkIds.filter(id => !checks.some(check => check.id === id && check.owner === owner
      && check.status === 'ran' && check.result === 'success'));
    report.bindings.push({ job: job.id, owner, checkIds: binding.checkIds, missingCheckIds: missing });
    if (missing.length) report.blockers.push(`required check IDs unresolved for ${job.id}/${owner}`);
  }
  if ([...pairs.keys()].some(pair => !modelPairs.has(pair))) report.blockers.push('policy binding is absent from current model');
  if (assessPushObligations(product?.projectReceipt).status === 'unresolved') report.blockers.push('receipt declares unresolved checks');
  if (!report.blockers.length) report.status = 'local-policy-satisfied';
  return report;
}

/** HEAD only: a dirty/untracked descriptor cannot change what a pushed SHA runs. */
export function preflightConfiguration(repo) {
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowMissing: true });
  const committed = head && git(repo, ['ls-tree', 'HEAD', '--', '.ci-local-guard.json']);
  if (!committed) return { entrypoint: null, dependencies: 'none', receipt: 'none', source: 'unconfigured' };
  if (!/^100(?:644|755) blob /.test(committed)) throw new Error('Project descriptor must be a regular committed file');
  const size = Number(git(repo, ['cat-file', '-s', 'HEAD:.ci-local-guard.json']));
  if (!Number.isInteger(size) || size > 64 * 1024) {
    throw new Error('Project descriptor exceeds 64 KiB');
  }
  let data;
  try { data = JSON.parse(git(repo, ['show', 'HEAD:.ci-local-guard.json'])); }
  catch { throw new Error('Project descriptor is not valid JSON'); }
  return validatePreflightConfiguration(data);
}

/** Verify transport identity, not whether the project's assertions are sufficient. */
export function validateProjectReceipt(data, identity, exitCode, schemaVersion = 'ci-local-guard/project-preflight/v1') {
  const text = (value, limit = 4096) => typeof value === 'string' && value.length > 0 && value.length <= limit;
  const invalid = () => { throw new Error('Invalid or inconsistent project preflight receipt'); };
  if (schemaVersion !== 'ci-local-guard/project-preflight/v1'
    || data?.schemaVersion !== schemaVersion || data.identity?.mode !== 'committed'
    || !/^[a-f0-9]{40}$/.test(identity.base || '') || !/^[a-f0-9]{40}$/.test(identity.head || '')
    || ['base', 'head', 'event'].some((key) => data.identity[key] !== identity[key])
    || !Array.isArray(data.checks) || data.checks.length > 512
    || !Array.isArray(data.changedFiles) || data.changedFiles.length > 10000
    || !data.changedFiles.every((file) => text(file) && !file.includes('\0'))
    || !Array.isArray(data.unverified) || data.unverified.length > 100
    || !data.unverified.every((owner) => text(owner, 128))) invalid();
  const ids = new Set();
  const checks = data.checks.map((check) => {
    if (!text(check?.id, 512) || ids.has(check.id) || !text(check.owner, 512)
      || typeof check.why !== 'string' || check.why.length > 4096
      || !['ran', 'unavailable', 'external-owner'].includes(check.status)) invalid();
    ids.add(check.id);
    if (check.status === 'ran') {
      if (!['success', 'failure'].includes(check.result) || !Number.isFinite(check.durationMs)
        || check.durationMs < 0 || !/^[\w.-]+\.log$/.test(check.log || '') || check.blockedBy !== null) invalid();
    } else if (check.result !== null || check.durationMs !== null || check.log !== null
      || (check.blockedBy !== null && !text(check.blockedBy, 512))
      || (check.status === 'unavailable' && !check.blockedBy)) invalid();
    return { id: check.id, owner: check.owner, why: check.why, status: check.status,
      result: check.result, durationMs: check.durationMs, blockedBy: check.blockedBy, log: check.log };
  });
  const outcome = checks.some((check) => check.result === 'failure') ? 'failed' : 'incomplete';
  if (data.outcome !== outcome || (exitCode === 0 && outcome === 'failed')
    || (Number.isInteger(exitCode) && exitCode > 0 && outcome !== 'failed')) invalid();
  return { schemaVersion: data.schemaVersion, identity: { ...identity, mode: 'committed' },
    changedFiles: [...data.changedFiles], checks, outcome, unverified: [...data.unverified] };
}

// Explicit unresolved owners cannot be converted into permission to push.
// Absence of a receipt is unknown, not proof that all responsibilities ran.
export function assessPushObligations(projectReceipt) {
  const report = { schemaVersion: 'ci-local-guard/push-obligations/v1', status: 'unverified', missing: [],
    completenessVerified: false,
    limitation: 'Receipt-declared unresolved checks only; applicability, assertion sufficiency and undeclared owners are not verified.' };
  if (projectReceipt?.status !== 'validated') return report;
  report.missing = projectReceipt.receipt.checks.filter((check) => check.status !== 'ran')
    .map(({ id, owner, status, why, blockedBy }) => ({ id, owner, status, why, blockedBy }));
  report.status = report.missing.length ? 'unresolved' : 'no-declared-missing';
  return report;
}

// Compare declarations, not assertion equivalence or hosted required-check policy.
export function assessPlanObligations(plan, product, identity) {
  const report = { schemaVersion: 'ci-local-guard/plan-obligations/v1', status: 'unverified',
    completenessVerified: false, owners: [], missing: [], evidenceBlockers: [],
    limitation: 'Exact owner-label comparison only; matching receipt checks do not prove assertion sufficiency, hosted applicability or complete protection.' };
  const sameIdentity = (value) => value && ['base', 'head', 'event', 'mode'].every(key => value[key] === identity[key]);
  if (!sameIdentity(plan?.identity)) {
    report.evidenceBlockers.push('plan-identity-mismatch-or-missing');
    return report;
  }
  const selected = new Map();
  for (const job of plan.jobs.filter(job => job.selected)) {
    for (const owner of job.owners) {
      if (!selected.has(owner)) selected.set(owner, []);
      selected.get(owner).push(job.id);
    }
  }
  const receipt = product?.projectReceipt;
  const usable = product?.status === 'ran' && product.checkoutObservation?.status === 'matched'
    && receipt?.status === 'validated' && sameIdentity(receipt.receipt.identity);
  if (product?.status !== 'ran') report.evidenceBlockers.push('fresh-product-execution-missing');
  if (product?.checkoutObservation?.status !== 'matched') report.evidenceBlockers.push('exact-checkout-match-missing');
  if (receipt?.status !== 'validated') report.evidenceBlockers.push('validated-project-receipt-missing');
  else if (!sameIdentity(receipt.receipt.identity)) report.evidenceBlockers.push('receipt-identity-mismatch-or-missing');
  report.owners = [...selected].map(([owner, jobs]) => {
    const checks = usable ? receipt.receipt.checks.filter(check => check.owner === owner) : [];
    const evidenceBlockers = !usable ? [...report.evidenceBlockers] : !checks.length ? ['owner-check-missing'] : [
      ...(checks.some(check => check.status === 'external-owner') ? ['external-owner-evidence-not-accepted'] : []),
      ...(checks.some(check => check.status === 'unavailable') ? ['owner-check-unavailable'] : []),
      ...(checks.some(check => check.status === 'ran' && check.result !== 'success') ? ['owner-check-not-successful'] : []),
    ];
    return { owner, jobs, checkIds: checks.map(check => check.id),
      evidenceBlockers,
      status: !usable ? 'unverified' : !checks.length ? 'missing'
        : checks.every(check => check.status === 'ran' && check.result === 'success') ? 'declared-success' : 'unresolved' };
  });
  report.missing = report.owners.filter(owner => owner.status !== 'declared-success').map(owner => owner.owner);
  report.status = !usable ? 'unverified' : plan.needsReview ? 'needs-review'
    : report.missing.length ? 'unresolved' : 'no-declared-missing';
  return report;
}

export function readProjectReceipt(repo, identity, exitCode, schemaVersion) {
  let directory = repo;
  for (const part of ['tmp', 'preflight']) {
    directory = path.join(directory, part);
    let info;
    try { info = lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return { status: 'unavailable' }; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe project receipt directory');
  }
  const file = path.join(directory, 'project-report.json');
  let info;
  try { info = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'unavailable' }; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Unsafe or oversized project receipt');
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Invalid project receipt JSON'); }
  const receipt = validateProjectReceipt(data, identity, exitCode, schemaVersion);
  const changed = git(repo, ['diff', '--name-only', '--diff-filter=ACDMRT', identity.base, identity.head])
    .split(/\r?\n/).filter(Boolean).sort();
  if (JSON.stringify(changed) !== JSON.stringify([...receipt.changedFiles].sort())) {
    throw new Error('Project receipt scope does not match exact Git diff');
  }
  for (const check of receipt.checks.filter((check) => check.status === 'ran')) {
    const log = lstatSync(path.join(directory, check.log));
    if (!log.isFile() || log.isSymbolicLink()) throw new Error('Unsafe or missing project receipt check log');
  }
  return { status: 'validated', receipt };
}

export const MAX_PUSH_INPUT_BYTES = 1024 * 1024;

export function parsePushUpdates(input = '') {
  if (typeof input !== 'string') throw Object.assign(new Error('Invalid Git pre-push input type'), { pushCode: 'invalid-push-input' });
  if (Buffer.byteLength(input) > MAX_PUSH_INPUT_BYTES) throw Object.assign(new Error('Git pre-push input exceeds 1 MiB'), { pushCode: 'push-input-too-large' });
  const lines = input.split(/\r?\n/).filter(Boolean);
  if (lines.length > 128) throw Object.assign(new Error('At most 128 push updates may be evaluated'), { pushCode: 'too-many-updates' });
  return lines.map((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !SHA.test(fields[1]) || !SHA.test(fields[3])) {
      throw Object.assign(new Error('Invalid Git pre-push update record'), { pushCode: 'invalid-push-input' });
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

export function planEventContext(event, { ref = null, baseRef = null, headRef = null, prAction = null, prFork = null } = {}) {
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(event)) throw new Error('Unsupported plan event context');
  const valid = (value) => value === null || (typeof value === 'string' && value.length <= 512
    && /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith('-')
    && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
    && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')));
  if (![ref, baseRef, headRef].every(valid) || (ref !== null && !ref.startsWith('refs/heads/'))
    || (event !== 'pull_request' && (baseRef !== null || headRef !== null))
    || (event === 'pull_request' && ref !== null)) throw new Error('Invalid plan event ref context');
  if ((prAction !== null && (typeof prAction !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(prAction)))
    || (prFork !== null && typeof prFork !== 'boolean')
    || (event !== 'pull_request' && (prAction !== null || prFork !== null))) throw new Error('Invalid PR action/fork context');
  // Omit unset additive fields so existing adapters retain their default shape.
  // Unknown bounded action names are transported, not assumed eligible.
  return { event, ref, baseRef, headRef, ...(prAction !== null ? { prAction } : {}), ...(prFork !== null ? { prFork } : {}) };
}

export function validateProjectPlan(data, identity, changedFiles, eventContext = planEventContext(identity?.event)) {
  const invalid = () => { throw new Error('Invalid or inconsistent project CI plan'); };
  const text = (s) => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\0\r\n]/.test(s);
  if (!SHA.test(identity?.base || '') || !SHA.test(identity?.head || '') || identity.mode !== 'committed'
    || !['pull_request', 'push', 'workflow_dispatch'].includes(identity.event)
    || !data || data.schemaVersion !== 'ci-local-guard/project-plan/v1'
    || Object.keys(data).some((key) => !['schemaVersion', 'identity', 'changedFiles', 'jobs', 'needsReview', 'eventContext'].includes(key))
    || !data.identity || Object.keys(data.identity).some((key) => !['base', 'head', 'event', 'mode'].includes(key))
    || ['base', 'head', 'event', 'mode'].some((key) => data.identity[key] !== identity[key])
    || !Array.isArray(data.changedFiles) || data.changedFiles.length > 10000
    || !data.changedFiles.every((s) => typeof s === 'string' && s.length > 0 && s.length <= 4096 && !s.includes('\0'))
    || new Set(data.changedFiles).size !== data.changedFiles.length
    || JSON.stringify([...data.changedFiles].sort()) !== JSON.stringify([...changedFiles].sort())
    || typeof data.needsReview !== 'boolean' || !Array.isArray(data.jobs) || data.jobs.length < 1 || data.jobs.length > 128) invalid();
  const expectedContext = planEventContext(identity.event, eventContext);
  if (data.eventContext !== undefined) {
    if (!data.eventContext || Object.keys(data.eventContext).some((key) => !['event', 'ref', 'baseRef', 'headRef', 'prAction', 'prFork'].includes(key))
      || Object.keys(expectedContext).some((key) => data.eventContext[key] !== expectedContext[key])
      || ['prAction', 'prFork'].some(key => (data.eventContext[key] ?? null) !== (expectedContext[key] ?? null))) invalid();
  } else if ([expectedContext.ref, expectedContext.baseRef, expectedContext.headRef, expectedContext.prAction ?? null, expectedContext.prFork ?? null].some((value) => value !== null)) invalid();
  const ids = new Set();
  const jobs = data.jobs.map((job) => {
    if (!job || Object.keys(job).some((key) => !['id', 'selected', 'reason', 'owners'].includes(key))
      || !text(job.id) || !/^[a-zA-Z0-9_.-]+$/.test(job.id) || ids.has(job.id)
      || typeof job.selected !== 'boolean' || !text(job.reason)
      || !Array.isArray(job.owners) || job.owners.length < 1 || job.owners.length > 64
      || !job.owners.every(text) || new Set(job.owners).size !== job.owners.length) invalid();
    ids.add(job.id);
    return { id: job.id, selected: job.selected, reason: job.reason, owners: [...job.owners] };
  });
  return { schemaVersion: data.schemaVersion, identity: { ...identity }, eventName: identity.event,
    changedFiles: [...data.changedFiles], eventContext: expectedContext, jobs, needsReview: data.needsReview };
}

export function simulator(repo, { base, head, event = 'pull_request', worktree = false, eventContext } = {}) {
  const config = preflightConfiguration(repo);
  if (config.source !== 'committed-descriptor' || !config.plan || worktree) throw new Error('Configured generic plan requires a committed plan adapter and explicit --head; working-tree mode is not supported');
  const entrypoint = projectPreflight(repo, { ...config, entrypoint: config.plan.entrypoint });
  const args = [entrypoint, '--base', base, '--event', event,
    ...(worktree ? ['--worktree'] : ['--head', head]), '--json'];
  const context = planEventContext(event, eventContext);
  const result = spawnSync(process.execPath, args, {
    cwd: repo, encoding: 'utf8', windowsHide: true,
    env: { ...cleanGitEnvironment(), CI_LOCAL_GUARD_EVENT_CONTEXT: JSON.stringify(context) },
    timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (![0, 2].includes(result.status)) {
    // Plan output is not retained evidence; never copy it into agent diagnostics.
    throw new Error(`Project CI simulator failed (${result.status}); adapter output suppressed. Inspect the project-owned plan adapter locally.`);
  }
  let plan;
  try {
    plan = JSON.parse(result.stdout);
  } catch {
    throw new Error('Project CI simulator did not return valid JSON');
  }
  plan = validateProjectPlan(plan, { base, head, event, mode: 'committed' },
    git(repo, ['diff', '--name-only', '--diff-filter=ACDMRT', base, head]).split(/\r?\n/).filter(Boolean), context);
  if (!Array.isArray(plan.jobs) || typeof plan.needsReview !== 'boolean') {
    throw new Error('Project CI simulator returned an incompatible plan schema');
  }
  if ((result.status === 2) !== plan.needsReview) {
    throw new Error('Project CI simulator exit status disagrees with review flag');
  }
  return plan;
}

export function formatPlan(plan) {
  const selected = plan.jobs.filter((job) => job.selected).map((job) => job.id);
  const seconds = plan.estimate?.consumptionSeconds;
  const estimate = Number.isFinite(seconds) ? `; indicative runner time ${Math.ceil(seconds / 60)} min` : '';
  return `jobs: ${selected.join(', ') || '(none)'}${estimate}; review: ${plan.needsReview ? 'REQUIRED' : 'no'}`;
}
