import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { collectAttemptJobs, githubGet, githubJobLog, runSource } from './ci-runs.mjs';
import { discoverCi } from './ci-discovery.mjs';
import { hostedNames } from './ci-history.mjs';
import { evidenceVersion } from './evidence.mjs';
import { interpolateMatrix } from './workflow-model.mjs';
import { replayArgv } from './ci-replay.mjs';

// Where did a hosted run fail: job -> step -> test, with the matching log
// section kept locally for paged reading. Read-only GitHub access; the log
// text is untrusted data and is never followed as instructions.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { locateCode: code, ...extra }); };
const FAILED = ['failure', 'timed_out', 'cancelled', 'startup_failure'];
const TAIL_LINES = 30;
const MAX_TESTS = 10;
const MESSAGE_LINES = 6;

export function locateOptions(args) {
  const opts = { summary: false };
  const single = ['--repo', '--repository', '--run', '--attempt', '--head', '--workflow', '--output'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--summary') { opts.summary = true; continue; }
    const value = args[i + 1];
    if (!single.includes(key) || Object.hasOwn(opts, key.slice(2)) || value === undefined || value.startsWith('--')) fail('invalid-locate-options', { detail: key });
    opts[key.slice(2)] = value;
    i += 1;
  }
  for (const key of ['run', 'attempt']) {
    if (opts[key] === undefined) continue;
    if (!/^[1-9][0-9]{0,15}$/.test(opts[key]) || !Number.isSafeInteger(Number(opts[key]))) fail('invalid-locate-options', { detail: `--${key}` });
    opts[key] = Number(opts[key]);
  }
  if (opts.attempt && !opts.run) fail('attempt-requires-run');
  if (opts.run && opts.head) fail('choose-run-or-head');
  if (opts.workflow && !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(opts.workflow)) fail('workflow-file-name-required');
  return opts;
}

const stamp = line => {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?Z /.exec(line);
  return match ? { seconds: Date.parse(`${match[1]}Z`) / 1000, text: line.slice(match[0].length) } : { seconds: null, text: line };
};

// Byte-indexed lines; GitHub prefixes every log line with a timestamp.
function indexLines(buffer) {
  const lines = [];
  for (let offset = 0; offset < buffer.length;) {
    let end = buffer.indexOf(10, offset);
    if (end < 0) end = buffer.length - 1;
    const { seconds, text } = stamp(buffer.subarray(offset, end + 1).toString('utf8').replace(/\r?\n$/, ''));
    lines.push({ start: offset, end: end + 1, seconds, text });
    offset = end + 1;
  }
  return lines;
}

const seconds = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };
const boundary = text => text.startsWith('##[group]Run ') || text === 'Post job cleanup.';

// A step's section: its "Run ..." header up to the next top-level header after
// the step completed. Composite actions print inner headers while running.
export function stepSection(lines, step) {
  const from = seconds(step.started_at);
  const to = seconds(step.completed_at);
  const header = `##[group]${step.name}`;
  let first = lines.findIndex(line => line.text === header && (from === null || line.seconds === null || line.seconds >= from - 1));
  if (first < 0 && from !== null) first = lines.findIndex(line => line.text.startsWith('##[group]Run ') && line.seconds !== null && line.seconds >= from - 1);
  if (first < 0) return null;
  let last = lines.length;
  for (let i = first + 1; i < lines.length; i++) {
    if (boundary(lines[i].text) && (to === null || lines[i].seconds === null || lines[i].seconds >= to)) { last = i; break; }
  }
  return { first, last, startByte: lines[first].start, endByte: lines[last - 1].end };
}

// Workspace-relative test location from node's TAP "location:" field.
function testLocation(raw) {
  const plain = raw.replace(/\\\\/g, '\\').replace(/\\/g, '/');
  const match = /\/(?:work|a)\/([^/]+)\/\1\/(.+?):(\d+)(?::\d+)?$/.exec(plain);
  return match ? { file: match[2], line: Number(match[3]) } : { raw: plain.slice(0, 300) };
}

