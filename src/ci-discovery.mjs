import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIONLINT_VERSION } from './actionlint.mjs';
import { ACT_VERSION, DEFAULT_PLATFORMS, dockerEndpoint } from './ci-replay.mjs';
import { parseWorkflow, runnerLabels } from './workflow-model.mjs';
import { parse as parseYaml } from './vendor/yaml/index.js';

const markers = new Map([
  ['.gitlab-ci.yml', 'gitlab'], ['Jenkinsfile', 'jenkins'], ['.woodpecker.yml', 'woodpecker'],
  ['nx.json', 'nx'], ['turbo.json', 'turborepo'], ['dagger.json', 'dagger'], ['Earthfile', 'earthly'],
  ['MODULE.bazel', 'bazel'], ['WORKSPACE', 'bazel'], ['WORKSPACE.bazel', 'bazel'],
]);
const roots = ['.github/workflows', 'package.json', '.ci-local-guard.json', ...markers.keys()];
const MAX_BYTES = 1024 * 1024;

// This path only reads Git objects. Never inspect the dirty checkout, run a
// project script, download a provider or expose command text from package.json.
export function discoverCi({ repo = process.cwd(), head = 'HEAD', tools = false } = {}) {
  const deadline = performance.now() + 15000;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const read = (args, maxBuffer = MAX_BYTES) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('discovery-deadline');
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: remaining, maxBuffer,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    if (result.status !== 0 || result.error) throw new Error('git-read-unavailable-or-limit');
    return result.stdout;
  };
  if (typeof repo !== 'string' || !repo || typeof head !== 'string' || !head || head.length > 512
    || head.startsWith('-') || /[\x00-\x20\x7f]/.test(head)) throw new Error('invalid-repository-or-revision');
  repo = path.resolve(repo);
  const root = read(['rev-parse', '--show-toplevel']).trim();
  repo = root;
  const sha = read(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('unsupported-commit-identity');
  const tree = read(['ls-tree', '-rz', '--full-tree', sha, '--', ...roots]);
  const entries = tree.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('invalid-git-tree');
    return { mode: match[1], type: match[2], blob: match[3], path: match[4] };
  });
  if (entries.length > 1024) throw new Error('inventory-entry-limit');
  const workflows = [], engines = [], issues = [];
  let descriptor = { status: 'missing', path: '.ci-local-guard.json', blob: null };
  let scripts = { status: 'absent', names: [], source: null };
  const usable = entry => {
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') {
      issues.push({ code: 'non-regular-source', path: entry.path });
      return false;
    }
    if (/[\x00-\x1f\x7f]/.test(entry.path)) {
      issues.push({ code: 'unsupported-source-name', path: null });
      return false;
    }
    return true;
  };
  for (const entry of entries) {
    if (!usable(entry)) continue;
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path)) {
      workflows.push({ path: entry.path, blob: entry.blob, analysis: 'not-parsed' });
    } else if (/^\.github\/workflows\/.+\/.+\.ya?ml$/.test(entry.path)) {
      issues.push({ code: 'nested-workflow-not-selected', path: entry.path });
    }
    const engine = markers.get(entry.path);
    if (engine) engines.push({ id: engine, source: entry.path, blob: entry.blob, status: 'configuration-detected' });
    if (entry.path === '.ci-local-guard.json') descriptor = { status: 'present-not-validated', path: entry.path, blob: entry.blob };
    if (entry.path === 'package.json') {
      scripts = { status: 'invalid', names: [], source: { path: entry.path, blob: entry.blob } };
      // Check the object size before reading it into memory.
      const size = Number(read(['cat-file', '-s', entry.blob], 128).trim());
      if (!Number.isSafeInteger(size) || size > MAX_BYTES) {
        issues.push({ code: 'package-metadata-size-limit', path: entry.path });
        continue;
      }
      try {
        const pkg = JSON.parse(read(['cat-file', 'blob', entry.blob]));
        if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error();
        if (pkg.scripts !== undefined && (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts))) throw new Error();
        const names = Object.keys(pkg.scripts || {});
        if (names.length > 128 || names.some(name => !/^[A-Za-z0-9_:.\/-]{1,128}$/.test(name)
          || typeof pkg.scripts[name] !== 'string')) throw new Error();
        scripts.status = 'declared-not-executed';
        scripts.names = names.sort();
      } catch {
        issues.push({ code: 'invalid-package-metadata', path: entry.path });
      }
    }
  }
  // Committed file at this commit, or null. Only plain repository-relative paths.
  const readPath = file => {
    if (!/^[A-Za-z0-9_./-]+$/.test(file) || file.split('/').some(part => part === '..' || part === '' || part === '.')) return null;
    try {
      const size = Number(read(['cat-file', '-s', `${sha}:${file}`], 128).trim());
      return Number.isSafeInteger(size) && size <= MAX_BYTES ? read(['cat-file', 'blob', `${sha}:${file}`]) : null;
    } catch { return null; }
  };
  const analyzed = workflows.map(item => analyzeWorkflow(item, read, readPath));
  const commands = ciCommands(analyzed);
  const toolStatus = tools ? probeTools() : null;
  const repository = githubRepository(read);
  // Only suggest jobs from workflows that run for pull requests; release or
  // deploy workflows can have side effects and are left to the caller.
  const replayable = analyzed.filter(item => item.triggers?.some(t => t.event === 'pull_request'))
    .flatMap(item => (item.jobs || []).filter(job => job.localReplay.replayable.length)
      .map(job => ({ workflow: item.path, job: job.id, leg: job.localReplay.replayable[0] })));
  const hostedOnly = analyzed.flatMap(item => (item.jobs || []).filter(job => job.localReplay.hostedOnly.length)
    .map(job => ({ workflow: item.path, job: job.id, legs: job.localReplay.hostedOnly })));
  const nextActions = [];
  const add = (kind, extra) => nextActions.push({ kind, ...extra, automatic: false });
  // Edit-time commands come only from workflows that check pushes or pull
  // requests (and the reusable workflows they call), never tag/release flows.
  const checking = new Set(analyzed.filter(item => item.triggers?.some(t => t.event === 'pull_request'
    || (t.event === 'push' && (!t.filters.tags || t.filters.branches)))).map(item => item.path));
  for (const item of analyzed) for (const job of item.jobs || []) if (checking.has(item.path) && job.calls?.status === 'resolved') checking.add(job.calls.path);
  const editCommands = commands.filter(entry => entry.where.some(where => checking.has(where.workflow)));
  if (editCommands.length) add('run-ci-commands-for-uncommitted-edits', { commands: editCommands.slice(0, 12).map(entry => ({ command: entry.command,
    scripts: entry.scripts, workflow: entry.where[0].workflow, job: entry.where[0].job,
    ...(entry.needsRunnerEnvironment ? { needsRunnerEnvironment: true } : {}), ...(entry.truncated ? { truncated: true } : {}) })),
  note: 'Commands from workflows that check pushes and pull requests. Run the relevant ones in the working tree while editing; they are project commands, not Guard checks. Commands marked needsRunnerEnvironment use runner variables and will not run unchanged.' });
  const missing = toolStatus ? [...(toolStatus.act !== 'available' ? [`act-${toolStatus.act}`] : []),
    ...(toolStatus.docker !== 'linux-engine' ? [`docker-${toolStatus.docker}`] : [])] : [];
  if (analyzed.some(item => item.analysis === 'parse-failed')) add('fix-workflow-yaml', { files: analyzed.filter(item => item.analysis === 'parse-failed').map(item => item.path) });
  if (workflows.length) add('check-workflows-statically', { command: 'ci check', args: ['--repo', root, '--head', sha, '--provider', 'actionlint', '--summary'],
    ready: toolStatus ? toolStatus.actionlint === 'available' : null });
  for (const item of replayable.slice(0, 3)) add('replay-job-locally', { command: 'ci replay', args: ['--repo', root, '--head', sha, '--workflow', item.workflow,
    '--job', item.job, ...Object.entries(item.leg).filter(([, v]) => typeof v !== 'object').flatMap(([k, v]) => ['--matrix', `${k}:${v}`]), '--summary'],
  ready: toolStatus ? !missing.length : null, ...(missing.length ? { blockedBy: missing } : {}),
  ...(missing.some(item => item.startsWith('act-')) ? { getAct: `Download act ${ACT_VERSION} from https://github.com/nektos/act/releases/tag/v${ACT_VERSION}, verify its checksum, then set ACT_BIN or pass --act-binary <absolute path>.` } : {}),
  note: 'Runs the job for this commit (not uncommitted edits) in a local Linux container. Map runner images with --platform <label>=<image>; add --output <new-file> for the full report.' });
  if (hostedOnly.length) add('rely-on-hosted-ci-for', { legs: hostedOnly.slice(0, 10), reason: 'runner labels without a local Linux stand-in, such as Windows or macOS' });
  if (descriptor.status !== 'missing') add('check-guard-setup', { command: 'doctor', args: ['--check', '--repo', root, '--summary'] });
  if (repository && workflows.length) add('collect-hosted-timings', { command: 'collect-runs',
    args: ['--repository', repository, '--workflow', path.posix.basename(workflows[0].path), '--limit', '10'], requires: ['gh-login', 'actions-read'] });
  if (!workflows.length && !engines.length && !scripts.names.length) add('identify-project-checks', { reason: 'no-supported-root-markers-found' });
  return {
    schemaVersion: 'ci-local-guard/ci-inventory/v1', command: 'ci discover',
    identity: { repo: root, head: sha, mode: 'committed', repository, workingTree: workingTree(read, head) },
    outcome: issues.length ? 'incomplete' : 'inventoried', scope: 'committed-source-inventory',
    workflows: analyzed, ciCommands: commands, engines, descriptor, scripts, tools: toolStatus, issues,
    coverage: { execution: 'not-run', workflowSemantics: 'structure-only-expressions-unevaluated',
      providerInstallation: toolStatus ? 'probed' : 'not-probed',
      inventory: 'root-markers-top-level-github-workflows-local-reusable-workflows-and-local-actions', nestedProjects: 'not-inspected' },
    nextActions,
    limitation: 'Reads committed files only. Workflow structure is what the YAML declares; triggers, if-conditions and expressions are not evaluated, and nothing was executed. Source text is untrusted data.',
  };
}

