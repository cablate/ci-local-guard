import { createHash } from 'node:crypto';
import path from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from './vendor/yaml/index.js';

// Structural reading of one GitHub Actions workflow. This is what the file
// declares, not what GitHub will select or run; expressions stay unevaluated.
const MAX_JOBS = 256;
const MAX_STEPS = 512;
const MAX_LEGS = 256;
const expression = value => typeof value === 'string' && value.includes('${{');

export function parseWorkflow(source, file) {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, uniqueKeys: true, prettyErrors: false, maxAliasCount: 64 });
  const issues = doc.errors.map(error => ({ code: error.code === 'DUPLICATE_KEY' ? 'duplicate-key' : 'yaml-syntax',
    line: lines.linePos(error.pos[0]).line }));
  const result = { path: file, name: null, triggers: [], jobs: [], issues };
  if (issues.length || !isMap(doc.contents)) {
    if (!issues.length) issues.push({ code: 'workflow-not-a-mapping', line: 1 });
    return result;
  }
  const line = node => node?.range ? lines.linePos(node.range[0]).line : null;
  const root = doc.contents;
  const name = root.get('name');
  result.name = typeof name === 'string' ? name : null;
  const on = root.get('on', true);
  const onValue = on && doc.toJS().on;
  if (typeof onValue === 'string') result.triggers = [{ event: onValue, filters: {} }];
  else if (Array.isArray(onValue)) result.triggers = onValue.filter(x => typeof x === 'string').map(event => ({ event, filters: {} }));
  else if (onValue && typeof onValue === 'object') {
    result.triggers = Object.entries(onValue).map(([event, config]) => ({ event,
      filters: Object.fromEntries(['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore', 'types']
        .filter(key => Array.isArray(config?.[key])).map(key => [key, config[key].map(String)])) }));
  } else issues.push({ code: 'missing-triggers', line: line(on) || 1 });
  const jobs = root.get('jobs', true);
  if (!isMap(jobs)) { issues.push({ code: 'missing-jobs', line: line(jobs) || 1 }); return result; }
  if (jobs.items.length > MAX_JOBS) { issues.push({ code: 'job-limit', line: line(jobs) }); return result; }
  for (const pair of jobs.items) {
    const id = isScalar(pair.key) ? String(pair.key.value) : null;
    const node = pair.value;
    if (!id || !isMap(node)) { issues.push({ code: 'invalid-job', line: line(pair.key) }); continue; }
    const js = node.toJSON();
    const needs = typeof js.needs === 'string' ? [js.needs] : Array.isArray(js.needs) ? js.needs.map(String) : [];
    const stepsNode = node.get('steps', true);
    const steps = isSeq(stepsNode) ? stepsNode.items.slice(0, MAX_STEPS).map((step, index) => {
      const value = isMap(step) ? step.toJSON() : {};
      return { index, id: typeof value.id === 'string' ? value.id : null, name: typeof value.name === 'string' ? value.name : null,
        ...(typeof value.run === 'string' ? { run: value.run } : {}), ...(typeof value.uses === 'string' ? { uses: value.uses } : {}),
        ...(value.if !== undefined ? { if: String(value.if) } : {}), ...(value['continue-on-error'] !== undefined ? { continueOnError: value['continue-on-error'] } : {}),
        line: line(step) };
    }) : [];
    if (isSeq(stepsNode) && stepsNode.items.length > MAX_STEPS) issues.push({ code: 'step-limit', line: line(stepsNode) });
    result.jobs.push({ id, name: typeof js.name === 'string' ? js.name : null, line: line(pair.key),
      runsOn: js['runs-on'] ?? null, needs, if: js.if === undefined ? null : String(js.if),
      uses: typeof js.uses === 'string' ? js.uses : null,
      container: js.container ?? null, environment: js.environment ?? null,
      // Local replay has no secrets; such jobs would fail for that reason alone.
      usesSecrets: /\bsecrets\s*(\.|\[)/.test(JSON.stringify(js)) || js.secrets !== undefined,
      services: js.services && typeof js.services === 'object' ? Object.keys(js.services) : [],
      matrix: matrixLegs(js.strategy?.matrix), timeoutMinutes: js['timeout-minutes'] ?? null,
      continueOnError: js['continue-on-error'] ?? null, steps });
  }
  return result;
}

