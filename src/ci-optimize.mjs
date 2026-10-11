import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { discoverCi } from './ci-discovery.mjs';
import { collectHistory, hostedNames, measure } from './ci-history.mjs';
import { githubGet } from './ci-runs.mjs';
import { isMap, LineCounter, parseDocument } from './vendor/yaml/index.js';

// Efficiency candidates (north-star F11): committed workflow structure plus,
// when gh works, the hosted history of that workflow. Read-only; nothing is
// executed and no tool is downloaded. Findings are places to look with line
// numbers and medians, not proven savings.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { optimizeCode: code, ...extra }); };
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const HISTORY_LIMIT = 15;
// An install command at a command position (line start, or after &&, || or ;).
const INSTALL_COMMAND = /(?:^|[&|;]\s*)(?:sudo\s+)?(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install|pip3?\s+install|poetry\s+install|bundle\s+install)(?=\s|$)/m;
// Hosted display names, aligned with ci-history's setup classification.
const isSetupStep = name => /^(Set up job|Complete job|Post |Run actions\/(checkout|setup-[a-z]+|cache)@)/.test(name);
const stepDisplayName = step => step.name || `Run ${(step.run || '').split(/\r?\n/).find(line => line.trim())?.trim() || ''}`;

// Committed workflow blob, by the SHA discovery already resolved for it.
function readWorkflowSource(repo, blob) {
  if (!/^[a-f0-9]{40}$/.test(blob || '')) throw new Error('workflow-source-unavailable');
  const result = spawnSync('git', ['-C', repo || '.', 'cat-file', 'blob', blob], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('workflow-source-unavailable');
  return result.stdout;
}

// What discovery's structure does not carry: top-level timeout-minutes and
// concurrency, job-level concurrency, and `cache:` inputs on setup steps.
// Line numbers come from the same LineCounter mechanism as workflow-model.
function supplement(source) {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, uniqueKeys: true, prettyErrors: false, maxAliasCount: 64 });
  if (doc.errors.length || !isMap(doc.contents)) return null;
  const root = doc.contents;
  const out = { workflowTimeout: root.has('timeout-minutes'), workflowConcurrency: root.has('concurrency'), onLine: 1, jobs: new Map() };
  for (const pair of root.items) {
    if (pair.key?.value === 'on' && pair.key.range) out.onLine = lines.linePos(pair.key.range[0]).line;
  }
  const jobsNode = root.get('jobs', true);
  if (!isMap(jobsNode)) return out;
  for (const pair of jobsNode.items) {
    const id = typeof pair.key?.value === 'string' ? pair.key.value : null;
    if (!id || !isMap(pair.value)) continue;
    const node = pair.value;
    const entry = { timeout: node.has('timeout-minutes'), concurrency: node.has('concurrency'), cachedStepLines: new Set() };
    const stepsNode = node.get('steps', true);
    if (Array.isArray(stepsNode?.items)) for (const step of stepsNode.items) {
      if (!isMap(step)) continue;
      const uses = step.get('uses');
      if (typeof uses !== 'string' || !uses.includes('setup-')) continue;
      const withNode = step.get('with', true);
      const cache = isMap(withNode) ? withNode.get('cache') : undefined;
      const enabled = cache !== undefined && cache !== false && !['false', 'none', ''].includes(String(cache));
      if (enabled && step.range) entry.cachedStepLines.add(lines.linePos(step.range[0]).line);
    }
    out.jobs.set(id, entry);
  }
  return out;
}

// Only trigger patterns that re-fire for pushes to a branch: pull_request, a
// push with branch filters (including '**'), or an unfiltered push (every
// branch). Tag/release/dispatch/cron-only workflows are never reported.
function repeatsPerPush(triggers = []) {
  return triggers.some(trigger => {
    if (trigger.event === 'pull_request') return true;
    if (trigger.event !== 'push') return false;
    const filters = trigger.filters || {};
    if (filters.branches?.length || filters['branches-ignore']?.length) return true;
    if (filters.tags?.length || filters['tags-ignore']?.length) return false;
    return true;
  });
}