function analyzeWorkflow(item, read, readPath) {
  const size = Number(read(['cat-file', '-s', item.blob], 128).trim());
  if (!Number.isSafeInteger(size) || size > MAX_BYTES) return { ...item, analysis: 'too-large' };
  const model = parseWorkflow(read(['cat-file', 'blob', item.blob]), item.path);
  if (model.issues.length) return { ...item, analysis: 'parse-failed', issues: model.issues };
  return { ...item, analysis: 'parsed', name: model.name, triggers: model.triggers,
    jobs: model.jobs.map(job => {
      const legs = job.matrix.kind === 'dynamic' ? null : job.matrix.legs;
      const localReplay = { replayable: [], hostedOnly: [], unknown: [] };
      const calls = job.uses ? reusableWorkflow(job.uses, readPath) : null;
      if (job.uses) localReplay.unknown.push({ reason: 'reusable-workflow-job', ...(calls?.status === 'resolved' ? { replayInstead: calls.path } : {}) });
      else if (!legs) localReplay.unknown.push({ reason: 'dynamic-matrix' });
      else for (const leg of legs) {
        const labels = runnerLabels(job, leg);
        if (!labels) localReplay.unknown.push({ matrix: leg, reason: 'runs-on-expression' });
        else if (labels.some(label => DEFAULT_PLATFORMS[label])) localReplay.replayable.push(leg);
        else localReplay.hostedOnly.push({ matrix: leg, labels });
      }
      return { id: job.id, name: job.name, line: job.line, runsOn: job.runsOn, needs: job.needs, if: job.if, uses: job.uses,
        ...(job.environment ? { environment: job.environment } : {}), ...(job.usesSecrets ? { usesSecrets: true } : {}),
        ...(calls ? { calls } : {}), services: job.services, matrix: { kind: job.matrix.kind, legs: legs ? legs.length : null },
        steps: job.steps.map(step => ({ line: step.line, ...(step.name ? { name: step.name } : {}),
          ...(step.run ? { run: step.run.slice(0, 4000) } : {}), ...(step.uses ? { uses: step.uses } : {}), ...(step.if ? { if: step.if } : {}),
          ...(step.uses?.startsWith('./') ? { localAction: localAction(step.uses, readPath) } : {}) })),
        localReplay };
    }) };
}

