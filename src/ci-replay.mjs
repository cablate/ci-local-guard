import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withExactCheckout } from './checkout.mjs';
import { createDockerResources, dockerCommand } from './docker-resources.mjs';
import { evidenceVersion } from './evidence.mjs';
import { cleanGitEnvironment } from './project.mjs';
import { executionTimeout, runLogged } from './run-log.mjs';
import { actResourceNames, jobClosure, parseWorkflow, runnerLabels } from './workflow-model.mjs';

// Resource ownership depends on act's container naming, so the version is pinned.
export const ACT_VERSION = '0.2.89';
export const DEFAULT_PLATFORMS = { 'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
  'ubuntu-24.04': 'catthehacker/ubuntu:act-24.04', 'ubuntu-22.04': 'catthehacker/ubuntu:act-22.04' };
const EVENTS = ['push', 'pull_request', 'workflow_dispatch'];
const MAX_LOG = 24 * 1024 * 1024;
const EXCERPT_LINES = 30;

const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { replayCode: code, ...extra }); };

function gitRead(repo, args, maxBuffer = 1024 * 1024) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer,
    timeout: 15000, env: { ...cleanGitEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0 || result.error) return null;
  return result.stdout;
}

function probe(binary, args, timeout = 10000) {
  const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 1024 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|temp|tmp|docker_host|userprofile|home)$/i.test(key))) });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

export function dockerEndpoint() {
  const host = process.env.DOCKER_HOST || probe('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  return host && /^(unix:\/\/\/|npipe:\/\/\/\/)/.test(host) ? host : null;
}

// Parse argv for `ci replay`. Unknown keys are errors, never ignored.
export function replayOptions(args) {
  const opts = { matrix: {}, platform: {}, pull: false, offline: false, summary: false };
  const single = ['--repo', '--head', '--workflow', '--job', '--event', '--ref', '--timeout', '--act-binary', '--output'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (['--pull', '--offline', '--summary'].includes(key)) { opts[key.slice(2)] = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) fail('invalid-replay-options', { detail: key });
    i += 1;
    if (key === '--matrix' || key === '--platform') {
      const match = key === '--matrix' ? /^([A-Za-z_][A-Za-z0-9_-]*):(.+)$/.exec(value) : /^([A-Za-z0-9_.-]+)=(\S+)$/.exec(value);
      if (!match) fail('invalid-replay-options', { detail: key });
      opts[key.slice(2)][match[1]] = match[2];
    } else if (single.includes(key) && !Object.hasOwn(opts, key.slice(2))) opts[key.slice(2)] = value;
    else fail('invalid-replay-options', { detail: key });
  }
  if (!opts.workflow || !opts.job) fail('workflow-and-job-required');
  opts.event ??= 'push';
  if (!EVENTS.includes(opts.event)) fail('unsupported-event');
  if (opts.timeout !== undefined && !/^[1-9][0-9]{0,4}$/.test(opts.timeout)) fail('invalid-timeout');
  return opts;
}

// Turn act --json lines in the retained log into jobs, steps and byte ranges.
export function parseActLog(file) {
  const size = statSync(file).size;
  if (size > MAX_LOG) fail('replay-log-too-large');
  const buffer = Buffer.alloc(size);
  const fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, size, 0); } finally { closeSync(fd); }
  const legs = new Map();
  const runner = [];
  const platformSkips = [];
  let last = null;
  let offset = 0;
  while (offset < buffer.length) {
    let end = buffer.indexOf(10, offset);
    if (end < 0) end = buffer.length - 1;
    const line = buffer.subarray(offset, end + 1).toString('utf8').trim();
    const start = offset;
    offset = end + 1;
    let entry = null;
    if (line.startsWith('{')) { try { entry = JSON.parse(line); } catch { entry = null; } }
    if (!entry || typeof entry !== 'object') {
      if (line && !line.startsWith('[ci-local-guard]')) runner.push(line.slice(0, 500));
      if (runner.length > EXCERPT_LINES) runner.shift();
      continue;
    }
    if (typeof entry.msg === 'string' && /unsupported platform/i.test(entry.msg)) platformSkips.push(entry.msg.trim().slice(0, 300));
    if (typeof entry.jobID !== 'string') continue;
    const matrix = entry.matrix && typeof entry.matrix === 'object' ? entry.matrix : {};
    const key = `${entry.jobID}\0${JSON.stringify(matrix)}`;
    if (!legs.has(key)) legs.set(key, { job: entry.jobID, name: entry.job ?? null, matrix, result: null, steps: new Map() });
    const leg = legs.get(key);
    if (typeof entry.jobResult === 'string') leg.result = entry.jobResult;
    if (!Array.isArray(entry.stepID) || !entry.stepID.length) continue;
    const stepKey = `${entry.stepID.join('/')}\0${entry.stage ?? ''}`;
    if (!leg.steps.has(stepKey)) leg.steps.set(stepKey, { id: entry.stepID.join('/'), name: entry.step ?? null,
      stage: entry.stage ?? null, result: null, startByte: start, endByte: offset, tail: [], failedTests: [] });
    const step = leg.steps.get(stepKey);
    step.endByte = offset;
    if (typeof entry.time === 'string') last = { job: leg.job, step: step.name, at: entry.time };
    if (typeof entry.stepResult === 'string') step.result = entry.stepResult;
    if (entry.raw_output && typeof entry.msg === 'string') {
      for (const text of entry.msg.split(/\r?\n/).filter(Boolean)) {
        step.tail.push(text.slice(0, 400));
        if (step.tail.length > EXCERPT_LINES) step.tail.shift();
        // TAP failures are observed lines, not inferred causes.
        const tap = /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(text);
        if (tap && step.failedTests.length < 20 && !step.failedTests.includes(tap[1])) step.failedTests.push(tap[1].slice(0, 300));
      }
    }
  }
  return { legs: [...legs.values()].map(leg => ({ ...leg, steps: [...leg.steps.values()] })), runner, platformSkips, size, last };
}

