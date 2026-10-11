// Shared harness for ci-local-guard stress/edge batteries.
// Zero dependencies; Node 22. Usage: see ../README.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI under test is this repository's own cli.mjs (three levels up from lib/).
export const GUARD_CLI = fileURLToPath(new URL('../../../cli.mjs', import.meta.url));
// The real repository the offline, flake and gh batteries read. Defaults to this
// Guard checkout; point GUARD_FIELD_REAL_REPO at a larger project for a heavier run.
export const REAL_REPO = process.env.GUARD_FIELD_REAL_REPO || path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
// quality/field-battery/ — one directory above this file.
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = path.join(ROOT, 'tmp');

export function run(args, { cwd = process.cwd(), env = {}, timeoutMs = 120000, input } = {}) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [GUARD_CLI, ...args], {
    cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, input,
    env: { ...process.env, ...env },
  });
  const ms = Math.round(performance.now() - t0);
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* non-JSON output is a valid observation */ }
  return { code: r.status, killedByTimeout: r.error?.code === 'ETIMEDOUT', stdout: r.stdout, stderr: r.stderr, json, ms };
}

export function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// files: { '<relative-path>': '<content>' }; opts.extraCommits: [{files, msg}]
export function makeRepo(name, files, opts = {}) {
  const dir = path.join(TMP, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard-tests@example.invalid']);
  git(dir, ['config', 'user.name', 'guard-tests']);
  const commit = (fileMap, msg) => {
    for (const [rel, content] of Object.entries(fileMap)) {
      const p = path.join(dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', msg]);
  };
  commit(files, opts.msg || 'base');
  for (const extra of opts.extraCommits || []) commit(extra.files, extra.msg || 'next');
  return dir;
}

export function tmpFile(name, content) {
  const p = path.join(TMP, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

// battery(scenarios, {label}) — each scenario:
// { name, args, cwd?, env?, timeoutMs?, expect(rec) => string[] problems, note(rec) => string|null,
//   skip?: reason the scenario is not run (a missing environment variable),
//   known?: open issue it reproduces; its problems report as KNOWN and do not fail the battery.
//   Remove the marker in the change that fixes the issue. }
// Returns { results, summary }. Writes reports/<ts>-<label>/.
export async function battery(scenarios, { label }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportDir = path.join(ROOT, 'reports', `${ts}-${label}`);
  mkdirSync(reportDir, { recursive: true });
  const results = [];
  for (const s of scenarios) {
    process.stdout.write(`- ${s.name} ... `);
    if (s.skip) {
      results.push({ name: s.name, status: 'SKIP', problems: [], note: s.skip });
      console.log(`SKIP | ${s.skip}`);
      continue;
    }
    let rec;
    try {
      rec = s.run ? await s.run() : run(s.args, s);
    } catch (e) {
      rec = { code: 'EXCEPTION', exception: String(e && e.message || e), ms: 0 };
    }
    let problems = [], note = null;
    try { problems = s.expect ? s.expect(rec) : []; } catch (e) { problems = [`expect() threw: ${e.message}`]; }
    try { note = s.note ? s.note(rec) : null; } catch { note = null; }
    const status = !problems.length ? 'PASS' : s.known ? 'KNOWN' : 'FAIL';
    if (s.known) note = [note, problems.length ? `known issue ${s.known}` : `known issue ${s.known} no longer reproduces: remove the marker`].filter(Boolean).join(' | ');
    results.push({ name: s.name, status, ms: rec.ms, code: rec.code, problems, note });
    writeFileSync(path.join(reportDir, `${s.name.replace(/[^a-zA-Z0-9_-]+/g, '_')}.json`), JSON.stringify(rec, null, 1));
    console.log(`${status} ${rec.ms}ms exit=${rec.code}${note ? ` | ${note}` : ''}${problems.length ? `\n    ! ${problems.join('; ')}` : ''}`);
  }
  const failed = results.filter(r => r.status === 'FAIL');
  const count = status => results.filter(r => r.status === status).length;
  const summary = { label, total: results.length, failed: failed.length, known: count('KNOWN'), skipped: count('SKIP') };
  writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify({ summary, results }, null, 1));
  console.log(`\n[${label}] ${count('PASS')}/${results.length} passed, ${summary.known} known, ${summary.skipped} skipped, ${failed.length} failed; reports: ${reportDir}\n`);
  return { results, summary, reportDir };
}

export const wf = {
  basic: (branches = ['main', 'dev']) => `name: CI\non:\n  push:\n    branches: [${branches.join(', ')}]\njobs:\n  build:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps:\n      - run: echo hello\n`,
  libFail: () => `name: LibGap\non: [push]\njobs:\n  gap:\n    runs-on: blacksmith-2vcpu-ubuntu-2204\n    steps:\n      - run: |\n          echo "error while loading shared libraries: libnspr4.so"\n          exit 1\n`,
  tapFail: () => `name: TapFail\non: [push]\njobs:\n  tap:\n    runs-on: blacksmith-2vcpu-ubuntu-2204\n    steps:\n      - run: |\n          echo "not ok 1 - tests/e2e/sample.spec.mjs:12:5 › sample title"\n          exit 1\n      - if: always()\n        run: |\n          sleep 1\n          echo late-main-stage-output\n`,
};