// Observed facts from a failed step's section: error annotations, failing TAP
// tests with their location and first error line, and the last output lines.
export function readSection(lines, section) {
  const errors = [];
  const tests = [];
  const tail = [];
  for (let i = section.first; i < section.last; i++) {
    const { text } = lines[i];
    if (text.startsWith('##[error]')) { if (errors.length < 5) errors.push(text.slice(9, 409)); continue; }
    const tap = /^\s*not ok \d+ - (.+?)(?:\s+#\s*(?:TODO|SKIP)\b.*)?$/.exec(text);
    if (tap && tests.length < MAX_TESTS && !tests.some(item => item.name === tap[1])) {
      const item = { name: tap[1].slice(0, 300), location: null, failedAt: null, message: [], startByte: lines[i].start, endByte: lines[i].end };
      const indent = /^\s*/.exec(text)[0].length;
      let block = null;
      for (let j = i + 1; j < section.last; j++) {
        const raw = lines[j].text;
        const yaml = raw.trim();
        if (/^\s*(not )?ok \d+ - /.test(raw) || /^\s*# Subtest: /.test(raw)) break;
        item.endByte = lines[j].end;
        if (yaml === '...') break;
        const depth = /^\s*/.exec(raw)[0].length;
        // Keys sit two spaces deeper than the test line; block scalars deeper still.
        if (depth <= indent + 2 && /^[A-Za-z]+:/.test(yaml)) block = null;
        if (block === 'error' && yaml && item.message.length < MESSAGE_LINES) item.message.push(yaml.slice(0, 300));
        if (block === 'stack' && !item.failedAt) {
          const frame = /\((?:file:\/\/\/?)?(.+?):(\d+):\d+\)$|at (?:file:\/\/\/?)?(.+?):(\d+):\d+$/.exec(yaml);
          const found = frame && testLocation(`${frame[1] || frame[3]}:${frame[2] || frame[4]}`);
          if (found?.file) item.failedAt = found;
        }
        if (block) continue;
        const loc = /^location: '(.+)'$/.exec(yaml);
        if (loc) item.location = testLocation(loc[1]);
        if (/^error: [|>]-?$/.test(yaml)) block = 'error';
        else if (/^stack: [|>]-?$/.test(yaml)) block = 'stack';
        else if (/^error: /.test(yaml)) item.message.push(yaml.slice(7).replace(/^'|'$/g, '').slice(0, 300));
      }
      tests.push(item);
    }
    if (!text.startsWith('##[')) { tail.push(text.slice(0, 400)); if (tail.length > TAIL_LINES) tail.shift(); }
  }
  return { errors, tests, tail };
}

const reader = (file, version, startByte, endByte) => ({ command: 'read-evidence',
  args: ['--file', file, '--offset', String(startByte), '--limit', String(Math.max(4, Math.min(16384, endByte - startByte))), '--version', version], automatic: false });

// The declared workflow step behind a hosted step name, only when unambiguous.
export function declaredStep(job, matrix, apiName) {
  const names = step => [step.name && interpolateMatrix(step.name, matrix),
    step.run && `Run ${String(step.run).split(/\r?\n/).find(Boolean)?.trim()}`, step.uses && `Run ${step.uses}`].filter(Boolean);
  const found = (job?.steps || []).filter(step => names(step).includes(apiName));
  return found.length === 1 ? found[0] : null;
}

function gitRead(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function logStore(repo) {
  const common = gitRead(repo, ['rev-parse', '--git-common-dir']);
  if (!common) fail('repository-unreadable');
  const root = process.env.CI_LOCAL_GUARD_LOG_DIR ? path.resolve(process.env.CI_LOCAL_GUARD_LOG_DIR, 'hosted')
    : path.join(path.resolve(repo, common), 'ci-local-guard', 'hosted-logs');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

// Logs of completed jobs do not change, so a saved copy is reused.
function saveLog(root, repository, jobId, fetchLog) {
  const file = path.join(root, `${repository.replace('/', '_')}-job-${jobId}.log`);
  if (existsSync(file)) return { file, reused: true };
  const text = fetchLog(repository, jobId);
  const fd = openSync(file, 'wx', 0o600);
  try { writeSync(fd, text); } finally { closeSync(fd); }
  return { file, reused: false };
}

function selectRuns(opts, repository, head, get) {
  const prefix = `repos/${repository}/actions`;
  if (opts.run) {
    const run = get(`${prefix}/runs/${opts.run}`);
    if (run?.id !== opts.run || run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()) fail('run-identity-mismatch');
    if (opts.attempt && opts.attempt > run.run_attempt) fail('attempt-not-found');
    return [opts.attempt && opts.attempt !== run.run_attempt ? get(`${prefix}/runs/${opts.run}/attempts/${opts.attempt}`) : run];
  }
  const listed = get(`${prefix}/runs?head_sha=${head}&per_page=100`);
  if (!Array.isArray(listed?.workflow_runs)) fail('github-metadata-unavailable');
  return listed.workflow_runs.filter(run => run.head_sha === head && (!opts.workflow || path.posix.basename(String(run.path).split('@')[0]) === opts.workflow));
}

export async function locateCi(opts, deps = {}) {
  const { get = githubGet, fetchLog = githubJobLog, discover = discoverCi, platform = process.platform } = deps;
  const report = { schemaVersion: 'ci-local-guard/ci-locate/v1', command: 'ci locate', identity: null, outcome: 'blocked', verdict: null,
    runs: [], failures: [], pending: [], issues: [], nextActions: [],
    limitation: 'Hosted job metadata and logs, read-only. Failures are observed output, not diagnosed causes. Logs are saved as GitHub returned them (GitHub masks registered secrets); no further redaction.' };
  try {
    const repo = path.resolve(opts.repo || '.');
    const inventory = discover({ repo, head: 'HEAD' });
    const repository = opts.repository || inventory.identity.repository;
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('github-repository-required');
    let head = null;
    if (!opts.run) {
      head = gitRead(repo, ['rev-parse', '--verify', '--end-of-options', `${opts.head || 'HEAD'}^{commit}`]);
      if (!head || !/^[a-f0-9]{40}$/.test(head)) fail('invalid-head');
    }
    let runs;
    try { runs = selectRuns(opts, repository, head, get); } catch (error) { if (error.locateCode) throw error; fail('github-metadata-unavailable'); }
    report.identity = { repository, localRepo: repo, localHead: inventory.identity.head, requested: opts.run ? { run: opts.run, attempt: opts.attempt ?? 'latest' } : { head, workflow: opts.workflow ?? 'any' } };
    if (!runs.length) {
      report.outcome = 'incomplete';
      report.issues.push({ code: 'no-hosted-runs-for-commit' });
      report.verdict = `No hosted runs found for ${head.slice(0, 7)}${opts.workflow ? ` in ${opts.workflow}` : ''}.`;
      report.nextActions.push({ kind: 'check-commit-was-pushed', reason: 'runs exist only after the commit reaches GitHub and a workflow triggers', automatic: false });
      return report;
    }
    const store = logStore(repo);
    const workflowCache = new Map();
    const workflowAt = (sha, file) => {
      const key = `${sha}\0${file}`;
      if (!workflowCache.has(key)) {
        let wf = null;
        try { wf = discover({ repo, head: sha }).workflows.find(item => item.path === file && item.analysis === 'parsed') || null; } catch { wf = null; }
        workflowCache.set(key, wf);
      }
      return workflowCache.get(key);
    };
    for (const run of runs) {
      const entry = collectAttemptJobs(`repos/${repository}/actions`, run, runSource(run), endpoint => get(endpoint));
      const file = String(run.path || '').split('@')[0] || null;
      const summary = { runId: run.id, attempt: run.run_attempt, workflow: file, name: run.name ?? null, sha: run.head_sha, event: run.event,
        branch: run.head_branch ?? null, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null,
        jobs: { total: entry.jobs.jobs.length, failed: 0, pending: 0 } };
      report.runs.push(summary);
      const wf = file ? workflowAt(run.head_sha, file) : null;
      const names = wf ? hostedNames(wf) : new Map();
      for (const job of entry.jobs.jobs) {
        if (job.status !== 'completed') { summary.jobs.pending += 1; report.pending.push({ runId: run.id, job: job.name, status: job.status }); continue; }
        if (!FAILED.includes(job.conclusion)) continue;
        summary.jobs.failed += 1;
        const mapped = names.get(job.name) || null;
        const declaredJob = mapped ? wf.jobs.find(item => item.id === mapped.job) : null;
        const steps = job.steps || [];
        const failedStep = steps.find(step => FAILED.includes(step.conclusion)) || null;
        const failure = { runId: run.id, attempt: run.run_attempt, sha: run.head_sha, job: job.name, jobId: job.id, conclusion: job.conclusion,
          runner: job.labels || [], workflowJob: mapped ? { id: mapped.job, matrix: mapped.matrix } : null,
          step: failedStep ? { number: failedStep.number, name: failedStep.name, conclusion: failedStep.conclusion } : null,
          stepKind: null, workflowLocation: null, command: null, observed: null, evidence: null, located: false };
        report.failures.push(failure);
        if (!failedStep) { failure.stepKind = 'no-step-reported'; continue; }
        const declared = declaredJob ? declaredStep(declaredJob, mapped.matrix, failedStep.name) : null;
        failure.stepKind = declared ? 'workflow-step' : ['Set up job', 'Complete job'].includes(failedStep.name) || /^(Post |Initialize containers|Stop containers)/.test(failedStep.name) ? 'runner-setup' : 'unmatched';
        if (declared) {
          failure.workflowLocation = { path: file, line: declared.line };
          failure.command = declared.run ? String(declared.run).slice(0, 2000) : null;
          failure.action = declared.uses || null;
        }
        let saved;
        try { saved = saveLog(store, repository, job.id, fetchLog); } catch { failure.evidence = { status: 'missing', reason: 'log unavailable: expired, deleted or no Actions read access' }; continue; }
        const buffer = readFileSync(saved.file);
        const lines = indexLines(buffer);
        const section = stepSection(lines, failedStep);
        const version = evidenceVersion(saved.file);
        if (!section) {
          failure.evidence = { status: 'step-not-found-in-log', path: saved.file, reader: reader(saved.file, version, Math.max(0, buffer.length - 16384), buffer.length) };
          continue;
        }
        const seen = readSection(lines, section);
        failure.observed = { errors: seen.errors, failedTests: seen.tests.map(({ startByte, endByte, ...test }) => ({ ...test,
          evidence: reader(saved.file, version, startByte, Math.min(endByte, startByte + 16384)) })),
          lastLines: seen.tail, meaning: 'Observed output of the failed step; not a diagnosed root cause.' };
        failure.evidence = { status: 'saved', path: saved.file, reused: saved.reused, startByte: section.startByte, endByte: section.endByte,
          tail: reader(saved.file, version, Math.max(section.startByte, section.endByte - 8192), section.endByte) };
        failure.located = true;
        const hostOs = { win32: 'windows', darwin: 'macos', linux: 'ubuntu' }[platform];
        const local = { headMatches: run.head_sha === inventory.identity.head,
          replayable: Boolean(declaredJob?.localReplay.replayable.some(leg => JSON.stringify(leg) === JSON.stringify(mapped.matrix))),
          sameOsAsRunner: Boolean(hostOs && (job.labels || []).some(label => label.toLowerCase().startsWith(hostOs))) };
        failure.local = local;
      }
    }
    decide(report, opts);
  } catch (error) {
    if (!error.locateCode) throw error;
    report.outcome = 'blocked';
    const { locateCode, ...detail } = error;
    report.issues.push({ code: locateCode, ...Object.fromEntries(Object.entries(detail).filter(([key]) => !['stack', 'message'].includes(key))) });
    report.nextActions.push({ kind: 'review-command-inputs', help: ['--help'], automatic: false });
  }
  return report;
}

function decide(report, opts) {
  const failures = report.failures;
  const unlocated = failures.filter(item => !item.located);
  const located = failures.filter(item => item.located);
  if (!failures.length) {
    report.outcome = report.pending.length ? 'incomplete' : 'passed';
    report.verdict = report.pending.length ? `No failed job yet; ${report.pending.length} job(s) still running.` : 'No failed jobs in the selected run attempts.';
    if (report.pending.length) report.nextActions.push({ kind: 'locate-again-later', command: 'ci locate', args: locateArgv(report, opts), automatic: false });
    return;
  }
  report.outcome = unlocated.length ? 'incomplete' : 'located';
  const first = failures[0];
  const test = first.observed?.failedTests?.[0];
  report.verdict = `${failures.length} failed job(s); ${located.length} located to a step.`
    + (first.step ? ` First: ${first.job} -> ${first.step.name}${test ? ` -> ${test.name}` : ''}.` : '');
  if (report.pending.length) report.issues.push({ code: 'run-still-in-progress', pending: report.pending.length });
  for (const item of unlocated) report.issues.push({ code: item.evidence?.status === 'missing' ? 'hosted-log-missing' : item.stepKind === 'no-step-reported' ? 'no-failed-step-reported' : 'step-not-found-in-log', job: item.job, runId: item.runId });
  const add = (kind, extra) => report.nextActions.push({ kind, ...extra, automatic: false });
  const sameCause = new Set();
  for (const item of located.slice(0, 4)) {
    for (const t of item.observed.failedTests.slice(0, 2)) {
      const key = `${t.name}\0${t.location?.file}:${t.location?.line}`;
      if (sameCause.has(key)) continue;
      sameCause.add(key);
      add('read-failed-test', { job: item.job, test: t.name, ...(t.location?.file ? { location: t.location, source: ['git', 'show', `${item.sha}:${(t.failedAt || t.location).file}`] } : {}), ...t.evidence });
    }
    if (!item.observed.failedTests.length) add('read-failed-step-log', { job: item.job, step: item.step.name, ...item.evidence.tail });
    if (item.workflowLocation) add('inspect-workflow-step', { job: item.job, ...item.workflowLocation });
    if (item.stepKind === 'runner-setup') add('check-runner-setup', { job: item.job, reason: 'the runner failed outside workflow steps; the project change may not be the cause' });
  }
  const runnable = located.find(item => item.command && (item.local.sameOsAsRunner || item.local.replayable));
  if (runnable) add('reproduce-step-command', { job: runnable.job, command: runnable.command, cwd: 'repository-root',
    note: runnable.local.sameOsAsRunner ? 'This host has the same OS family as the failed runner.' : 'Runs on your host, not in the runner image; a Linux replay is closer.' });
  const replay = located.find(item => item.local.replayable && item.workflowLocation);
  if (replay) add('replay-failed-job', { command: 'ci replay', args: replayArgv({ repo: report.identity.localRepo, head: replay.sha, workflow: replay.workflowLocation.path,
    job: replay.workflowJob.id, event: 'push', matrix: replay.workflowJob.matrix }) });
  const other = located.find(item => !item.local.headMatches);
  if (other) add('note-local-head-differs', { runSha: other.sha, localHead: report.identity.localHead, reason: 'the failed run is for a different commit than your local HEAD; check the failing code still exists before editing' });
  add('verify-before-next-push', { command: 'ci verify', args: ['--repo', report.identity.localRepo, '--summary'],
    reason: 'after fixing and committing, check locally before pushing again' });
}

function locateArgv(report, opts) {
  return ['--repo', report.identity.localRepo, ...(opts.run ? ['--run', String(opts.run)] : ['--head', report.identity.requested.head]),
    ...(opts.workflow ? ['--workflow', opts.workflow] : []), '--summary'];
}

export function summarizeLocate(report) {
  return { ...report, runs: report.runs.map(({ runId, attempt, workflow, sha, branch, event, conclusion, status, jobs }) => ({ runId, attempt, workflow, sha, branch, event, status, conclusion, jobs })),
    failures: report.failures.map(item => ({ job: item.job, runId: item.runId, sha: item.sha, step: item.step?.name ?? null, stepKind: item.stepKind,
      workflowLocation: item.workflowLocation, command: item.command, located: item.located,
      failedTests: (item.observed?.failedTests || []).map(({ name, location, failedAt, message }) => ({ name, location, failedAt, message })),
      errors: item.observed?.errors || [], lastLines: (item.observed?.lastLines || []).slice(-8),
      evidence: item.evidence && { status: item.evidence.status, path: item.evidence.path, startByte: item.evidence.startByte, endByte: item.evidence.endByte } })) };
}