function eventPayload(event, { sha, ref }) {
  const branch = ref.replace(/^refs\/heads\//, '');
  if (event === 'push') return { ref, before: '0'.repeat(40), after: sha, head_commit: { id: sha } };
  if (event === 'workflow_dispatch') return { ref, inputs: {} };
  return { action: 'opened', number: 1, pull_request: { number: 1, head: { ref: branch, sha }, base: { ref: 'main', sha } } };
}

function readerArgs(file, startByte, endByte) {
  const version = evidenceVersion(file);
  return ['--file', file, '--offset', String(startByte), '--limit', String(Math.max(4, Math.min(16384, endByte - startByte))), '--version', version];
}

export async function replayCi(options, deps = {}) {
  const { executeTool = runLogged, docker = dockerCommand, exactCheckout = withExactCheckout,
    endpoint = dockerEndpoint, probeTool = probe } = deps;
  const opts = options;
  const report = { schemaVersion: 'ci-local-guard/ci-replay/v1', command: 'ci replay', identity: null, outcome: 'blocked',
    scope: 'local-act-replay-of-one-job', execution: { status: 'not-run' }, jobs: [], failures: [], issues: [],
    coverage: { replayed: [], notReplayed: [], hosted: 'unverified' }, resources: null, evidence: [], nextActions: [],
    limitation: 'Local container replay with act; images, secrets, permissions and runner environment differ from GitHub-hosted runners. A local pass is evidence for the replayed legs only.' };
  const rerun = extra => ({ command: 'ci replay', args: replayArgv({ ...opts, ...extra }), automatic: false });
  try {
    const top = gitRead(path.resolve(opts.repo || process.cwd()), ['rev-parse', '--show-toplevel'])?.trim();
    if (!top) fail('repository-unavailable');
    const head = opts.head || 'HEAD';
    if (head.startsWith('-') || /[\x00-\x20\x7f]/.test(head)) fail('invalid-revision');
    const sha = gitRead(top, ['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`])?.trim();
    if (!/^[a-f0-9]{40}$/.test(sha || '')) fail('revision-unavailable');
    const file = opts.workflow.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) fail('top-level-workflow-path-required');
    const blob = gitRead(top, ['rev-parse', '--verify', `${sha}:${file}`])?.trim();
    const source = blob && gitRead(top, ['cat-file', 'blob', blob]);
    if (!source) fail('workflow-not-in-commit');
    let ref = opts.ref;
    if (!ref) {
      const branch = gitRead(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
      ref = `refs/heads/${branch || 'main'}`;
    }
    if (!/^refs\/(heads|tags)\/[^\s\x00-\x1f]+$/.test(ref)) fail('invalid-ref');
    report.identity = { repo: top, head: sha, workflow: { path: file, blob, sha256: createHash('sha256').update(source).digest('hex') },
      job: opts.job, event: opts.event, eventContext: { ref, source: opts.ref ? 'caller-declared' : 'current-branch-default', verified: false },
      matrixFilter: opts.matrix, provider: { id: 'act', expectedVersion: ACT_VERSION, version: null }, docker: null, platforms: [] };

    const workflow = parseWorkflow(source, file);
    if (workflow.issues.length) fail('workflow-parse-failed', { issues: workflow.issues });
    const declared = workflow.triggers.map(t => t.event);
    if (!declared.includes(opts.event)) fail('event-not-declared-by-workflow', { declared });
    let closure;
    try { closure = jobClosure(workflow, opts.job); }
    catch (error) { fail(error.message, { jobs: workflow.jobs.map(j => j.id) }); }
    const reusable = closure.find(job => job.uses);
    if (reusable) fail('reusable-workflow-job-not-supported', { job: reusable.id });

    // Decide each leg's image before anything runs; unmapped labels are not replayed.
    const platforms = { ...DEFAULT_PLATFORMS, ...opts.platform };
    const needed = new Map();
    for (const job of closure) {
      if (job.matrix.kind === 'dynamic') fail('dynamic-matrix-not-supported', { job: job.id });
      const selected = leg => Object.entries(opts.matrix).every(([k, v]) => !Object.hasOwn(leg, k) || String(leg[k]) === v);
      const legs = job.matrix.legs.filter(selected);
      if (!legs.length) fail('matrix-filter-matches-no-leg', { job: job.id, legs: job.matrix.legs });
      if (job.id === opts.job) report.coverage.notSelected = job.matrix.legs.filter(leg => !selected(leg)).map(matrix => ({ job: job.id, matrix }));
      for (const leg of legs) {
        const labels = runnerLabels(job, leg);
        if (!labels) fail('runs-on-not-statically-known', { job: job.id });
        const label = labels.find(item => platforms[item]);
        if (!label) { report.coverage.notReplayed.push({ job: job.id, matrix: leg, labels, reason: 'runner-label-not-mapped-to-linux-image' }); continue; }
        needed.set(label, platforms[label]);
        if (job.id === opts.job) report.coverage.replayed.push({ job: job.id, matrix: leg, labels, image: platforms[label],
          imageSource: opts.platform[label] ? 'caller-mapped' : 'guard-default' });
      }
    }
    if (!report.coverage.replayed.length) fail('no-replayable-leg');
    const services = closure.flatMap(job => job.services.map(service => ({ job: job.id, service })));

    // Pinned act and a local Linux Docker engine.
    const act = opts['act-binary'] || process.env.ACT_BIN || 'act';
    const found = /^act version ([0-9.]+)/.exec(probeTool(act, ['--version']) || '')?.[1] || null;
    report.identity.provider.version = found;
    if (!found) fail('act-unavailable');
    if (found !== ACT_VERSION) fail('unsupported-act-version');
    const host = endpoint();
    if (!host) fail('local-docker-endpoint-unavailable');
    const serverOs = probeTool('docker', ['--host', host, 'version', '--format', '{{.Server.Os}}']);
    if (serverOs !== 'linux') fail(serverOs ? 'linux-docker-engine-required' : 'docker-engine-unavailable');
    report.identity.docker = { endpoint: host, serverOs };
    for (const [label, image] of needed) {
      const id = probeTool('docker', ['--host', host, 'image', 'inspect', '--format', '{{.Id}}', image]);
      report.identity.platforms.push({ label, image, imageId: id || null });
      if (!id && !opts.pull) fail('image-not-present', { image, label });
    }

    const claims = actResourceNames(workflow, closure, opts.matrix);
    if (claims.unpredictable.length) fail('resource-names-unpredictable', { unpredictable: claims.unpredictable });
    // act needs a user-defined network for its aliases; this run owns one.
    const network = opts.offline ? null : `guard-replay-${randomUUID().slice(0, 12)}`;
    if (network) claims.network.push(network);
    const scope = createDockerResources({ host, claims, execute: docker });
    report.resources = { runId: scope.runId, label: scope.label, ownership: 'this-run-label-or-exact-act-names-absent-before-run',
      claimed: { container: claims.container.length, volume: claims.volume.length, network: claims.network.length },
      services, cleanup: null, shared: [] };
    const toolcacheBefore = (await scope.present('volume', ['act-toolcache'])).length > 0;
    try { await scope.prepare(); }
    catch (error) { fail(error.collisions ? 'docker-resource-collision' : 'docker-inventory-unavailable', { collisions: error.collisions }); }
    if (network) {
      try { await docker('docker', ['--host', host, 'network', 'create', '--label', scope.label, network], 15000); }
      catch { await scope.cleanup({ producerStopped: true }); fail('replay-network-unavailable'); }
    }

    report.outcome = 'incomplete';
    report.execution.status = 'running';
    const profile = path.join(process.env.CI_LOCAL_GUARD_CACHE || path.join(os.homedir(), '.cache', 'ci-local-guard'), 'act-profile');
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const inputs = mkdtempSync(path.join(os.tmpdir(), 'guard-replay-'));
    let logFile = null;
    let execution;
    try {
      const empty = path.join(inputs, 'empty');
      writeFileSync(empty, '', { flag: 'wx', mode: 0o600 });
      const eventFile = path.join(inputs, 'event.json');
      writeFileSync(eventFile, JSON.stringify(eventPayload(opts.event, { sha, ref })), { flag: 'wx', mode: 0o600 });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|pathext|systemroot|windir|temp|tmp|comspec)$/i.test(key)));
      // No ambient .actrc, .env, .secrets, tokens or Docker credentials.
      Object.assign(env, { HOME: profile, USERPROFILE: profile, APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile,
        XDG_CACHE_HOME: profile, DOCKER_CONFIG: path.join(profile, 'docker'), DOCKER_HOST: host, CI_LOCAL_GUARD_KEEP_LOGS: '1' });
      await exactCheckout(top, sha, async checkout => {
        const args = [opts.event, '-C', checkout, '-W', file, '-j', opts.job, '-e', eventFile, '--json',
          ...Object.entries(opts.matrix).flatMap(([k, v]) => ['--matrix', `${k}:${v}`]),
          ...[...needed].flatMap(([label, image]) => ['-P', `${label}=${image}`]),
          `--pull=${opts.pull}`, '--container-daemon-socket', '-', '--no-cache-server',
          '--env-file', empty, '--secret-file', empty, '--var-file', empty, '--input-file', empty,
          '--action-cache-path', path.join(profile, 'actions'), '--container-options', `--init --label ${scope.label}`,
          '--network', network || 'none', '--rm'];
        const started = Date.now();
        try {
          const result = await executeTool(act, args, inputs, { logRepo: top, env, stage: 'ci-replay',
            timeoutMs: opts.timeout ? Number(opts.timeout) * 1000 : executionTimeout(), maxBytes: MAX_LOG });
          execution = { status: 'completed', exitCode: 0, durationMs: result.durationMs, causes: [] };
          logFile = result.logFile;
        } catch (error) {
          logFile = error.logFile || null;
          execution = { status: 'failed', exitCode: error.executionFailure?.exitCode ?? null, durationMs: error.durationMs ?? Date.now() - started,
            causes: error.executionFailure?.causes || ['process-execution-failed'], terminationUncertain: Boolean(error.preserveCheckout) };
        }
        // Ignore further interrupts until this run's containers are gone.
        const hold = () => { execution.causes.includes('second-interrupt-during-cleanup') || execution.causes.push('second-interrupt-during-cleanup'); };
        process.on('SIGINT', hold); process.on('SIGTERM', hold);
        try {
          report.resources.cleanup = await scope.cleanup({ producerStopped: !execution.terminationUncertain, timeoutMs: 60000 });
        } finally { process.off('SIGINT', hold); process.off('SIGTERM', hold); }
        if (execution.terminationUncertain) throw Object.assign(new Error('replay-termination-unconfirmed'), { preserveCheckout: true });
      }, { linkDependencies: false });
    } catch (error) {
      if (error.retainedCheckout) report.retainedCheckout = error.retainedCheckout;
      if (!execution) throw error;
      report.issues.push({ code: error.replayCode || (/^[a-z-]+$/.test(error.message) ? error.message : 'replay-checkout-failed') });
    } finally {
      rmSync(inputs, { recursive: true, force: true });
    }
    if (!toolcacheBefore && (await scope.present('volume', ['act-toolcache']).catch(() => [])).length) {
      report.resources.shared.push({ kind: 'volume', name: 'act-toolcache', createdByThisRun: true, policy: 'retained-shared-act-tool-cache' });
    } else if (toolcacheBefore) report.resources.shared.push({ kind: 'volume', name: 'act-toolcache', createdByThisRun: false, policy: 'reused-shared-act-tool-cache' });
    report.execution = { ...execution, endedAt: new Date().toISOString() };
    if (logFile) {
      report.evidence.push({ id: 'replay-log', kind: 'log', path: logFile,
        reader: { command: 'read-evidence', args: ['--file', logFile], automatic: false } });
      summarize(report, parseActLog(logFile), workflow, logFile);
    } else report.issues.push({ code: 'replay-log-unavailable' });
    decide(report, opts, rerun);
  } catch (error) {
    if (!error.replayCode) throw error;
    report.outcome = 'blocked';
    const { replayCode, ...detail } = error;
    report.issues.push({ code: replayCode, ...Object.fromEntries(Object.entries(detail).filter(([key]) => !['stack', 'message'].includes(key))) });
    blockedActions(report, replayCode, detail, opts, rerun);
  }
  return report;
}

