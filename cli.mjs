#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { ACTIONLINT_VERSION, ensureActionlint } from './src/actionlint.mjs';
import { observeCheckout, withExactCheckout } from './src/checkout.mjs';
import { runLogged } from './src/run-log.mjs';
import { auditRuns, collectRun, collectRuns, compareRuns, inspectRuns } from './src/ci-runs.mjs';
import { assessLocalPushPolicy, assessPlanObligations, assessProtection, assessPushObligations, cleanGitEnvironment, formatPlan, git, MAX_PUSH_INPUT_BYTES, parsePushUpdates, planEventContext, preflightConfiguration, projectPreflight, simulator, ZERO_SHA } from './src/project.mjs';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_PATH = path.join(toolRoot, 'hooks').replaceAll('\\', '/');
const jsonRequested = ['preflight', 'plan', 'pre-push'].includes(process.argv[2]) && process.argv.slice(3).includes('--json');
const diagnostic = (text) => (jsonRequested ? process.stderr : process.stdout).write(text);
let preflightReport;
let planReport;
let pushReport;
let activePushUpdate;
let preflightTiming;
let preflightStarted;

async function timedPhase(name, action) {
  if (!preflightTiming) return action();
  const started = performance.now();
  let status = 'failed';
  try {
    const result = await action();
    status = 'completed';
    return result;
  } finally {
    preflightTiming.phases[name] = { status, durationMs: Math.floor(performance.now() - started) };
  }
}

function finishTiming() {
  if (!preflightTiming) return null;
  preflightTiming.totalMs = Math.floor(performance.now() - preflightStarted);
  const measured = Object.values(preflightTiming.phases).reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0);
  preflightTiming.unattributedMs = preflightTiming.totalMs - measured;
  return preflightTiming;
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--repo', '--base', '--head', '--event', '--worktree', '--json', '--ref', '--base-ref', '--head-ref', '--with-plan', '--pr-action', '--pr-fork'].includes(key)) throw new Error(`Unknown option: ${key}`);
    if (['--worktree', '--json', '--with-plan'].includes(key)) {
      result[key.slice(2)] = true;
    } else {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      result[key.slice(2)] = args[++index];
    }
  }
  return result;
}

function explicitBase(opts) {
  const base = opts.base || process.env.CI_LOCAL_GUARD_BASE;
  if (!base) throw new Error('Use explicit --base <ref> or CI_LOCAL_GUARD_BASE; this tool does not guess a target branch');
  return base;
}

function requestedPlanContext(event, opts) {
  const fork = opts['pr-fork'];
  if (fork !== undefined && !['true', 'false'].includes(fork)) throw new Error('--pr-fork requires true or false');
  return planEventContext(event, { ref: opts.ref ?? null, baseRef: opts['base-ref'] ?? null, headRef: opts['head-ref'] ?? null,
    prAction: opts['pr-action'] ?? null, prFork: fork === undefined ? null : fork === 'true' });
}

async function run(command, args, repo, env = process.env, logRepo = repo, stage = 'check', receiptOptions = {}) {
  const result = await runLogged(command, args, repo, { env, logRepo, stage,
    collectDirectory: stage === 'preflight' ? 'tmp/preflight' : undefined,
    receiptIdentity: receiptOptions.identity, receiptSchema: receiptOptions.schemaVersion, requireReceipt: receiptOptions.required,
    validateAfter: receiptOptions.validateAfter });
  diagnostic(`[ci-local-guard] ${stage} completed in ${result.durationMs} ms${result.logFile ? `; log: ${result.logFile}` : ''}.\n`);
  return result;
}