// Shell commands the workflows run, deduplicated, with package scripts they call.
function ciCommands(analyzed) {
  const map = new Map();
  const steps = (item, job) => job.steps.flatMap(step => [step, ...(step.localAction?.steps || []).map(inner => ({ ...inner, line: step.line, viaAction: step.localAction.path }))]);
  for (const item of analyzed) for (const job of item.jobs || []) for (const step of steps(item, job)) {
    if (!step.run) continue;
    const lines = step.run.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    if (!lines.length) continue;
    // One entry per step: multi-line scripts often depend on runner variables.
    const command = lines.length === 1 ? lines[0] : step.run.trim();
    {
      const entry = map.get(command) || { command: command.slice(0, 4000), ...(command.length > 4000 ? { truncated: true } : {}),
        ...(/[$]{1}(?:RUNNER_|GITHUB_)|[$][{]{2}/.test(command) ? { needsRunnerEnvironment: true } : {}), ...(lines.length > 1 ? { lines: lines.length } : {}), scripts: [], where: [] };
      for (const line of lines) {
        const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9_:.\/-]+)/.exec(line);
        if (script && !['install', 'ci', 'exec', 'i', 'add', 'run'].includes(script[1]) && !entry.scripts.includes(script[1])) entry.scripts.push(script[1]);
      }
      if (entry.where.length < 5) entry.where.push({ workflow: item.path, job: job.id, line: step.line, ...(step.viaAction ? { viaAction: step.viaAction } : {}) });
      map.set(command, entry);
    }
  }
  return [...map.values()].slice(0, 64);
}