function summarize(report, parsed, workflow, logFile) {
  const byId = new Map(workflow.jobs.map(job => [job.id, job]));
  report.jobs = parsed.legs.map(leg => ({ job: leg.job, matrix: leg.matrix, result: leg.result || 'not-reported',
    steps: leg.steps.map(({ id, name, stage, result, startByte, endByte }) => ({ id, name, stage, result: result || 'not-reported', evidence: { startByte, endByte } })) }));
  for (const leg of parsed.legs) {
    for (const step of leg.steps.filter(item => item.result === 'failure')) {
      const job = byId.get(leg.job);
      const declared = /^\d+$/.test(step.id) ? job?.steps[Number(step.id)] : job?.steps.find(item => item.id === step.id);
      report.failures.push({ job: leg.job, matrix: leg.matrix, step: { id: step.id, name: step.name, stage: step.stage },
        workflowLocation: declared ? { path: workflow.path, line: declared.line } : null,
        command: declared?.run ? declared.run.slice(0, 2000) : null, action: declared?.uses || null,
        observed: { lastLines: step.tail, failedTests: step.failedTests,
          meaning: 'Observed output of the failed step; not a diagnosed root cause.' },
        evidence: { id: 'replay-log', startByte: step.startByte, endByte: step.endByte,
          reader: { command: 'read-evidence', args: readerArgs(logFile, step.startByte, step.endByte), automatic: false } } });
    }
  }
  // Where a stopped run was: the last step that printed anything, and when.
  if (parsed.last && report.execution) {
    const silent = Math.round((Date.parse(report.execution.endedAt) - Date.parse(parsed.last.at)) / 1000);
    report.execution.lastActivity = { ...parsed.last, ...(Number.isFinite(silent) && silent >= 0 ? { silentSeconds: silent } : {}) };
  }
  if (parsed.platformSkips.length) report.coverage.runnerMessages = parsed.platformSkips.slice(0, 5);
  if (report.outcome !== 'passed') report.runnerOutput = parsed.runner.slice(-EXCERPT_LINES);
}

