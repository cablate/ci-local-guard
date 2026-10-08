import { spawnSync } from 'node:child_process';

// Metadata only: offline inspection and a bounded read-only GitHub collector.
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const repositoryIdentity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  && value.split('/').every((part) => part !== '.' && part !== '..');

export function runSource(run) {
  const branch = run.head_branch ?? null;
  const repository = run.head_repository == null ? null : run.head_repository.full_name;
  if ((branch !== null && (typeof branch !== 'string' || !branch.length
    || Buffer.byteLength(branch) > 1024 || /[\s\x00-\x1f\x7f]/u.test(branch)))
    || (run.head_repository != null && (!repositoryIdentity(repository) || repository.length > 512))) {
    throw new Error('Invalid run source metadata');
  }
  return { headBranch: branch, headRepository: repository === null ? null : repository.toLowerCase() };
}

/** Fixed host/method; never return raw stderr or provider payload in an error. */
export function githubGet(endpoint, { execute = spawnSync } = {}) {
  const route = typeof endpoint === 'string' && endpoint.match(/^repos\/([^/]+\/[^/]+)\/(.+)$/);
  const listing = /^workflows\/[A-Za-z0-9_.-]+\.ya?ml\/runs\?status=completed&per_page=(?:[1-9]|[1-9]\d|100)&page=(?:[1-9]|10)$/;
  const attempt = /^runs\/[1-9]\d*\/attempts\/[1-9]\d*(?:\/jobs\?per_page=100&page=(?:[1-9]|10))?$/;
  const actions = route?.[2].startsWith('actions/') ? route[2].slice(8) : null;
  if (!route || !repositoryIdentity(route[1]) || !(actions && (listing.test(actions) || attempt.test(actions)))) {
    throw new Error('Invalid GitHub metadata endpoint');
  }
  const result = execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10', endpoint], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('GitHub metadata GET failed; check gh installation, authentication, Actions read access or rate limits');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('GitHub metadata response is not valid JSON'); }
}

