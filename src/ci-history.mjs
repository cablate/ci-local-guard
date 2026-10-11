import { collectAttemptJobs, githubGet, githubJobLog, runSource } from './ci-runs.mjs';
import { discoverCi } from './ci-discovery.mjs';
import { verifyCi } from './ci-verify.mjs';
import { interpolateMatrix } from './workflow-model.mjs';

// How much hosted CI time goes into failures, and how much of that a local
// pre-push check would have caught. Read-only GitHub metadata; local replays
// only with --reproduce.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { historyCode: code, ...extra }); };
const time = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : null; };
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p90 = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null; };

export function historyOptions(args) {
  const opts = { platform: {}, summary: false, reproduce: false };
  const single = ['--repo', '--repository', '--workflow', '--limit', '--reproduce-limit', '--timeout', '--act-binary', '--input', '--save-export', '--output', '--test-timing', '--compare-job', '--samples'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--summary') { opts.summary = true; continue; }
    if (key === '--json') continue; // Output is always JSON; accepted like the other ci commands.
    if (key === '--reproduce') { opts.reproduce = true; continue; }
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) fail('invalid-history-options', { detail: key });
    i += 1;
    if (key === '--platform') {
      const match = /^([A-Za-z0-9_.-]+)=(\S+)$/.exec(value);
      if (!match) fail('invalid-history-options', { detail: key });
      opts.platform[match[1]] = match[2];
    } else if (single.includes(key) && !Object.hasOwn(opts, key.slice(2))) opts[key.slice(2)] = value;
    else fail('invalid-history-options', { detail: key });
  }
  if (!opts.workflow || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(opts.workflow)) fail('workflow-file-name-required');
  for (const [key, max, fallback] of [['limit', 200, 30], ['reproduce-limit', 20, 5], ['samples', 10, 3]]) {
    if (opts[key] === undefined) opts[key] = fallback;
    else if (!/^[1-9][0-9]{0,2}$/.test(opts[key]) || Number(opts[key]) > max) fail('invalid-limit');
    else opts[key] = Number(opts[key]);
  }
  return opts;
}

// Completed runs of one workflow, every attempt (reruns hide earlier failures).
export function collectHistory({ repository, workflow, limit }, { get = githubGet, now = Date.now } = {}) {
  const started = now();
  let requests = 0;
  const read = endpoint => {
    if (requests >= 800 || now() - started > 600000) fail('collection-budget-exceeded');
    requests += 1;
    return get(endpoint);
  };
  const prefix = `repos/${repository}/actions`;
  const listed = [];
  for (let page = 1; listed.length < limit && page <= 10; page++) {
    const perPage = Math.min(100, limit);
    const result = read(`${prefix}/workflows/${workflow}/runs?status=completed&per_page=${perPage}&page=${page}`);
    if (!Array.isArray(result?.workflow_runs)) fail('invalid-run-listing');
    listed.push(...result.workflow_runs);
    if (result.workflow_runs.length < perPage) break;
  }
  const attempts = [];
  const seen = new Set();
  for (const run of listed.slice(0, limit)) {
    if (!Number.isSafeInteger(run?.id) || seen.has(run.id) || !/^[a-f0-9]{40}$/.test(run.head_sha || '')) fail('invalid-run-identity');
    seen.add(run.id);
    for (let attempt = run.run_attempt; attempt >= 1; attempt -= 1) {
      const detail = read(`${prefix}/runs/${run.id}/attempts/${attempt}`);
      if (detail?.id !== run.id || detail.run_attempt !== attempt || detail.head_sha !== run.head_sha) fail('run-attempt-identity-mismatch');
      attempts.push(collectAttemptJobs(prefix, detail, runSource(detail), read));
    }
  }
  return { schemaVersion: 'ci-local-guard/github-export/v1', repository, runs: attempts,
    collection: { host: 'github.com', workflow, attempts: 'history', requestedLimit: limit, listedRuns: Math.min(listed.length, limit),
      returnedAttempts: attempts.length, completedListingOnly: true, requests, collectedAt: new Date(now()).toISOString() } };
}

