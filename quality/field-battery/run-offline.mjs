// Offline edge battery — no gh, no Docker. Run: node run-offline.mjs [--only <substr>]
import { battery, makeRepo, tmpFile, run, git, wf, REAL_REPO, ROOT } from './lib/harness.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const S = [];

// --- discover: repository shapes ---
S.push({
  // The plain directory must sit outside any git repository, or discover walks up
  // to the enclosing repo and inventories it instead of reporting blocked.
  name: 'discover-non-repo',
  args: ['ci', 'discover', '--repo', path.join(nodeOs.tmpdir(), 'guard-field-battery-plain-dir')],
  run() { mkdirSync(path.dirname(this.args[3]), { recursive: true }); mkdirSync(this.args[3], { recursive: true }); return run(this.args); },
  expect: r => [r.json && r.json.outcome !== 'blocked' ? 'expected blocked outcome' : null].filter(Boolean),
});
S.push({
  name: 'discover-no-workflows',
  args: ['ci', 'discover', '--repo', ''],
  run() { const d = makeRepo('no-wf', { 'README.md': 'x' }); return run(['ci', 'discover', '--repo', d]); },
  // v0.2.1 N3: discover itself notes no-github-workflows instead of deferring to ci check.
  expect: r => [!r.json ? `expected graceful report, got exit=${r.code}` : null,
    !(r.json?.notes || []).some(n => n.code === 'no-github-workflows') ? 'no-github-workflows note missing from discover' : null].filter(Boolean),
  note: r => `notes=${(r.json?.notes || []).map(n => n.code).join(',') || 'none'}`,
});
S.push({
  name: 'discover-invalid-yaml',
  run() { const d = makeRepo('bad-yaml', { '.github/workflows/bad.yml': 'on: [push\njobs:\n\t x: {', }); return run(['ci', 'discover', '--repo', d]); },
  expect: r => [!r.json ? `no JSON report (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.issues?.map(i => i.code).join(',') || r.json?.verdict || null,
});
S.push({
  name: 'discover-huge-workflow-1.1MB',
  run() { const d = makeRepo('huge-wf', { '.github/workflows/big.yml': wf.basic() + '# ' + 'x'.repeat(1100 * 1024) + '\n' }); return run(['ci', 'discover', '--repo', d, '--summary']); },
  expect: r => [!r.json ? `no JSON report (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || 'accepted',
});
S.push({
  name: 'discover-workflows-path-is-file',
  run() { const d = makeRepo('wf-is-file', { '.github/workflows': 'not a directory' }); return run(['ci', 'discover', '--repo', d]); },
  expect: r => [!r.json ? `no JSON report (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || 'accepted',
});
S.push({
  name: 'discover-bad-package-json',
  run() { const d = makeRepo('bad-pkg', { 'package.json': '{ oops', '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'discover', '--repo', d]); },
  expect: r => [!r.json ? `no JSON report (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.issues?.map(i => i.code).join(',') || 'accepted',
});
S.push({
  name: 'discover-descriptor-json',
  run() { const d = makeRepo('descriptor', { '.github/workflows/ci.yml': wf.basic(), '.ci-local-guard.json': JSON.stringify({ pushPolicy: {} }) }); return run(['ci', 'discover', '--repo', d]); },
  expect: r => [!r.json ? 'no JSON report' : null].filter(Boolean),
  note: r => r.json?.identity?.descriptor || JSON.stringify(r.json?.issues || []),
});
S.push({
  name: 'discover-path-spaces-unicode',
  run() { const d = makeRepo('sp accent 我的/places repo', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'discover', '--repo', d]); },
  expect: r => [r.json?.outcome === 'passed' || r.json?.outcome === 'inventoried' ? null : `outcome=${r.json?.outcome} exit=${r.code}`].filter(Boolean),
});
S.push({
  name: 'discover-head-nonexistent',
  run() { const d = makeRepo('head-ref', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'discover', '--repo', d, '--head', 'refs/heads/nope']); },
  expect: r => [!(r.json?.outcome === 'blocked') ? `expected blocked, got ${r.json?.outcome} exit=${r.code}` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || null,
});
S.push({
  name: 'discover-head-dash-injection',
  run() { const d = makeRepo('head-dash', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'discover', '--repo', d, '--head', '--exec=evil']); },
  expect: r => [!(r.json?.outcome === 'blocked') ? `expected blocked, got ${r.json?.outcome}` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || null,
});
S.push({
  name: 'discover-head-sha',
  run() { const d = makeRepo('head-sha', { '.github/workflows/ci.yml': wf.basic() }); const sha = run(['ci', 'discover', '--repo', d]); const head = sha.json?.identity?.head; return head ? run(['ci', 'discover', '--repo', d, '--head', head]) : sha; },
  expect: r => [r.json?.outcome !== 'passed' && r.json?.outcome !== 'inventoried' ? `outcome=${r.json?.outcome}` : null].filter(Boolean),
});

// --- discover: inventory scaling (deadline pressure, offline) ---
// v0.2.1 N1: budget scales 15s + 250ms/entry (cap 120s); a deadline/unavailable
// issue here means the scaling regressed. 1025 still hits inventory-entry-limit.
for (const n of [60, 150, 400, 1025]) {
  S.push({
    name: `discover-scaling-${n}-workflows`,
    run() {
      const files = {};
      for (let i = 0; i < n; i++) files[`.github/workflows/w${i}.yml`] = wf.basic(['main', `b${i}`]);
      const d = makeRepo(`scale-${n}`, files);
      return run(['ci', 'discover', '--repo', d, '--summary'], { timeoutMs: 180000 });
    },
    expect: r => [!r.json ? `no JSON (exit=${r.code} killed=${r.killedByTimeout})` : null,
      (r.json?.issues || []).some(i => /deadline|git-read-unavailable|git-call-timeout/.test(i.code || '')) ? `deadline regression at n=${n}: ${(r.json.issues || []).map(i => i.code).join(',')}` : null].filter(Boolean),
    note: r => `${r.json?.outcome ?? 'exit=' + r.code} issues=${(r.json?.issues || []).map(i => i.code).join(',')}`,
  });
}

// --- diff (offline, synthetic) ---
S.push({
  name: 'diff-branch-narrowing-regression',
  run() {
    const d = makeRepo('diff-narrow', { '.github/workflows/ci.yml': wf.basic(['main', 'dev']) },
      { extraCommits: [{ files: { '.github/workflows/ci.yml': wf.basic(['main']) }, msg: 'drop dev' }] });
    return run(['ci', 'diff', '--repo', d, '--base', 'HEAD~1', '--head', 'HEAD', '--json']);
  },
  expect: r => {
    if (!r.json) return [`no JSON (exit=${r.code})`];
    const scenarios = JSON.stringify(r.json);
    return [!/dev/.test(scenarios) ? 'dev push scenario not represented' : null,
      r.json.outcome === 'unchanged' ? 'expected a change to be reported' : null].filter(Boolean);
  },
  note: r => `${r.json?.outcome} reduced=${r.json?.summary?.reduced} review=${r.json?.summary?.review}`,
});
S.push({
  name: 'diff-output-existing-file-refused',
  run() {
    const d = makeRepo('diff-out', { '.github/workflows/ci.yml': wf.basic() },
      { extraCommits: [{ files: { '.github/workflows/ci.yml': wf.basic(['main']) }, msg: 'c2' }] });
    const existing = tmpFile('diff-existing.json', '{"old":true}');
    return run(['ci', 'diff', '--repo', d, '--base', 'HEAD~1', '--head', 'HEAD', '--output', existing]);
  },
  expect: r => {
    const kept = readFileSync(path.join(ROOT, 'tmp', 'diff-existing.json'), 'utf8');
    return [kept.includes('"old":true') ? null : 'existing output file was overwritten'].filter(Boolean);
  },
  note: r => `exit=${r.code} ${r.json?.issues?.[0]?.code || r.json?.outcome}`,
});

// --- read-evidence edges (offline) ---
const re = (name, args, files) => ({ name, run() { files?.(); return run(['read-evidence', ...args]); } });
S.push(re('read-evidence-empty-file', ['--file', tmpFile('ev-empty.txt', ''), '--limit', '16'], null));
S.push(re('read-evidence-binary', ['--file', (() => { const p = path.join(ROOT, 'tmp', 'ev-bin.bin'); writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x82, 0x83])); return p; })(), '--limit', '16'], null));
S.push(re('read-evidence-limit-below-min', ['--file', tmpFile('ev-min.txt', 'abcdefgh'), '--limit', '3'], null));
S.push(re('read-evidence-limit-above-max', ['--file', tmpFile('ev-max.txt', 'x'.repeat(20000)), '--limit', '99999999'], null));
S.push(re('read-evidence-negative-offset', ['--file', tmpFile('ev-neg.txt', 'abcdefgh'), '--offset', '-4', '--limit', '4'], null));
S.push(re('read-evidence-offset-past-eof', ['--file', tmpFile('v-eof.txt', 'abcdefgh'), '--offset', '9999', '--limit', '4'], null));
S.push(re('read-evidence-version-mismatch', ['--file', tmpFile('ev-ver.txt', 'abcdefgh'), '--limit', '4', '--version', 'deadbeef'], null));
S.push(re('read-evidence-missing-file', ['--file', path.join(ROOT, 'tmp', 'does-not-exist.log'), '--limit', '4'], null));
S.push(re('read-evidence-directory-as-file', ['--file', path.join(ROOT, 'tmp'), '--limit', '4'], null));
for (const s of S.filter(x => x.name.startsWith('read-evidence'))) {
  s.expect = r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean);
  s.note = r => `${r.json?.status || r.json?.reason || r.json?.outcome} ${(r.json?.text || r.json?.reason || '').slice(0, 40)}`;
}