// One job's plain-text log, read-only. Terminal escapes are stripped; the text
// is untrusted data and is never followed as instructions.
export function githubJobLog(repository, jobId, { execute = spawnSync } = {}) {
  if (!repositoryIdentity(repository) || !positiveId(jobId)) throw new Error('Invalid job log request');
  const result = execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '--allow-escape-sequences',
    '-H', 'X-GitHub-Api-Version: 2026-03-10', `repos/${repository}/actions/jobs/${jobId}/logs`], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
  });
  if (result.error || result.status !== 0) throw new Error('GitHub job log GET failed; the log may have expired or access is missing');
  return String(result.stdout).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export function collectAttemptJobs(prefix, run, source, read) {
  const attempt = run.run_attempt;
  let total = null;
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = read(`${prefix}/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(result?.jobs) || result.jobs.length > 100 || !Number.isInteger(result.total_count)
      || result.total_count < 0 || result.total_count > 1000 || (total !== null && result.total_count !== total)) {
      throw new Error('Invalid or changing jobs pagination');
    }
    total = result.total_count;
    jobs.push(...result.jobs.map((job) => {
      if (!job || typeof job !== 'object') throw new Error('Invalid job metadata');
      const selected = Object.fromEntries(['id', 'run_id', 'run_attempt', 'head_sha', 'name', 'status', 'conclusion', 'started_at', 'completed_at', 'labels']
        .map((field) => [field, job[field]]));
      if (job.steps != null) {
        if (!Array.isArray(job.steps) || job.steps.length > 1000) throw new Error('Invalid or oversized step metadata');
        selected.steps = job.steps.map((step) => {
          if (!step || typeof step !== 'object') throw new Error('Invalid step metadata');
          return Object.fromEntries(['number', 'name', 'status', 'conclusion', 'started_at', 'completed_at']
            .map((field) => [field, step[field]]));
        });
      }
      return selected;
    }));
    if (jobs.length === total) break;
    if (jobs.length > total || result.jobs.length < 100 || page === 10) throw new Error('Incomplete jobs pagination; no complete export produced');
  }
  const selectedRun = Object.fromEntries(['id', 'run_attempt', 'workflow_id', 'head_sha', 'head_branch', 'event', 'status', 'conclusion', 'created_at', 'run_started_at']
    .map((field) => [field, run[field]]));
  selectedRun.head_repository = source.headRepository === null ? null : { full_name: source.headRepository };
  return { run: selectedRun, jobs: { total_count: total, jobs } };
}

/** Exact API attempt, not latest-listing selection or a protection verdict. */
export function collectRun({ repository, runId, attempt, head, workflowId }, { get = githubGet, now = Date.now } = {}) {
  if (!repositoryIdentity(repository) || !positiveId(runId) || !positiveId(attempt) || !positiveId(workflowId)
    || typeof head !== 'string' || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('Use repository owner/name, positive safe integer run ID/attempt/workflow ID and exact lowercase 40-character head SHA');
  }
  const started = now();
  let requests = 0;
  const read = (endpoint) => {
    if (requests >= 11 || now() - started > 120000) throw new Error('Exact run metadata collection budget exceeded');
    requests += 1;
    return get(endpoint);
  };
  const prefix = `repos/${repository}/actions`;
  const run = read(`${prefix}/runs/${runId}/attempts/${attempt}`);
  if (run?.id !== runId || run.run_attempt !== attempt || run.head_sha !== head || run.workflow_id !== workflowId
    || typeof run.repository?.full_name !== 'string' || run.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Exact run attempt does not match requested repository/run/attempt/workflow/SHA');
  }
  const entry = collectAttemptJobs(prefix, run, runSource(run), read);
  const exported = { schemaVersion: 'ci-local-guard/github-export/v1', repository, runs: [entry],
    collection: { host: 'github.com', selection: 'exact-run-attempt',
      expected: { runId, attempt, head, workflowId }, identityCheck: 'api-request-matched',
      completedListingOnly: false, returnedAttempts: 1, requests, collectedAt: new Date(now()).toISOString(),
      checkoutIdentity: 'unverified', hostedPolicyStatus: 'unverified' } };
  inspectRuns(exported);
  if (Buffer.byteLength(JSON.stringify(exported)) > 10 * 1024 * 1024) throw new Error('Collected export exceeds 10 MiB');
  return exported;
}

export function collectRuns({ repository, workflow, limit = 10, attempts = 'latest' }, { get = githubGet, now = Date.now } = {}) {
  if (!repositoryIdentity(repository) || typeof workflow !== 'string' || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)
    || !Number.isInteger(limit) || limit < 1 || limit > 25 || !['latest', 'history'].includes(attempts)) {
    throw new Error('Use repository owner/name, workflow filename.yml, limit 1..25 and attempts latest|history');
  }
  const started = now();
  let requests = 0;
  const read = (endpoint) => {
    if (requests >= 128 || now() - started > 120000) throw new Error('Metadata collection budget exceeded; reduce the sample');
    requests += 1;
    return get(endpoint);
  };
  const prefix = `repos/${repository}/actions`;
  const listing = read(`${prefix}/workflows/${workflow}/runs?status=completed&per_page=${limit}&page=1`);
  if (!Array.isArray(listing?.workflow_runs) || listing.workflow_runs.length > limit) throw new Error('Invalid workflow run listing');
  const runs = [];
  const seen = new Set();
  for (const listed of listing.workflow_runs) {
    if (!positiveId(listed?.id) || !positiveId(listed.run_attempt) || !positiveId(listed.workflow_id)
      || !/^[a-f0-9]{40}$/.test(listed.head_sha || '') || seen.has(listed.id)) throw new Error('Invalid or duplicate listed run identity');
    seen.add(listed.id);
    const listedSource = runSource(listed);
    for (let attempt = listed.run_attempt; attempt >= (attempts === 'history' ? 1 : listed.run_attempt) && runs.length < limit; attempt -= 1) {
      const run = read(`${prefix}/runs/${listed.id}/attempts/${attempt}`);
      if (run?.id !== listed.id || run.run_attempt !== attempt || run.head_sha !== listed.head_sha || run.workflow_id !== listed.workflow_id
        || typeof run.repository?.full_name !== 'string' || run.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
        throw new Error('Run attempt identity changed or does not match requested repository/workflow');
      }
      const source = runSource(run);
      if ((listed.head_branch !== undefined && listedSource.headBranch !== source.headBranch)
        || (listed.head_repository !== undefined && listedSource.headRepository !== source.headRepository)) {
        throw new Error('Run attempt source identity changed from listing');
      }
      runs.push(collectAttemptJobs(prefix, run, source, read));
    }
    if (runs.length === limit) break;
  }
  const exported = { schemaVersion: 'ci-local-guard/github-export/v1', repository, runs,
    collection: { host: 'github.com', workflow, attempts, requestedLimit: limit, returnedAttempts: runs.length,
      completedListingOnly: true, requests, collectedAt: new Date(now()).toISOString() } };
  inspectRuns(exported); // Same identity, duplicate and timing validation as offline replay.
  if (Buffer.byteLength(JSON.stringify(exported)) > 10 * 1024 * 1024) throw new Error('Collected export exceeds 10 MiB');
  return exported;
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1) : 0;
  const local = value.replace(/(?:Z|[+-]\d{2}:\d{2})$/, '');
  const canonical = `${local.length === 19 ? `${local}.000` : local}Z`;
  return new Date(parsed + minutes * 60000).toISOString() === canonical ? parsed : null;
}

function seconds(start, end) {
  const a = timestamp(start);
  const b = timestamp(end);
  return a !== null && b !== null && b >= a ? (b - a) / 1000 : null;
}

function inspectSteps(job, jobSeconds) {
  if (job.steps == null) return { steps: null, stepTiming: 'missing', stepSumSeconds: null, unattributedJobSeconds: null };
  if (!Array.isArray(job.steps) || job.steps.length > 1000) throw new Error('Invalid or oversized step metadata');
  const numbers = new Set();
  const steps = job.steps.map((step) => {
    if (!positiveId(step?.number) || typeof step.name !== 'string' || typeof step.status !== 'string'
      || [step.conclusion, step.started_at, step.completed_at].some((value) => value != null && typeof value !== 'string')) {
      throw new Error('Invalid step metadata');
    }
    if (numbers.has(step.number)) throw new Error('Duplicate step number');
    numbers.add(step.number);
    return { number: step.number, name: step.name, status: step.status, conclusion: step.conclusion ?? null,
      startedAt: step.started_at ?? null, completedAt: step.completed_at ?? null,
      durationSeconds: step.status === 'completed' ? step.conclusion === 'skipped' ? 0 : seconds(step.started_at, step.completed_at) : null };
  }).sort((a, b) => a.number - b.number);
  if (!steps.length || jobSeconds === null || steps.some((step) => step.durationSeconds === null)) {
    return { steps, stepTiming: 'incomplete', stepSumSeconds: null, unattributedJobSeconds: null };
  }
  const executed = steps.filter((step) => step.conclusion !== 'skipped').sort((a, b) => timestamp(a.startedAt) - timestamp(b.startedAt));
  const start = timestamp(job.started_at), end = timestamp(job.completed_at);
  if (executed.some((step, index) => start === null || end === null || timestamp(step.startedAt) < start
    || timestamp(step.completedAt) > end || (index > 0 && timestamp(step.startedAt) < timestamp(executed[index - 1].completedAt)))) {
    return { steps, stepTiming: 'inconsistent', stepSumSeconds: null, unattributedJobSeconds: null };
  }
  const sum = steps.reduce((total, step) => total + step.durationSeconds, 0);
  return { steps, stepTiming: 'observed', stepSumSeconds: sum, unattributedJobSeconds: jobSeconds - sum };
}

export function inspectRuns(input) {
  if (input?.schemaVersion !== 'ci-local-guard/github-export/v1' || !Array.isArray(input.runs)
    || input.runs.length > 100) throw new Error('Invalid or oversized GitHub export');
  if (!repositoryIdentity(input.repository)) throw new Error('Invalid repository identity');
  const imports = new Map();
  for (const entry of input.runs) {
    const { run, jobs: page } = entry || {};
    if (!positiveId(run?.id) || !positiveId(run.run_attempt) || !/^[a-f0-9]{40}$/.test(run.head_sha || '')
      || typeof run.event !== 'string' || typeof run.status !== 'string'
      || (run.workflow_id != null && !positiveId(run.workflow_id))
      || [run.conclusion, run.created_at, run.run_started_at].some((value) => value != null && typeof value !== 'string')
      || !Array.isArray(page?.jobs) || page.jobs.length > 1000
      || !Number.isSafeInteger(page.total_count) || page.total_count < 0) throw new Error('Invalid run or jobs export');
    const warnings = [];
    const source = runSource(run);
    if (source.headBranch === null || source.headRepository === null) warnings.push('head branch or source repository metadata is missing');
    const ids = new Set();
    const jobs = page.jobs.map((job) => {
      if (!positiveId(job?.id) || typeof job.name !== 'string' || typeof job.status !== 'string'
        || [job.conclusion, job.started_at, job.completed_at].some((value) => value != null && typeof value !== 'string')) throw new Error('Invalid job export');
      if (ids.has(job.id)) throw new Error('Duplicate job identity');
      ids.add(job.id);
      if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== run.head_sha) {
        throw new Error('Job identity does not match run/attempt/SHA');
      }
      const durationSeconds = job.status === 'completed'
        ? job.conclusion === 'skipped' ? 0 : seconds(job.started_at, job.completed_at) : null;
      if (durationSeconds === null) warnings.push(`job ${job.id}: active, missing or invalid timing`);
      return { id: job.id, name: job.name, status: job.status, conclusion: job.conclusion ?? null,
        startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null, durationSeconds,
        runnerLabels: Array.isArray(job.labels) ? job.labels.filter((label) => typeof label === 'string') : [],
        cacheState: 'unknown', ...inspectSteps(job, durationSeconds) };
    }).sort((a, b) => a.id - b.id);
    const complete = page.total_count === jobs.length;
    if (!complete) warnings.push('jobs export is incomplete: pagination or missing jobs');
    if (!jobs.length) warnings.push('no jobs available');
    const measured = complete && jobs.length > 0 && jobs.every((job) => job.durationSeconds !== null);
    const jobSumSeconds = measured ? jobs.reduce((total, job) => total + job.durationSeconds, 0) : null;
    const executed = jobs.filter((job) => job.conclusion !== 'skipped');
    const ends = executed.map((job) => timestamp(job.completedAt));
    const latestEnd = ends.length && ends.every((end) => end !== null) ? Math.max(...ends) : null;
    const executionWallSeconds = run.status === 'completed' && measured && latestEnd !== null
      ? seconds(run.run_started_at, new Date(latestEnd).toISOString()) : null;
    const normalized = { id: run.id, attempt: run.run_attempt, workflowId: run.workflow_id ?? null, head: run.head_sha,
      event: run.event, ...source, status: run.status, conclusion: run.conclusion ?? null,
      initialDelaySeconds: seconds(run.created_at, run.run_started_at), queueSeconds: null,
      executionWallSeconds, jobSumSeconds, cacheState: 'unknown', changeClass: 'unknown',
      jobs, warnings, sourceUrl: `https://github.com/${input.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}` };
    const key = `${run.id}/${run.run_attempt}`;
    if (imports.has(key) && JSON.stringify(imports.get(key)) !== JSON.stringify(normalized)) throw new Error(`Conflicting run attempt ${key}`);
    imports.set(key, normalized);
  }
  return { schemaVersion: 'ci-local-guard/run-inspection/v1', provider: 'github-actions',
    repository: input.repository, runs: [...imports.values()], savings: null,
    limitations: ['Job-sum is an execution proxy, not billed usage.',
      'Queue time, cache state, change class and required-gate equivalence are not inferred.',
      'Head branch/source repository are API metadata only, not PR target, full ref type or checkout attestation.',
      'Execution wall ends at the last observed job; updated_at is not a completion timestamp.'] };
}