async function actionlintBinary() {
  const binary = await ensureActionlint();
  const version = execFileSync(binary, ['-version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (version.split(/\s+/)[0] !== ACTIONLINT_VERSION) {
    throw new Error(`actionlint ${ACTIONLINT_VERSION} required; found ${version}`);
  }
  return binary;
}

function installHook(repo) {
  for (const name of ['pre-push', 'pre-commit']) {
    const hook = path.join(toolRoot, 'hooks', name);
    // An executable shared/read-only installation needs no permission mutation.
    if ((statSync(hook).mode & 0o111) !== 0o111) chmodSync(hook, 0o755);
  }
  const current = git(repo, ['config', '--local', '--get', 'core.hooksPath'], { allowMissing: true });
  if (current === HOOKS_PATH) {
    diagnostic(`[ci-local-guard] Hook already active: ${HOOKS_PATH}\n`);
    return;
  }
  if (current && current !== '.githooks') {
    throw new Error(`Existing custom hook path ${current}; refusing to replace it automatically`);
  }
  if (current === '.githooks' && existsSync(path.resolve(repo, current))) {
    throw new Error('Existing .githooks directory is active; refusing to replace it automatically');
  }
  git(repo, ['config', '--local', 'ci-local-guard.previousHooksPath', current || '<default>']);
  git(repo, ['config', '--local', 'core.hooksPath', HOOKS_PATH]);
  diagnostic(`[ci-local-guard] Installed local pre-push hook outside the project repository. Previous path: ${current || '(default)'}\n`);
}

function uninstallHook(repo) {
  const current = git(repo, ['config', '--local', '--get', 'core.hooksPath'], { allowMissing: true });
  if (current !== HOOKS_PATH) throw new Error('This tool does not own the current Git hooks path; refusing to change it');
  const previous = git(repo, ['config', '--local', '--get', 'ci-local-guard.previousHooksPath'], { allowMissing: true });
  if (!previous) throw new Error('Previous Git hooks path is unknown; refusing to guess');
  if (previous === '<default>') git(repo, ['config', '--local', '--unset', 'core.hooksPath']);
  else git(repo, ['config', '--local', 'core.hooksPath', previous]);
  git(repo, ['config', '--local', '--unset', 'ci-local-guard.previousHooksPath']);
  diagnostic(`[ci-local-guard] Restored previous local Git hooks path: ${previous}\n`);
}

// The project's own product checks (types, tests, generated bundles...) for the
// exact pushed commit; local evidence does not guarantee hosted CI success.
async function runProjectPreflight(exactRepo, decision, logRepo = exactRepo) {
  const event = decision.event || 'pull_request';
  const env = { ...process.env, CI_LOCAL_GUARD_EVENT: event };
  const { config, preflight } = await timedPhase('projectPreparation', () => {
    const config = preflightConfiguration(exactRepo);
    const preflight = projectPreflight(exactRepo, config);
    return { config, preflight };
  });
  if (!preflight) {
    diagnostic('[ci-local-guard] Product preflight unavailable: this commit provides no project preflight; product checks were not executed.\n');
    return { status: 'unavailable', projectReceipt: { status: 'unavailable' }, protection: assessProtection(config.protection) };
  }
  diagnostic(`[ci-local-guard] Running project preflight for ${decision.head.slice(0, 8)}\n`);
  let execution;
  const checkoutObservation = { schemaVersion: 'ci-local-guard/local-checkout-observation/v1',
    status: 'unavailable', observedBy: 'guard-git', before: null, after: null,
    limitation: 'Local before/after tracked Git state only; transient mutations, untracked/ignored files, dependencies and hosted provenance are not attested.' };
  try {
    await timedPhase('product', async () => {
      checkoutObservation.before = observeCheckout(exactRepo);
      checkoutObservation.status = 'observed-before';
      if (checkoutObservation.before.head !== decision.head || checkoutObservation.before.trackedDirty) {
        checkoutObservation.status = 'drifted';
        throw new Error('Product checkout does not match the clean requested commit; check stopped, not PASS');
      }
      execution = await run(process.execPath, [preflight, '--base', decision.base, '--head', decision.head, '--event', event],
        exactRepo, env, logRepo, 'preflight', {
          identity: config.receipt !== 'none' ? { base: decision.base, head: decision.head, event } : undefined,
          schemaVersion: 'ci-local-guard/project-preflight/v1',
          required: config.source === 'committed-descriptor' && config.receipt !== 'none',
          validateAfter: () => {
            checkoutObservation.after = observeCheckout(exactRepo);
            const after = checkoutObservation.after;
            checkoutObservation.status = after.head === decision.head && after.tree === checkoutObservation.before.tree && !after.trackedDirty
              ? 'matched' : 'drifted';
            if (checkoutObservation.status !== 'matched') throw new Error('Product checkout changed during checks; check stopped, not PASS');
          },
        });
    });
  } catch (error) {
    error.checkoutObservation = checkoutObservation;
    error.protection = assessProtection(config.protection, error.projectReceipt, checkoutObservation);
    throw error;
  }
  const pushObligations = assessPushObligations(execution.projectReceipt);
  if (pushObligations.status === 'unresolved') diagnostic('[ci-local-guard] Explicit check owners remain unresolved; success is selective, not permission to push.\n');
  diagnostic(`[ci-local-guard] Product preflight ran: PASS for ${decision.head.slice(0, 8)} against ${decision.base.slice(0, 8)}.\n`);
  return { status: 'ran', result: 'success', adapter: config.source, entrypoint: config.entrypoint, ...execution, checkoutObservation, pushObligations,
    protection: assessProtection(config.protection, execution.projectReceipt, checkoutObservation) };
}

async function selectCommittedPlan(exactRepo, { base, head, event, eventContext }) {
  const config = preflightConfiguration(exactRepo);
  if (config.source !== 'committed-descriptor' || !config.plan) throw new Error('Committed generic project plan adapter required');
  const before = observeCheckout(exactRepo);
  if (before.head !== head || before.trackedDirty) throw new Error('Plan checkout does not match requested commit');
  const selected = simulator(exactRepo, { base, head, event, eventContext });
  const after = observeCheckout(exactRepo);
  if (after.head !== before.head || after.tree !== before.tree || after.trackedDirty) throw new Error('Plan checkout changed during prediction; result rejected');
  return selected;
}

// Product checks, optionally compared to a project-owned committed plan.
async function preflightHead(repo, baseRef, headRef = 'HEAD', event = 'pull_request', opts = {}) {
  const { base, head } = await timedPhase('identity', () => ({
    base: git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`]),
    head: git(repo, ['rev-parse', '--verify', `${headRef}^{commit}`]),
  }));
  preflightReport = {
    schemaVersion: 'ci-local-guard/preflight-report/v1',
    identity: { repo, base, head, mode: 'committed', event },
    outcome: 'incomplete',
    product: { status: 'unavailable', result: null },
    unverified: ['simulator-review', 'ci-policy', 'browser', 'database', 'hosted'],
    nextAction: 'Review project check coverage and run the missing applicable gates; this command is not a complete CI verdict.',
  };
  const result = await withExactCheckout(repo, head, async (exactRepo) => {
    let plan;
    if (opts['with-plan']) {
      const eventContext = requestedPlanContext(event, opts);
      preflightReport.eventContext = { ...eventContext, source: 'caller-declared', verified: false };
      plan = await timedPhase('planSelection', () => selectCommittedPlan(exactRepo, { base, head, event, eventContext }));
      preflightReport.prediction = plan;
    }
    const product = await runProjectPreflight(exactRepo, { base, head, event }, repo);
    if (plan) preflightReport.planObligations = assessPlanObligations(plan, product, preflightReport.identity);
    return product;
  },
    { timings: preflightTiming?.phases });
  preflightReport.product = { result: null, ...result };
  preflightReport.timing = finishTiming();
  if (result.status === 'unavailable') {
    process.exitCode = 2;
    preflightReport.nextAction = `No checks ran. Read ${path.join(toolRoot, 'README.md')} — AI 操作入口 / 專案契約. Review this project's existing CI/scripts and commit an explicit .ci-local-guard.json in the candidate before retrying; do not borrow another checkout's rules or weaken protection.`;
  }
  if (preflightReport.planObligations && preflightReport.planObligations.status !== 'no-declared-missing') {
    process.exitCode = 2;
    if (preflightReport.planObligations.status === 'needs-review') preflightReport.outcome = 'needs-review';
  }
  diagnostic('[ci-local-guard] Standalone preflight does not verify simulator review or the CI-policy gate.\n');
  if (jsonRequested) process.stdout.write(`${JSON.stringify(preflightReport)}\n`);
}

function preCommit(repo) {
  // Fast checks on what is being committed; the full preflight runs at push.
  const whitespace = spawnSync('git', ['-C', repo, 'diff', '--cached', '--check'], {
    encoding: 'utf8', windowsHide: true, env: cleanGitEnvironment(),
  });
  if (whitespace.status !== 0) {
    diagnostic(whitespace.stdout);
    throw new Error('Staged changes have whitespace errors (trailing spaces, blank lines at EOF, conflict markers); commit stopped');
  }

}

async function planHead(repo, opts) {
  if (!opts.head || opts.worktree) throw new Error('Committed project plan adapter and explicit --head required; working-tree mode is not supported');
  const base = git(repo, ['rev-parse', '--verify', `${explicitBase(opts)}^{commit}`]);
  const head = git(repo, ['rev-parse', '--verify', `${opts.head || 'HEAD'}^{commit}`]);
  const event = opts.event || 'pull_request';
  const eventContext = requestedPlanContext(event, opts);
  planReport = { schemaVersion: 'ci-local-guard/plan-report/v1',
    identity: { base, head, event, mode: 'committed' },
    eventContext: { ...eventContext, source: 'caller-declared', verified: false },
    outcome: 'failed', checksExecuted: false, completenessVerified: false,
    changedFiles: [], prediction: null,
    unverified: ['full-protection-coverage', 'source-equivalence-to-hosted', 'manual-and-scheduled-workflows', 'hosted-policy', 'execution'],
    nextAction: 'Review applicable owners and missing evidence; a prediction does not authorize push or deployment.' };
  const evaluate = async (exactRepo) => {
    const config = preflightConfiguration(exactRepo);
    if (config.source !== 'committed-descriptor' || !config.plan) throw new Error('Committed project plan adapter and explicit --head required');
    const before = observeCheckout(exactRepo);
    planReport.policy = { source: 'exact-checkout', head: before.head, tree: before.tree,
      trackedDirty: before.trackedDirty, observation: 'before-only',
      limitation: 'Sampled tracked state only; untracked inputs, dependencies, transient changes and hosted provenance are not attested.' };
    if (before.head !== head || before.trackedDirty) throw new Error('Plan policy checkout does not match the clean requested commit');
    const changed = git(exactRepo, ['diff', '--name-only', '--diff-filter=ACDMRT', base, head]);
    planReport.changedFiles = changed.split(/\r?\n/).filter(Boolean);
    if (!changed.trim()) {
      planReport.outcome = 'no-changes';
      diagnostic('[ci-local-guard] No changed files in this comparison; no CI allocation to predict.\n');
    } else {
      const plan = simulator(exactRepo, { base, head, event, eventContext });
      planReport.prediction = plan;
      planReport.protection = assessProtection(config.protection);
      planReport.outcome = plan.needsReview ? 'needs-review' : 'predicted';
      diagnostic(`[ci-local-guard] ${formatPlan(plan)}\n`);
      for (const job of plan.jobs) diagnostic(`  ${job.selected ? 'RUN ' : 'SKIP'} ${job.id}: ${job.reason}\n`);
    }
    const after = observeCheckout(exactRepo);
    if (after.head !== before.head || after.tree !== before.tree || after.trackedDirty !== before.trackedDirty) {
      planReport.policy.observation = 'drifted';
      throw new Error('Plan policy checkout changed during prediction; result rejected');
    }
    planReport.policy.observation = 'matched';
  };
  await withExactCheckout(repo, head, evaluate);
  if (planReport.outcome === 'needs-review') process.exitCode = 2;
  if (jsonRequested) process.stdout.write(`${JSON.stringify(planReport)}\n`);
}

async function prePush(repo) {
  pushReport.repo = repo;
  const config = preflightConfiguration(repo);
  pushReport.adapter = config.source;
  if (config.source !== 'committed-descriptor' || !config.pushPolicy) throw Object.assign(new Error('Configured standalone preflight does not provide a push-policy contract; generic pre-push is not supported without explicit committed policy'), { pushCode: 'unconfigured-policy' });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_PUSH_INPUT_BYTES) throw Object.assign(new Error('Git pre-push input exceeds 1 MiB'), { pushCode: 'push-input-too-large' });
    chunks.push(chunk);
  }
  const updates = parsePushUpdates(Buffer.concat(chunks, bytes).toString('utf8'));
  pushReport.updates = updates.map(update => ({ ...update, status: 'not-run', identity: null, prediction: null, product: null, policy: null }));
  if (config.source === 'committed-descriptor') {
    for (const update of pushReport.updates) {
      activePushUpdate = update;
      update.status = 'checking';
      if (update.localSha === ZERO_SHA) { update.status = 'ignored-deletion'; continue; }
      if (update.remoteSha === ZERO_SHA) throw Object.assign(new Error('Cannot prove previous commit for generic local push policy; new remote refs require review'), { pushCode: 'new-remote-ref' });
      const base = git(repo, ['rev-parse', '--verify', `${update.remoteSha}^{commit}`]);
      const head = git(repo, ['rev-parse', '--verify', `${update.localSha}^{commit}`]);
      update.identity = { base, head, event: 'push', mode: 'committed' };
      await withExactCheckout(repo, head, async exactRepo => {
        const pushed = preflightConfiguration(exactRepo);
        if (!pushed.pushPolicy || !pushed.plan || pushed.receipt === 'none') throw Object.assign(new Error('Pushed commit requires explicit local push policy, plan and validated receipt contract'), { pushCode: 'missing-contract' });
        if (!pushed.pushPolicy.targetRefs.includes(update.remoteRef)) throw Object.assign(new Error('Push target is outside declared local policy; review required'), { pushCode: 'target-outside-policy' });
        const identity = { base, head, event: 'push', mode: 'committed' };
        const plan = await selectCommittedPlan(exactRepo, { ...identity, eventContext: planEventContext('push', { ref: update.remoteRef }) });
        update.prediction = { needsReview: plan.needsReview, jobs: plan.jobs, eventContext: plan.eventContext };
        if (plan.needsReview) throw Object.assign(new Error('CI scope requires manual review; push stopped'), { pushCode: 'plan-review' });
        const product = await runProjectPreflight(exactRepo, identity, repo);
        update.product = product;
        const report = assessLocalPushPolicy(pushed.pushPolicy, plan, product, identity, update.remoteRef);
        update.policy = report;
        diagnostic(`[ci-local-guard] Local push policy: ${JSON.stringify(report)}\n`);
        if (report.status !== 'local-policy-satisfied') throw Object.assign(new Error('Project-declared local gates unresolved; push stopped'), { pushCode: 'unresolved-local-gates' });
        diagnostic('[ci-local-guard] Declared local gates satisfied only; Hosted/PR/merge protection and assertion completeness remain unverified.\n');
      });
      update.status = 'local-policy-satisfied';
    }
    pushReport.outcome = pushReport.updates.some(update => update.status === 'local-policy-satisfied') ? 'local-policy-satisfied' : 'no-gates-executed';
    activePushUpdate = null;
    return;
  }

}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === 'pre-push') pushReport = { schemaVersion: 'ci-local-guard/push-report/v1', repo: null, adapter: null,
    outcome: 'blocked', completenessVerified: false, hostedPolicyStatus: 'unverified', updates: [], failure: null,
    inputSource: 'git-pre-push-stdin-format', hostedProvenanceVerified: false,
    nextAction: 'Review missing or unverified protection; a satisfied local gate is not a complete CI verdict or deployment authorization.' };
  if (verb === 'preflight') {
    preflightStarted = performance.now();
    preflightTiming = { schemaVersion: 'ci-local-guard/preflight-timing/v1', clock: 'monotonic',
      scope: 'command-handler-before-report-output', totalMs: null, unattributedMs: null,
      phases: Object.fromEntries(['repository', 'identity', 'checkout', 'projectPreparation', 'dependencies', 'product', 'cleanup']
        .map((phase) => [phase, { status: 'not-run', durationMs: null }])),
      limitation: 'Excludes Node/module startup and final report output; wall time only, not CPU, billing, cold-install or optimization savings evidence.' };
  }
  if ((!verb || ['--help', 'help'].includes(verb)) && rest.length === 0) {
    process.stdout.write(`CI Local Guard — local preflight and evidence-linked CI diagnostics (private candidate)

Offline (Node 22.13..22.x only; no Git or credentials):
  inspect-runs --input <github-export.json>
  audit-runs --input <github-export.json>
  compare-runs --input <comparison-envelope.json>

Read-only GitHub collection (requires gh and Actions read access):
  collect-runs --repository owner/name --workflow ci.yml [--limit 1..25] [--attempts latest|history]
  collect-run --repository owner/name --run-id <id> --attempt <n> --workflow-id <id> --head <exact SHA>

Local repository commands (require Git; trust project code before execution):
  preflight --repo <project> --base <ref> [--head <ref>] [--event pull_request|push|workflow_dispatch] [--json] [--with-plan]
    --with-plan: generic committed adapter; accepts plan ref context; fresh execution and receipt required
  plan --repo <project> --base <ref> --head <ref> [--event pull_request|push|workflow_dispatch] [--json]
    Generic committed plan: [--ref refs/heads/name] or PR [--base-ref name] [--head-ref name] [--pr-action opened] [--pr-fork true|false]
  plan|doctor|pre-commit|pre-push|install-hook|uninstall-hook --repo <project>
  pre-push --repo <project> [--json] < Git-pre-push-update-records

Generic push requires explicit committed local policy, exact plan and fresh receipt; not a Hosted CI verdict.
Exit 0 for offline diagnostics means a report was produced, not CI coverage or savings proved.
AI guide: ${path.join(toolRoot, 'README.md')}
AI/Agent: start at AI 操作入口; use JSON reports, not PASS text or exit zero alone.
See README.md for schemas, side effects and unverified protection boundaries.
`);
    return;
  }
  if (['collect-runs', 'collect-run'].includes(verb)) {
    const exact = verb === 'collect-run';
    const allowed = exact ? ['--repository', '--run-id', '--attempt', '--workflow-id', '--head']
      : ['--repository', '--workflow', '--limit', '--attempts'];
    const values = {};
    for (let index = 0; index < rest.length; index += 2) {
      const key = rest[index];
      if (!allowed.includes(key) || Object.hasOwn(values, key)
        || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('Invalid collector options; see help for required identity fields');
      values[key] = rest[index + 1];
    }
    const integer = key => /^\d+$/.test(values[key] || '') ? Number(values[key]) : NaN;
    const exported = exact ? collectRun({ repository: values['--repository'], runId: integer('--run-id'), attempt: integer('--attempt'),
      workflowId: integer('--workflow-id'), head: values['--head'] }) : collectRuns({ repository: values['--repository'], workflow: values['--workflow'],
      limit: values['--limit'] === undefined ? 10 : Number(values['--limit']), attempts: values['--attempts'] || 'latest' });
    process.stdout.write(JSON.stringify(exported) + '\n');
    return;
  }
  if (['inspect-runs', 'audit-runs', 'compare-runs'].includes(verb)) {
    if (rest.length !== 2 || rest[0] !== '--input') throw new Error('Usage: ' + verb + ' --input <export.json>');
    const input = path.resolve(rest[1]);
    const info = statSync(input);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('Export must be a regular file of at most 10 MiB');
    let data;
    try { data = JSON.parse(readFileSync(input, 'utf8')); }
    catch { throw new Error('Export could not be read as valid JSON'); }
    const report = (verb === 'compare-runs' ? compareRuns : verb === 'audit-runs' ? auditRuns : inspectRuns)(data);
    process.stdout.write(JSON.stringify(report) + '\n');
    return;
  }
  if (!['doctor', 'plan', 'preflight', 'install-hook', 'uninstall-hook', 'pre-push', 'pre-commit'].includes(verb)) {
    throw new Error('Usage: node cli.mjs <doctor|plan|preflight|install-hook|uninstall-hook|pre-push|pre-commit> --repo <project> [--base <ref>]');
  }
  const opts = options(rest);
  if (opts['with-plan'] && verb !== 'preflight') throw new Error('--with-plan supports preflight only');
  if (verb !== 'plan' && !(verb === 'preflight' && opts['with-plan']) && ['ref', 'base-ref', 'head-ref', 'pr-action', 'pr-fork'].some(key => Object.hasOwn(opts, key))) throw new Error('Event ref context options support plan or preflight --with-plan only');
  if (opts.json && !['preflight', 'plan', 'pre-push'].includes(verb)) throw new Error('--json supports preflight, plan and pre-push only');
  if (opts.event && !['pull_request', 'push', 'workflow_dispatch'].includes(opts.event)) throw new Error('Unsupported CI event');
  if (verb === 'preflight' && (opts.worktree)) {
    throw new Error('preflight accepts committed --head only; --worktree and --branch are not supported');
  }
  const repo = ['pre-push', 'pre-commit', 'preflight', 'plan', 'install-hook', 'uninstall-hook'].includes(verb)
    ? await timedPhase('repository', () => git(path.resolve(opts.repo || process.cwd()), ['rev-parse', '--show-toplevel']))
    : git(path.resolve(opts.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
  if (verb === 'doctor') {
    const binary = await actionlintBinary();
    diagnostic(`[ci-local-guard] Ready: ${repo}\n[ci-local-guard] actionlint ${ACTIONLINT_VERSION}: ${binary}\n`);
  } else if (verb === 'plan') {
    await planHead(repo, opts);
  } else if (verb === 'preflight') {
    await preflightHead(repo, explicitBase(opts), opts.head || 'HEAD', opts.event || 'pull_request', opts);
  } else if (verb === 'install-hook') {
    const config = preflightConfiguration(repo);
    if (config.source !== 'committed-descriptor' || !config.pushPolicy || !config.plan || config.receipt === 'none') throw new Error('Hook installation requires explicit committed local push policy, plan and receipt');
    installHook(repo);
  } else if (verb === 'uninstall-hook') {
    uninstallHook(repo);
  } else if (verb === 'pre-push') {
    await prePush(repo);
    if (jsonRequested) process.stdout.write(`${JSON.stringify(pushReport)}\n`);
  } else if (verb === 'pre-commit') {
    preCommit(repo);
  }
}

function failureNextAction(error) {
  const causes = error.executionFailure?.causes || [];
  if (error.checkoutObservation?.status === 'drifted' || causes.includes('post-execution-validation-failed')) return 'Restore and review the execution checkout/validation contract before rerunning; this result cannot establish a reusable PASS.';
  if (causes.includes('receipt-invalid') || causes.includes('receipt-unavailable')) return 'Correct the project receipt identity/schema/exit contract and inspect the retained log; do not treat child exit zero as a successful gate.';
  if (causes.some(code => code.startsWith('log-') || code === 'child-log-collection-failed')) return 'Resolve the bounded log collection/storage failure and inspect retained evidence before rerunning; do not skip required checks or disable evidence protection.';
  if (causes.includes('process-start-failed')) return 'Check the declared executable/runtime and dependencies; the process did not start successfully, so no check PASS is available.';
  if (causes.includes('child-exit-nonzero') || causes.includes('process-terminated')) return 'Inspect executionFailure.failedChecks and the retained log; resolve the failed or interrupted checks before rerunning. Do not retry to green or weaken checks.';
  return 'Inspect stderr and the retained log; correct the failure before retrying.';
}

main().catch((error) => {
  console.error(`[ci-local-guard] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  if (jsonRequested && process.argv[2] === 'pre-push') {
    const failure = { code: error.pushCode || 'execution-failed', logFile: error.logFile || null };
    pushReport.outcome = 'blocked';
    pushReport.failure = failure;
    if (activePushUpdate) {
      activePushUpdate.status = 'blocked';
      activePushUpdate.failure = failure;
      if (error.projectReceipt || error.logFile) activePushUpdate.product = { status: 'failed', result: 'failure',
        logFile: error.logFile || null, durationMs: Number.isFinite(error.durationMs) ? error.durationMs : null,
        projectReceipt: error.projectReceipt || { status: 'unavailable' }, checkoutObservation: error.checkoutObservation || null,
        collectedLogs: error.collectedLogs || null, executionFailure: error.executionFailure || null };
    }
    if (error.executionFailure) pushReport.nextAction = failureNextAction(error);
    process.stdout.write(`${JSON.stringify(pushReport)}\n`);
  } else if (jsonRequested && process.argv[2] === 'plan') {
    const report = planReport || { schemaVersion: 'ci-local-guard/plan-report/v1', identity: null,
      checksExecuted: false, completenessVerified: false, prediction: null, changedFiles: [],
      unverified: ['full-protection-coverage', 'source-equivalence-to-hosted', 'manual-and-scheduled-workflows', 'hosted-policy', 'execution'] };
    report.outcome = 'failed';
    report.prediction = null;
    report.nextAction = 'Inspect stderr and correct the policy or input failure; no successful prediction is available.';
    process.stdout.write(JSON.stringify(report) + '\n');
  } else if (jsonRequested) {
    const report = preflightReport || {
      schemaVersion: 'ci-local-guard/preflight-report/v1', identity: null,
      unverified: ['simulator-review', 'ci-policy', 'browser', 'database', 'hosted'],
    };
    report.outcome = 'failed';
    report.timing = finishTiming();
    report.product = { status: 'failed', result: 'failure', logFile: error.logFile || null,
      durationMs: Number.isFinite(error.durationMs) ? error.durationMs : null,
      collectedLogs: error.collectedLogs || null, projectReceipt: error.projectReceipt || { status: 'unavailable' },
      checkoutObservation: error.checkoutObservation || null, protection: error.protection || assessProtection(),
      executionFailure: error.executionFailure || null };
    report.nextAction = failureNextAction(error);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
});
