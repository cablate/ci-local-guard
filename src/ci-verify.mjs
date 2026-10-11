import { spawnSync } from 'node:child_process';
import { checkCi } from './ci-check.mjs';
import { discoverCi } from './ci-discovery.mjs';
import { DEFAULT_PLATFORMS, replayCi } from './ci-replay.mjs';
import { cleanGitEnvironment } from './project.mjs';
import { evaluateTrigger } from './workflow-triggers.mjs';

// One pre-push answer for a commit: which CI work is expected to fail, what
// already passed locally, and what only hosted CI can verify. It composes
// discover (structure), triggers (selection), check (static) and replay (run).
const EVENTS = ['push', 'pull_request'];
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { verifyCode: code, ...extra }); };

function gitText(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000,
    maxBuffer: 8 * 1024 * 1024, env: { ...cleanGitEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

export function verifyOptions(args) {
  const opts = { platform: {}, runnerLabels: [], summary: false, staticOnly: false, pull: false };
  const single = ['--repo', '--head', '--event', '--base', '--target', '--ref', '--timeout', '--act-binary', '--output'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--summary') { opts.summary = true; continue; }
    if (key === '--static-only') { opts.staticOnly = true; continue; }
    if (key === '--pull') { opts.pull = true; continue; }
    if (key === '--runner-label') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--') || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) fail('invalid-verify-options', { detail: key });
      opts.runnerLabels.push(value);
      i += 1;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) fail('invalid-verify-options', { detail: key });
    i += 1;
    if (key === '--platform') {
      const match = /^([A-Za-z0-9_.-]+)=(\S+)$/.exec(value);
      if (!match) fail('invalid-verify-options', { detail: key });
      opts.platform[match[1]] = match[2];
    } else if (single.includes(key) && !Object.hasOwn(opts, key.slice(2))) opts[key.slice(2)] = value;
    else fail('invalid-verify-options', { detail: key });
  }
  opts.event ??= 'push';
  if (!EVENTS.includes(opts.event)) fail('unsupported-event');
  if (opts.timeout !== undefined && !/^[1-9][0-9]{0,4}$/.test(opts.timeout)) fail('invalid-timeout');
  for (const value of [opts.head, opts.base, opts.target, opts.ref]) {
    if (value !== undefined && (value.startsWith('-') || /[\x00-\x20\x7f]/.test(value))) fail('invalid-revision');
  }
  return opts;
}

// What this push or pull request changes, and the ref context for filters.
export function changeContext(repo, head, opts) {
  const branch = gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const ref = opts.ref || `refs/heads/${branch || 'main'}`;
  const defaultBase = opts.event === 'push' ? '@{upstream}' : (gitText(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main');
  const baseRef = opts.base || defaultBase;
  const base = gitText(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]);
  const target = opts.target || (opts.event === 'pull_request' ? baseRef.replace(/^(refs\/heads\/|refs\/remotes\/[^/]+\/|origin\/)/, '') : null);
  let changedFiles = null;
  let source = 'unknown';
  if (base) {
    const listed = gitText(repo, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
    if (listed !== null) { changedFiles = listed.split('\0').filter(Boolean); source = `${baseRef}...head`; }
  }
  return { ref, refSource: opts.ref ? 'caller-declared' : 'current-branch', base: base || null, baseRef,
    baseSource: opts.base ? 'caller-declared' : 'default', targetBranch: target, changedFiles, changedFilesSource: source };
}

// Which jobs of the triggered workflows can be replayed, and which cannot.
export function planTargets(workflows, triggers) {
  const targets = [];
  const hostedOnly = [];
  const undetermined = [];
  for (const wf of workflows) {
    const trigger = triggers.find(item => item.workflow === wf.path);
    // `called` workflows are reported through the calling job.
    if (!trigger || ['not-triggered', 'called'].includes(trigger.status)) continue;
    const jobs = wf.jobs || [];
    const local = job => !job.uses && !job.usesSecrets && !job.environment && job.localReplay.replayable.length > 0;
    // Replaying a job runs what it needs, so skip jobs needed by another job
    // that is itself replayed. Needs of hosted-only jobs are replayed directly.
    const needed = new Set();
    const visit = id => { for (const need of jobs.find(job => job.id === id)?.needs || []) if (!needed.has(need)) { needed.add(need); visit(need); } };
    for (const job of jobs.filter(local)) visit(job.id);
    for (const job of jobs) {
      const base = { workflow: wf.path, job: job.id, ...(trigger.status === 'unknown' ? { triggerUnknown: true } : {}) };
      if (job.uses) {
        const called = job.calls?.status === 'resolved' && triggers.find(item => item.workflow === job.calls.path);
        // Its jobs are replayed through the called workflow when that one is itself triggered.
        if (called && ['triggered', 'unknown'].includes(called.status)) continue;
        undetermined.push({ ...base, reason: called ? `runs reusable workflow ${job.calls.path}; replaying jobs of a workflow_call-only workflow is not supported yet`
          : 'remote reusable workflow' });
        continue;
      }
      if (job.usesSecrets || job.environment) {
        hostedOnly.push({ ...base, reason: job.environment ? 'uses a deployment environment' : 'uses secrets, which local replay does not have' });
        continue;
      }
      for (const leg of job.localReplay.hostedOnly) hostedOnly.push({ ...base, matrix: leg.matrix, labels: leg.labels, reason: `runner ${leg.labels.join(',')} has no local Linux stand-in` });
      for (const item of job.localReplay.unknown) undetermined.push({ ...base, ...(item.matrix ? { matrix: item.matrix } : {}), reason: item.reason });
      if (needed.has(job.id)) continue;
      for (const leg of job.localReplay.replayable) targets.push({ ...base, matrix: leg.matrix, ...(job.if ? { condition: job.if } : {}) });
    }
  }
  return { targets, hostedOnly, undetermined };
}

// A runner-label family: windows-latest → windows, macos-14 → macos. Mixed or
// unrecognized families (third-party labels) stay hosted; guessing is worse.
function runnerFamily(labels) {
  const families = labels.map(label => /windows/i.test(label) ? 'windows' : /macos|^mac-/i.test(label) ? 'macos'
    : /ubuntu|linux/i.test(label) ? 'linux' : 'other');
  return families.every(family => family === families[0]) ? families[0] : 'mixed';
}

// Hosted-only legs whose runner family matches this machine can at least be
// exercised in the working tree. These are suggestions with the commands and
// line numbers — never counted as replayed, never a hosted verdict.
export function hostExecutableLegs(hostedOnly, workflows, platform = process.platform) {
  const wanted = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : null;
  if (!wanted) return [];
  const legs = [];
  for (const item of hostedOnly) {
    if (!Array.isArray(item.labels) || !/^runner /.test(item.reason) || runnerFamily(item.labels) !== wanted) continue;
    const job = workflows.find(wf => wf.path === item.workflow)?.jobs?.find(job => job.id === item.job);
    const commands = (job?.steps || []).filter(step => step.run).slice(0, 12).map(step => ({ line: step.line, run: step.run }));
    legs.push({ workflow: item.workflow, job: item.job, ...(item.matrix ? { matrix: item.matrix } : {}), labels: item.labels,
      commands, ...(item.triggerUnknown ? { triggerUnknown: true } : {}),
      limitation: 'Working-tree execution on this machine: not isolated, includes uncommitted edits, and is not a hosted result.' });
  }
  return legs;
}

export async function verifyCi(opts, deps = {}) {
  const { discover = discoverCi, check = checkCi, replay = replayCi, hostPlatform = process.platform } = deps;
  const report = { schemaVersion: 'ci-local-guard/ci-verify/v1', command: 'ci verify', identity: null, outcome: 'blocked',
    verdict: null, expectedFailures: [], passedLocally: [], hostedOnly: [], hostExecutable: [], notVerified: [], notTriggered: [], triggers: [],
    staticOutsideTrigger: [], staticCheck: null, replays: [], issues: [], nextActions: [],
    limitation: 'Covers only what runs locally: static workflow checks and Linux jobs replayed with act. Trigger selection follows documented branch/tag/path filters; job if-conditions are evaluated by act during replay, not here. Hosted-only items still need GitHub Actions. hostExecutable only suggests working-tree commands for runner families matching this machine; they are not replays.' };
  try {
    const inventory = discover({ repo: opts.repo, head: opts.head || 'HEAD', tools: true, platform: opts.platform });
    const repo = inventory.identity.repo;
    const head = inventory.identity.head;
    const context = changeContext(repo, head, opts);
    report.identity = { repo, head, event: opts.event, ref: context.ref, refSource: context.refSource,
      base: context.base, baseRef: context.baseRef, baseSource: context.baseSource, targetBranch: context.targetBranch,
      changedFiles: context.changedFiles ? { source: context.changedFilesSource, count: context.changedFiles.length, files: context.changedFiles.slice(0, 200) }
        : { source: 'unknown', count: null, files: null },
      workingTree: inventory.identity.workingTree, tools: inventory.tools };
    if (!inventory.workflows.length) fail('no-github-workflows');
    for (const wf of inventory.workflows) {
      if (wf.analysis !== 'parsed') {
        report.triggers.push({ workflow: wf.path, status: 'unknown', reasons: [`workflow ${wf.analysis}`] });
        continue;
      }
      report.triggers.push({ workflow: wf.path, ...evaluateTrigger(wf, { event: opts.event, ref: context.ref,
        targetBranch: context.targetBranch, changedFiles: context.changedFiles }) });
    }
    // A reusable workflow runs when a triggered workflow calls it.
    for (const wf of inventory.workflows) {
      if (report.triggers.find(item => item.workflow === wf.path)?.status === 'not-triggered') continue;
      for (const job of wf.jobs || []) {
        const called = job.calls?.status === 'resolved' && report.triggers.find(item => item.workflow === job.calls.path);
        if (called?.status === 'not-triggered') Object.assign(called, { status: 'called', reasons: [`called by ${wf.path} job ${job.id}`] });
      }
    }
    report.notTriggered = report.triggers.filter(item => item.status === 'not-triggered');
    const plan = planTargets(inventory.workflows.filter(wf => wf.analysis === 'parsed'), report.triggers);
    report.hostedOnly = plan.hostedOnly;
    report.hostExecutable = hostExecutableLegs(plan.hostedOnly, inventory.workflows.filter(wf => wf.analysis === 'parsed'), hostPlatform);
    report.notVerified.push(...plan.undetermined.map(item => ({ ...item, stage: 'selection' })));
    for (const wf of inventory.workflows.filter(item => item.analysis !== 'parsed')) {
      report.expectedFailures.push({ kind: 'workflow-invalid', workflow: wf.path, issues: wf.issues || [{ code: wf.analysis }] });
    }

    // Static check of all workflows: a broken file fails the whole run.
    if (inventory.tools?.actionlint === 'available') {
      const result = await check({ repo, head, provider: 'actionlint', runnerLabels: opts.runnerLabels });
      report.staticCheck = { provider: 'actionlint', outcome: result.outcome, findings: result.findings.length };
      if (result.outcome === 'findings') {
        const platforms = { ...DEFAULT_PLATFORMS, ...opts.platform };
        let mappedRunnerLabels = 0;
        for (const finding of result.findings) {
          // A label the caller mapped to a local image is a coverage choice, not a push failure.
          const unknown = finding.rule === 'runner-label' ? [...finding.message.matchAll(/"([^"]+)" is unknown/g)].map(match => match[1]) : [];
          if (unknown.length && unknown.every(label => platforms[label])) { mappedRunnerLabels += 1; continue; }
          if (report.triggers.find(item => item.workflow === finding.location.path)?.status === 'not-triggered') {
            report.staticOutsideTrigger.push({ workflow: finding.location.path, reason: 'workflow is not triggered by this event', finding });
            continue;
          }
          report.expectedFailures.push({ kind: 'static', ...finding });
        }
        if (mappedRunnerLabels) report.staticCheck.mappedRunnerLabels = mappedRunnerLabels;
      } else if (result.outcome !== 'passed') report.notVerified.push({ stage: 'static', reason: result.issues.map(item => item.code).join(',') || result.outcome });
    } else {
      report.staticCheck = { provider: 'actionlint', outcome: 'not-run', reason: `actionlint ${inventory.tools?.actionlint || 'unknown'}` };
      report.notVerified.push({ stage: 'static', reason: 'actionlint not available', how: 'run doctor once to prepare the pinned actionlint, or set ACTIONLINT_BIN' });
    }

    // Replay each selected Linux job leg against the same event and ref.
    for (const target of opts.staticOnly ? [] : plan.targets) {
      const matrix = Object.fromEntries(Object.entries(target.matrix).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, String(v)]));
      const result = await replay({ repo, head, workflow: target.workflow, job: target.job, event: opts.event, ref: context.ref,
        matrix, platform: opts.platform, pull: opts.pull, offline: false, timeout: opts.timeout, 'act-binary': opts['act-binary'], summary: true });
      const entry = { workflow: target.workflow, job: target.job, matrix: target.matrix, outcome: result.outcome,
        ...(target.triggerUnknown ? { triggerUnknown: true } : {}), ...(target.condition ? { condition: target.condition } : {}),
        jobs: (result.jobs || []).map(leg => ({ job: leg.job, result: leg.result })),
        evidence: result.evidence?.[0]?.path || null };
      report.replays.push(entry);
      if (result.outcome === 'passed') report.passedLocally.push(entry);
      else if (result.outcome === 'failed') {
        // An image gap is not a project failure; only real step failures are.
        const compact = item => ({ job: item.job, step: item.step.name, workflowLocation: item.workflowLocation,
          command: item.command, failedTests: item.observed.failedTests, lastLines: item.observed.lastLines.slice(-8), reader: item.evidence.reader,
          ...(item.observed.environmentMismatch ? { environmentMismatch: item.observed.environmentMismatch } : {}) });
        const environment = result.failures.filter(item => item.observed.environmentMismatch);
        const project = result.failures.filter(item => !item.observed.environmentMismatch);
        if (project.length) report.expectedFailures.push({ kind: 'replay', ...entry, failures: project.map(compact),
          ...(environment.length ? { environmentFailures: environment.length } : {}), nextActions: result.nextActions });
        else report.notVerified.push({ stage: 'replay-environment', ...entry,
          reason: 'environment-mismatch: the replay image lacks libraries or tools that hosted runners preinstall',
          failures: environment.map(compact), nextActions: result.nextActions.slice(0, 3) });
      } else report.notVerified.push({ stage: 'replay', ...entry, reason: result.issues.map(item => item.code).join(',') || result.outcome,
        nextActions: result.nextActions.slice(0, 3) });
    }
    if (opts.staticOnly) for (const target of plan.targets) report.notVerified.push({ stage: 'replay', ...target, reason: 'skipped-by-static-only' });

    report.outcome = report.expectedFailures.length ? 'expected-to-fail' : report.notVerified.length ? 'incomplete' : 'clear-locally';
    report.verdict = verdict(report);
    nextSteps(report, opts);
  } catch (error) {
    if (!error.verifyCode && !/^[a-z-]+$/.test(error.message)) throw error;
    report.outcome = 'blocked';
    report.issues.push({ code: error.verifyCode || error.message });
    report.nextActions.push({ kind: 'discover-ci', command: 'ci discover', args: ['--repo', opts.repo || '.', '--summary'], automatic: false });
  }
  return report;
}

function label(item) {
  const leg = item.matrix && Object.keys(item.matrix).length ? ` (${Object.values(item.matrix).join(', ')})` : '';
  return `${item.workflow.replace(/^\.github\/workflows\//, '')}/${item.job}${leg}`;
}

function verdict(report) {
  const parts = [];
  if (report.expectedFailures.length) {
    parts.push(`${report.expectedFailures.length} expected failure(s): ${report.expectedFailures.slice(0, 3).map(item => item.kind === 'replay'
      ? `${label(item)} step "${item.failures[0]?.step}"${item.failures[0]?.failedTests?.length ? ` (${item.failures[0].failedTests.slice(0, 2).join('; ')})` : ''}`
      : item.kind === 'static' ? `${item.location.path}:${item.location.line} ${item.rule}` : `${item.workflow} invalid`).join(' | ')}`);
  }
  if (report.staticCheck) parts.push(`static check ${report.staticCheck.outcome}`);
  parts.push(`${report.passedLocally.length} job leg(s) passed locally`);
  if (report.notVerified.length) parts.push(`${report.notVerified.length} not verified locally`);
  const gaps = report.notVerified.filter(item => item.stage === 'replay-environment').length;
  if (gaps) parts.push(`${gaps} replay environment gap(s)`);
  if (report.staticOutsideTrigger.length) parts.push(`${report.staticOutsideTrigger.length} static finding(s) outside the event`);
  if (report.hostedOnly.length) parts.push(`${report.hostedOnly.length} hosted-only: ${report.hostedOnly.slice(0, 3).map(label).join(', ')}`);
  if (report.hostExecutable.length) parts.push(`${report.hostExecutable.length} hosted-only leg(s) with working-tree commands on this machine`);
  parts.push(`${report.notTriggered.length} workflow(s) not triggered`);
  return parts.join('; ');
}

function nextSteps(report, opts) {
  const add = (kind, extra) => report.nextActions.push({ kind, ...extra, automatic: false });
  for (const item of report.expectedFailures.slice(0, 3)) {
    if (item.kind === 'replay') {
      const failure = item.failures[0];
      if (failure?.reader) add('read-failed-step-log', { target: label(item), command: failure.reader.command, args: failure.reader.args });
      if (failure?.command) add('reproduce-in-working-tree', { target: label(item), command: failure.command,
        note: 'Run in the working tree while fixing; then commit and run ci verify again.' });
    } else if (item.kind === 'static') add('fix-workflow', { path: item.location.path, line: item.location.line, rule: item.rule, message: item.message });
    else add('fix-workflow-yaml', { workflow: item.workflow, issues: item.issues });
  }
  for (const item of report.notVerified.filter(entry => entry.nextActions?.length).slice(0, 2)) {
    add('unblock-local-verification', { target: label(item), reason: item.reason, suggestions: item.nextActions });
  }
  if (report.identity?.changedFiles?.count === null) add('declare-base', { reason: 'changed files unknown; paths filters could not be evaluated',
    example: ['--base', opts.event === 'push' ? 'origin/<branch>' : 'origin/main'] });
  if (report.identity?.workingTree?.status === 'uncommitted-changes') add('commit-before-verifying', { reason: 'ci verify checks the commit, not uncommitted edits' });
  if (report.outcome === 'clear-locally' && report.hostedOnly.length) add('watch-hosted-ci-for', { items: report.hostedOnly });
  if (report.hostExecutable.length) add('run-host-commands', {
    legs: report.hostExecutable.slice(0, 6).map(leg => ({ workflow: leg.workflow, job: leg.job,
      ...(leg.matrix ? { matrix: leg.matrix } : {}), commands: leg.commands })),
    note: 'These hosted-only legs use a runner family this machine matches. Running their commands in the working tree extends pre-push coverage; it is not isolated, includes uncommitted edits, and does not replace the hosted run.' });
}

export function summarizeVerify(report) {
  return { ...report, triggers: report.triggers.map(({ workflow, status, reasons }) => ({ workflow, status, reason: reasons[0] })),
    identity: report.identity && { ...report.identity, changedFiles: { ...report.identity.changedFiles, files: report.identity.changedFiles.files?.slice(0, 20) } },
    expectedFailures: report.expectedFailures.map(item => item.kind === 'replay' ? { ...item, nextActions: undefined,
      failures: item.failures.map(failure => ({ ...failure, lastLines: failure.lastLines.slice(-4), reader: undefined })) } : item),
    hostExecutable: report.hostExecutable.map(leg => ({ ...leg, commands: leg.commands.slice(0, 6)
      .map(command => ({ ...command, run: command.run.slice(0, 200) })) })),
    notVerified: report.notVerified.map(({ nextActions, ...item }) => item) };
}
