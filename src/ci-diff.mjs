import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseWorkflow, runnerLabels } from './workflow-model.mjs';
import { evaluateTrigger } from './workflow-triggers.mjs';
import { parse as parseYaml } from './vendor/yaml/index.js';

// What a workflow change does to CI coverage: for the same event and the same
// changed files, which workflows, jobs, legs and commands run more, less, or
// cannot be determined. Reads committed files only; nothing is executed.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { diffCode: code, ...extra }); };
const MAX_FILES = 20000;
const PROBE_BRANCH = 'guard-probe/feature';
const PROBE_TAG = 'v0.0.0-guard-probe';
const EXAMPLES = 5;

export function diffOptions(args) {
  const opts = { summary: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--summary') { opts.summary = true; continue; }
    const value = args[i + 1];
    if (!['--repo', '--base', '--head', '--output'].includes(key) || Object.hasOwn(opts, key.slice(2)) || value === undefined || value.startsWith('--')) fail('invalid-diff-options', { detail: key });
    opts[key.slice(2)] = value;
    i += 1;
  }
  return opts;
}

function git(repo, args, maxBuffer = 64 * 1024 * 1024) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer,
    env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

const revision = value => typeof value === 'string' && value && value.length <= 512 && !value.startsWith('-') && !/[\x00-\x20\x7f]/.test(value);
const commandOf = run => String(run).split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')).join('\n');
const actionOf = uses => String(uses).replace(/@[^@]*$/, '');
const legKey = leg => JSON.stringify(Object.entries(leg || {}).sort(([a], [b]) => a.localeCompare(b)));
const legLabel = leg => Object.values(leg || {}).filter(value => typeof value !== 'object').join(', ') || 'single';
const literalFalse = value => /^\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/i.test(String(value));
const tolerant = value => value === true || /^\s*(?:true|\$\{\{\s*true\s*\}\})\s*$/i.test(String(value)) ? 'true'
  : value === null || value === undefined || value === false || /^\s*false\s*$/i.test(String(value)) ? 'false' : 'expression';

