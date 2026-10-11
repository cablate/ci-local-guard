import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { discoverCi } from './ci-discovery.mjs';
import { collectHistory, criticalJob, hostedNames, measure, needsResolver } from './ci-history.mjs';
import { githubGet } from './ci-runs.mjs';
import { isMap, LineCounter, parseDocument } from './vendor/yaml/index.js';

// Efficiency candidates (north-star F11): committed workflow structure plus,
// when gh works, the hosted history of that workflow. Read-only; nothing is
// executed and no tool is downloaded. Findings are places to look with line
// numbers and medians, not proven savings.
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { optimizeCode: code, ...extra }); };
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const HISTORY_LIMIT = 15;
// A lockfile-driven dependency install at a command position. Global tool
// installs (npm -g, pip install <tool>) are not what a dependency cache keys
// on, so they are left out.
function dependencyInstall(run) {
  return run.split(/\r?\n|&&|\|\||;/).map(segment => segment.trim()).some(segment => {
    const match = /^(?:sudo\s+)?(npm|pnpm|yarn|pip3?|python3?\s+-m\s+pip|poetry|bundle)\s+(ci|install)(?=\s|$)(.*)$/.exec(segment);
    if (!match) return false;
    const [, tool, verb, rest] = match;
    const args = rest.trim().split(/\s+/).filter(Boolean);
    if (args.some(arg => ['-g', '--global'].includes(arg))) return false;
    if (/pip/.test(tool)) return args.some(arg => ['-r', '--requirement', '-e', '--editable', '.'].includes(arg)
      || /^-r\S/.test(arg) || /^\.(\[|\/|$)/.test(arg));
    if (tool === 'npm' && verb === 'install') {
      // `npm install` alone follows the lockfile; `npm install <pkg>` adds a package.
      const valued = new Set(['--prefix', '--cache', '--registry', '--workspace', '-w']);
      for (let i = 0; i < args.length; i++) {
        if (valued.has(args[i])) { i++; continue; }
        if (!args[i].startsWith('-')) return false;
      }
    }
    return true;
  });
}
// Hosted display names, aligned with ci-history's setup classification.
const isSetupStep = name => /^(Set up job|Complete job|Post |Run actions\/(checkout|setup-[a-z]+|cache)@)/.test(name);
const runnerFamily = label => /windows/i.test(label) ? 'windows' : /macos|^mac-/i.test(label) ? 'macos' : /ubuntu|linux/i.test(label) ? 'linux' : 'other';
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
  // Workflows have no timeout-minutes key; only jobs do.
  const out = { workflowConcurrency: concurrencyMode(root.get('concurrency', true)), onLine: 1, jobs: new Map() };
  for (const pair of root.items) {
    if (pair.key?.value === 'on' && pair.key.range) out.onLine = lines.linePos(pair.key.range[0]).line;
  }
  const jobsNode = root.get('jobs', true);
  if (!isMap(jobsNode)) return out;
  for (const pair of jobsNode.items) {
    const id = typeof pair.key?.value === 'string' ? pair.key.value : null;
    if (!id || !isMap(pair.value)) continue;
    const node = pair.value;
    const entry = { timeout: node.has('timeout-minutes'), concurrency: concurrencyMode(node.get('concurrency', true)), cachedStepLines: new Set() };
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

// null without a group; 'cancel' when cancel-in-progress is true; 'queue' when
// a group only queues runs; 'unknown' when cancel-in-progress is an expression.
function concurrencyMode(node) {
  if (node === undefined || node === null) return null;
  if (!isMap(node)) return 'queue'; // A bare group name never cancels.
  const cancel = node.get('cancel-in-progress');
  if (cancel === true || cancel === 'true') return 'cancel';
  if (typeof cancel === 'string' && cancel.includes('${{')) return 'unknown';
  return 'queue';
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
  // 1. A job without timeout-minutes (workflows have no such key).
  for (const job of workflow.jobs || []) {
    const s = sup.jobs.get(job.id);
    if (s?.timeout) continue;
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
  // 2. Re-firing triggers with no concurrency group anywhere, or a pull
  // request workflow whose groups only queue. A push-only group that queues
  // is usually a deliberate deploy lock and is left alone.
  const modes = [sup.workflowConcurrency, ...(workflow.jobs || []).map(job => sup.jobs.get(job.id)?.concurrency)].filter(Boolean);
  if (modes.length && modes.every(mode => mode === 'queue') && (workflow.triggers || []).some(trigger => trigger.event === 'pull_request')) {
    findings.push({ code: 'missing-concurrency-cancel', workflow: workflow.path, line: sup.onLine, impact: 'risk',
      evidence: { kind: 'static', concurrency: 'queues-without-cancel' },
      suggestion: 'The concurrency group only queues runs, so on a pull request every superseded push still runs to completion. Add cancel-in-progress: true (or an expression that enables it for pull requests).' });
  }
  if (repeatsPerPush(workflow.triggers) && !modes.length) {
    findings.push({ code: 'missing-concurrency-cancel', workflow: workflow.path, line: sup.onLine, impact: 'risk',
      evidence: { kind: 'static', concurrency: 'none' },
      suggestion: 'Add a workflow-level concurrency group (for example group: \${{ github.workflow }}-\${{ github.ref }} with cancel-in-progress: true) so a newer push cancels the superseded run.' });
  }
  // 3. Dependency installs in a job with no caching of any kind.
  for (const job of workflow.jobs || []) {
    const s = sup.jobs.get(job.id);
    const cached = (s?.cachedStepLines?.size || 0) > 0
      || (job.steps || []).some(step => step.uses && /^actions\/cache/.test(step.uses));
    if (cached) continue;
    for (const step of job.steps || []) {
      if (!step.run || !dependencyInstall(step.run)) continue;
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
function historyAnalyze(workflow, exported, analyzedPaths = new Set()) {
  const measured = (exported?.runs || []).map(measure);
  const successes = measured.filter(item => item.conclusion === 'success');
  const none = { findings: [], stats: { attempts: measured.length, successes: 0, stepTiming: () => null } };
  if (!successes.length) return none;
  const jobSeconds = new Map();
  const finishedLast = new Map();
  const familyOf = new Map(); // hosted job name -> runner family from its observed labels
  const stepSeconds = new Map(); // `${hostedJobName}\0${stepName}` -> [seconds]
  // Same rule as ci history: a short gate job that only waits hands the
  // critical path back to the job it waited on.
  const needsOf = needsResolver(workflow);
  for (const attempt of successes) {
    const critical = criticalJob(attempt.jobs, needsOf);
    if (critical) finishedLast.set(critical.job.name, (finishedLast.get(critical.job.name) || 0) + 1);
    for (const job of attempt.jobs) {
      if (job.os && !familyOf.has(job.name)) familyOf.set(job.name, runnerFamily(job.os));
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
  // A hosted job that ran through a local reusable call is named
  // "<caller> / <called job>". When the called workflow is analyzed too, its
  // own history already reports it, so drop the copy; otherwise attribute it
  // to the caller job and its line.
  const callers = (workflow.jobs || []).filter(job => typeof job.uses === 'string' && job.uses.startsWith('./'));
  const resolve = hostedName => {
    const target = names.get(hostedName);
    if (target) return { job: target.job, line: jobLine(target.job) };
    for (const caller of callers) {
      if (!hostedName.startsWith(`${caller.name || caller.id} / `)) continue;
      const called = caller.uses.replace(/^\.\//, '');
      return analyzedPaths.has(called) ? null : { job: caller.id, line: caller.line, via: called };
    }
    return { job: hostedName, line: null };
  };
  const findings = [];
  const critical = [...jobs].sort((a, b) => b.finishedLast - a.finishedLast)[0];
  const criticalTarget = critical && resolve(critical.name);
  if (critical && critical.finishedLast / successes.length >= 0.5) {
    // 4. One step takes at least 60% of the critical job's median time.
    const steps = [...stepSeconds.entries()].filter(([key]) => key.startsWith(`${critical.name}\0`))
      .map(([key, list]) => ({ name: key.slice(key.indexOf('\0') + 1), medianSeconds: median(list), samples: list.length }))
      .sort((a, b) => b.medianSeconds - a.medianSeconds);
    const top = steps[0];
    if (criticalTarget && top && critical.medianSeconds > 0 && top.medianSeconds / critical.medianSeconds >= 0.6) {
      findings.push({ code: 'dominant-step-on-critical-path', workflow: workflow.path,
        job: criticalTarget.job, step: top.name, line: criticalTarget.line, impact: 'wait',
        ...(criticalTarget.via ? { via: criticalTarget.via } : {}),
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
      const target = resolve(job.name);
      if (!target) continue;
      findings.push({ code: 'duplicate-setup', workflow: workflow.path, job: target.job,
        line: target.line, impact: 'total-minutes', ...(target.via ? { via: target.via } : {}),
        evidence: { kind: 'history', seconds: total, samples: job.samples, setup: setups },
        suggestion: 'These checkout/setup steps repeat across parallel jobs; share them (composite action) or cache the toolchain to cut total minutes. Parallel jobs do not affect the wait.' });
    }
  }
  // 5. Matrix legs of one job, on the same runner family, whose medians differ
  // by at least 1.5x. Legs on different operating systems cannot be
  // rebalanced; that spread is the platform (dominant-step covers its cost).
  const groups = new Map();
  for (const job of jobs) {
    const base = /^(.*) \(.+\)$/.exec(job.name)?.[1];
    if (!base) continue;
    const key = `${base}\0${familyOf.get(job.name) || 'unknown'}`;
    groups.set(key, [...(groups.get(key) || []), job]);
  }
  for (const [key, legs] of groups) {
    const base = key.slice(0, key.indexOf('\0'));
    const sorted = [...legs].sort((a, b) => b.medianSeconds - a.medianSeconds);
    const fastest = sorted.at(-1);
    if (sorted.length < 2 || !fastest.medianSeconds || sorted[0].medianSeconds / fastest.medianSeconds < 1.5) continue;
    const target = resolve(sorted[0].name);
    if (!target) continue;
    findings.push({ code: 'matrix-leg-spread', workflow: workflow.path, job: target.job,
      line: target.line, impact: 'wait', ...(target.via ? { via: target.via } : {}),
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
  const { discover = discoverCi, collect = collectHistory, get = githubGet, read = readWorkflowSource,
    progress = text => process.stderr.write(`[ci-local-guard] ${text}\n`) } = deps;
  const report = { schemaVersion: 'ci-local-guard/ci-optimize/v1', command: 'ci optimize', identity: null,
    outcome: 'blocked', scope: 'workflow-efficiency-candidates',
    coverage: null, findings: [], issues: [], nextActions: [], limitation: null };
  try {
    if (opts.workflow !== undefined && !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(opts.workflow)) fail('invalid-workflow-file');
    if (opts.limit !== undefined && !(/^[1-9][0-9]?$/.test(String(opts.limit)) && Number(opts.limit) <= 50)) fail('invalid-limit');
    const limit = opts.limit === undefined ? HISTORY_LIMIT : Number(opts.limit);
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
    // Local workflows the selection calls, read even when --workflow leaves
    // them out: whether a call job is bounded depends on them.
    for (const workflow of parsed) for (const job of workflow.jobs || []) {
      const file = typeof job.uses === 'string' && job.uses.startsWith('./') ? job.uses.slice(2) : null;
      if (!file || supplements.has(file)) continue;
      const called = inventory.workflows.find(item => item.path === file && item.analysis === 'parsed');
      const sup = called ? supplement(read(opts.repo, called.blob)) : null;
      if (sup) supplements.set(file, sup);
    }
    const repository = inventory.identity?.repository || null;
    const histories = [];
    if (repository) {
      const pending = parsed.filter(workflow => supplements.has(workflow.path));
      for (const [index, workflow] of pending.entries()) {
        // One line per workflow so a caller can tell a long read from a hang.
        progress(`ci optimize: reading hosted history ${index + 1}/${pending.length} ${workflow.path} (up to ${limit} runs)`);
        try {
          histories.push({ workflow, exported: collect({ repository, workflow: path.posix.basename(workflow.path), limit }, { get }) });
        } catch (error) {
          report.issues.push({ code: 'history-unavailable', workflow: workflow.path,
            reason: /^[a-z-]+$/.test(error.message) ? error.message : 'github-metadata-unavailable' });
        }
      }
    }
    const analyzedPaths = new Set(histories.map(({ workflow }) => workflow.path));
    const analyzed = histories.map(({ workflow, exported }) => historyAnalyze(workflow, exported, analyzedPaths));
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
      sampleLimit: limit };
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