// Per attempt: wall time from start to the last job, summed job seconds, and
// billable minutes estimated as GitHub does (each started job rounded up to a
// minute; skipped and never-started jobs are not billed).
export function measure(entry) {
  const start = time(entry.run.run_started_at) ?? time(entry.run.created_at);
  const jobs = entry.jobs.jobs.map(job => {
    const a = time(job.started_at); const b = time(job.completed_at);
    const seconds = a !== null && b !== null && b >= a ? Math.round((b - a) / 1000) : null;
    const os = (job.labels || []).map(String).find(label => /windows|macos|ubuntu|linux/i.test(label)) || (job.labels || [])[0] || null;
    const steps = (job.steps || []).map(step => {
      const s = time(step.started_at); const e = time(step.completed_at);
      return { name: step.name, seconds: s !== null && e !== null && e >= s ? Math.round((e - s) / 1000) : null };
    });
    return { name: job.name, id: job.id ?? null, conclusion: job.conclusion, seconds, os, startedAt: a, completedAt: b, steps,
      failedSteps: (job.steps || []).filter(step => step.conclusion === 'failure').map(step => step.name) };
  });
  const ends = entry.jobs.jobs.map(job => time(job.completed_at)).filter(value => value !== null);
  const known = jobs.filter(job => job.seconds !== null);
  const billed = known.filter(job => job.conclusion !== 'skipped');
  return { runId: entry.run.id, attempt: entry.run.run_attempt, sha: entry.run.head_sha, branch: entry.run.head_branch,
    event: entry.run.event, conclusion: entry.run.conclusion, startedAt: entry.run.run_started_at,
    waitSeconds: start !== null && ends.length ? Math.round((Math.max(...ends) - start) / 1000) : null,
    jobSeconds: billed.reduce((sum, job) => sum + job.seconds, 0),
    billableMinutes: billed.reduce((sum, job) => sum + Math.max(1, Math.ceil(job.seconds / 60)), 0),
    skippedJobs: jobs.filter(job => job.conclusion === 'skipped').length,
    timingComplete: known.length === jobs.length, jobs };
}

// GitHub names matrix jobs "name (v1, v2)" unless the name already uses matrix values.
// Which jobs of an attempt a hosted job waits for: its declared needs when the
// workflow maps its name, otherwise (unless declaredOnly) the jobs that had
// finished before it started.
export function needsResolver(workflow) {
  const names = workflow ? hostedNames(workflow) : new Map();
  const needsById = new Map((workflow?.jobs || []).map(job => [job.id, job.needs || []]));
  return (job, attemptJobs, { declaredOnly = false } = {}) => {
    const target = names.get(job.name);
    if (target) {
      const needs = needsById.get(target.job) || [];
      return attemptJobs.filter(other => other !== job && needs.includes(names.get(other.name)?.job));
    }
    if (declaredOnly || job.startedAt === null || job.startedAt === undefined) return [];
    return attemptJobs.filter(other => other !== job && other.completedAt !== null && other.completedAt <= job.startedAt);
  };
}

// The job that set an attempt's wait. An aggregating gate job finishes last
// but only waits for the others; when it is shorter than half of the job it
// waited on, walk back to that job.
export function criticalJob(attemptJobs, needsOf = needsResolver(null)) {
  const ended = attemptJobs.filter(job => job.completedAt !== null && job.conclusion !== 'skipped');
  if (!ended.length) return null;
  let current = ended.reduce((a, b) => (b.completedAt > a.completedAt ? b : a));
  const gates = [];
  for (let hops = 0; hops < 8; hops++) {
    const needed = needsOf(current, ended);
    if (!needed.length) break;
    const waitedOn = needed.reduce((a, b) => (b.completedAt > a.completedAt ? b : a));
    if (current.seconds === null || waitedOn.seconds === null || current.seconds * 2 > waitedOn.seconds) break;
    gates.push(current.name);
    current = waitedOn;
  }
  return { job: current, gates };
}

