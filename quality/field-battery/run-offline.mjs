// Offline edge battery — no gh, no Docker. Run: node run-offline.mjs [--only <substr>]
import { battery, makeRepo, tmpFile, run, wf, REAL_REPO, ROOT } from './lib/harness.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';

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
  run() { return run(['preflight', '--repo', REAL_REPO, '--base', 'HEAD~3', '--head', 'HEAD', '--json']); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome} ${(r.json?.issues || []).map(i => i.code).join(',')}`,
});

const scenarios = only ? S.filter(s => s.name.includes(only)) : S;
const { summary } = await battery(scenarios, { label: 'offline' });
process.exit(summary.failed ? 1 : 0);