function staticFindings(workflow, sup, timing, supplements) {
  const findings = [];
  // 1. No timeout-minutes at the job level or the workflow level. A reusable
  // call job cannot set timeout-minutes itself; it is bounded when the
  // workflow it calls carries a workflow-level timeout.
  for (const job of workflow.jobs || []) {
    const s = sup.jobs.get(job.id);
    if (sup.workflowTimeout || s?.timeout) continue;
    if (job.uses) {
      // A call job cannot set timeout-minutes; it is bounded when every job
      // of the called (local) workflow carries its own timeout.
      const called = supplements.get(job.uses.replace(/^\.\//, ''));
      if (called && called.jobs.size && [...called.jobs.values()].every(entry => entry.timeout)) continue;
      findings.push({ code: 'missing-timeout-minutes', workflow: workflow.path, job: job.id, line: job.line, impact: 'risk',
        evidence: { kind: 'static' },
        suggestion: `Job "${job.id}" calls a reusable workflow and cannot set timeout-minutes itself; give every job of ${job.uses.replace(/^\.\//, '')} a timeout-minutes to bound it.` });
      continue;
    }
    findings.push({ code: 'missing-timeout-minutes', workflow: workflow.path, job: job.id, line: job.line, impact: 'risk',
      evidence: { kind: 'static' },
      suggestion: `Add timeout-minutes (for example 15) to job "${job.id}" so a stuck run cannot burn up to GitHub's 360-minute default; this bounds the worst case, it is not waste that already happened.` });
  }
  // 2. Re-firing triggers with no concurrency group anywhere.
  if (repeatsPerPush(workflow.triggers) && !sup.workflowConcurrency
    && !(workflow.jobs || []).some(job => sup.jobs.get(job.id)?.concurrency)) {
    findings.push({ code: 'missing-concurrency-cancel', workflow: workflow.path, line: sup.onLine, impact: 'risk',
      evidence: { kind: 'static' },
      suggestion: 'Add a workflow-level concurrency group (for example group: \${{ github.workflow }}-\${{ github.ref }} with cancel-in-progress: true) so a newer push cancels the superseded run.' });
  }
  // 3. Dependency installs in a job with no caching of any kind.
  for (const job of workflow.jobs || []) {
    const s = sup.jobs.get(job.id);
    const cached = (s?.cachedStepLines?.size || 0) > 0
      || (job.steps || []).some(step => step.uses && /^actions\/cache/.test(step.uses));
    if (cached) continue;
    for (const step of job.steps || []) {
      if (!step.run || !INSTALL_COMMAND.test(step.run)) continue;
      const name = stepDisplayName(step);
      const observed = timing ? timing(job.id, name) : null;
      findings.push({ code: 'uncached-dependency-install', workflow: workflow.path, job: job.id, step: name, line: step.line,
        impact: 'total-minutes',
        evidence: observed ? { kind: 'history', seconds: observed.seconds, samples: observed.samples } : { kind: 'static' },
        suggestion: 'Cache dependencies: actions/setup-node with cache: npm (or actions/cache keyed on the lockfile) in this job.' });
    }
  }
  return findings;
}

// History findings for one workflow. The critical path is the job that
// finished last, following ci-history's algorithm (most-finished-last, held
// only when it was last in at least half of the successful attempts).
function historyAnalyze(workflow, exported) {
  const measured = (exported?.runs || []).map(measure);
  const successes = measured.filter(item => item.conclusion === 'success');
  const none = { findings: [], stats: { attempts: measured.length, successes: 0, stepTiming: () => null } };
  if (!successes.length) return none;
  const jobSeconds = new Map();
  const finishedLast = new Map();
  const stepSeconds = new Map(); // `${hostedJobName}\0${stepName}` -> [seconds]
  for (const attempt of successes) {
    const ended = attempt.jobs.filter(job => job.completedAt !== null);
    if (ended.length) {
      const last = ended.reduce((a, b) => (b.completedAt > a.completedAt ? b : a));
      finishedLast.set(last.name, (finishedLast.get(last.name) || 0) + 1);
    }
    for (const job of attempt.jobs) {
      if (job.seconds === null || job.conclusion === 'skipped') continue;
      jobSeconds.set(job.name, [...(jobSeconds.get(job.name) || []), job.seconds]);
      for (const step of job.steps || []) if (step.seconds !== null) {
        const key = `${job.name}\0${step.name}`;
        stepSeconds.set(key, [...(stepSeconds.get(key) || []), step.seconds]);
      }
    }
  }
  const jobs = [...jobSeconds.entries()].map(([name, list]) => ({ name, medianSeconds: median(list), samples: list.length,
    finishedLast: finishedLast.get(name) || 0 })).sort((a, b) => b.medianSeconds - a.medianSeconds);
  const names = hostedNames(workflow); // hosted display name -> { job, matrix }
  const hostedByJob = new Map();
  for (const [name, target] of names) hostedByJob.set(target.job, [...(hostedByJob.get(target.job) || []), name]);
  const jobLine = jobId => workflow.jobs?.find(job => job.id === jobId)?.line ?? null;
  const findings = [];
  const critical = [...jobs].sort((a, b) => b.finishedLast - a.finishedLast)[0];
  if (critical && critical.finishedLast / successes.length >= 0.5) {
    const criticalTarget = names.get(critical.name);
    // 4. One step takes at least 60% of the critical job's median time.
    const steps = [...stepSeconds.entries()].filter(([key]) => key.startsWith(`${critical.name}\0`))
      .map(([key, list]) => ({ name: key.slice(key.indexOf('\0') + 1), medianSeconds: median(list), samples: list.length }))
      .sort((a, b) => b.medianSeconds - a.medianSeconds);
    const top = steps[0];
    if (top && critical.medianSeconds > 0 && top.medianSeconds / critical.medianSeconds >= 0.6) {
      findings.push({ code: 'dominant-step-on-critical-path', workflow: workflow.path,
        job: criticalTarget ? criticalTarget.job : critical.name, step: top.name,
        line: criticalTarget ? jobLine(criticalTarget.job) : null, impact: 'wait',
        evidence: { kind: 'history', seconds: top.medianSeconds, samples: top.samples,
          hostedJob: critical.name, shareOfJob: Math.round((top.medianSeconds / critical.medianSeconds) * 100) / 100,
          jobMedianSeconds: critical.medianSeconds, finishedLastIn: `${critical.finishedLast}/${successes.length}` },
        suggestion: 'This step sets the wait for the whole workflow. Split it or parallelize inside it (for tests: ci history --test-timing), then re-measure.' });
    }
    // 6. Setup steps repeated across parallel (non-critical) jobs.
    const jobsWithStep = stepName => new Set([...stepSeconds.keys()]
      .filter(key => key.slice(key.indexOf('\0') + 1) === stepName)
      .map(key => key.slice(0, key.indexOf('\0')))).size;
    for (const job of jobs) {
      if (job.name === critical.name) continue;
      const setups = [...stepSeconds.entries()]
        .filter(([key]) => key.startsWith(`${job.name}\0`) && isSetupStep(key.slice(key.indexOf('\0') + 1)))
        .map(([key, list]) => ({ step: key.slice(key.indexOf('\0') + 1), medianSeconds: median(list),
          samples: list.length, presentInJobs: jobsWithStep(key.slice(key.indexOf('\0') + 1)) }));
      const total = setups.reduce((sum, item) => sum + item.medianSeconds, 0);
      if (!setups.length || total < 30 || !setups.some(item => item.presentInJobs >= 2)) continue;
      const target = names.get(job.name);
      findings.push({ code: 'duplicate-setup', workflow: workflow.path, job: target ? target.job : job.name,
        line: target ? jobLine(target.job) : null, impact: 'total-minutes',
        evidence: { kind: 'history', seconds: total, samples: job.samples, setup: setups },
        suggestion: 'These checkout/setup steps repeat across parallel jobs; share them (composite action) or cache the toolchain to cut total minutes. Parallel jobs do not affect the wait.' });
    }
  }
  // 5. Matrix legs of one job whose medians differ by at least 1.5x.
  const groups = new Map();
  for (const job of jobs) {
    const base = /^(.*) \(.+\)$/.exec(job.name)?.[1];
    if (base) groups.set(base, [...(groups.get(base) || []), job]);
  }
  for (const [base, legs] of groups) {
    const sorted = [...legs].sort((a, b) => b.medianSeconds - a.medianSeconds);
    const fastest = sorted.at(-1);
    if (sorted.length < 2 || !fastest.medianSeconds || sorted[0].medianSeconds / fastest.medianSeconds < 1.5) continue;
    const target = names.get(sorted[0].name);
    findings.push({ code: 'matrix-leg-spread', workflow: workflow.path, job: target ? target.job : base,
      line: target ? jobLine(target.job) : null, impact: 'wait',
      evidence: { kind: 'history', seconds: sorted[0].medianSeconds, samples: sorted[0].samples,
        legs: sorted.map(leg => ({ name: leg.name, medianSeconds: leg.medianSeconds, samples: leg.samples })) },
      suggestion: `The slowest leg of "${base}" sets the wait. Compare the legs (ci history --test-timing --compare-job), then rebalance or split the slow leg.` });
  }
  // Median seconds of a workflow step, matched through its hosted display name.
  const stepTiming = (jobId, stepName) => {
    for (const hostedName of hostedByJob.get(jobId) || []) {
      const list = stepSeconds.get(`${hostedName}\0${stepName}`);
      if (list?.length) return { seconds: median(list), samples: list.length };
    }
    return null;
  };
  return { findings, stats: { attempts: measured.length, successes: successes.length, stepTiming } };
}

export function optimizeCi(opts = {}, deps = {}) {
  const { discover = discoverCi, collect = collectHistory, get = githubGet, read = readWorkflowSource } = deps;
  const report = { schemaVersion: 'ci-local-guard/ci-optimize/v1', command: 'ci optimize', identity: null,
    outcome: 'blocked', scope: 'workflow-efficiency-candidates',
    coverage: null, findings: [], issues: [], nextActions: [], limitation: null };
  try {
    if (opts.workflow !== undefined && !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(opts.workflow)) fail('invalid-workflow-file');
    const inventory = discover({ repo: opts.repo, head: opts.head || 'HEAD' });
    if (!Array.isArray(inventory.workflows) || !inventory.workflows.length) fail('no-github-workflows');
    const selected = opts.workflow
      ? inventory.workflows.filter(item => item.path === `.github/workflows/${opts.workflow}`)
      : inventory.workflows;
    if (!selected.length) fail('workflow-not-found');
    const parsed = selected.filter(item => item.analysis === 'parsed');
    for (const item of selected.filter(item => item.analysis !== 'parsed')) {
      report.issues.push({ code: 'workflow-not-analyzed', workflow: item.path, reason: item.analysis });
    }
    const supplements = new Map();
    for (const workflow of parsed) {
      const sup = supplement(read(opts.repo, workflow.blob));
      if (sup) supplements.set(workflow.path, sup);
      else report.issues.push({ code: 'workflow-source-unparsable', workflow: workflow.path });
    }
    const repository = inventory.identity?.repository || null;
    const histories = [];
    if (repository) {
      for (const workflow of parsed) {
        if (!supplements.has(workflow.path)) continue;
        try {
          histories.push({ workflow, exported: collect({ repository, workflow: path.posix.basename(workflow.path), limit: HISTORY_LIMIT }, { get }) });
        } catch (error) {
          report.issues.push({ code: 'history-unavailable', workflow: workflow.path,
            reason: /^[a-z-]+$/.test(error.message) ? error.message : 'github-metadata-unavailable' });
        }
      }
    }
    const analyzed = histories.map(({ workflow, exported }) => historyAnalyze(workflow, exported));
    const observed = histories.some(({ exported }) => exported.runs?.length);
    const findings = [];
    for (const workflow of parsed) {
      const sup = supplements.get(workflow.path);
      if (!sup) continue;
      const index = histories.findIndex(entry => entry.workflow.path === workflow.path);
      findings.push(...staticFindings(workflow, sup, index >= 0 ? analyzed[index].stats.stepTiming : null, supplements));
    }
    for (const item of analyzed) findings.push(...item.findings);
    report.identity = { repo: inventory.identity.repo, head: inventory.identity.head, repository, mode: 'committed',
      workflows: parsed.map(item => item.path) };
    report.coverage = { history: observed ? 'observed' : 'static-only', workflows: parsed.length,
      historyWorkflows: histories.map(({ workflow, exported }) => ({ workflow: workflow.path, attempts: exported.runs.length })),
      sampleLimit: HISTORY_LIMIT };
    report.findings = findings;
    report.limitation = 'Static findings read committed workflow structure only; nothing was executed and expressions are unevaluated. '
      + 'History findings are medians over recent completed runs of this workflow: observations to investigate, not guaranteed savings. '
      + 'impact "risk" bounds the worst case (a missing timeout-minutes can burn up to the 360-minute default; a missing concurrency group lets superseded runs finish) and is not waste that already happened.'
      + (observed ? '' : ' Hosted history was unavailable (no GitHub repository, gh not usable, or no completed runs), so history findings were skipped: this report is static-only (coverage.history).');
    report.outcome = findings.length ? 'candidates' : 'clear';
    nextSteps(report, opts, inventory, observed, repository);
  } catch (error) {
    if (!error.optimizeCode && !/^[a-z-]+$/.test(error.message)) fail('optimize-failed');
    report.issues.push({ code: error.optimizeCode || error.message });
    report.outcome = 'blocked';
  }
  return report;
}

function nextSteps(report, opts, inventory, observed, repository) {
  const add = (kind, extra) => report.nextActions.push({ kind, ...extra, automatic: false });
  const repo = opts.repo || '.';
  const codes = new Set(report.findings.map(finding => finding.code));
  if (['missing-timeout-minutes', 'missing-concurrency-cancel', 'uncached-dependency-install'].some(code => codes.has(code))) {
    add('edit-workflow-yaml', { count: report.findings.filter(finding => finding.evidence.kind === 'static').length,
      note: 'Each static finding names the file, job and line to change. The edits stay on hosted CI; nothing runs locally for this report.' });
  }
  const dominant = report.findings.find(finding => finding.code === 'dominant-step-on-critical-path');
  if (dominant) add('measure-inside-dominant-step', { command: 'ci history',
    args: ['--repo', repo, '--workflow', path.posix.basename(dominant.workflow), '--test-timing', dominant.evidence.hostedJob],
    note: 'Reads that job logs TAP test durations from a few successful runs (read-only, needs gh).' });
  const spread = report.findings.find(finding => finding.code === 'matrix-leg-spread');
  if (spread) add('compare-leg-timings', { command: 'ci history',
    args: ['--repo', repo, '--workflow', path.posix.basename(spread.workflow), '--test-timing', spread.evidence.legs[0].name,
      '--compare-job', spread.evidence.legs.at(-1).name],
    note: 'Compares test durations between the slowest and fastest leg (read-only).' });
  if (dominant || spread) {
    const finding = dominant || spread;
    add('verify-a-split-with-replay', { command: 'ci replay',
      args: ['--repo', repo, '--head', inventory.identity.head, '--workflow', finding.workflow, '--job', finding.job],
      note: 'After splitting or rebalancing, replay the job (and its needs) locally before pushing. Runs project code in containers.' });
  }
  if (!observed && repository) add('check-hosted-history-access', {
    note: 'gh or the workflow history was unavailable, so history findings were skipped; re-run with gh installed, logged in and Actions read access.' });
}