function decide(report, opts, rerun) {
  const { execution } = report;
  const target = report.jobs.filter(leg => leg.job === opts.job);
  const cleaned = report.resources?.cleanup?.outcome === 'cleaned';
  const interrupted = execution.causes.some(cause => ['execution-timeout', 'execution-cancelled', 'process-drain-timeout',
    'process-tree-termination-unverified', 'log-budget-exceeded'].includes(cause));
  // Only a failed workflow step is a project failure; setup failures are environment problems.
  const failed = report.failures.some(failure => failure.workflowLocation);
  const setupFailed = !failed && report.jobs.some(leg => leg.result === 'failure');
  if (setupFailed) report.issues.push({ code: 'job-failed-outside-workflow-steps', meaning: 'act could not prepare or finish the job; see runnerOutput' });
  const allPassed = target.length >= report.coverage.replayed.length && report.jobs.length > 0
    && report.jobs.every(leg => leg.result === 'success');
  if (interrupted) report.outcome = 'incomplete';
  else if (failed) report.outcome = 'failed';
  else if (allPassed && execution.status === 'completed') report.outcome = 'passed';
  else report.outcome = 'incomplete';
  if (!cleaned) {
    report.outcome = report.outcome === 'failed' ? 'failed' : 'incomplete';
    report.issues.push({ code: 'docker-cleanup-unconfirmed', remaining: report.resources?.cleanup?.remaining || [] });
    report.nextActions.push({ kind: 'inspect-remaining-docker-resources', resources: report.resources?.cleanup?.remaining || [],
      reason: report.resources?.cleanup?.reasons || [], automatic: false });
  }
  if (report.outcome === 'failed') {
    for (const failure of report.failures.slice(0, 3)) {
      report.nextActions.push({ kind: 'read-failed-step-log', step: failure.step.name, ...failure.evidence.reader });
      if (failure.workflowLocation) report.nextActions.push({ kind: 'inspect-workflow-step', ...failure.workflowLocation, automatic: false });
      if (failure.command) report.nextActions.push({ kind: 'reproduce-step-command', command: failure.command, cwd: 'repository-root',
        note: 'Copied from the workflow. Run it in your working tree to check uncommitted fixes quickly; it runs on your host, not in the replay image.', automatic: false });
    }
    report.nextActions.push({ kind: 'replay-after-commit', reason: 'replay checks a commit; commit the fix first', ...rerun({ head: 'HEAD' }) });
  } else if (report.outcome === 'passed') {
    const other = [...report.coverage.notReplayed, ...(report.coverage.notSelected || [])];
    if (other.length) report.nextActions.push({ kind: 'verify-legs-on-hosted-ci', legs: other,
      reason: 'these legs were not replayed: no local Linux stand-in, or excluded by --matrix', automatic: false });
    report.nextActions.push({ kind: 'confirm-on-hosted-ci', reason: 'local replay is not a hosted result', automatic: false });
  } else if (interrupted) {
    report.nextActions.push({ kind: 'read-replay-log-tail', reason: execution.causes.join(','), automatic: false });
    const stalled = execution.lastActivity;
    if (stalled?.silentSeconds >= 120) report.nextActions.push({ kind: 'inspect-stalled-step', job: stalled.job, step: stalled.step, silentSeconds: stalled.silentSeconds,
      reason: 'no output for minutes before the stop; often a slow or stuck download in a setup step. Tool caches are kept, so a retry may skip finished downloads', automatic: false });
    if (execution.causes.includes('execution-timeout')) report.nextActions.push({ kind: 'replay-with-longer-timeout', ...rerun({ timeout: String(Math.min(99999, Number(opts.timeout || 900) * 2)) }) });
  } else {
    report.nextActions.push({ kind: 'read-runner-output', reason: 'act stopped before reporting a job result', automatic: false });
  }
}