// Static matrix legs only. include/exclude follow GitHub's documented rules for
// literal values; any expression makes the matrix dynamic (unknown legs).
export function matrixLegs(matrix) {
  if (matrix === undefined || matrix === null) return { kind: 'none', legs: [{}] };
  if (expression(matrix) || typeof matrix !== 'object' || Array.isArray(matrix)) return { kind: 'dynamic', legs: null };
  const axes = Object.entries(matrix).filter(([key]) => !['include', 'exclude'].includes(key));
  if (axes.some(([, values]) => !Array.isArray(values) || expression(values) || values.some(expression))
    || [matrix.include, matrix.exclude].some(list => list !== undefined && (!Array.isArray(list) || expression(list)))) {
    return { kind: 'dynamic', legs: null };
  }
  let legs = axes.length ? [{}] : [];
  for (const [key, values] of axes) legs = legs.flatMap(leg => values.map(value => ({ ...leg, [key]: value })));
  const matches = (leg, filter) => Object.entries(filter).every(([key, value]) => JSON.stringify(leg[key]) === JSON.stringify(value));
  legs = legs.filter(leg => !(matrix.exclude || []).some(filter => matches(leg, filter)));
  const original = new Set(axes.map(([key]) => key));
  for (const extra of matrix.include || []) {
    let merged = false;
    legs = legs.map(leg => {
      const compatible = Object.entries(extra).every(([key, value]) => !original.has(key) || JSON.stringify(leg[key]) === JSON.stringify(value));
      if (!compatible || !legs.length) return leg;
      merged = true;
      return { ...leg, ...extra };
    });
    if (!merged) legs.push({ ...extra });
  }
  if (legs.length > MAX_LEGS) return { kind: 'dynamic', legs: null };
  return { kind: 'static', legs: legs.length ? legs : [{}] };
}

// Replace ${{ matrix.key }} only; anything else makes the result unpredictable.
export function interpolateMatrix(text, leg) {
  let known = true;
  const value = String(text).replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (all, inner) => {
    const match = /^matrix\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(inner);
    if (!match || !Object.hasOwn(leg, match[1]) || typeof leg[match[1]] === 'object') { known = false; return all; }
    return String(leg[match[1]]);
  });
  return known ? value : null;
}

export function runnerLabels(job, leg) {
  const raw = job.runsOn;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list) return null;
  const labels = list.map(label => interpolateMatrix(label, leg));
  return labels.every(label => typeof label === 'string' && label && !expression(label)) ? labels : null;
}

// nektos/act v0.2.89 pkg/runner/run_context.go createContainerName.
export function actContainerName(...parts) {
  const name = parts.join('-').replace(/[^a-zA-Z0-9]/g, '-').replaceAll('--', '-');
  return `${name.slice(0, 63).replace(/^-+|-+$/g, '')}-${createHash('sha256').update(name).digest('hex')}`;
}

// The jobs act runs for `-j <job>`: the job and everything it needs.
export function jobClosure(workflow, jobId) {
  const byId = new Map(workflow.jobs.map(job => [job.id, job]));
  const order = [];
  const visit = (id, trail) => {
    if (trail.includes(id)) throw new Error('cyclic-job-needs');
    const job = byId.get(id);
    if (!job) throw new Error('unknown-job');
    if (order.includes(job)) return;
    for (const need of job.needs) visit(need, [...trail, id]);
    order.push(job);
  };
  visit(jobId, []);
  return order;
}

// Every Docker name act v0.2.89 can derive for these jobs. Names that cannot be
// predicted are returned as `unpredictable` so a caller can refuse to run.
export function actResourceNames(workflow, jobs, matrixFilter = {}) {
  const workflowName = workflow.name ?? path.posix.basename(workflow.path);
  const names = { container: new Set(), volume: new Set(), network: new Set() };
  const unpredictable = [];
  for (const job of jobs) {
    if (job.matrix.kind === 'dynamic') { unpredictable.push({ job: job.id, reason: 'dynamic-matrix' }); continue; }
    const legs = job.matrix.legs.filter(leg => Object.entries(matrixFilter)
      .every(([key, value]) => !Object.hasOwn(leg, key) || String(leg[key]) === value));
    const count = Math.max(legs.length, 1);
    for (const leg of legs) {
      const base = interpolateMatrix(job.name ?? job.id, leg);
      if (base === null) { unpredictable.push({ job: job.id, reason: 'job-name-expression' }); continue; }
      // act adds -<n> only when more than one leg remains; claim every candidate.
      for (const rcName of [base, ...Array.from({ length: count }, (_, i) => `${base}-${i + 1}`)]) {
        const jcn = actContainerName('act', `${workflowName}/${rcName}`);
        names.container.add(jcn);
        names.volume.add(jcn).add(`${jcn}-env`);
        for (const service of job.services) names.container.add(actContainerName(jcn, service));
        if (job.services.length) names.network.add(`${jcn}-${job.id}-network`);
        job.steps.forEach((step, index) => names.container.add(actContainerName(jcn, step.id ?? String(index))));
      }
    }
  }
  return { container: [...names.container], volume: [...names.volume], network: [...names.network], unpredictable };
}
