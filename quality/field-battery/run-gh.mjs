// gh read-only battery — regressions for issue #2 fixes + option limits + concurrency.
// Needs gh auth. No writes to GitHub. Run: node run-gh.mjs [--only <substr>]
// Target: REAL_REPO and its GitHub repository (see README for the GUARD_FIELD_* variables).
import { battery, run, REAL_REPO, ROOT, GUARD_CLI } from './lib/harness.mjs';
import { readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const env = process.env;
const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 }); return r.status === 0 ? r.stdout.trim() : ''; };
// owner/name: GUARD_FIELD_REPOSITORY, else parsed from the checkout's origin remote.
const REPOSITORY = env.GUARD_FIELD_REPOSITORY
  || /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(sh('git', ['-C', REAL_REPO, 'remote', 'get-url', 'origin']))?.[1] || null;
const WORKFLOW = env.GUARD_FIELD_WORKFLOW || 'ci.yml';
// A failed run whose log has test failures (Playwright, Vitest/Jest or TAP).
const FAILED_RUN = env.GUARD_FIELD_FAILED_RUN || null;
// A run triggered by workflow_run, whose trigger commit differs from its own head.
const WORKFLOW_RUN_RUN = env.GUARD_FIELD_WORKFLOW_RUN_RUN || null;
// Repeatable --platform mappings for third-party runner labels, comma-separated label=image.
const PLATFORMS = (env.GUARD_FIELD_PLATFORMS || '').split(',').filter(Boolean);
// Run IDs for the concurrency scenario: GUARD_FIELD_RUN_IDS, else the latest runs of the repository.
const RUN_IDS = (env.GUARD_FIELD_RUN_IDS || (REPOSITORY ? sh('gh', ['run', 'list', '--repo', REPOSITORY, '--limit', '4', '--json', 'databaseId', '--jq', '.[].databaseId']).split(/\s+/).join(',') : ''))
  .split(',').filter(Boolean);
const missing = name => `${name} not set`;
const S = [];