function blockedActions(report, code, detail, opts, rerun) {
  const add = (kind, extra = {}) => report.nextActions.push({ kind, automatic: false, ...extra });
  if (code === 'act-unavailable' || code === 'unsupported-act-version') add('provide-act', { version: ACT_VERSION,
    how: `Install act ${ACT_VERSION} from https://github.com/nektos/act/releases, verify its checksum, then pass --act-binary <absolute path> or set ACT_BIN.` });
  else if (code === 'image-not-present') {
    add('allow-image-pull', { image: detail.image, sideEffect: 'downloads the image from its registry', ...rerun({ pull: true }) });
    add('map-local-image', { label: detail.label, example: `--platform ${detail.label}=<local-linux-image-with-node-and-git>` });
  } else if (code === 'no-replayable-leg') add('verify-on-hosted-ci', { legs: report.coverage.notReplayed,
    reason: 'no selected leg maps to a local Linux image; map one with --platform <label>=<image> only if a Linux image is an acceptable stand-in' });
  else if (code === 'docker-resource-collision') add('inspect-colliding-resources', { resources: detail.collisions,
    reason: 'resources with this run\'s act names already exist (another act run or leftovers); Guard will not delete resources it did not create' });
  else if (code === 'event-not-declared-by-workflow') add('choose-declared-event', { declared: detail.declared });
  else if (['unknown-job', 'cyclic-job-needs'].includes(code)) add('choose-job', { jobs: detail.jobs });
  else if (code === 'matrix-filter-matches-no-leg') add('choose-matrix-leg', { legs: detail.legs });
  else if (['local-docker-endpoint-unavailable', 'docker-engine-unavailable', 'linux-docker-engine-required'].includes(code)) add('start-local-linux-docker');
  else if (code === 'workflow-parse-failed') add('fix-workflow-yaml', { issues: detail.issues });
  else add('discover-ci', { command: 'ci discover', args: ['--repo', opts.repo || '.', '--summary'] });
}

export function replayArgv(opts) {
  return ['--repo', opts.repo || '.', ...(opts.head ? ['--head', opts.head] : []), '--workflow', opts.workflow, '--job', opts.job,
    '--event', opts.event, ...(opts.ref ? ['--ref', opts.ref] : []),
    ...Object.entries(opts.matrix || {}).flatMap(([k, v]) => ['--matrix', `${k}:${v}`]),
    ...Object.entries(opts.platform || {}).flatMap(([k, v]) => ['--platform', `${k}=${v}`]),
    ...(opts.pull ? ['--pull'] : []), ...(opts.offline ? ['--offline'] : []), ...(opts.timeout ? ['--timeout', opts.timeout] : []),
    ...(opts['act-binary'] ? ['--act-binary', opts['act-binary']] : []), '--summary'];
}

export function summarizeReplay(report) {
  return { ...report, jobs: report.jobs.map(leg => ({ job: leg.job, matrix: leg.matrix, result: leg.result,
    steps: leg.steps.length, failedSteps: leg.steps.filter(step => step.result === 'failure').map(step => step.name) })),
  failures: report.failures.map(failure => ({ ...failure, observed: { ...failure.observed, lastLines: failure.observed.lastLines.slice(-12) } })) };
}