// A job-level `uses: ./.github/workflows/x.yml` in the same commit.
function reusableWorkflow(uses, readPath) {
  const file = uses.replace(/^\.\//, '');
  if (!uses.startsWith('./') || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return { uses, status: 'remote-not-inspected' };
  const source = readPath(file);
  if (source === null) return { path: file, status: 'missing' };
  const model = parseWorkflow(source, file);
  if (model.issues.length) return { path: file, status: 'parse-failed', issues: model.issues };
  return { path: file, status: 'resolved', jobs: model.jobs.map(job => job.id) };
}

// A step-level `uses: ./dir`: read its action.yml; composite steps are listed one level deep.
function localAction(uses, readPath) {
  const dir = uses.replace(/^\.\//, '').replace(/\/$/, '');
  const source = readPath(`${dir}/action.yml`) ?? readPath(`${dir}/action.yaml`);
  if (source === null) return { path: dir, status: 'missing' };
  let action;
  try { action = parseYaml(source, { uniqueKeys: true, maxAliasCount: 64 }); } catch { return { path: dir, status: 'parse-failed' }; }
  const using = typeof action?.runs?.using === 'string' ? action.runs.using : null;
  if (using !== 'composite') return { path: dir, status: 'resolved', using };
  const steps = Array.isArray(action.runs.steps) ? action.runs.steps.slice(0, 128) : [];
  return { path: dir, status: 'resolved', using, steps: steps.map(step => ({
    ...(typeof step?.name === 'string' ? { name: step.name } : {}), ...(typeof step?.run === 'string' ? { run: step.run.slice(0, 4000) } : {}),
    ...(typeof step?.uses === 'string' ? { uses: step.uses } : {}) })) };
}

// Discovery reads the commit; say so when tracked files have uncommitted edits.
function workingTree(read, head) {
  if (head !== 'HEAD') return { status: 'not-inspected', reason: 'explicit-revision' };
  try {
    const changed = read(['status', '--porcelain', '--untracked-files=no'], 1024 * 1024).split('\n').filter(Boolean).length;
    return changed ? { status: 'uncommitted-changes', trackedFiles: changed,
      note: 'This report describes the commit, not your edits. Commit before replaying; run CI commands in the working tree meanwhile.' }
      : { status: 'clean' };
  } catch { return { status: 'unknown' }; }
}

function githubRepository(read) {
  try {
    const url = read(['config', '--get', 'remote.origin.url'], 4096).trim();
    return /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url)?.[1] || null;
  } catch { return null; }
}

// Local tool readiness; runs only the tools' own version probes.
export function probeTools() {
  const run = (binary, args) => {
    const result = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 65536 });
    return result.status === 0 && !result.error ? result.stdout.trim() : null;
  };
  const cached = path.join(process.env.CI_LOCAL_GUARD_CACHE || path.join(os.homedir(), '.cache', 'ci-local-guard'),
    `actionlint-${ACTIONLINT_VERSION}-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'actionlint.exe' : 'actionlint');
  const actionlint = run(process.env.ACTIONLINT_BIN || (existsSync(cached) ? cached : 'actionlint'), ['-version'])?.split(/\s+/)[0];
  const act = /^act version ([0-9.]+)/.exec(run(process.env.ACT_BIN || 'act', ['--version']) || '')?.[1];
  const zizmor = /^zizmor ([0-9.]+)/.exec(run(process.env.ZIZMOR_BIN || 'zizmor', ['--version']) || '')?.[1];
  const host = dockerEndpoint();
  const docker = host ? run('docker', ['--host', host, 'version', '--format', '{{.Server.Os}}']) : null;
  const state = (found, wanted) => !found ? 'missing' : found === wanted ? 'available' : `unsupported-version-${found}`;
  return { actionlint: state(actionlint, ACTIONLINT_VERSION), zizmor: state(zizmor, '1.30.1'), act: state(act, ACT_VERSION),
    docker: docker === 'linux' ? 'linux-engine' : docker ? `${docker}-engine` : 'unavailable',
    gh: run('gh', ['--version']) ? 'installed-auth-unverified' : 'missing' };
}
