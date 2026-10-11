// Flake/deadline pressure battery — quantifies the 15s discovery deadline margin.
// Run: node run-flake.mjs
import { run, REAL_REPO } from './lib/harness.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// quality/field-battery/ — the directory containing this file.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.join(ROOT, 'reports', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-flake');
mkdirSync(reportDir, { recursive: true });
const results = {};
const timed = async (label, n, fn) => {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(await fn(i));
  const ms = xs.map(x => x.ms).sort((a, b) => a - b);
  results[label] = { n, outcomes: xs.map(x => x.outcome), minMs: ms[0], medianMs: ms[n >> 1], maxMs: ms[n - 1],
    blocked: xs.filter(x => /unavailable|deadline|git-call-timeout/.test(x.outcome)).length };
  console.log(`${label}: median=${results[label].medianMs}ms max=${results[label].maxMs}ms blocked=${results[label].blocked}/${n} [${results[label].outcomes.map(o => o.slice(0, 12)).join(',')}]`);
};

const discover = () => {
  const r = run(['ci', 'discover', '--repo', REAL_REPO, '--summary']);
  return { ms: r.ms, outcome: r.json?.issues?.[0]?.code || r.json?.outcome || `exit-${r.code}` };
};

// 1. Baseline: warm-cache sequential discover on the real repo (12 workflows).
await timed('baseline-real-repo', 8, discover);

// 2. Parallel discover x6 (git read contention).
{
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 6 }, () => Promise.resolve(discover())));
  results['parallel-x6'] = { ms: Math.round(performance.now() - t0), outcomes: rs.map(r => r.outcome), blocked: rs.filter(r => /unavailable|deadline/.test(r.outcome)).length };
  console.log(`parallel-x6: ${results['parallel-x6'].ms}ms blocked=${results['parallel-x6'].blocked}/6`);
}

// 3. CPU-loaded discover: one busy worker per logical core while measuring.
//    (6 burners on a 16-core host only loaded ~40% and made this scenario look
//    artificially clean — always match the core count.)
{
  const cores = nodeOs.cpus().length;
  const burners = Array.from({ length: cores }, () => spawn(process.execPath, ['-e', 'const t=Date.now()+70000;while(Date.now()<t){Math.sqrt(Math.random())}'], { windowsHide: true }));
  await new Promise(r => setTimeout(r, 1500)); // let them spin up
  await timed(`cpu-loaded-${cores}cores-real-repo`, 5, discover);
  burners.forEach(b => b.kill());
}

// 4. Cold-ish isolation: kill OS file cache influence is not possible without admin;
//    instead simulate many-git-call repos is covered by run-offline scaling scenarios.

writeFileSync(path.join(reportDir, 'flake.json'), JSON.stringify(results, null, 1));
console.log(`\nreports: ${reportDir}`);
const anyBlocked = Object.values(results).some(r => r.blocked > 0);
console.log(anyBlocked ? 'RESULT: deadline pressure reproduced at least once' : 'RESULT: no deadline block in this run');
process.exit(0);