/** Descriptive before/after metrics, without promoting metadata similarity to causality. */
export function compareRuns(input) {
  if (input?.schemaVersion !== 'ci-local-guard/run-comparison-input/v1') throw new Error('Invalid run comparison envelope');
  const before = inspectRuns(input.before), after = inspectRuns(input.after);
  if (before.repository.toLowerCase() !== after.repository.toLowerCase()) throw new Error('Comparison repositories differ');
  const blockers = [];
  const beforeIds = new Set(before.runs.map((run) => run.id));
  if (after.runs.some((run) => beforeIds.has(run.id))) blockers.push('same run ID appears in both cohorts, including reruns');
  const profile = (run) => JSON.stringify([run.workflowId, run.event, run.headBranch, run.headRepository,
    run.jobs.filter((job) => job.conclusion !== 'skipped').map((job) => [job.name, [...new Set(job.runnerLabels)].sort(),
      job.steps?.map((step) => [step.number, step.name, step.status, step.conclusion]) ?? null])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return { mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
      min: sorted[0], max: sorted.at(-1) };
  };
  const cohort = (label, runs) => {
    if (runs.length < 2) blockers.push(`${label}: fewer than two independent run attempts`);
    if (new Set(runs.map((run) => run.id)).size !== runs.length) blockers.push(`${label}: rerun attempts are not independent run samples`);
    if (runs.some((run) => run.workflowId === null || run.jobs.some((job) => job.conclusion !== 'skipped' && !job.runnerLabels.length))) {
      blockers.push(`${label}: workflow or runner identity missing`);
    }
    if (runs.some((run) => run.headBranch === null || run.headRepository === null)) blockers.push(`${label}: head branch or source repository identity missing`);
    if (new Set(runs.map(profile)).size > 1) blockers.push(`${label}: mixed workflow/event/source-branch/source-repository/executed-job/runner/step profiles`);
    const invalidExecution = runs.flatMap((run) => run.jobs.filter((job) => job.conclusion !== 'skipped').flatMap((job) => {
      const issues = [];
      if (job.status !== 'completed' || job.conclusion !== 'success') issues.push('executed-job is not completed successfully');
      if (job.stepTiming !== 'observed') issues.push(`step metadata ${job.stepTiming}`);
      if (!job.steps?.some((step) => step.conclusion !== 'skipped')) issues.push('no observed executed step');
      if (job.steps?.some((step) => step.status !== 'completed' || !['success', 'skipped'].includes(step.conclusion))) {
        issues.push('step is incomplete or non-success');
      }
      return issues.length ? [{ runId: run.id, attempt: run.attempt, jobId: job.id, jobName: job.name, issues }] : [];
    }));
    if (invalidExecution.length) blockers.push(`${label}: executed-job/step evidence missing, inconsistent or non-success`);
    const invalid = runs.filter((run) => run.status !== 'completed' || run.conclusion !== 'success'
      || run.jobSumSeconds === null || run.executionWallSeconds === null);
    if (invalid.length || !runs.length) blockers.push(`${label}: empty, non-success or incomplete timing sample`);
    return { attempts: runs.length, evidence: runs.map((run) => ({ runId: run.id, attempt: run.attempt,
      head: run.head, event: run.event, headBranch: run.headBranch, headRepository: run.headRepository,
      workflowId: run.workflowId, conclusion: run.conclusion, sourceUrl: run.sourceUrl })),
      invalidEvidence: invalid.map((run) => ({ runId: run.id, attempt: run.attempt, warnings: run.warnings })),
      invalidExecutionEvidence: invalidExecution,
      metrics: invalid.length || !runs.length ? null : {
        executionWallSeconds: stats(runs.map((run) => run.executionWallSeconds)),
        jobSumSeconds: stats(runs.map((run) => run.jobSumSeconds)) } };
  };
  const baseline = cohort('before', before.runs), candidate = cohort('after', after.runs);
  if (before.runs.length && after.runs.length && profile(before.runs[0]) !== profile(after.runs[0])) {
    blockers.push('before/after workflow/event/source-branch/source-repository/executed-job/runner/step profiles differ');
  }
  const matched = blockers.length === 0;
  return { schemaVersion: 'ci-local-guard/run-comparison/v1', repository: before.repository,
    outcome: 'needs-evidence', comparisonStatus: matched ? 'observed-context-matched' : 'blocked',
    before: baseline, after: candidate, blockers,
    observedDeltaAfterMinusBefore: matched ? Object.fromEntries(['executionWallSeconds', 'jobSumSeconds'].map((metric) => [metric, {
      mean: candidate.metrics[metric].mean - baseline.metrics[metric].mean,
      median: candidate.metrics[metric].median - baseline.metrics[metric].median }])) : null,
    attributionStatus: 'unverified', savings: null, automaticChanges: [],
    missingEvidence: ['checked-out commit/tree identity', 'comparable change class and inputs', 'actual cache identity/hit state',
      'PR target/action/fork context and full ref type',
      'step names/statuses do not establish commands or assertions', 'required protection equivalence', 'isolated intervention and confounder review'],
    limitations: ['Matched observed profiles do not prove equivalent inputs, runner capacity, workflow contents or protection.',
      'Differences are descriptive elapsed seconds, not attributable savings, billing or a forecast.',
      'No failed, cancelled or incomplete attempts are silently removed; select and justify representative cohorts explicitly.'] };
}

export function auditRuns(input) {
  const inspected = inspectRuns(input);
  const groups = new Map();
  const stepGroups = new Map();
  const byHead = new Map();
  const observations = [];
  const reference = (run) => ({ runId: run.id, attempt: run.attempt, head: run.head, sourceUrl: run.sourceUrl });
  const measured = inspected.runs.filter((run) => run.status === 'completed' && run.jobSumSeconds !== null);
  for (const run of inspected.runs) {
    const sameHead = byHead.get(run.head) || [];
    sameHead.push(run); byHead.set(run.head, sameHead);
    if (['failure', 'timed_out', 'cancelled'].includes(run.conclusion)) observations.push({
      kind: 'non-success-attempt', conclusion: run.conclusion, evidence: [reference(run)],
      knownJobSeconds: run.jobSumSeconds,
      nextAction: 'Inspect failure/cancellation cause and affected protection owner; do not treat consumed time as avoidable waste.',
    });
  }
  for (const [head, runs] of byHead) {
    if (new Set(runs.map((run) => run.id)).size > 1) observations.push({
      kind: 'same-sha-multiple-runs', head, events: [...new Set(runs.map((run) => run.event))].sort(),
      evidence: runs.map(reference),
      nextAction: 'Review trigger overlap and distinct event responsibilities; same SHA alone does not prove duplicate protection.',
    });
  }
  for (const run of measured) {
    for (const job of run.jobs.filter((job) => job.conclusion !== 'skipped')) {
      const runnerLabels = [...new Set(job.runnerLabels)].sort();
      const key = JSON.stringify([run.workflowId, run.event, runnerLabels, job.name, job.conclusion]);
      let group = groups.get(key);
      if (!group) {
        group = { workflowId: run.workflowId, event: run.event, runnerLabels, job: job.name, conclusion: job.conclusion,
          knownJobSeconds: 0, samples: [] };
        groups.set(key, group);
      }
      group.knownJobSeconds += job.durationSeconds;
      group.samples.push({ ...reference(run), jobId: job.id, durationSeconds: job.durationSeconds });
      if (job.stepTiming === 'observed') for (const step of job.steps.filter((step) => step.conclusion !== 'skipped')) {
        const stepKey = JSON.stringify([key, step.number, step.name, step.conclusion]);
        let entry = stepGroups.get(stepKey);
        if (!entry) {
          entry = { workflowId: run.workflowId, event: run.event, runnerLabels, job: job.name, jobConclusion: job.conclusion,
            step: step.name, number: step.number, conclusion: step.conclusion, knownStepSeconds: 0, samples: [] };
          stepGroups.set(stepKey, entry);
        }
        entry.knownStepSeconds += step.durationSeconds;
        entry.samples.push({ ...reference(run), jobId: job.id, stepNumber: step.number, durationSeconds: step.durationSeconds });
      }
    }
  }
  const total = measured.length ? measured.reduce((sum, run) => sum + run.jobSumSeconds, 0) : null;
  const ranking = [...groups.values()].map((group) => ({ ...group,
    meanJobSeconds: group.knownJobSeconds / group.samples.length,
    shareOfMeasuredJobSeconds: total > 0 ? group.knownJobSeconds / total : null,
    nextAction: 'Read exact-SHA workflow, commands, scope and step evidence before proposing subtraction or cache changes.',
  })).sort((a, b) => b.knownJobSeconds - a.knownJobSeconds || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { schemaVersion: 'ci-local-guard/run-audit/v1', repository: inspected.repository,
    outcome: 'needs-evidence', sample: { attempts: inspected.runs.length, measuredAttempts: measured.length,
      excludedAttempts: inspected.runs.length - measured.length },
    knownJobSeconds: total, ranking, observations,
    stepRanking: [...stepGroups.values()].map((group) => ({ ...group, meanStepSeconds: group.knownStepSeconds / group.samples.length }))
      .sort((a, b) => b.knownStepSeconds - a.knownStepSeconds || JSON.stringify(a).localeCompare(JSON.stringify(b))),
    stepEvidence: { observedJobs: measured.reduce((sum, run) => sum + run.jobs.filter((job) => job.stepTiming === 'observed').length, 0),
      unmeasuredJobs: measured.reduce((sum, run) => sum + run.jobs.filter((job) => job.stepTiming !== 'observed').length, 0) },
    excludedEvidence: inspected.runs.filter((run) => !measured.includes(run)).map((run) => ({ ...reference(run), warnings: run.warnings })),
    comparisonStatus: 'insufficient-evidence', savings: null, automaticChanges: [],
    missingEvidence: ['exact workflow/policy version', 'change class', 'actual cache state', 'complete step/substage evidence and setup/artifact consumers',
      'required-gate equivalence and protection map', 'comparable before/after intervention'],
    limitations: ['Ranking describes observed execution, not billing or avoidable waste.',
      'Groups separate workflow ID (unknown when absent), event, runner labels, job name and conclusion; these do not prove identical inputs.',
      'Partial/active attempts are excluded from ranking and retain their evidence; missing timing is never zero.',
      'Step ranking uses only non-overlapping observed steps inside job bounds; absent/incomplete steps remain unmeasured, including skipped jobs.',
      'Step names do not prove cache hits or protection equivalence; unattributed job time is not automatically setup or waste.'],
  };
}