// --- offline export commands: crafted envelopes ---
const minimalExport = (runId = 1, jobId = 1) => ({
  schemaVersion: 'ci-local-guard/github-export/v1', repository: 'acme/widgets',
  runs: [{ run: { id: runId, workflow_id: 1, name: 'CI', event: 'push', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', run_started_at: '2026-10-11T00:00:00Z', created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:01:00Z', run_attempt: 1 }, jobs: { total_count: 1, jobs: [{ id: jobId, run_id: runId, run_attempt: 1, head_sha: 'a'.repeat(40), name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-10-11T00:00:10Z', completed_at: '2026-10-11T00:00:40Z', steps: [{ number: 1, name: 'Run tests', status: 'completed', conclusion: 'success', started_at: '2026-10-11T00:00:10Z', completed_at: '2026-10-11T00:00:40Z' }] }] } }],
});
const envelope = (before, after) => ({ schemaVersion: 'ci-local-guard/run-comparison-input/v1', before, after });
const exportCase = (name, input, verb = 'inspect-runs') => ({
  name, run() { const p = tmpFile(`env-${name}.json`, JSON.stringify(input)); return run([verb, '--input', p]); },
  expect: r => [!(r.json || /^(\[ci-local-guard\]|Usage)/.test(r.stderr || '')) ? `neither JSON nor graceful stderr rejection (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json ? `${r.json.outcome} ${(r.json.issues || []).map(i => i.code).join(',')}` : `rejected-without-json: ${(r.stderr || '').trim().slice(0, 60)}`,
});
S.push(exportCase('inspect-minimal-valid', minimalExport()));
S.push(exportCase('inspect-wrong-schema', { ...minimalExport(), schemaVersion: 'something/else/v9' }));
S.push(exportCase('inspect-missing-runs', { schemaVersion: 'ci-local-guard/github-export/v1', repository: 'a/b' }));
S.push(exportCase('inspect-null-timestamps', (() => { const e = minimalExport(); e.runs[0].jobs.jobs[0].started_at = null; e.runs[0].jobs.jobs[0].completed_at = null; return e; })()));
S.push(exportCase('inspect-negative-duration', (() => { const e = minimalExport(); e.runs[0].jobs.jobs[0].started_at = '2026-10-11T00:00:40Z'; e.runs[0].jobs.jobs[0].completed_at = '2026-10-11T00:00:10Z'; return e; })()));
S.push(exportCase('inspect-duplicate-ids', (() => { const e = minimalExport(); const e2 = minimalExport(); e2.runs[0].run.id = 1; return { ...e, runs: [...e.runs, ...e2.runs] }; })()));
S.push(exportCase('inspect-empty-runs', { schemaVersion: 'ci-local-guard/github-export/v1', repository: 'a/b', runs: [] }));
S.push(exportCase('inspect-null-run-field', (() => { const e = minimalExport(); e.runs[0].run.head_sha = null; return e; })()));
S.push(exportCase('compare-valid', envelope(minimalExport(), minimalExport(2, 2)), 'compare-runs'));
S.push(exportCase('compare-cross-repository', envelope(minimalExport(), { ...minimalExport(2, 2), repository: 'acme/other' }), 'compare-runs'));
S.push(exportCase('audit-minimal-valid', minimalExport(), 'audit-runs'));

// v0.2.1 N2: invalid offline input answers with a JSON blocked report and exit 2,
// not exit 1 + bare stderr. Add file-level invalid inputs, then tighten every
// invalid export case to require the JSON blocked report.
S.push(exportCase('inspect-nonexistent-file', null));
S[S.length - 1].run = () => run(['inspect-runs', '--input', path.join(ROOT, 'tmp', 'no-such-export.json')]);
S.push(exportCase('inspect-directory-input', null));
S[S.length - 1].run = () => run(['inspect-runs', '--input', path.join(ROOT, 'tmp')]);
S.push(exportCase('inspect-non-json-input', null));
S[S.length - 1].run = () => run(['inspect-runs', '--input', tmpFile('env-inspect-non-json-input.json', 'this is { not json')]);
S.push(exportCase('inspect-missing-input-flag', null));
S[S.length - 1].run = () => run(['inspect-runs']);
for (const s of S.filter(x => /^(inspect-(?!minimal-valid)|compare-cross-repository)/.test(x.name))) {
  s.expect = r => [!r.json ? `no JSON blocked report (exit=${r.code}, stderr=${(r.stderr || '').trim().slice(0, 60)})` : null,
    r.json && r.json.outcome === 'blocked' && r.code !== 2 ? `exit=${r.code}, expected 2 for blocked` : null].filter(Boolean);
  s.note = r => r.json ? `${r.json.outcome} exit=${r.code} ${(r.json.issues || []).map(i => i.code).join(',')}` : `rejected-without-json: ${(r.stderr || '').trim().slice(0, 60)}`;
}

// --- static check / doctor / plan (offline) ---
S.push({
  name: 'check-real-repo-actionlint',
  args: ['ci', 'check', '--repo', REAL_REPO, '--summary'],
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `findings=${r.json?.staticCheck?.findings ?? r.json?.findings ?? '?'} exit=${r.code}`,
});
S.push({
  name: 'check-zizmor-binary-missing',
  run() { return run(['ci', 'check', '--repo', REAL_REPO, '--provider', 'zizmor', '--binary', 'C:/nonexistent-zizmor.exe']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || r.json?.outcome || null,
});
S.push({
  name: 'doctor-real-repo',
  args: ['doctor', '--check', '--json', '--repo', REAL_REPO],
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => Object.keys(r.json || {}).slice(0, 6).join(','),
});
S.push({
  name: 'plan-two-commits',
  run() { return run(['plan', '--repo', REAL_REPO, '--base', 'HEAD~3', '--head', 'HEAD', '--event', 'push', '--json']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => r.json?.outcome || null,
});
S.push({
  name: 'preflight-generic-without-policy',
  // Preflight runs the checks the change selects; on this checkout that can be the full node --test suite.
  run() { return run(['preflight', '--repo', REAL_REPO, '--base', 'HEAD~3', '--head', 'HEAD', '--json'], { timeoutMs: 300000 }); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome} ${(r.json?.issues || []).map(i => i.code).join(',')}`,
});

// --- ci optimize (static: fixture repos have no remote) and ci verify hostExecutable ---
const callerWorkflows = () => ({
  '.github/workflows/ci.yml': 'name: Tests\non:\n  push:\n    branches: [\'**\']\n  workflow_call:\nconcurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  test:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - run: echo ok\n',
  '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: [\'v*\']\njobs:\n  verify:\n    uses: ./.github/workflows/ci.yml\n',
});
const findingCodes = r => (r.json?.findings || []).map(f => `${f.code}:${f.job || ''}`);
for (const filtered of [false, true]) S.push({
  name: `optimize-call-job-bounded${filtered ? '-filtered' : ''}`,
  run() { const d = makeRepo('opt-call', callerWorkflows()); return run(['ci', 'optimize', '--repo', d, ...(filtered ? ['--workflow', 'release.yml'] : []), '--json']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null,
    findingCodes(r).includes('missing-timeout-minutes:verify') ? 'call job reported unbounded although every called job has timeout-minutes' : null].filter(Boolean),
  note: r => `${r.json?.outcome} ${r.json?.coverage?.history} [${findingCodes(r).join(',')}]`,
});
S.push({
  name: 'optimize-concurrency-without-cancel',
  run() { const d = makeRepo('opt-conc', { '.github/workflows/pr.yml': 'name: PR\non: [pull_request]\nconcurrency:\n  group: pr-${{ github.ref }}\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo ok\n' }); return run(['ci', 'optimize', '--repo', d, '--json']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null,
    !(r.json?.findings || []).some(f => f.code === 'missing-concurrency-cancel' && f.evidence?.concurrency === 'queues-without-cancel') ? 'a pull request group without cancel-in-progress not reported as queueing' : null].filter(Boolean),
  note: r => `${r.json?.outcome} [${findingCodes(r).join(',')}]`,
});
S.push({
  name: 'optimize-global-tool-install',
  run() { const d = makeRepo('opt-global', { '.github/workflows/ci.yml': 'name: CI\non:\n  push:\n    tags: [\'v*\']\njobs:\n  t:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - run: npm install -g npm@11\n      - run: pip install --user pipx\n' }); return run(['ci', 'optimize', '--repo', d, '--json']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null,
    findingCodes(r).some(code => code.startsWith('uncached-dependency-install')) ? 'global tool installs reported as dependency installs' : null].filter(Boolean),
  note: r => `${r.json?.outcome} [${findingCodes(r).join(',')}]`,
});
S.push({
  name: 'verify-host-executable-shell-and-dir',
  skip: process.platform !== 'win32' && 'hostExecutable lists windows legs only on a Windows host',
  run() {
    const steps = Array.from({ length: 14 }, (_, i) => `      - run: echo step${i + 1}\n`).join('');
    const d = makeRepo('verify-hostexec', { '.github/workflows/win.yml': `name: Win\non: [push]\njobs:\n  win:\n    runs-on: windows-latest\n    timeout-minutes: 5\n    defaults:\n      run:\n        shell: bash\n        working-directory: app\n    steps:\n${steps}  plain:\n    runs-on: windows-latest\n    timeout-minutes: 5\n    steps:\n      - run: echo plain\n` });
    return run(['ci', 'verify', '--repo', d, '--event', 'push'], { timeoutMs: 300000 });
  },
  expect: r => {
    const legs = r.json?.hostExecutable || [];
    const leg = legs.find(item => item.job === 'win');
    const plain = legs.find(item => item.job === 'plain')?.commands?.[0];
    if (!leg) return [`no hostExecutable leg for win (exit=${r.code}, outcome=${r.json?.outcome})`];
    return [leg.totalCommands !== 14 || leg.truncated !== true ? `totalCommands=${leg.totalCommands} truncated=${leg.truncated} (expected 14, true)` : null,
      leg.commands.some(c => c.workingDirectory !== 'app') ? 'defaults.run.working-directory (app) not carried on every command' : null,
      leg.commands.some(c => c.shell !== 'bash' || c.shellSource !== 'declared') ? 'declared defaults.run.shell (bash) not carried on every command' : null,
      plain?.shell !== 'pwsh' ? `undeclared shell on windows is ${plain?.shell}, expected the runner default pwsh` : null].filter(Boolean);
  },
  note: r => `${r.json?.outcome} legs=${r.json?.hostExecutable?.length} commands=${r.json?.hostExecutable?.[0]?.commands?.length}`,
});

// --- project adoption (docs/reference.md "Connect a project"): descriptor, adapter, receipt, plan, pre-push, hooks ---
// One committed fixture project; ADAPTER_MODE / PLAN_MODE (inherited by the adapters) select the behaviour under test.
const ADOPT_ADAPTER = `
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const opt = flag => process.argv[process.argv.indexOf(flag) + 1];
const mode = process.env.ADAPTER_MODE || 'ok';
const base = opt('--base'), head = opt('--head'), event = opt('--event');
if (process.env.ADAPTER_MARKER) appendFileSync(process.env.ADAPTER_MARKER, mode + ' ' + event + '\\n');
const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', base, head], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
mkdirSync('tmp/preflight', { recursive: true });
writeFileSync('tmp/preflight/unit.log', 'unit-output-line\\n');
writeFileSync('tmp/preflight/lint.log', 'lint-output-line ' + 'x'.repeat(50) + '\\n');
if (mode === 'throw') throw new Error('adapter crashed on purpose');
const failed = mode === 'fail' || mode === 'fail-exit0';
const checks = [
  { id: '0:unit', owner: 'unit', why: 'unit tests', status: 'ran', result: 'success', durationMs: 5, log: 'unit.log', blockedBy: null },
  { id: '1:lint', owner: 'lint', why: 'lint', status: 'ran', result: failed ? 'failure' : 'success', durationMs: 3, log: 'lint.log', blockedBy: null },
];
const receipt = { schemaVersion: 'ci-local-guard/project-preflight/v1', identity: { base, head, event, mode: 'committed' },
  changedFiles: changed, checks, outcome: failed ? 'failed' : 'incomplete', unverified: ['browser'] };
if (mode === 'bad-identity') receipt.identity.head = '0'.repeat(40);
if (mode === 'bad-event') receipt.identity.event = event === 'push' ? 'pull_request' : 'push';
if (mode === 'bad-changed') receipt.changedFiles = ['nope.txt'];
if (mode === 'no-schema') delete receipt.schemaVersion;
if (mode === 'log-escape') receipt.checks[0].log = '../unit.log';
if (mode === 'log-missing') receipt.checks[0].log = 'gone.log';
if (mode === 'outcome-local-complete') receipt.outcome = 'local-complete';
if (mode === 'outcome-mismatch') receipt.checks[1].result = 'failure';
if (mode === 'dup-id') receipt.checks[1].id = '0:unit';
if (mode === 'only-unit') receipt.checks = receipt.checks.slice(0, 1);
if (mode === 'external-lint') receipt.checks[1] = { id: '1:lint', owner: 'lint', why: 'needs a hosted runner', status: 'external-owner', result: null, durationMs: null, log: null, blockedBy: null };
if (mode !== 'no-receipt') writeFileSync('tmp/preflight/project-report.json', JSON.stringify(receipt));
process.exitCode = (mode === 'fail' || mode === 'exit1-success') ? 1 : 0;
`;
const ADOPT_PLAN = `
import { execFileSync } from 'node:child_process';
const opt = flag => process.argv[process.argv.indexOf(flag) + 1];
const mode = process.env.PLAN_MODE || 'ok';
const base = opt('--base'), head = opt('--head'), event = opt('--event');
if (mode === 'leak') { console.log('PLAN-LEAK-7f3a'); console.error('PLAN-LEAK-7f3a'); process.exit(3); }
let changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', base, head], { encoding: 'utf8' }).trim().split('\\n').filter(Boolean);
if (mode === 'bad-changed') changed = ['other.txt'];
const out = { schemaVersion: 'ci-local-guard/project-plan/v1', identity: { base, head, event, mode: 'committed' },
  changedFiles: changed, eventContext: JSON.parse(process.env.CI_LOCAL_GUARD_EVENT_CONTEXT),
  jobs: [{ id: 'ci', selected: true, reason: 'always', owners: ['unit', 'lint'] }], needsReview: mode === 'review' };
if (mode === 'drop-pr') { delete out.eventContext.prAction; delete out.eventContext.prFork; }
if (mode === 'no-context') delete out.eventContext;
console.log(JSON.stringify(out));
process.exitCode = mode === 'review' ? 2 : 0;
`;
const adoptDescriptor = ({ pushPolicy = true, plan = true, receipt = 'guard-v1', entrypoint = 'quality/preflight.mjs', dependencies = 'none', bindings } = {}) => JSON.stringify({
  schemaVersion: 'ci-local-guard/project/v1',
  preflight: { entrypoint, dependencies, receipt },
  ...(plan ? { plan: { entrypoint: 'quality/plan.mjs', dependencies: 'none' } } : {}),
  ...(pushPolicy ? { pushPolicy: { schemaVersion: 'ci-local-guard/local-push-policy/v1', scope: 'project-declared-local-gates', targetRefs: ['refs/heads/main'],
    bindings: bindings || [{ job: 'ci', owner: 'unit', checkIds: ['0:unit'] }, { job: 'ci', owner: 'lint', checkIds: ['1:lint'] }] } } : {}),
}, null, 1);
// base = HEAD~1, head = HEAD; the change touches src/a.txt only.
const adoptProject = (name, { desc, files } = {}) => makeRepo(name, {
  '.ci-local-guard.json': desc ?? adoptDescriptor(), 'quality/preflight.mjs': ADOPT_ADAPTER, 'quality/plan.mjs': ADOPT_PLAN, 'src/a.txt': 'one\n', ...files,
}, { extraCommits: [{ files: { 'src/a.txt': 'two\n' }, msg: 'change' }] });
const adoptCache = new Map();
const adopt = (key, opts) => { if (!adoptCache.has(key)) adoptCache.set(key, adoptProject(`adopt-${key}`, opts)); return adoptCache.get(key); };
const adoptIds = d => ({ base: git(d, ['rev-parse', 'HEAD~1']).trim(), head: git(d, ['rev-parse', 'HEAD']).trim() });
const adoptMarker = name => { const p = path.join(ROOT, 'tmp', `adopt-marker-${name}.txt`); mkdirSync(path.dirname(p), { recursive: true }); rmSync(p, { force: true }); return p; };
const markerRuns = p => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').length : 0);
const adoptPreflight = (d, env = {}, extra = []) => run(['preflight', '--repo', d, '--base', 'HEAD~1', '--head', 'HEAD', '--summary', ...extra], { env });
const adoptPlan = (d, extra = [], env = {}) => run(['plan', '--repo', d, '--base', 'HEAD~1', '--head', 'HEAD', ...extra], { env });
const gitRaw = (cwd, args, env = {}) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...env } });
const gitLocalConfig = (cwd, key) => { const r = gitRaw(cwd, ['config', '--local', '--get', key]); return r.status === 0 ? r.stdout.trim() : null; };
const said = r => `${r.stdout || ''}${r.stderr || ''}`;
const causes = r => r.json?.execution?.causes || [];
const guardHooksPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks').split(path.sep).join('/');

// preflight + adapter + receipt
S.push({
  name: 'adopt-preflight-pass',
  run() { const d = adopt('pre'); const r = adoptPreflight(d); r.ids = adoptIds(d); return r; },
  expect: r => [r.code !== 0 ? `exit=${r.code}, expected 0` : null,
    r.json?.outcome !== 'incomplete' ? `outcome=${r.json?.outcome}, expected incomplete (pass never claims complete CI)` : null,
    r.json?.execution?.result !== 'success' || r.json?.execution?.receiptStatus !== 'validated' ? `execution=${JSON.stringify(r.json?.execution)}` : null,
    r.json?.identity?.base !== r.ids.base || r.json?.identity?.head !== r.ids.head ? 'identity does not echo the exact base/head SHAs' : null,
    r.json?.identity?.event !== 'pull_request' ? `default event=${r.json?.identity?.event}, docs say pull_request` : null,
    (r.json?.evidence || []).length ? 'successful run kept a log (docs: removed by default)' : null,
    !(r.json?.coverage?.projectUnverified || []).includes('browser') ? 'receipt unverified item not carried into coverage.projectUnverified' : null].filter(Boolean),
  note: r => `${r.json?.outcome} unverified=${(r.json?.coverage?.projectUnverified || []).join(',')}`,
});
S.push({
  name: 'adopt-preflight-adapter-fails-evidence-jump',
  run() {
    const d = adopt('pre');
    const r = adoptPreflight(d, { ADAPTER_MODE: 'fail' });
    const location = r.json?.execution?.failedChecks?.[0]?.evidenceLocation;
    const log = r.json?.evidence?.[0];
    if (location && log) {
      const first = run(['read-evidence', '--file', log.path, '--limit', '4096']);
      r.jump = run(['read-evidence', '--file', log.path, '--offset', String(location.startByte), '--version', first.json?.version || 'missing', '--limit', String(location.endByte - location.startByte)]);
    }
    return r;
  },
  expect: r => {
    const failed = r.json?.execution?.failedChecks || [];
    const location = failed[0]?.evidenceLocation;
    const page = r.jump?.json;
    return [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
      r.json?.outcome !== 'failed' ? `outcome=${r.json?.outcome}` : null,
      failed.length !== 1 || failed[0].id !== '1:lint' ? `failedChecks=${JSON.stringify(failed.map(f => f.id))}, expected only 1:lint` : null,
      !location ? 'failed check carries no evidenceLocation' : null,
      r.json?.evidence?.[0]?.availability !== 'retained-at-report-time' ? 'failure log not retained' : null,
      location && page?.status !== 'available' ? `read-evidence jump failed: ${JSON.stringify(page)}` : null,
      page && (page.offset !== location.startByte || page.endOffset !== location.endByte) ? `jump window ${page.offset}-${page.endOffset}, location ${location.startByte}-${location.endByte}` : null,
      page && !page.text.includes('lint-output-line') ? 'jump did not land on the failing check section' : null,
      page && page.text.includes('unit-output-line') ? 'jump window leaks the neighbouring passing check' : null].filter(Boolean);
  },
  note: r => `jump=${r.jump?.json?.status} ${r.jump?.json?.offset}-${r.jump?.json?.endOffset}`,
});
S.push({
  name: 'adopt-preflight-adapter-crash-keeps-log',
  run() {
    const r = adoptPreflight(adopt('pre'), { ADAPTER_MODE: 'throw' });
    const log = r.json?.evidence?.[0];
    if (log) r.page = run(['read-evidence', '--file', log.path, '--limit', '8192']);
    return r;
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
    !causes(r).includes('child-exit-nonzero') || !causes(r).includes('receipt-unavailable') ? `causes=${causes(r).join(',')}` : null,
    !r.page?.json?.text?.includes('adapter crashed on purpose') ? 'retained log does not show the adapter crash' : null].filter(Boolean),
  note: r => `causes=${causes(r).join(',')}`,
});
S.push({
  name: 'adopt-preflight-no-receipt',
  run() { return adoptPreflight(adopt('pre'), { ADAPTER_MODE: 'no-receipt' }); },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1 (exit 0 child without a receipt is not a pass)` : null,
    !causes(r).includes('receipt-unavailable') ? `causes=${causes(r).join(',')}` : null].filter(Boolean),
});
const receiptRejections = ['fail-exit0', 'exit1-success', 'outcome-mismatch', 'outcome-local-complete', 'bad-identity', 'bad-event', 'bad-changed',
  'no-schema', 'log-escape', 'log-missing', 'dup-id'];
for (const mode of receiptRejections) S.push({
  name: `adopt-receipt-rejected-${mode}`,
  run() { return adoptPreflight(adopt('pre'), { ADAPTER_MODE: mode }); },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
    r.json?.outcome !== 'failed' ? `outcome=${r.json?.outcome}` : null,
    !causes(r).includes('receipt-invalid') ? `causes=${causes(r).join(',')}, expected receipt-invalid` : null,
    r.json?.execution?.receiptStatus !== 'invalid' ? `receiptStatus=${r.json?.execution?.receiptStatus}` : null,
    (r.json?.execution?.failedChecks || []).length ? 'an invalid receipt still produced failedChecks' : null].filter(Boolean),
  note: r => `${(r.stderr.match(/preflight failed \((.*?)\); log:/) || [])[1] || r.stderr.trim().slice(0, 80)}`,
});
S.push({
  name: 'adopt-receipt-rejection-reasons-distinguishable',
  known: '#10',
  run() {
    const reasons = {};
    for (const mode of ['bad-identity', 'bad-event', 'no-schema', 'log-escape', 'dup-id', 'outcome-local-complete']) {
      const r = adoptPreflight(adopt('pre'), { ADAPTER_MODE: mode });
      reasons[mode] = (r.stderr.match(/preflight failed \((.*?)\); log:/) || [])[1] || null;
    }
    return { code: 0, ms: 0, reasons };
  },
  expect: r => {
    const distinct = new Set(Object.values(r.reasons));
    return distinct.size < Object.keys(r.reasons).length
      ? [`${Object.keys(r.reasons).length} different receipt defects produce ${distinct.size} distinct message(s): ${[...distinct].join(' / ')}`] : [];
  },
  note: r => `distinct=${new Set(Object.values(r.reasons)).size}`,
});
S.push({
  name: 'adopt-receipt-external-owner-and-missing-owner',
  run() {
    const d = adopt('pre');
    const withPlan = ['--event', 'push', '--ref', 'refs/heads/main', '--with-plan'];
    return Object.assign(adoptPreflight(d, { ADAPTER_MODE: 'external-lint' }, withPlan), {
      missing: adoptPreflight(d, { ADAPTER_MODE: 'only-unit' }, withPlan), plain: adoptPreflight(d, { ADAPTER_MODE: 'external-lint' }) });
  },
  expect: r => [r.code !== 2 ? `external-owner with plan: exit=${r.code}, expected 2` : null,
    r.json?.coverage?.planStatus !== 'unresolved' || !(r.json?.coverage?.planMissingOwners || []).includes('lint') ? `external-owner coverage=${JSON.stringify(r.json?.coverage)}` : null,
    r.missing.code !== 2 || !(r.missing.json?.coverage?.planMissingOwners || []).includes('lint') ? `missing owner: exit=${r.missing.code} coverage=${JSON.stringify(r.missing.json?.coverage?.planMissingOwners)}` : null,
    r.plain.code !== 0 || !(r.plain.json?.coverage?.declaredMissingChecks || []).some(check => check.id === '1:lint' && check.status === 'external-owner') ? `without plan: exit=${r.plain.code}, declaredMissingChecks=${JSON.stringify(r.plain.json?.coverage?.declaredMissingChecks)}` : null].filter(Boolean),
  note: r => `with-plan ${r.json?.coverage?.planStatus}; plain exit=${r.plain.code}`,
});
S.push({
  name: 'adopt-preflight-receipt-none-cannot-gate-push',
  run() {
    const d = adopt('rnone', { desc: adoptDescriptor({ receipt: 'none' }) });
    const { base, head } = adoptIds(d);
    return Object.assign(adoptPreflight(d), { push: run(['pre-push', '--json'], { cwd: d, input: `refs/heads/main ${head} refs/heads/main ${base}\n` }) });
  },
  expect: r => [r.code !== 0 ? `receipt none preflight exit=${r.code}, expected 0` : null,
    r.json?.execution?.receiptStatus !== 'unavailable' ? `receiptStatus=${r.json?.execution?.receiptStatus}` : null,
    r.push.code !== 1 || r.push.json?.failure?.code !== 'missing-contract' ? `pre-push exit=${r.push.code} failure=${JSON.stringify(r.push.json?.failure)}, docs: receipt none cannot satisfy a push policy` : null].filter(Boolean),
  note: r => `push=${r.push.json?.failure?.code}`,
});
S.push({
  name: 'adopt-preflight-unconfigured',
  run() { const d = makeRepo('adopt-unconfigured', { 'src/a.txt': 'one\n' }, { extraCommits: [{ files: { 'src/a.txt': 'two\n' } }] }); return adoptPreflight(d); },
  expect: r => [r.code !== 2 ? `exit=${r.code}, expected 2` : null,
    r.json?.execution?.status !== 'unavailable' ? `execution.status=${r.json?.execution?.status}` : null,
    r.json?.nextActions?.[0]?.kind !== 'configure-project' ? `nextActions=${JSON.stringify(r.json?.nextActions)}` : null].filter(Boolean),
  note: r => `outcome=${r.json?.outcome}`,
});
S.push({
  // reference.md "Read a report" lists unconfigured / unavailable as a result; preflight reports outcome incomplete
  // there, the same word a passing run uses (exit 0), so outcome alone cannot tell the two apart.
  name: 'adopt-preflight-unconfigured-outcome-label',
  known: '#10',
  run() { const d = makeRepo('adopt-unconfigured', { 'src/a.txt': 'one\n' }, { extraCommits: [{ files: { 'src/a.txt': 'two\n' } }] }); return adoptPreflight(d); },
  expect: r => ['unconfigured', 'unavailable'].includes(r.json?.outcome) ? [] : [`outcome=${r.json?.outcome} for a run that executed nothing (exit ${r.code}); a passing run (exit 0) also reports incomplete`],
});
const badDescriptors = {
  'entrypoint-outside-repo': { entrypoint: '../adopt-evil.mjs' },
  'entrypoint-absolute': { entrypoint: '/abs/preflight.mjs' },
  'entrypoint-dotdot': { entrypoint: 'quality/../quality/preflight.mjs' },
  'entrypoint-shell-command': { entrypoint: 'node quality/preflight.mjs' },
  'entrypoint-not-javascript': { entrypoint: 'quality/preflight.ts' },
  'entrypoint-backslash': { entrypoint: `quality${String.fromCharCode(92)}preflight.mjs` },
  'dependencies-npm': { dependencies: 'npm' },
  'receipt-unknown-value': { receipt: 'guard-v2' },
};
for (const [name, bad] of Object.entries(badDescriptors)) S.push({
  name: `adopt-descriptor-rejected-${name}`,
  run() {
    const mark = adoptMarker(name);
    tmpFile('adopt-evil.mjs', `import { appendFileSync } from 'node:fs'; appendFileSync(process.env.ADAPTER_MARKER, 'evil\\n');`);
    const d = adoptProject(`adopt-bad-${name}`, { desc: adoptDescriptor(bad) });
    return Object.assign(adoptPreflight(d, { ADAPTER_MARKER: mark }), { executed: markerRuns(mark), doctor: run(['doctor', '--check', '--repo', d, '--summary']) });
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
    !r.stderr.includes('Invalid CI Local Guard project descriptor') ? `stderr=${r.stderr.trim().slice(0, 100)}` : null,
    r.executed ? `an adapter ran ${r.executed} time(s) despite the rejected descriptor` : null,
    r.doctor.json?.outcome !== 'blocked' ? `doctor --check says ${r.doctor.json?.outcome}, expected blocked` : null].filter(Boolean),
});
S.push({
  name: 'adopt-descriptor-invalid-cause-visible',
  known: '#10',
  run() { return adoptPreflight(adoptProject('adopt-bad-cause', { desc: adoptDescriptor({ entrypoint: '../x.mjs' }) })); },
  expect: r => (causes(r).length || (r.json?.nextActions || []).some(a => a.reason !== 'input-or-project-check-failed')) ? []
    : [`--summary JSON for a rejected descriptor has causes=[] and only reason ${r.json?.nextActions?.[0]?.reason}; the real error is on stderr only (${r.stderr.trim()})`],
});
S.push({
  name: 'adopt-descriptor-entrypoint-file-missing',
  known: '#10',
  run() { const d = adoptProject('adopt-missing-entry', { desc: adoptDescriptor({ entrypoint: 'quality/missing.mjs' }) }); return Object.assign(adoptPreflight(d), { doctor: run(['doctor', '--check', '--repo', d, '--summary']) }); },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
    r.doctor.json?.outcome !== 'blocked' ? `doctor --check says ${r.doctor.json?.outcome}` : null,
    /ENOENT|ci-local-guard-\w{6}/.test(r.stderr) ? `raw ENOENT with the disposable checkout path instead of an entrypoint message: ${r.stderr.trim().slice(0, 140)}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-preflight-base-required-and-env',
  run() { const d = adopt('pre'); return Object.assign(run(['preflight', '--repo', d, '--head', 'HEAD', '--summary']), {
    viaEnv: run(['preflight', '--repo', d, '--head', 'HEAD', '--summary'], { env: { CI_LOCAL_GUARD_BASE: 'HEAD~1' } }),
    worktree: adoptPreflight(d, {}, ['--worktree']), badEvent: adoptPreflight(d, {}, ['--event', 'release']) }); },
  expect: r => [r.code !== 1 || r.json?.outcome !== 'failed' ? `no base: exit=${r.code} outcome=${r.json?.outcome}` : null,
    r.viaEnv.code !== 0 ? `CI_LOCAL_GUARD_BASE: exit=${r.viaEnv.code}` : null,
    r.worktree.code !== 1 ? `--worktree: exit=${r.worktree.code}, expected refusal` : null,
    r.badEvent.code !== 1 ? `--event release: exit=${r.badEvent.code}, expected refusal` : null].filter(Boolean),
});

// plan and preflight --with-plan
const planCtx = ['--event', 'push', '--ref', 'refs/heads/main', '--json'];
const prCtx = ['--event', 'pull_request', '--base-ref', 'main', '--head-ref', 'feat/x', '--pr-action', 'opened', '--pr-fork', 'false', '--json'];
S.push({
  name: 'adopt-plan-push-ok',
  run() { return adoptPlan(adopt('pre'), planCtx); },
  expect: r => [r.code !== 0 ? `exit=${r.code}` : null, r.json?.outcome !== 'predicted' ? `outcome=${r.json?.outcome}` : null,
    r.json?.eventContext?.ref !== 'refs/heads/main' || r.json?.eventContext?.verified !== false ? `eventContext=${JSON.stringify(r.json?.eventContext)}` : null,
    JSON.stringify(r.json?.changedFiles) !== '["src/a.txt"]' ? `changedFiles=${JSON.stringify(r.json?.changedFiles)}` : null,
    r.json?.checksExecuted !== false ? 'plan claims checks executed' : null].filter(Boolean),
});
S.push({
  name: 'adopt-plan-needs-review-exit-2',
  run() { return adoptPlan(adopt('pre'), planCtx, { PLAN_MODE: 'review' }); },
  expect: r => [r.code !== 2 ? `exit=${r.code}, expected 2` : null, r.json?.outcome !== 'needs-review' ? `outcome=${r.json?.outcome}` : null].filter(Boolean),
});
for (const mode of ['bad-changed', 'no-context', 'leak']) S.push({
  name: `adopt-plan-rejected-${mode}`,
  run() { return adoptPlan(adopt('pre'), mode === 'no-context' ? prCtx : planCtx, { PLAN_MODE: mode }); },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null, r.json?.outcome !== 'failed' ? `outcome=${r.json?.outcome}` : null,
    r.json?.prediction ? 'a rejected plan still returned a prediction' : null,
    /PLAN-LEAK-7f3a/.test(said(r)) ? 'failed plan adapter output was echoed (docs: suppressed)' : null].filter(Boolean),
  note: r => r.stderr.trim().slice(0, 90),
});
S.push({
  name: 'adopt-plan-pr-context-must-be-echoed',
  run() {
    const d = adopt('pre');
    return Object.assign(adoptPlan(d, prCtx), { dropped: adoptPlan(d, prCtx, { PLAN_MODE: 'drop-pr' }),
      pushWithAction: adoptPlan(d, [...planCtx, '--pr-action', 'opened']), badFork: adoptPlan(d, ['--event', 'pull_request', '--pr-fork', 'maybe', '--json']),
      prWithoutContext: adoptPlan(d, ['--event', 'pull_request', '--json']) });
  },
  expect: r => [r.code !== 0 || r.json?.eventContext?.prAction !== 'opened' || r.json?.eventContext?.prFork !== false ? `echoing adapter: exit=${r.code} ctx=${JSON.stringify(r.json?.eventContext)}` : null,
    r.dropped.code !== 1 ? `adapter that drops prAction/prFork accepted: exit=${r.dropped.code}` : null,
    r.pushWithAction.code !== 1 ? `--pr-action on a push event accepted: exit=${r.pushWithAction.code}` : null,
    r.badFork.code !== 1 ? `--pr-fork maybe accepted: exit=${r.badFork.code}` : null,
    r.prWithoutContext.code !== 0 ? `PR plan without optional context: exit=${r.prWithoutContext.code}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-plan-needs-explicit-inputs',
  run() {
    const d = adopt('pre');
    return Object.assign(run(['plan', '--repo', d, '--base', 'HEAD~1', '--json']), { noBase: run(['plan', '--repo', d, '--head', 'HEAD', '--json']),
      worktree: adoptPlan(d, ['--worktree', '--json']), badRef: adoptPlan(d, ['--event', 'push', '--ref', 'main', '--json']),
      noChanges: run(['plan', '--repo', d, '--base', 'HEAD', '--head', 'HEAD', '--json']) });
  },
  expect: r => [r.code !== 1 ? `no --head: exit=${r.code}` : null, r.noBase.code !== 1 ? `no --base: exit=${r.noBase.code}` : null,
    r.worktree.code !== 1 ? `--worktree: exit=${r.worktree.code}` : null, r.badRef.code !== 1 ? `--ref main (not refs/heads/main): exit=${r.badRef.code}` : null,
    r.noChanges.code !== 0 || r.noChanges.json?.outcome !== 'no-changes' ? `identical base/head: exit=${r.noChanges.code} outcome=${r.noChanges.json?.outcome}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-with-plan-order-and-review',
  run() {
    const d = adopt('pre');
    const mark = adoptMarker('with-plan');
    const ctx = ['--event', 'push', '--ref', 'refs/heads/main', '--with-plan'];
    const ok = adoptPreflight(d, { ADAPTER_MARKER: mark }, ctx);
    const afterOk = markerRuns(mark);
    const review = adoptPreflight(d, { ADAPTER_MARKER: mark, PLAN_MODE: 'review' }, ctx);
    const afterReview = markerRuns(mark);
    const mismatch = adoptPreflight(d, { ADAPTER_MARKER: mark, PLAN_MODE: 'bad-changed' }, ctx);
    return Object.assign(ok, { afterOk, review, ranOnReview: afterReview - afterOk, mismatch, ranOnMismatch: markerRuns(mark) - afterReview });
  },
  expect: r => [r.code !== 0 || r.json?.coverage?.planStatus !== 'no-declared-missing' ? `ok: exit=${r.code} planStatus=${r.json?.coverage?.planStatus}` : null,
    r.review.code !== 2 || r.review.json?.outcome !== 'needs-review' ? `review: exit=${r.review.code} outcome=${r.review.json?.outcome}` : null,
    r.mismatch.code !== 1 ? `plan changedFiles mismatch: exit=${r.mismatch.code}` : null,
    r.ranOnMismatch ? 'product adapter ran although the plan was rejected first' : null].filter(Boolean),
  note: r => `adapter runs: ok=${r.afterOk} review=${r.ranOnReview} mismatch=${r.ranOnMismatch}`,
});

// pre-push: Git feeds "<local ref> <local sha> <remote ref> <remote sha>" records on stdin
const ZERO = '0'.repeat(40);
const pushLine = (lref, local, rref, remote) => `${lref} ${local} ${rref} ${remote}\n`;
const pushCase = (name, build, { env, key = 'push', opts, expect, note, known } = {}) => S.push({
  name: `adopt-push-${name}`, known,
  run() {
    const d = adopt(key, opts);
    const mark = adoptMarker(`push-${name}`);
    const ids = adoptIds(d);
    const input = typeof build === 'function' ? build({ ...ids, dir: d }) : build;
    return Object.assign(run(['pre-push', '--json'], { cwd: d, input, env: { ...env, ADAPTER_MARKER: mark } }), { executed: () => markerRuns(mark), ids });
  },
  expect: r => { const rec = r; const code = r.json?.failure?.code; return expect(Object.assign(rec, { failureCode: code, adapterRuns: r.executed() })); },
  note: note || (r => `outcome=${r.json?.outcome} failure=${r.json?.failure?.code ?? '-'} statuses=${(r.json?.updates || []).slice(0, 3).map(u => u.status).join(',')}`),
});
const blocked = (code, { runs = 0 } = {}) => r => [r.code !== 1 ? `exit=${r.code}, expected 1` : null,
  r.json?.outcome !== 'blocked' ? `outcome=${r.json?.outcome}` : null,
  r.failureCode !== code ? `failure.code=${r.failureCode}, expected ${code}` : null,
  r.adapterRuns !== runs ? `adapter ran ${r.adapterRuns} time(s), expected ${runs}` : null].filter(Boolean);
const mainLine = ({ base, head }) => pushLine('refs/heads/main', head, 'refs/heads/main', base);
pushCase('policy-satisfied', mainLine, { expect: r => [r.code !== 0 ? `exit=${r.code}, expected 0` : null,
  r.json?.outcome !== 'local-policy-satisfied' ? `outcome=${r.json?.outcome}` : null,
  r.json?.completenessVerified !== false || r.json?.hostedPolicyStatus !== 'unverified' ? 'report overclaims completeness or hosted policy' : null,
  r.json?.updates?.[0]?.product?.projectReceipt?.status !== 'validated' ? 'push product has no validated receipt' : null,
  r.json?.updates?.[0]?.policy?.status !== 'local-policy-satisfied' ? `policy=${r.json?.updates?.[0]?.policy?.status}` : null,
  r.adapterRuns !== 1 ? `adapter ran ${r.adapterRuns} time(s), expected 1` : null].filter(Boolean) });
pushCase('crlf-records', b => mainLine(b).replace('\n', '\r\n'), { expect: r => [r.code !== 0 ? `exit=${r.code}, expected 0` : null] .filter(Boolean) });
pushCase('empty-stdin', '', { expect: r => [r.code !== 0 || r.json?.outcome !== 'no-gates-executed' ? `exit=${r.code} outcome=${r.json?.outcome}` : null].filter(Boolean) });
pushCase('target-outside-policy', ({ base, head }) => pushLine('refs/heads/feat', head, 'refs/heads/feat', base), { expect: blocked('target-outside-policy') });
pushCase('new-remote-ref-main', ({ head }) => pushLine('refs/heads/main', head, 'refs/heads/main', ZERO), { expect: blocked('new-remote-ref') });
pushCase('new-feature-branch', ({ head }) => pushLine('refs/heads/feat', head, 'refs/heads/feat', ZERO), { expect: blocked('new-remote-ref') });
pushCase('new-tag', ({ head }) => pushLine('refs/tags/v1', head, 'refs/tags/v1', ZERO), { expect: blocked('new-remote-ref') });
pushCase('delete-ref-skips-checks', ({ head }) => pushLine('(delete)', ZERO, 'refs/heads/main', head), { expect: r => [r.code !== 0 || r.json?.outcome !== 'no-gates-executed' ? `exit=${r.code} outcome=${r.json?.outcome}` : null,
  r.json?.updates?.[0]?.status !== 'ignored-deletion' ? `status=${r.json?.updates?.[0]?.status}` : null, r.adapterRuns ? 'a deletion ran product checks' : null].filter(Boolean) });
pushCase('delete-plus-ok', b => pushLine('(delete)', ZERO, 'refs/heads/old', b.head) + mainLine(b), { expect: r => [r.code !== 0 || r.json?.outcome !== 'local-policy-satisfied' ? `exit=${r.code} outcome=${r.json?.outcome}` : null].filter(Boolean) });
pushCase('ok-then-new-ref-blocks-whole-push', b => mainLine(b) + pushLine('refs/heads/feat', b.head, 'refs/heads/feat', ZERO), { expect: r => [
  r.code !== 1 || r.failureCode !== 'new-remote-ref' ? `exit=${r.code} failure=${r.failureCode}` : null,
  JSON.stringify((r.json?.updates || []).map(u => u.status)) !== '["local-policy-satisfied","blocked"]' ? `statuses=${JSON.stringify((r.json?.updates || []).map(u => u.status))}` : null].filter(Boolean) });
pushCase('force-push-divergent-remote', ({ head, dir }) => {
  const side = git(dir, ['commit-tree', 'HEAD~1^{tree}', '-p', 'HEAD~1', '-m', 'divergent remote']).trim();
  return pushLine('refs/heads/main', head, 'refs/heads/main', side);
}, { expect: r => [r.code !== 0 || r.json?.outcome !== 'local-policy-satisfied' ? `exit=${r.code} outcome=${r.json?.outcome} failure=${r.failureCode}` : null].filter(Boolean) });
pushCase('remote-object-not-fetched', ({ head }) => pushLine('refs/heads/main', head, 'refs/heads/main', 'a'.repeat(40)), {
  known: '#10',
  // The old remote sha is unknown locally (remote ahead of the last fetch, or a force-with-lease push).
  expect: r => r.code === 1 && r.failureCode !== 'execution-failed' ? [] : [`exit=${r.code}; failure.code=${r.failureCode} is the generic execution-failed with a raw git error (${(r.stderr || '').trim().slice(0, 80)}), no hint to fetch`] });
pushCase('check-fails', mainLine, { env: { ADAPTER_MODE: 'fail' }, expect: r => [r.code !== 1 || r.json?.outcome !== 'blocked' ? `exit=${r.code} outcome=${r.json?.outcome}` : null,
  !r.json?.failure?.logFile ? 'blocked push names no retained log' : null,
  JSON.stringify(r.json?.updates?.[0]?.product?.executionFailure?.failedChecks?.map(c => c.id)) !== '["1:lint"]' ? `failedChecks=${JSON.stringify(r.json?.updates?.[0]?.product?.executionFailure?.failedChecks)}` : null].filter(Boolean) });
pushCase('plan-needs-review', mainLine, { env: { PLAN_MODE: 'review' }, expect: blocked('plan-review') });
pushCase('receipt-identity-mismatch', mainLine, { env: { ADAPTER_MODE: 'bad-identity' }, expect: r => [r.code !== 1 || r.json?.outcome !== 'blocked' ? `exit=${r.code} outcome=${r.json?.outcome}` : null].filter(Boolean) });
pushCase('external-owner-evidence-not-accepted', mainLine, { env: { ADAPTER_MODE: 'external-lint' }, expect: r => [r.code !== 1 || r.failureCode !== 'unresolved-local-gates' ? `exit=${r.code} failure=${r.failureCode}` : null].filter(Boolean) });
pushCase('policy-binding-missing-for-plan-owner', mainLine, { key: 'push-partial-policy',
  opts: { desc: adoptDescriptor({ bindings: [{ job: 'ci', owner: 'unit', checkIds: ['0:unit'] }] }) },
  expect: r => [r.code !== 1 || r.failureCode !== 'unresolved-local-gates' ? `exit=${r.code} failure=${r.failureCode}` : null,
    !(r.json?.updates?.[0]?.policy?.blockers || []).some(b => /missing policy binding for ci\/lint/.test(b)) ? `blockers=${JSON.stringify(r.json?.updates?.[0]?.policy?.blockers)}` : null].filter(Boolean) });
pushCase('no-push-policy-configured', mainLine, { key: 'push-no-policy', opts: { desc: adoptDescriptor({ pushPolicy: false }) }, expect: blocked('unconfigured-policy') });
pushCase('malformed-record-3-fields', ({ head }) => `refs/heads/main ${head} refs/heads/main\n`, { expect: blocked('invalid-push-input') });
pushCase('malformed-record-short-sha', ({ base }) => `refs/heads/main abc refs/heads/main ${base}\n`, { expect: blocked('invalid-push-input') });
pushCase('128-updates-accepted', ({ head }) => Array.from({ length: 128 }, (_, i) => pushLine('(delete)', ZERO, `refs/heads/d${i}`, head)).join(''), { expect: r => [r.code !== 0 || (r.json?.updates || []).length !== 128 ? `exit=${r.code} updates=${r.json?.updates?.length}` : null].filter(Boolean) });
pushCase('129-updates-rejected', ({ head }) => Array.from({ length: 129 }, (_, i) => pushLine('(delete)', ZERO, `refs/heads/d${i}`, head)).join(''), { expect: blocked('too-many-updates') });
pushCase('input-over-1MiB', 'x'.repeat(1024 * 1024 + 16), { expect: r => [r.code !== 1 || !['push-input-too-large', 'too-many-updates', 'invalid-push-input'].includes(r.failureCode) ? `exit=${r.code} failure=${r.failureCode}` : null,
  r.adapterRuns ? 'adapter ran for oversized input' : null].filter(Boolean) });

// install-hook / uninstall-hook / pre-commit
const traceHook = label => `#!/bin/sh\necho ${label} >> "$(git rev-parse --show-toplevel)/hook-trace.txt"\nexit 0\n`;
const traceOf = d => (existsSync(path.join(d, 'hook-trace.txt')) ? readFileSync(path.join(d, 'hook-trace.txt'), 'utf8') : '');
S.push({
  name: 'adopt-hook-install-over-active-githooks-refused',
  // The common case: the project already has core.hooksPath=.githooks with its own pre-push.
  run() {
    const d = adoptProject('adopt-hk-githooks', { files: { '.githooks/pre-push': traceHook('custom-pre-push') } });
    git(d, ['config', 'core.hooksPath', '.githooks']);
    return Object.assign(run(['install-hook', '--repo', d]), { hooksPath: gitLocalConfig(d, 'core.hooksPath'), previous: gitLocalConfig(d, 'ci-local-guard.previousHooksPath'),
      ownHook: existsSync(path.join(d, '.githooks/pre-push')) });
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected a refusal` : null, r.hooksPath !== '.githooks' ? `hooksPath changed to ${r.hooksPath}` : null,
    r.previous !== null ? 'previousHooksPath recorded although nothing changed' : null].filter(Boolean),
  note: r => `${r.stderr.trim().slice(0, 100)} (no chaining mode: the project's own hook and Guard cannot coexist)`,
});
S.push({
  name: 'adopt-hook-install-over-custom-hookspath-refused',
  run() {
    const d = adoptProject('adopt-hk-husky', { files: { '.husky/pre-push': traceHook('husky') } });
    git(d, ['config', 'core.hooksPath', '.husky']);
    return Object.assign(run(['install-hook', '--repo', d]), { hooksPath: gitLocalConfig(d, 'core.hooksPath') });
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}` : null, r.hooksPath !== '.husky' ? `hooksPath changed to ${r.hooksPath}` : null].filter(Boolean),
  note: r => r.stderr.trim().slice(0, 100),
});
S.push({
  name: 'adopt-hook-install-requires-committed-contract',
  run() {
    const d = adoptProject('adopt-hk-nocontract', { desc: adoptDescriptor({ pushPolicy: false, plan: false }) });
    return Object.assign(run(['install-hook', '--repo', d]), { hooksPath: gitLocalConfig(d, 'core.hooksPath') });
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}` : null, r.hooksPath ? `hooksPath set to ${r.hooksPath}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-hook-install-uninstall-roundtrip',
  run() {
    const d = adoptProject('adopt-hk-roundtrip');
    const install = run(['install-hook', '--repo', d]);
    const installed = { hooksPath: gitLocalConfig(d, 'core.hooksPath'), previous: gitLocalConfig(d, 'ci-local-guard.previousHooksPath') };
    const again = run(['install-hook', '--repo', d]);
    const uninstall = run(['uninstall-hook', '--repo', d]);
    const restored = { hooksPath: gitLocalConfig(d, 'core.hooksPath'), previous: gitLocalConfig(d, 'ci-local-guard.previousHooksPath') };
    const twice = run(['uninstall-hook', '--repo', d]);
    return Object.assign(install, { installed, again, uninstall, restored, twice });
  },
  expect: r => [r.code !== 0 ? `install exit=${r.code}` : null,
    r.installed.hooksPath !== guardHooksPath ? `hooksPath=${r.installed.hooksPath}, expected ${guardHooksPath}` : null,
    r.installed.previous !== '<default>' ? `previous=${r.installed.previous}` : null,
    r.again.code !== 0 ? `second install exit=${r.again.code}, expected idempotent` : null,
    r.uninstall.code !== 0 || r.restored.hooksPath !== null || r.restored.previous !== null ? `uninstall exit=${r.uninstall.code} hooksPath=${r.restored.hooksPath} previous=${r.restored.previous}` : null,
    r.twice.code !== 1 ? `second uninstall exit=${r.twice.code}, expected refusal` : null].filter(Boolean),
  note: r => `previous=${r.installed.previous}`,
});
S.push({
  name: 'adopt-hook-uninstall-after-foreign-change-refused',
  run() {
    const d = adoptProject('adopt-hk-foreign');
    run(['install-hook', '--repo', d]);
    git(d, ['config', 'core.hooksPath', '.husky/_']);
    return Object.assign(run(['uninstall-hook', '--repo', d]), { hooksPath: gitLocalConfig(d, 'core.hooksPath'), previous: gitLocalConfig(d, 'ci-local-guard.previousHooksPath') });
  },
  expect: r => [r.code !== 1 ? `exit=${r.code}, expected a refusal` : null, r.hooksPath !== '.husky/_' ? `foreign hooksPath overwritten with ${r.hooksPath}` : null].filter(Boolean),
  note: r => `stale previousHooksPath left behind: ${r.previous}`,
});
S.push({
  name: 'adopt-hook-uninstall-never-installed-refused',
  run() { return run(['uninstall-hook', '--repo', adopt('pre')]); },
  expect: r => [r.code !== 1 ? `exit=${r.code}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-hook-install-silently-bypasses-dotgit-hooks',
  known: '#10',
  // hooksPath redirects every hook (pre-push, commit-msg, post-checkout, git-lfs...) away from .git/hooks.
  run() {
    const d = adoptProject('adopt-hk-dotgit');
    for (const name of ['commit-msg', 'pre-push']) writeFileSync(path.join(d, '.git', 'hooks', name), traceHook(`dotgit-${name}`), { mode: 0o755 });
    gitRaw(d, ['commit', '--allow-empty', '-m', 'before']);
    const ranBefore = traceOf(d).includes('dotgit-commit-msg');
    rmSync(path.join(d, 'hook-trace.txt'), { force: true });
    const install = run(['install-hook', '--repo', d]);
    gitRaw(d, ['commit', '--allow-empty', '-m', 'after']);
    return Object.assign(install, { ranBefore, ranAfter: traceOf(d).includes('dotgit-commit-msg') });
  },
  expect: r => [!r.ranBefore ? 'fixture: the project commit-msg hook did not run before install' : null,
    r.code === 0 && !r.ranAfter && !/existing|bypass|\.git\/hooks|other hooks|chain|lfs/i.test(said(r)) ? "install exit 0 and the project's own .git/hooks (commit-msg, pre-push) silently stopped running; no warning, no chaining" : null].filter(Boolean),
});
S.push({
  name: 'adopt-hook-install-silently-overrides-global-hookspath',
  known: '#10',
  run() {
    const d = adoptProject('adopt-hk-global');
    const globalDir = path.join(ROOT, 'tmp', 'adopt-global-hooks');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(path.join(globalDir, 'pre-commit'), traceHook('GLOBAL-pre-commit'), { mode: 0o755 });
    const globalConfig = tmpFile('adopt-global-gitconfig', `[core]\n\thooksPath = ${globalDir.split(path.sep).join('/')}\n`);
    const env = { GIT_CONFIG_GLOBAL: globalConfig };
    gitRaw(d, ['commit', '--allow-empty', '-m', 'before'], env);
    const ranBefore = traceOf(d).includes('GLOBAL-pre-commit');
    rmSync(path.join(d, 'hook-trace.txt'), { force: true });
    const install = run(['install-hook', '--repo', d], { env });
    gitRaw(d, ['commit', '--allow-empty', '-m', 'after'], env);
    return Object.assign(install, { ranBefore, ranAfter: traceOf(d).includes('GLOBAL-pre-commit') });
  },
  expect: r => [!r.ranBefore ? 'fixture: the global pre-commit hook did not run before install' : null,
    r.code === 0 && !r.ranAfter && !/global|existing|override/i.test(said(r)) ? `install exit 0 and the user's global core.hooksPath hooks stopped running in this repo; output says only: ${said(r).trim().slice(0, 100)}` : null].filter(Boolean),
});
S.push({
  name: 'adopt-hook-pre-commit-real-git',
  run() {
    const d = adoptProject('adopt-hk-precommit');
    const install = run(['install-hook', '--repo', d]);
    const head = () => gitRaw(d, ['rev-parse', 'HEAD']).stdout.trim();
    const start = head();
    writeFileSync(path.join(d, 'src', 'ws.txt'), 'trailing  \n');
    gitRaw(d, ['add', '-A']);
    const dirty = gitRaw(d, ['commit', '-m', 'whitespace']);
    const afterDirty = head();
    gitRaw(d, ['reset', '-q']);
    rmSync(path.join(d, 'src', 'ws.txt'));
    writeFileSync(path.join(d, 'src', 'ok.txt'), 'clean\n');
    gitRaw(d, ['add', '-A']);
    const clean = gitRaw(d, ['commit', '-m', 'clean']);
    writeFileSync(path.join(d, 'src', 'ok.txt'), 'clean\nunstaged trailing  \n');
    const unstaged = gitRaw(d, ['commit', '--allow-empty', '-m', 'unstaged whitespace is not checked']);
    return Object.assign(install, { dirty, afterDirty, start, clean, unstaged });
  },
  expect: r => [r.code !== 0 ? `install exit=${r.code}` : null,
    r.dirty.status === 0 || r.afterDirty !== r.start ? 'staged trailing whitespace was committed' : null,
    !/trailing whitespace/.test(said(r.dirty)) || !/commit stopped/.test(said(r.dirty)) ? `blocked commit shows ${said(r.dirty).trim().slice(0, 100)}` : null,
    r.clean.status !== 0 ? `clean commit blocked: ${said(r.clean).trim().slice(0, 100)}` : null,
    r.unstaged.status !== 0 ? 'unstaged whitespace blocked a commit' : null].filter(Boolean),
});
S.push({
  name: 'adopt-hook-real-git-push-sequence',
  // Through the installed hook with a real bare remote: the first push of any ref is blocked; only updates of
  // refs listed in targetRefs pass, each running the full adapter.
  run() {
    const d = adoptProject('adopt-hk-push');
    const remote = path.join(ROOT, 'tmp', 'adopt-hk-push-remote.git');
    rmSync(remote, { recursive: true, force: true });
    spawnSync('git', ['init', '--bare', '-b', 'main', remote], { encoding: 'utf8', windowsHide: true });
    git(d, ['remote', 'add', 'origin', remote.split(path.sep).join('/')]);
    const install = run(['install-hook', '--repo', d]);
    const mark = adoptMarker('real-push');
    const env = { ADAPTER_MARKER: mark };
    const push = (args, extra = {}) => gitRaw(d, ['push', ...args], { ...env, ...extra });
    const steps = { firstPush: push(['origin', 'main']), noVerify: push(['--no-verify', 'origin', 'main']) };
    steps.afterNoVerifyRuns = markerRuns(mark);
    writeFileSync(path.join(d, 'src', 'a.txt'), 'three\n');
    gitRaw(d, ['add', '-A']); gitRaw(d, ['commit', '-m', 'three']);
    steps.secondPush = push(['origin', 'main']);
    steps.runsAfterSecond = markerRuns(mark);
    steps.newBranch = push(['origin', 'HEAD:refs/heads/feat']);
    gitRaw(d, ['tag', 'v1']);
    steps.tag = push(['origin', 'v1']);
    steps.seedBranch = push(['--no-verify', 'origin', 'HEAD:refs/heads/feat']);
    steps.delete = push(['origin', '--delete', 'feat']);
    writeFileSync(path.join(d, 'src', 'a.txt'), 'four\n');
    gitRaw(d, ['add', '-A']); gitRaw(d, ['commit', '-m', 'four']);
    steps.failing = push(['origin', 'main'], { ADAPTER_MODE: 'fail' });
    steps.remoteStillAtThree = gitRaw(d, ['ls-remote', 'origin', 'refs/heads/main']).stdout.split(/\s/)[0] === gitRaw(d, ['rev-parse', 'HEAD~1']).stdout.trim();
    return Object.assign(install, { steps });
  },
  expect: r => { const s = r.steps; return [r.code !== 0 ? `install exit=${r.code}` : null,
    s.firstPush.status === 0 || !/new remote refs require review/.test(said(s.firstPush)) ? `first push of main: exit=${s.firstPush.status}` : null,
    s.noVerify.status !== 0 || s.afterNoVerifyRuns ? 'fixture: --no-verify push failed or ran the hook' : null,
    s.secondPush.status !== 0 || s.runsAfterSecond !== 1 || !/local-policy-satisfied/.test(said(s.secondPush)) ? `second push of main: exit=${s.secondPush.status} adapterRuns=${s.runsAfterSecond}` : null,
    s.newBranch.status === 0 ? 'push of a new branch passed the hook' : null,
    s.tag.status === 0 ? 'push of a new tag passed the hook' : null,
    s.delete.status !== 0 ? `deleting a remote branch: exit=${s.delete.status} ${said(s.delete).trim().slice(0, 100)}` : null,
    s.failing.status === 0 || !s.remoteStillAtThree ? 'a push whose adapter failed reached the remote' : null].filter(Boolean); },
  note: r => `first=${r.steps.firstPush.status} second=${r.steps.secondPush.status} newBranch=${r.steps.newBranch.status} tag=${r.steps.tag.status} delete=${r.steps.delete.status}`,
});
S.push({
  name: 'adopt-hook-node-missing-from-hook-path',
  known: '#10',
  // Git GUIs and nvm/scoop setups can run hooks without node on PATH; the hook then blocks every commit and push.
  run() {
    const d = adoptProject('adopt-hk-nonode');
    run(['install-hook', '--repo', d]);
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const hasNode = dir => dir && spawnSync(path.join(dir, nodeName), ['-v'], { encoding: 'utf8' }).status === 0;
    const stripped = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(dir => !hasNode(dir)).join(path.delimiter);
    writeFileSync(path.join(d, 'x.txt'), 'x\n');
    git(d, ['add', '-A']);
    const commit = gitRaw(d, ['commit', '-m', 'without node on PATH'], { PATH: stripped, Path: stripped });
    return { code: commit.status, ms: 0, out: said(commit), unusable: Boolean(commit.error) || commit.status === null };
  },
  expect: r => r.unusable ? [] : [r.code === 0 ? 'fixture: the hook did not run without node on PATH' : null,
    r.code !== 0 && !/PATH|Node\.js/.test(r.out) ? `commit blocked with only: ${r.out.trim().slice(0, 120)}` : null].filter(Boolean),
  note: r => (r.unusable ? 'SKIP-ENV: git itself is not reachable once node directories leave PATH' : `exit=${r.code}`),
});

const scenarios = only ? S.filter(s => s.name.includes(only)) : S;
const { summary } = await battery(scenarios, { label: 'offline' });
process.exit(summary.failed ? 1 : 0);