// Workflows of one commit, with local composite action steps inlined one level.
export function loadCommit(repo, sha) {
  const listing = git(repo, ['ls-tree', '-r', '--name-only', '-z', '--full-tree', sha]);
  if (listing === null) fail('git-read-failed');
  const files = listing.split('\0').filter(Boolean);
  const read = file => git(repo, ['show', `${sha}:${file}`], 1024 * 1024);
  const workflows = new Map();
  for (const file of files.filter(item => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(item))) {
    const source = read(file);
    const model = source === null ? { path: file, issues: [{ code: 'unreadable' }], triggers: [], jobs: [] } : parseWorkflow(source, file);
    for (const job of model.jobs) for (const step of job.steps) {
      if (!step.uses?.startsWith('./')) continue;
      const dir = step.uses.replace(/^\.\//, '').replace(/\/$/, '');
      const text = read(`${dir}/action.yml`) ?? read(`${dir}/action.yaml`);
      try {
        const action = text === null ? null : parseYaml(text, { uniqueKeys: true, maxAliasCount: 64 });
        if (action?.runs?.using === 'composite' && Array.isArray(action.runs.steps)) step.inner = action.runs.steps.slice(0, 128)
          .filter(inner => typeof inner?.run === 'string').map(inner => commandOf(inner.run)).filter(Boolean);
      } catch { step.inner = null; }
    }
    workflows.set(file, model);
  }
  return { sha, files, workflows };
}

// Every command a job runs, with the step it comes from.
function jobCommands(job) {
  const list = [];
  for (const step of job.steps) {
    if (step.run) list.push({ command: commandOf(step.run), line: step.line, step: step.index });
    for (const inner of step.inner || []) list.push({ command: inner, line: step.line, step: step.index, viaAction: step.uses });
  }
  return list.filter(item => item.command);
}

function allCommands(snapshot) {
  const where = new Map();
  for (const wf of snapshot.workflows.values()) for (const job of wf.jobs) for (const item of jobCommands(job)) {
    if (!where.has(item.command)) where.set(item.command, []);
    where.get(item.command).push({ workflow: wf.path, job: job.id, line: item.line });
  }
  return where;
}

const legsOf = job => job.matrix.kind === 'dynamic' ? null : job.matrix.legs;

// Each tracked file alone as the change: which workflows run before and after.
function triggerChanges(before, after, files, defaultBranch) {
  const changes = [];
  const events = new Set([...before.triggers, ...after.triggers].map(item => item.event));
  for (const event of events) {
    const a = before.triggers.find(item => item.event === event);
    const b = after.triggers.find(item => item.event === event);
    if (a && b && JSON.stringify(a.filters) === JSON.stringify(b.filters)) continue;
    if (!['push', 'pull_request', 'pull_request_target'].includes(event)) {
      changes.push({ kind: !b ? 'event-removed' : !a ? 'event-added' : 'event-filters-changed', effect: !b ? 'reduced' : !a ? 'added' : 'unknown',
        workflow: after.path, event, reason: !a || !b ? `on.${event} ${!b ? 'removed' : 'added'}` : `on.${event} filters changed and are not modelled` });
      continue;
    }
    const scenarios = event === 'push'
      ? [{ ref: `refs/heads/${defaultBranch}`, label: `push to ${defaultBranch}` }, { ref: `refs/heads/${PROBE_BRANCH}`, label: 'push to another branch' },
        { ref: `refs/tags/${PROBE_TAG}`, label: 'push of a tag' }]
      : [{ targetBranch: defaultBranch, label: `${event} into ${defaultBranch}` }, { targetBranch: PROBE_BRANCH, label: `${event} into another branch` }];
    for (const scenario of scenarios) {
      const tally = { narrowed: [], widened: [], unknown: 0, reason: null };
      const fileList = scenario.ref?.startsWith('refs/tags/') ? [null] : files;
      for (const file of fileList) {
        const input = { event, ref: scenario.ref || `refs/heads/${PROBE_BRANCH}`, targetBranch: scenario.targetBranch, changedFiles: file === null ? undefined : [file] };
        const was = evaluateTrigger(before, input);
        const now = evaluateTrigger(after, input);
        if (was.status === 'unknown' || now.status === 'unknown') { if (was.status !== now.status) { tally.unknown += 1; tally.reason ||= (now.status === 'unknown' ? now : was).reasons.at(-1); } continue; }
        if (was.status === 'triggered' && now.status === 'not-triggered') { tally.narrowed.push(file); tally.reason ||= now.reasons.at(-1); }
        if (was.status === 'not-triggered' && now.status === 'triggered') tally.widened.push(file);
      }
      const scope = file => file === null ? 'every tag push' : null;
      if (tally.narrowed.length) changes.push({ kind: 'trigger-narrowed', effect: 'reduced', workflow: after.path, event, scenario: scenario.label,
        files: tally.narrowed[0] === null ? scope(null) : tally.narrowed.length, examples: tally.narrowed.filter(Boolean).slice(0, EXAMPLES), reason: tally.reason });
      if (tally.widened.length) changes.push({ kind: 'trigger-widened', effect: 'added', workflow: after.path, event, scenario: scenario.label,
        files: tally.widened[0] === null ? scope(null) : tally.widened.length, examples: tally.widened.filter(Boolean).slice(0, EXAMPLES) });
      if (tally.unknown) changes.push({ kind: 'trigger-undetermined', effect: 'unknown', workflow: after.path, event, scenario: scenario.label, files: tally.unknown, reason: tally.reason });
    }
  }
  return changes;
}

function jobChanges(wfPath, a, b, headCommands) {
  const changes = [];
  const at = { workflow: wfPath, job: b.id, baseLine: a.line, headLine: b.line };
  const legsA = legsOf(a);
  const legsB = legsOf(b);
  if (!legsA || !legsB) {
    if (JSON.stringify(a.matrix) !== JSON.stringify(b.matrix)) changes.push({ kind: 'matrix-undetermined', effect: 'unknown', ...at, reason: 'matrix uses an expression' });
  } else {
    const keysB = new Map(legsB.map(leg => [legKey(leg), leg]));
    const keysA = new Map(legsA.map(leg => [legKey(leg), leg]));
    const removed = legsA.filter(leg => !keysB.has(legKey(leg)));
    const added = legsB.filter(leg => !keysA.has(legKey(leg)));
    if (removed.length) changes.push({ kind: 'legs-removed', effect: 'reduced', ...at, legs: removed.map(leg => ({ leg: legLabel(leg), runsOn: runnerLabels(a, leg) })) });
    if (added.length) changes.push({ kind: 'legs-added', effect: 'added', ...at, legs: added.map(leg => ({ leg: legLabel(leg), runsOn: runnerLabels(b, leg) })) });
    for (const leg of legsB.filter(item => keysA.has(legKey(item)))) {
      const was = runnerLabels(a, leg);
      const now = runnerLabels(b, leg);
      if (JSON.stringify(was) !== JSON.stringify(now)) changes.push({ kind: 'runner-changed', effect: was && now ? 'review' : 'unknown', ...at, leg: legLabel(leg), before: was, after: now });
    }
  }
  if ((a.if ?? null) !== (b.if ?? null)) {
    if (b.if !== null && literalFalse(b.if)) changes.push({ kind: 'job-disabled', effect: 'reduced', ...at, after: b.if });
    else if (b.if === null) changes.push({ kind: 'job-condition-removed', effect: 'added', ...at, before: a.if });
    else changes.push({ kind: 'job-condition-changed', effect: 'unknown', ...at, before: a.if, after: b.if, reason: 'if-conditions are not evaluated' });
  }
  const tolA = tolerant(a.continueOnError);
  const tolB = tolerant(b.continueOnError);
  if (tolA !== tolB) changes.push({ kind: 'job-failures-tolerated', effect: tolB === 'true' ? 'reduced' : tolA === 'true' ? 'added' : 'unknown', ...at, before: a.continueOnError, after: b.continueOnError });
  if ((a.uses ?? null) !== (b.uses ?? null)) changes.push({ kind: 'called-workflow-changed', effect: 'review', ...at, before: a.uses, after: b.uses });
  // Commands: removed ones count only when no job runs them any more.
  const before = jobCommands(a);
  const after = jobCommands(b);
  const afterSet = new Set(after.map(item => item.command));
  const beforeSet = new Set(before.map(item => item.command));
  const added = after.filter(item => !beforeSet.has(item.command));
  for (const item of before.filter(entry => !afterSet.has(entry.command))) {
    const elsewhere = (headCommands.get(item.command) || []).filter(place => !(place.workflow === wfPath && place.job === b.id));
    const replaced = added.find(entry => entry.step === item.step);
    if (elsewhere.length) changes.push({ kind: 'command-moved', effect: 'neutral', ...at, command: item.command.slice(0, 500), baseLine: item.line, to: elsewhere.slice(0, 3) });
    else if (replaced) changes.push({ kind: 'command-changed', effect: 'review', ...at, before: item.command.slice(0, 500), after: replaced.command.slice(0, 500), baseLine: item.line, headLine: replaced.line });
    else changes.push({ kind: 'command-removed', effect: 'reduced', ...at, command: item.command.slice(0, 500), baseLine: item.line, ...(item.viaAction ? { viaAction: item.viaAction } : {}) });
  }
  const changedSteps = new Set(changes.filter(c => c.kind === 'command-changed').map(c => c.headLine));
  for (const item of added.filter(entry => !changedSteps.has(entry.line))) changes.push({ kind: 'command-added', effect: 'added', ...at, command: item.command.slice(0, 500), headLine: item.line });
  // Step conditions and tolerance, matched by the command they guard.
  const stepByCommand = steps => new Map(steps.filter(step => step.run).map(step => [commandOf(step.run), step]));
  const stepsA = stepByCommand(a.steps);
  for (const [command, step] of stepByCommand(b.steps)) {
    const old = stepsA.get(command);
    if (!old) continue;
    const place = { ...at, command: command.slice(0, 200), baseLine: old.line, headLine: step.line };
    if ((old.if ?? null) !== (step.if ?? null)) {
      if (step.if !== undefined && literalFalse(step.if)) changes.push({ kind: 'step-disabled', effect: 'reduced', ...place, after: step.if });
      else if (step.if === undefined) changes.push({ kind: 'step-condition-removed', effect: 'added', ...place, before: old.if });
      else changes.push({ kind: 'step-condition-changed', effect: 'unknown', ...place, before: old.if ?? null, after: step.if, reason: 'if-conditions are not evaluated' });
    }
    const t0 = tolerant(old.continueOnError);
    const t1 = tolerant(step.continueOnError);
    if (t0 !== t1) changes.push({ kind: 'step-failures-tolerated', effect: t1 === 'true' ? 'reduced' : t0 === 'true' ? 'added' : 'unknown', ...place, before: old.continueOnError ?? null, after: step.continueOnError ?? null });
  }
  const actions = steps => new Map(steps.filter(step => step.uses && !step.uses.startsWith('./')).map(step => [actionOf(step.uses), step]));
  const usesA = actions(a.steps);
  const usesB = actions(b.steps);
  for (const [action, step] of usesA) {
    if (!usesB.has(action)) changes.push({ kind: 'action-removed', effect: 'review', ...at, action: step.uses, baseLine: step.line });
    else if (usesB.get(action).uses !== step.uses) changes.push({ kind: 'action-version-changed', effect: 'neutral', ...at, before: step.uses, after: usesB.get(action).uses });
  }
  for (const [action, step] of usesB) if (!usesA.has(action)) changes.push({ kind: 'action-added', effect: 'neutral', ...at, action: step.uses, headLine: step.line });
  if (Number(b.timeoutMinutes) < Number(a.timeoutMinutes)) changes.push({ kind: 'timeout-reduced', effect: 'review', ...at, before: a.timeoutMinutes, after: b.timeoutMinutes });
  return changes;
}

export function compareSnapshots(base, head, { defaultBranch = 'main' } = {}) {
  const changes = [];
  const issues = [];
  const headCommands = allCommands(head);
  const files = [...new Set([...base.files, ...head.files])].slice(0, MAX_FILES);
  if (base.files.length + head.files.length > 2 * MAX_FILES) issues.push({ code: 'file-probe-limit', probed: MAX_FILES });
  const paths = new Set([...base.workflows.keys(), ...head.workflows.keys()]);
  for (const file of [...paths].sort()) {
    const a = base.workflows.get(file);
    const b = head.workflows.get(file);
    for (const [side, wf] of [['base', a], ['head', b]]) if (wf?.issues.length) issues.push({ code: 'workflow-parse-failed', side, workflow: file, details: wf.issues.slice(0, 3) });
    if ((a && a.issues.length) || (b && b.issues.length)) {
      changes.push({ kind: 'workflow-undetermined', effect: 'unknown', workflow: file, reason: 'a version could not be parsed' });
      continue;
    }
    if (!b) {
      const commands = a.jobs.flatMap(jobCommands);
      const kept = commands.filter(item => headCommands.has(item.command));
      changes.push({ kind: 'workflow-removed', effect: kept.length === commands.length && commands.length ? 'review' : 'reduced', workflow: file,
        jobs: a.jobs.map(job => job.id), commandsStillRun: kept.length, commands: commands.length });
      continue;
    }
    if (!a) { changes.push({ kind: 'workflow-added', effect: 'added', workflow: file, jobs: b.jobs.map(job => job.id), events: b.triggers.map(t => t.event) }); continue; }
    changes.push(...triggerChanges(a, b, files, defaultBranch));
    const idsA = new Map(a.jobs.map(job => [job.id, job]));
    const idsB = new Map(b.jobs.map(job => [job.id, job]));
    const gone = a.jobs.filter(job => !idsB.has(job.id));
    const fresh = b.jobs.filter(job => !idsA.has(job.id));
    for (const job of gone) {
      const commands = jobCommands(job).map(item => item.command).sort();
      const twin = fresh.find(other => JSON.stringify(jobCommands(other).map(item => item.command).sort()) === JSON.stringify(commands)
        && JSON.stringify(legsOf(other)?.map(legKey).sort()) === JSON.stringify(legsOf(job)?.map(legKey).sort()));
      if (twin) {
        fresh.splice(fresh.indexOf(twin), 1);
        changes.push({ kind: 'job-renamed', effect: 'neutral', workflow: file, job: twin.id, from: job.id, baseLine: job.line, headLine: twin.line });
        changes.push(...jobChanges(file, job, twin, headCommands).filter(c => !['command-moved'].includes(c.kind)));
        continue;
      }
      const missing = jobCommands(job).filter(item => !headCommands.has(item.command));
      const shared = fresh.filter(other => jobCommands(other).some(item => commands.includes(item.command))).map(other => other.id);
      changes.push({ kind: 'job-removed', ...(shared.length ? { possiblyReplacedBy: shared } : {}), effect: missing.length || !commands.length ? 'reduced' : 'review', workflow: file, job: job.id, baseLine: job.line,
        legs: (legsOf(job) || []).map(legLabel), commandsNoLongerRun: missing.map(item => item.command.slice(0, 200)).slice(0, 10),
        ...(missing.length ? {} : { note: 'every command still runs in another job; check the runners and legs it ran on' }) });
    }
    for (const job of fresh) changes.push({ kind: 'job-added', effect: 'added', workflow: file, job: job.id, headLine: job.line, legs: (legsOf(job) || []).map(legLabel) });
    for (const job of b.jobs.filter(item => idsA.has(item.id))) changes.push(...jobChanges(file, idsA.get(job.id), job, headCommands));
  }
  return { changes, issues };
}

export async function diffCi(opts) {
  const report = { schemaVersion: 'ci-local-guard/ci-diff/v1', command: 'ci diff', identity: null, outcome: 'blocked', verdict: null,
    summary: null, changes: [], issues: [], nextActions: [],
    limitation: 'Compares committed workflow files structurally. Each tracked file is tried alone as a change for push and pull_request filters; expressions, if-conditions and remote reusable workflows are not evaluated. Nothing is executed.' };
  try {
    const repo = path.resolve(opts.repo || '.');
    const root = git(repo, ['rev-parse', '--show-toplevel'])?.trim();
    if (!root) fail('repository-unreadable');
    const headRef = opts.head || 'HEAD';
    let baseRef = opts.base;
    if (!baseRef) baseRef = git(root, ['rev-parse', '--verify', '--quiet', 'origin/HEAD']) ? 'origin/HEAD' : null;
    if (!baseRef) fail('base-required');
    if (!revision(baseRef) || !revision(headRef)) fail('invalid-revision');
    const head = git(root, ['rev-parse', '--verify', '--end-of-options', `${headRef}^{commit}`])?.trim();
    const tip = git(root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])?.trim();
    if (!head || !tip) fail('unknown-revision');
    // Compare against where the branch started, so unrelated changes on the base branch are not attributed to it.
    const base = opts.base ? tip : git(root, ['merge-base', tip, head])?.trim() || tip;
    const defaultBranch = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])?.trim().replace(/^origin\//, '') || 'main';
    report.identity = { repo: root, base, head, baseRef: opts.base ? baseRef : `merge-base(${baseRef}, ${headRef})`, headRef, defaultBranch };
    const before = loadCommit(root, base);
    const after = loadCommit(root, head);
    const { changes, issues } = compareSnapshots(before, after, { defaultBranch });
    report.changes = changes;
    report.issues.push(...issues);
    const count = effect => changes.filter(change => change.effect === effect).length;
    report.summary = { reduced: count('reduced'), unknown: count('unknown'), review: count('review'), added: count('added'), neutral: count('neutral') };
    const { reduced, unknown, review } = report.summary;
    report.outcome = !changes.length ? 'unchanged' : reduced ? 'reduced' : unknown ? 'undetermined' : 'no-reduction';
    report.verdict = !changes.length ? 'No workflow change affects what CI runs.'
      : reduced ? `${reduced} change(s) make CI check less; confirm each is intended.`
        : unknown ? `No reduction found, but ${unknown} change(s) could not be evaluated.`
          : `No reduction found${review ? `; ${review} change(s) alter what runs and are worth a look` : ''}.`;
    const add = (kind, extra) => report.nextActions.push({ kind, ...extra, automatic: false });
    for (const change of changes.filter(item => item.effect === 'reduced').slice(0, 5)) {
      add('confirm-reduction-is-intended', { change: change.kind, workflow: change.workflow, ...(change.job ? { job: change.job } : {}),
        ...(change.baseLine ? { baseLine: change.baseLine } : {}), ...(change.headLine ? { headLine: change.headLine } : {}) });
    }
    if (unknown) add('check-undetermined-changes', { reason: 'expressions and if-conditions are not evaluated; read them or replay both commits' });
    const replayable = changes.find(item => item.job && ['reduced', 'unknown', 'review'].includes(item.effect));
    if (replayable) add('replay-both-commits', { command: 'ci replay', reason: 'compare execution of the same job before and after',
      runs: [base, head].map(sha => ['--repo', root, '--head', sha, '--workflow', replayable.workflow, '--job', replayable.job, '--summary']) });
    if (changes.length) add('verify-before-push', { command: 'ci verify', args: ['--repo', root, '--head', head, '--summary'] });
  } catch (error) {
    if (!error.diffCode) throw error;
    report.outcome = 'blocked';
    const { diffCode, ...detail } = error;
    report.issues.push({ code: diffCode, ...Object.fromEntries(Object.entries(detail).filter(([key]) => !['stack', 'message'].includes(key))) });
    report.nextActions.push({ kind: 'review-command-inputs', help: ['--help'], automatic: false });
  }
  return report;
}

export function summarizeDiff(report) {
  const order = ['reduced', 'unknown', 'review', 'added', 'neutral'];
  const shown = [...report.changes].sort((a, b) => order.indexOf(a.effect) - order.indexOf(b.effect)).slice(0, 30);
  return { ...report, changes: shown, changesShown: shown.length, changesTotal: report.changes.length };
}