S.push({
  name: 'locate-failed-run-failedtests',
  skip: !FAILED_RUN && missing('GUARD_FIELD_FAILED_RUN'),
  args: ['ci', 'locate', '--repo', REAL_REPO, '--run', FAILED_RUN, '--attempt', '1'],
  expect: r => {
    const f = r.json?.failures?.[0];
    return [r.json?.outcome !== 'located' ? `outcome=${r.json?.outcome}` : null,
      !f?.observed?.failedTests?.[0]?.location?.file ? 'failedTests not parsed' : null].filter(Boolean);
  },
  note: r => r.json?.failures?.[0]?.observed?.failedTests?.[0]?.location?.file || null,
});
S.push({
  name: 'locate-workflowrun-runhead-split',
  skip: !WORKFLOW_RUN_RUN && missing('GUARD_FIELD_WORKFLOW_RUN_RUN'),
  args: ['ci', 'locate', '--repo', REAL_REPO, '--run', WORKFLOW_RUN_RUN],
  expect: r => {
    const x = r.json?.runs?.[0];
    return [!x?.runHead ? 'runHead missing' : null,
      x?.sha === x?.runHead?.sha ? 'trigger SHA and run head not separated' : null].filter(Boolean);
  },
  note: r => { const x = r.json?.runs?.[0]; return `${x?.event} sha=${x?.sha?.slice(0, 7)} runHead=${x?.runHead?.sha?.slice(0, 7)}`; },
});
S.push({
  name: 'locate-nonexistent-run',
  args: ['ci', 'locate', '--repo', REAL_REPO, '--run', '1'],
  expect: r => [!r.json || r.json.outcome !== 'blocked' ? `expected blocked, got ${r.json?.outcome ?? 'no-json'} exit=${r.code}` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || null,
});
S.push({
  name: 'locate-attempt-out-of-range',
  skip: !FAILED_RUN && missing('GUARD_FIELD_FAILED_RUN'),
  args: ['ci', 'locate', '--repo', REAL_REPO, '--run', FAILED_RUN, '--attempt', '99'],
  expect: r => [!r.json || r.json.outcome !== 'blocked' ? `expected blocked, got ${r.json?.outcome ?? 'no-json'} exit=${r.code}` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || null,
});
const noRepository = !REPOSITORY && 'GitHub repository unknown: set GUARD_FIELD_REPOSITORY';
for (const lim of ['0', '201', '1']) {
  S.push({
    name: `history-limit-${lim}`,
    skip: noRepository,
    args: ['ci', 'history', '--repo', REAL_REPO, '--workflow', WORKFLOW, '--repository', REPOSITORY, '--limit', lim],
    timeoutMs: 240000,
    expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
    note: r => `${r.json?.outcome ?? 'exit=' + r.code} ${(r.json?.issues || []).map(i => i.code).join(',')}`,
  });
}
S.push({
  name: 'history-unknown-workflow',
  skip: noRepository,
  args: ['ci', 'history', '--repo', REAL_REPO, '--workflow', 'nope.yml', '--repository', REPOSITORY, '--limit', '3'],
  timeoutMs: 240000,
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome ?? 'exit=' + r.code} ${(r.json?.issues || []).map(i => i.code).join(',')} runs=${r.json?.identity?.runs ?? '?'}`,
});
S.push({
  name: 'history-export-roundtrip',
  skip: noRepository,
  run() {
    const out = path.join(ROOT, 'tmp', 'gh-export.json');
    rmSync(out, { force: true }); // a leftover export would make the first save hit export-not-saved
    const first = run(['ci', 'history', '--repo', REAL_REPO, '--workflow', WORKFLOW, '--repository', REPOSITORY, '--limit', '3', '--save-export', out], { timeoutMs: 240000 });
    if (first.code !== 0 || !first.json?.savedExport) return { ...first, roundtrip: 'save-failed' };
    const again = run(['ci', 'history', '--repo', REAL_REPO, '--workflow', WORKFLOW, '--input', out, '--limit', '3'], { timeoutMs: 120000 });
    const overw = run(['ci', 'history', '--repo', REAL_REPO, '--workflow', WORKFLOW, '--repository', REPOSITORY, '--limit', '3', '--save-export', out], { timeoutMs: 240000 });
    const kept = readFileSync(out, 'utf8');
    return { code: again.code, json: again.json, ms: first.ms + again.ms, roundtrip: again.json?.identity?.source, overwriteIssue: overw.json?.issues?.[0]?.code, exportPreserved: kept.length > 100 };
  },
  expect: r => [r.roundtrip !== 'saved-export' ? `roundtrip source=${r.roundtrip}` : null,
    r.overwriteIssue !== 'export-not-saved' ? `existing-file save not flagged (${r.overwriteIssue})` : null,
    r.exportPreserved !== true ? 'export file clobbered' : null].filter(Boolean),
  note: r => `source=${r.roundtrip} overwrite=${r.overwriteIssue}`,
});
S.push({
  name: 'verify-static-platform-mapping',
  skip: !PLATFORMS.length && missing('GUARD_FIELD_PLATFORMS'),
  run() { return run(['ci', 'verify', '--repo', REAL_REPO, '--static-only', '--event', 'push', ...PLATFORMS.flatMap(p => ['--platform', p])]); },
  expect: r => [(r.json?.hostedOnly || []).length !== 0 ? `hostedOnly=${r.json?.hostedOnly?.length} (expected 0 with mapping)` : null,
    !r.json ? 'no JSON' : null].filter(Boolean),
  note: r => r.json?.verdict?.slice(0, 80) || null,
});
S.push({
  name: 'diff-json-real-repo',
  run() { const out = path.join(ROOT, 'tmp', 'gh-diff.json'); rmSync(out, { force: true }); return run(['ci', 'diff', '--repo', REAL_REPO, '--json', '--output', out]); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome} ${r.json?.reportStorage?.status}`,
});
S.push({
  name: 'concurrent-locate-x4',
  skip: RUN_IDS.length < 2 && 'fewer than 2 run IDs: set GUARD_FIELD_RUN_IDS or GUARD_FIELD_REPOSITORY',
  run() {
    const t0 = performance.now();
    return Promise.all(RUN_IDS.slice(0, 4).map(id => new Promise(res => {
      const p = spawn(process.execPath, [GUARD_CLI, 'ci', 'locate', '--repo', REAL_REPO, '--run', id], { windowsHide: true });
      let out = ''; p.stdout.on('data', c => out += c); p.on('close', c => res({ code: c, json: JSON.parse(out || 'null') }));
    }))).then(rs => ({ code: rs.every(r => r.code === 0) ? 0 : 1, ms: Math.round(performance.now() - t0), concurrent: rs.map(r => ({ code: r.code, outcome: r.json?.outcome, runId: r.json?.requested?.run })) }));
  },
  expect: r => [r.concurrent?.some(x => (x.code !== 0 && x.code !== 1) || !x.outcome) ? 'a concurrent locate failed' : null].filter(Boolean),
  note: r => r.concurrent?.map(x => x.outcome).join(' '),
});

const scenarios = only ? S.filter(s => s.name.includes(only)) : S;
const { summary } = await battery(scenarios, { label: 'gh' });
process.exit(summary.failed ? 1 : 0);