export function hostedNames(workflow) {
  const names = new Map();
  for (const job of workflow.jobs || []) {
    const legs = [...job.localReplay.replayable.map(item => item.matrix), ...job.localReplay.hostedOnly.map(item => item.matrix),
      ...job.localReplay.unknown.map(item => item.matrix).filter(Boolean)];
    const base = job.name ?? job.id;
    for (const leg of legs.length ? legs : [{}]) {
      const values = Object.values(leg).filter(value => typeof value !== 'object');
      const name = /\$\{\{\s*matrix\./.test(base) ? interpolateMatrix(base, leg) : values.length ? `${base} (${values.join(', ')})` : base;
      if (name) names.set(name, { job: job.id, matrix: leg });
    }
  }
  return names;
}

const sameLeg = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Compare one failed hosted attempt with a local verify of the same commit.
export function classify(failed, verify, workflowPath, names) {
  return failed.jobs.filter(job => job.conclusion === 'failure').map(job => {
    const target = names.get(job.name);
    const base = { name: job.name, failedSteps: job.failedSteps };
    if (!target) return { ...base, class: 'undetermined', reason: 'job name not found in the workflow at this commit' };
    const mine = item => item.workflow === workflowPath && item.job === target.job && (!item.matrix || sameLeg(item.matrix, target.matrix));
    // A needed job runs inside the replay of the job that needs it. Other legs
    // of the same job are separate targets, never "inside".
    const insideResult = item => item.workflow === workflowPath && item.job !== target.job
      ? item.jobs?.find(leg => leg.job === target.job)?.result : undefined;
    const replays = [...verify.expectedFailures.filter(item => item.kind === 'replay'), ...verify.passedLocally];
    const failedHere = verify.expectedFailures.find(item => item.kind === 'replay' && (mine(item) || insideResult(item) === 'failure'));
    if (failedHere) return { ...base, class: 'reproduced-locally', localFailure: failedHere.failures?.map(item => ({ step: item.step, failedTests: item.failedTests })) };
    if (verify.passedLocally.some(mine) || replays.some(item => insideResult(item) === 'success')) {
      return { ...base, class: 'passed-locally', reason: 'local replay passed: environment difference, flaky test, or a check that needs the hosted runner' };
    }
    const hosted = verify.hostedOnly.find(mine);
    if (hosted) return { ...base, class: 'outside-local-coverage', reason: hosted.reason };
    if (verify.expectedFailures.some(item => item.kind !== 'replay')) return { ...base, class: 'reproduced-locally', reason: 'workflow static check or YAML failure at this commit' };
    const pending = verify.notVerified.find(item => mine(item));
    return { ...base, class: 'undetermined', reason: pending?.reason || `local verify ${verify.outcome}` };
  });
}

function summarizeAttempts(measured, needsOf = needsResolver(null)) {
  const pick = list => ({ count: list.length, waitSeconds: { median: median(list.map(x => x.waitSeconds).filter(v => v !== null)), p90: p90(list.map(x => x.waitSeconds).filter(v => v !== null)) },
    jobSeconds: { median: median(list.map(x => x.jobSeconds)) }, billableMinutes: { median: median(list.map(x => x.billableMinutes)) } });
  const jobs = new Map();
  for (const attempt of measured.filter(x => x.conclusion === 'success')) for (const job of attempt.jobs) {
    if (job.seconds === null || job.conclusion === 'skipped') continue;
    if (!jobs.has(job.name)) jobs.set(job.name, { name: job.name, os: job.os, seconds: [] });
    jobs.get(job.name).seconds.push(job.seconds);
  }
  const successes = measured.filter(x => x.conclusion === 'success');
  // The job that sets the wait: the last to finish, or the job a gate waited on.
  const lastCounts = new Map();
  const gateCounts = new Map();
  const stepTimes = new Map();
  for (const attempt of successes) {
    const critical = criticalJob(attempt.jobs, needsOf);
    if (critical) {
      lastCounts.set(critical.job.name, (lastCounts.get(critical.job.name) || 0) + 1);
      for (const gate of critical.gates) gateCounts.set(gate, (gateCounts.get(gate) || 0) + 1);
    }
    for (const job of attempt.jobs) for (const step of job.steps || []) {
      if (step.seconds === null) continue;
      const key = `${job.name}\0${step.name}`;
      if (!stepTimes.has(key)) stepTimes.set(key, []);
      stepTimes.get(key).push(step.seconds);
    }
  }
  const jobList = [...jobs.values()].map(job => {
    const steps = [...stepTimes].filter(([key]) => key.startsWith(`${job.name}\0`))
      .map(([key, list]) => ({ name: key.split('\0')[1], medianSeconds: median(list), setup: isSetupStep(key.split('\0')[1]) }))
      .sort((a, b) => b.medianSeconds - a.medianSeconds);
    return { name: job.name, os: job.os, runs: job.seconds.length, medianSeconds: median(job.seconds), p90Seconds: p90(job.seconds),
      finishedLast: lastCounts.get(job.name) || 0, ...(gateCounts.get(job.name) ? { gateIn: gateCounts.get(job.name) } : {}), steps: steps.slice(0, 8),
      setupSeconds: steps.filter(step => step.setup).reduce((sum, step) => sum + step.medianSeconds, 0) };
  }).sort((a, b) => b.medianSeconds - a.medianSeconds);
  return { success: pick(successes), jobs: jobList, speedLeads: speedLeads(jobList, successes.length) };
}

// TAP results with YAML diagnostics (node --test and other TAP producers):
// "ok 3 - name" followed by "duration_ms: 12.3". Timestamps from GitHub logs
// are removed first. Returns Map(name -> ms) for top-level and nested tests.
export function tapDurations(text) {
  const durations = new Map();
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '');
    const result = /^\s*(?:not )?ok \d+ - (.+?)(?:\s+# (?:SKIP|TODO).*)?$/.exec(line);
    if (result) { pending = result[1].slice(0, 300); continue; }
    const duration = /^\s+duration_ms: ([\d.]+)\s*$/.exec(line);
    if (duration && pending !== null) {
      if (!durations.has(pending)) durations.set(pending, Number(duration[1]));
      pending = null;
    }
  }
  return durations;
}

// Test durations for one job over recent successful attempts, optionally
// against another job (for example the other matrix leg).
export function testTiming(measured, { job, compare, samples = 3, repository }, fetchLog) {
  const pick = name => measured.filter(attempt => attempt.conclusion === 'success')
    .map(attempt => ({ runId: attempt.runId, attempt: attempt.attempt, job: attempt.jobs.find(item => item.name === name) }))
    // A successful run can still skip this job; only its own success has a log.
    .filter(item => item.job?.id && item.job.conclusion === 'success').slice(0, samples);
  const collect = name => {
    const chosen = pick(name);
    const perTest = new Map();
    const sources = [];
    for (const item of chosen) {
      let text;
      try { text = fetchLog(repository, item.job.id); }
      catch { sources.push({ runId: item.runId, jobId: item.job.id, status: 'log-unavailable' }); continue; }
      const durations = tapDurations(text);
      sources.push({ runId: item.runId, jobId: item.job.id, status: durations.size ? 'parsed' : 'no-tap-durations', tests: durations.size });
      for (const [test, ms] of durations) perTest.set(test, [...(perTest.get(test) || []), ms]);
    }
    return { sources, perTest };
  };
  const main = collect(job);
  if (!main.perTest.size) return { job, status: 'no-test-durations', sources: main.sources,
    meaning: 'No TAP duration_ms lines were found in these logs. Other report formats are not parsed yet.' };
  const other = compare ? collect(compare) : null;
  const rows = [...main.perTest].map(([test, list]) => {
    const ms = median(list);
    const versus = other?.perTest.get(test);
    return { test, medianMs: Math.round(ms), ...(versus ? { compareMedianMs: Math.round(median(versus)), ratio: Math.round((ms / Math.max(1, median(versus))) * 10) / 10 } : {}) };
  }).sort((a, b) => b.medianMs - a.medianMs);
  const sum = rows.reduce((total, row) => total + row.medianMs, 0);
  const compareSum = rows.reduce((total, row) => total + (row.compareMedianMs || 0), 0);
  // The longest non-setup step, as a median over the same sampled attempts.
  const sampled = pick(job).map(item => item.job.steps.filter(step => !isSetupStep(step.name) && step.seconds !== null));
  const names = new Map();
  for (const steps of sampled) for (const step of steps) names.set(step.name, [...(names.get(step.name) || []), step.seconds]);
  const longestStep = [...names].map(([name, list]) => ({ name, seconds: median(list) })).sort((a, b) => b.seconds - a.seconds)[0];
  return { job, compare: compare || null, status: 'measured', sources: main.sources, compareSources: other?.sources || null,
    tests: rows.length, sumOfTestsSeconds: Math.round(sum / 1000), ...(other ? { compareSumOfTestsSeconds: Math.round(compareSum / 1000) } : {}),
    longestStep: longestStep ? { name: longestStep.name, seconds: longestStep.seconds } : null,
    parallelism: longestStep?.seconds ? Math.round((sum / 1000 / longestStep.seconds) * 10) / 10 : null,
    slowest: rows.slice(0, 20),
    meaning: 'Durations are reported by the test runner. A sum larger than the step time means tests ran in parallel, so the step ends with the slowest worker, not after the sum.' };
}

const isSetupStep = name => /^(Set up job|Complete job|Post |Run actions\/(checkout|setup-[a-z]+|cache)@)/.test(name);

// Evidence-backed places to look, not conclusions: each lead says what the
// numbers show and what would have to be measured before changing anything.
function speedLeads(jobs, runs) {
  const leads = [];
  if (!runs || !jobs.length) return leads;
  const critical = [...jobs].sort((a, b) => b.finishedLast - a.finishedLast)[0];
  const next = jobs.filter(job => job.name !== critical.name).sort((a, b) => b.medianSeconds - a.medianSeconds)[0];
  if (critical.finishedLast / runs >= 0.5) {
    const gates = jobs.filter(job => job.gateIn).map(job => ({ name: job.name, medianSeconds: job.medianSeconds, gateIn: `${job.gateIn}/${runs}` }));
    leads.push({ kind: 'critical-job', job: critical.name, finishedLastIn: `${critical.finishedLast}/${runs}`, medianSeconds: critical.medianSeconds,
      nextLongestJob: next ? { name: next.name, medianSeconds: next.medianSeconds } : null, ...(gates.length ? { gateJobs: gates } : {}),
      meaning: `Waiting time follows this job${gates.length ? ` (${gates.map(gate => gate.name).join(', ')} finishes after it but only waits for it)` : ''}. Speeding up other jobs will not shorten the wait${next ? `; at best the wait drops toward ${next.medianSeconds}s plus setup` : ''}.` });
    const step = critical.steps.find(item => !item.setup);
    if (step && critical.medianSeconds && step.medianSeconds / critical.medianSeconds >= 0.5) {
      leads.push({ kind: 'dominant-step', job: critical.name, step: step.name, medianSeconds: step.medianSeconds,
        shareOfJob: Math.round((step.medianSeconds / critical.medianSeconds) * 100) / 100,
        meaning: 'Most of the critical job is this step. Look inside it (for tests: --test-timing) before changing the workflow.' });
    }
    if (critical.medianSeconds && critical.setupSeconds / critical.medianSeconds >= 0.3) {
      leads.push({ kind: 'setup-overhead', job: critical.name, setupSeconds: critical.setupSeconds,
        meaning: 'Checkout, toolchain setup and post steps take a large share; caching or a lighter setup may help.' });
    }
  }
  // Matrix legs of the same job with very different durations.
  const groups = new Map();
  for (const job of jobs) {
    const base = /^(.*) \(.+\)$/.exec(job.name)?.[1];
    if (base) groups.set(base, [...(groups.get(base) || []), job]);
  }
  for (const [base, legs] of groups) {
    const sorted = [...legs].sort((a, b) => b.medianSeconds - a.medianSeconds);
    if (sorted.length > 1 && sorted.at(-1).medianSeconds > 0 && sorted[0].medianSeconds / sorted.at(-1).medianSeconds >= 3) {
      leads.push({ kind: 'leg-disparity', job: base, slowest: { name: sorted[0].name, medianSeconds: sorted[0].medianSeconds },
        fastest: { name: sorted.at(-1).name, medianSeconds: sorted.at(-1).medianSeconds },
        meaning: 'The same work is much slower on one runner. Compare test timings between the legs to find what is platform-sensitive.' });
    }
  }
  return leads;
}

export async function historyCi(opts, deps = {}) {
  const { collect = collectHistory, discover = discoverCi, verify = verifyCi, readExport, saveExport, fetchLog = githubJobLog,
    progress = text => process.stderr.write(`[ci-local-guard] ${text}\n`) } = deps;
  const report = { schemaVersion: 'ci-local-guard/ci-history/v1', command: 'ci history', identity: null, outcome: 'blocked',
    verdict: null, baseline: null, failures: null, reproduction: { status: opts.reproduce ? 'pending' : 'not-requested', items: [] },
    avoidable: null, issues: [], nextActions: [],
    limitation: 'GitHub metadata only, plus local verify of failed commits when requested. Wait time runs from attempt start to the last job and includes queueing after the start; billable minutes round each job up to a minute and ignore runner-type multipliers and free allowances.' };
  try {
    const inventory = discover({ repo: opts.repo, head: 'HEAD' });
    const repository = opts.repository || inventory.identity.repository;
    if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('github-repository-required');
    let exported;
    if (opts.input) {
      try { exported = readExport(opts.input); } catch { fail('input-unreadable'); }
      if (exported?.schemaVersion !== 'ci-local-guard/github-export/v1' || !Array.isArray(exported.runs)) fail('invalid-export');
    } else exported = collect({ repository, workflow: opts.workflow, limit: opts.limit });
    if (opts['save-export']) {
      try { saveExport(opts['save-export'], exported); report.savedExport = opts['save-export']; }
      catch { report.issues.push({ code: 'export-not-saved', reason: 'file exists or is not writable' }); }
    }
    const measured = exported.runs.map(measure);
    const times = measured.map(x => time(x.startedAt)).filter(v => v !== null);
    report.identity = { repository, workflow: opts.workflow, localRepo: inventory.identity.repo, source: opts.input ? 'saved-export' : 'github-api',
      runs: new Set(measured.map(x => x.runId)).size, attempts: measured.length,
      window: times.length ? { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() } : null };
    const workflow = inventory.workflows?.find(item => item.path === `.github/workflows/${opts.workflow}` && item.analysis === 'parsed') || null;
    const needsOf = needsResolver(workflow);
    report.baseline = summarizeAttempts(measured, needsOf);
    const failed = measured.filter(x => x.conclusion === 'failure');
    // A job that failed only because a job it declares in needs failed is the
    // gate's echo of that failure; count it apart, not as a second failure.
    const downstream = new Map();
    const ownFailures = failed.flatMap(x => x.jobs.filter(job => job.conclusion === 'failure').filter(job => {
      const echo = needsOf(job, x.jobs, { declaredOnly: true }).some(need => need.conclusion === 'failure');
      if (echo) downstream.set(job.name, (downstream.get(job.name) || 0) + 1);
      return !echo;
    }).map(job => job.name));
    // Hosted data alone: a failure followed by a success on the same commit
    // (a rerun attempt or a later run) is flaky, not something a pre-push
    // check could have caught.
    const flakyOf = new Map(failed.map(x => [x, measured.some(other => other.sha === x.sha && other.conclusion === 'success'
      && (other.runId === x.runId ? other.attempt > x.attempt : (time(other.startedAt) ?? 0) > (time(x.startedAt) ?? 0)))]));
    const flaky = failed.filter(x => flakyOf.get(x));
    const total = list => ({ attempts: list.length, waitSeconds: list.reduce((s, x) => s + (x.waitSeconds || 0), 0),
      billableMinutes: list.reduce((s, x) => s + x.billableMinutes, 0) });
    report.failures = { count: failed.length, waitSeconds: failed.reduce((s, x) => s + (x.waitSeconds || 0), 0),
      flaky: { ...total(flaky), meaning: 'failed, then passed on the same commit without a code change (rerun or later run); hosted metadata only, nothing replayed' },
      persistent: total(failed.filter(x => !flakyOf.get(x))),
      jobSeconds: failed.reduce((s, x) => s + x.jobSeconds, 0), billableMinutes: failed.reduce((s, x) => s + x.billableMinutes, 0),
      byJob: Object.entries(ownFailures.reduce((acc, name) => ({ ...acc, [name]: (acc[name] || 0) + 1 }), {}))
        .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      ...(downstream.size ? { downstreamOfFailedNeeds: [...downstream].map(([name, count]) => ({ name, count })) } : {}),
      attempts: failed.map(x => ({ runId: x.runId, attempt: x.attempt, sha: x.sha, branch: x.branch, event: x.event, waitSeconds: x.waitSeconds,
        billableMinutes: x.billableMinutes, skippedJobs: x.skippedJobs, ...(flakyOf.get(x) ? { flaky: true } : {}),
        failedJobs: x.jobs.filter(job => job.conclusion === 'failure').map(job => ({ name: job.name, failedSteps: job.failedSteps })) })) };

    if (opts['test-timing']) {
      report.testTiming = testTiming(measured, { job: opts['test-timing'], compare: opts['compare-job'], samples: opts.samples, repository }, fetchLog);
    }
    if (opts.reproduce) {
      const workflowPath = `.github/workflows/${opts.workflow}`;
      const candidates = [];
      // Flaky commits passed later on hosted CI; replaying them costs minutes
      // and cannot show a pre-push catch, so they are classified, not replayed.
      for (const attempt of flaky) report.reproduction.items.push({ runId: attempt.runId, attempt: attempt.attempt, sha: attempt.sha,
        runClass: 'flaky', reason: 'passed later on the same commit; not replayed' });
      for (const attempt of failed) if (!flakyOf.get(attempt) && !candidates.some(x => x.sha === attempt.sha) && ['push', 'pull_request'].includes(attempt.event)) candidates.push(attempt);
      for (const attempt of failed.filter(x => !flakyOf.get(x) && !['push', 'pull_request'].includes(x.event))) {
        report.reproduction.items.push({ runId: attempt.runId, attempt: attempt.attempt, sha: attempt.sha, runClass: 'undetermined', reason: `event ${attempt.event} is not replayed` });
      }
      const selected = candidates.slice(0, opts['reproduce-limit']);
      // A rough budget from the hosted runs: each replay runs the workflow's
      // jobs one after another, so the summed job time of a failed attempt.
      const estimate = selected.reduce((sum, attempt) => sum + attempt.jobSeconds, 0);
      report.reproduction.estimate = { commits: selected.length, hostedJobSeconds: estimate,
        meaning: 'summed hosted job seconds of the selected failed attempts; local replays add image and toolchain setup and can take several times longer' };
      progress(`ci history --reproduce: ${selected.length} commit(s) to replay${flaky.length ? `, ${flaky.length} flaky attempt(s) skipped` : ''}; hosted jobs took about ${Math.round(estimate / 60)} min, expect longer locally`);
      for (const [index, attempt] of selected.entries()) {
        progress(`ci history --reproduce: commit ${index + 1}/${selected.length} ${attempt.sha.slice(0, 12)} (${attempt.event}; hosted jobs took ${Math.round(attempt.jobSeconds / 60)} min)`);
        const at = discover({ repo: opts.repo, head: attempt.sha });
        const wf = at.workflows.find(item => item.path === workflowPath);
        if (!wf || wf.analysis !== 'parsed') {
          report.reproduction.items.push({ runId: attempt.runId, sha: attempt.sha, runClass: 'undetermined', reason: 'workflow missing or unparsable at this commit locally' });
          continue;
        }
        const result = await verify({ repo: opts.repo, head: attempt.sha, base: `${attempt.sha}^`, event: attempt.event,
          ref: attempt.event === 'push' && attempt.branch ? `refs/heads/${attempt.branch}` : undefined,
          platform: opts.platform, timeout: opts.timeout,
          'act-binary': opts['act-binary'], pull: false, staticOnly: false });
        const jobs = classify(attempt, result, workflowPath, hostedNames(wf));
        const runClass = jobs.some(job => job.class === 'reproduced-locally') ? 'avoidable'
          : jobs.every(job => job.class === 'outside-local-coverage') ? 'outside-local-coverage'
            : jobs.some(job => job.class === 'undetermined') ? 'undetermined' : 'not-reproduced';
        for (const same of failed.filter(x => x.sha === attempt.sha)) {
          report.reproduction.items.push({ runId: same.runId, attempt: same.attempt, sha: same.sha, runClass, jobs,
            localVerdict: result.verdict, localOutcome: result.outcome });
        }
      }
      for (const attempt of candidates.slice(opts['reproduce-limit'])) {
        for (const same of failed.filter(x => x.sha === attempt.sha)) report.reproduction.items.push({ runId: same.runId, attempt: same.attempt, sha: same.sha, runClass: 'not-checked', reason: 'beyond --reproduce-limit' });
      }
      report.reproduction.status = 'done';
      const byClass = cls => report.reproduction.items.filter(item => item.runClass === cls);
      const cost = items => items.reduce((acc, item) => {
        const x = failed.find(f => f.runId === item.runId && f.attempt === item.attempt);
        return { attempts: acc.attempts + 1, waitSeconds: acc.waitSeconds + (x?.waitSeconds || 0), billableMinutes: acc.billableMinutes + (x?.billableMinutes || 0) };
      }, { attempts: 0, waitSeconds: 0, billableMinutes: 0 });
      report.avoidable = { avoidable: cost(byClass('avoidable')), outsideLocalCoverage: cost(byClass('outside-local-coverage')),
        notReproduced: cost(byClass('not-reproduced')), flaky: cost(byClass('flaky')), undetermined: cost([...byClass('undetermined'), ...byClass('not-checked')]),
        meaning: 'avoidable = a local ci verify of the same commit fails the same job before pushing' };
    }
    report.outcome = 'measured';
    report.verdict = verdict(report);
    nextSteps(report, opts);
  } catch (error) {
    if (!error.historyCode && !/^[a-z-]+$/.test(error.message)) {
      report.issues.push({ code: 'github-metadata-unavailable', hint: 'check gh installation, login and Actions read access' });
    } else report.issues.push({ code: error.historyCode || error.message });
    report.outcome = 'blocked';
  }
  return report;
}

function verdict(report) {
  const b = report.baseline.success;
  const parts = [`${report.identity.attempts} attempts of ${report.identity.workflow}`,
    `successful runs: median wait ${b.waitSeconds.median ?? '?'}s (p90 ${b.waitSeconds.p90 ?? '?'}s), median ${b.billableMinutes.median ?? '?'} billable min`,
    `${report.failures.count} failed attempt(s) used ${report.failures.waitSeconds}s of waiting and ${report.failures.billableMinutes} billable min`
      + (report.failures.flaky.attempts ? ` (${report.failures.flaky.attempts} flaky: passed later on the same commit, ${report.failures.flaky.billableMinutes} min)` : '')];
  if (report.avoidable) {
    const a = report.avoidable;
    parts.push(`avoidable with local verify: ${a.avoidable.attempts} attempt(s), ${a.avoidable.waitSeconds}s, ${a.avoidable.billableMinutes} min`);
    parts.push(`outside local coverage: ${a.outsideLocalCoverage.attempts}; passed locally: ${a.notReproduced.attempts}; flaky (not replayed): ${a.flaky.attempts}; undetermined: ${a.undetermined.attempts}`);
  }
  return parts.join('; ');
}

function nextSteps(report, opts) {
  const add = (kind, extra) => report.nextActions.push({ kind, ...extra, automatic: false });
  if (report.failures.flaky.attempts) add('investigate-flaky-failures', { count: report.failures.flaky.attempts,
    billableMinutes: report.failures.flaky.billableMinutes, jobs: [...new Set(report.failures.attempts.filter(item => item.flaky)
      .flatMap(item => item.failedJobs.map(job => job.name)))].slice(0, 10),
    note: 'These failed and then passed on the same commit. A pre-push check would not catch them; look at test stability (timeouts, ordering, shared state) instead.' });
  if (!opts.reproduce && report.failures.persistent.attempts) add('classify-failures-locally', { command: 'ci history',
    args: ['--repo', opts.repo || '.', '--workflow', opts.workflow, '--limit', String(opts.limit), '--reproduce', '--summary'],
    note: 'Replays each failed commit locally, skipping flaky ones; runs project code in containers.' });
  const slow = report.baseline.jobs[0];
  if (slow) add('inspect-slowest-job', { job: slow.name, medianSeconds: slow.medianSeconds, note: 'A candidate for speed work, not proof of waste.' });
  const outside = report.reproduction.items.filter(item => item.runClass === 'outside-local-coverage');
  if (outside.length) add('review-hosted-only-failures', { count: outside.length, note: 'These failures cannot be caught locally; consider whether the platform-specific checks can run earlier or more cheaply.' });
}

export function summarizeHistory(report) {
  return { ...report, failures: report.failures && { ...report.failures, attempts: report.failures.attempts.slice(0, 10) },
    reproduction: { ...report.reproduction, items: report.reproduction.items.map(({ localVerdict, ...item }) => item) } };
}
