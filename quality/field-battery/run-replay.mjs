// Docker/act replay battery — validates issue #2 items 9-11 plus replay edges.
// Needs Docker running. Run: node run-replay.mjs [--only <substr>]
import { battery, makeRepo, run, wf } from './lib/harness.mjs';

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const ACT = process.env.GUARD_FIELD_ACT || 'C:/Users/user/.claude/tools/act/act.exe';
const FULL = 'blacksmith-2vcpu-ubuntu-2404=catthehacker/ubuntu:act-latest';
const SLIM = 'blacksmith-2vcpu-ubuntu-2204=debian:bookworm-slim';
const S = [];

S.push({
  name: 'replay-happy-path',
  run() { const d = makeRepo('rp-happy', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/ci.yml', '--job', 'build', '--platform', FULL, '--act-binary', ACT], { timeoutMs: 300000 }); },
  expect: r => [r.json?.outcome !== 'passed' ? `outcome=${r.json?.outcome ?? 'no-json'} exit=${r.code} ${(r.json?.issues || []).map(i => i.code).join(',')}` : null].filter(Boolean),
  note: r => r.json?.verdict || (r.stderr || '').slice(0, 100),
});
S.push({
  name: 'replay-env-mismatch-libgap',
  run() { const d = makeRepo('rp-lib', { '.github/workflows/lib.yml': wf.libFail() }); return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/lib.yml', '--job', 'gap', '--platform', SLIM, '--act-binary', ACT], { timeoutMs: 300000 }); },
  expect: r => {
    const f = r.json?.failures?.[0];
    return [f?.observed?.environmentMismatch?.kind !== 'missing-shared-library' ? `environmentMismatch missing (outcome=${r.json?.outcome})` : null,
      !(r.json?.nextActions || []).some(a => a.kind === 'consider-fuller-replay-image') ? 'consider-fuller-replay-image action missing' : null].filter(Boolean);
  },
  note: r => r.json?.failures?.[0]?.observed?.environmentMismatch?.detail || (r.stderr || '').slice(0, 120),
});
S.push({
  name: 'replay-tap-failedtests-lastactivity',
  run() { const d = makeRepo('rp-tap', { '.github/workflows/tap.yml': wf.tapFail() }); return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/tap.yml', '--job', 'tap', '--platform', SLIM, '--act-binary', ACT], { timeoutMs: 300000 }); },
  expect: r => {
    const f = r.json?.failures?.[0], ex = r.json?.execution || r.json?.replays?.[0]?.execution;
    return [!f?.observed?.failedTests?.length ? `failedTests not parsed from replay log (outcome=${r.json?.outcome})` : null,
      !ex?.lastFailure ? 'execution.lastFailure missing' : null,
      !ex?.lastActivity ? 'execution.lastActivity missing' : null,
      // v0.2.1 N4: step fields carry display names, not the raw multiline command.
      ex?.lastFailure && /[\r\n]/.test(ex.lastFailure.step || '') ? `lastFailure.step is raw command text: ${JSON.stringify(ex.lastFailure.step).slice(0, 60)}` : null,
      ex?.lastActivity && /[\r\n]/.test(ex.lastActivity.step || '') ? `lastActivity.step is raw command text: ${JSON.stringify(ex.lastActivity.step).slice(0, 60)}` : null].filter(Boolean);
  },
  note: r => { const f = r.json?.failures?.[0], ex = r.json?.execution || {}; return `failedTests=${JSON.stringify(f?.observed?.failedTests)?.slice(0, 80)} lastFailure=${JSON.stringify(ex.lastFailure)?.slice(0, 60)} lastActivity=${JSON.stringify(ex.lastActivity)?.slice(0, 80)}`; },
});
// v0.2.1 N4: a declared step name wins over "Run <line>"; failures[].command keeps the script.
S.push({
  name: 'replay-named-step-display',
  run() {
    const wfNamed = 'name: NamedFail\non: [push]\njobs:\n  build:\n    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps:\n      - name: Compile assets\n        run: |\n          echo compiling\n          exit 1\n';
    const d = makeRepo('rp-named', { '.github/workflows/n.yml': wfNamed });
    return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/n.yml', '--job', 'build', '--platform', FULL, '--act-binary', ACT], { timeoutMs: 300000 });
  },
  expect: r => {
    const f = r.json?.failures?.[0], ex = r.json?.execution;
    return [f?.step?.name !== 'Compile assets' ? `step.name=${JSON.stringify(f?.step?.name)}, expected declared name` : null,
      !(f?.command && f.command.includes('echo compiling')) ? 'failures[].command does not keep the full script' : null,
      ex?.lastFailure?.step !== 'Compile assets' ? `lastFailure.step=${JSON.stringify(ex?.lastFailure?.step)}` : null].filter(Boolean);
  },
  note: r => `step.name=${r.json?.failures?.[0]?.step?.name} command=${JSON.stringify(r.json?.failures?.[0]?.command)?.slice(0, 40)}`,
});
S.push({
  name: 'replay-unknown-job',
  run() { const d = makeRepo('rp-unk', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/ci.yml', '--job', 'nope', '--platform', FULL, '--act-binary', ACT]); },
  expect: r => [!r.json || r.json.outcome !== 'blocked' ? `expected blocked, got ${r.json?.outcome ?? 'no-json'} exit=${r.code}` : null].filter(Boolean),
  note: r => r.json?.issues?.[0]?.code || null,
});
S.push({
  name: 'replay-image-not-present-no-pull',
  run() { const d = makeRepo('rp-img', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/ci.yml', '--job', 'build', '--platform', 'blacksmith-2vcpu-ubuntu-2404=definitely/not-present:xyz', '--act-binary', ACT], { timeoutMs: 120000 }); },
  expect: r => [!r.json ? `no JSON (exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome} ${(r.json?.issues || []).map(i => i.code).join(',')}`,
});
S.push({
  name: 'replay-sudo-missing-tag',
  run() {
    const wfSudo = 'name: SudoGap\non: [push]\njobs:\n  sudo:\n    runs-on: blacksmith-2vcpu-ubuntu-2204\n    steps:\n      - run: |\n          sudo -n true 2>&1 || { echo \'sh: 1: sudo: command not found\'; exit 1; }\n';
    const d = makeRepo('rp-sudo', { '.github/workflows/s.yml': wfSudo });
    return run(['ci', 'replay', '--repo', d, '--workflow', '.github/workflows/s.yml', '--job', 'sudo', '--platform', SLIM, '--act-binary', ACT], { timeoutMs: 300000 });
  },
  expect: r => {
    const f = r.json?.failures?.[0];
    return [f?.observed?.environmentMismatch?.kind !== 'missing-tool' ? `missing-tool tag absent (outcome=${r.json?.outcome})` : null].filter(Boolean);
  },
  note: r => r.json?.failures?.[0]?.observed?.environmentMismatch?.detail || (r.stderr || '').slice(0, 100),
});
S.push({
  name: 'verify-replay-integration',
  run() { const d = makeRepo('rp-verify', { '.github/workflows/ci.yml': wf.basic() }); return run(['ci', 'verify', '--repo', d, '--event', 'push', '--platform', FULL, '--act-binary', ACT], { timeoutMs: 300000 }); },
  expect: r => [(r.json?.passedLocally || []).length < 1 ? `passedLocally empty (outcome=${r.json?.outcome} exit=${r.code})` : null].filter(Boolean),
  note: r => `${r.json?.outcome}; passed=${(r.json?.passedLocally || []).map(j => j.job).join(',')}`,
});

const scenarios = only ? S.filter(s => s.name.includes(only)) : S;
const { summary } = await battery(scenarios, { label: 'replay' });
process.exit(summary.failed ? 1 : 0);
