import { discoverCi } from './ci-discovery.mjs';
import { reserveReportOutput } from './agent-report.mjs';
import { checkCi } from './ci-check.mjs';
import { replayCi, replayOptions, summarizeReplay } from './ci-replay.mjs';
import { summarizeVerify, verifyCi, verifyOptions } from './ci-verify.mjs';
import { historyCi, historyOptions, summarizeHistory } from './ci-history.mjs';
import { readFileSync, statSync, writeFileSync } from 'node:fs';

// New namespace, independent of legacy report envelopes and exit contracts.
export async function ciCommand(args) {
  let save;
  let report;
  let summary = false;
  try {
    if (!['discover', 'check', 'replay', 'verify', 'history'].includes(args[0])) throw new Error('unsupported-ci-command');
    if (args[0] === 'history') {
      const opts = historyOptions(args.slice(1));
      summary = opts.summary;
      if (opts.output) save = reserveReportOutput(opts.output);
      report = await historyCi(opts, { readExport: file => {
        if (statSync(file).size > 10 * 1024 * 1024) throw new Error('export-too-large');
        return JSON.parse(readFileSync(file, 'utf8'));
      }, saveExport: (file, data) => writeFileSync(file, `${JSON.stringify(data)}\n`, { flag: 'wx', mode: 0o600 }) });
    } else if (args[0] === 'verify') {
      const opts = verifyOptions(args.slice(1));
      summary = opts.summary;
      if (opts.output) save = reserveReportOutput(opts.output);
      report = await verifyCi(opts);
    } else if (args[0] === 'replay') {
      const opts = replayOptions(args.slice(1));
      summary = opts.summary;
      if (opts.output) save = reserveReportOutput(opts.output);
      report = await replayCi(opts);
    } else {
      const opts = {};
      for (let i = 1; i < args.length; i++) {
        const key = args[i];
        const allowed = ['--repo', '--head', '--output', '--summary', '--json', ...(args[0] === 'check' ? ['--provider', '--binary'] : [])];
        if (!allowed.includes(key) || Object.hasOwn(opts, key)) throw new Error('invalid-ci-options');
        if (['--summary', '--json'].includes(key)) opts[key] = true;
        else {
          if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid-ci-options');
          opts[key] = args[++i];
        }
      }
      summary = Boolean(opts['--summary']);
      if (opts['--output']) save = reserveReportOutput(opts['--output']);
      report = args[0] === 'check' ? await checkCi({ repo: opts['--repo'], head: opts['--head'], provider: opts['--provider'], binary: opts['--binary'] })
        : discoverCi({ repo: opts['--repo'], head: opts['--head'], tools: true });
    }
  } catch (error) {
    // Neither provider stderr nor arbitrary Git/configuration data enters JSON.
    const kind = { check: ['ci-check', 'top-level-github-workflow-static-baseline'], replay: ['ci-replay', 'local-act-replay-of-one-job'], verify: ['ci-verify', 'pre-push-local-verification'], history: ['ci-history', 'hosted-failure-and-timing-history'] }[args[0]]
      || ['ci-inventory', 'committed-source-inventory'];
    report = { schemaVersion: `ci-local-guard/${kind[0]}/v1`, command: `ci ${['check', 'replay', 'verify', 'history'].includes(args[0]) ? args[0] : 'discover'}`, identity: null,
      outcome: 'blocked', scope: kind[1],
      issues: [{ code: error.reportOutputFailure || error.replayCode || error.verifyCode || error.historyCode || (/^[a-z-]+$/.test(error.message) ? error.message : 'discovery-failed') }],
      nextActions: [{ kind: 'review-command-inputs', help: ['--help'], automatic: false }],
    };
  }
  report.reportStorage = { status: 'not-requested', path: null };
  if (save) save(report);
  const output = summary && report.command === 'ci history' && report.identity ? summarizeHistory(report) : summary && report.command === 'ci verify' && report.identity ? summarizeVerify(report) : summary && report.command === 'ci replay' && report.jobs ? summarizeReplay(report) : summary && report.engines ? { ...report,
    workflows: report.workflows.map(({ path, name, analysis, triggers, jobs, issues }) => ({ path, name, analysis,
      ...(triggers ? { events: triggers.map(t => t.event) } : {}), ...(issues ? { issues } : {}),
      ...(jobs ? { jobs: jobs.map(job => ({ id: job.id, runsOn: job.runsOn, needs: job.needs, steps: job.steps.length,
        matrixLegs: job.matrix.legs, localReplay: { replayable: job.localReplay.replayable.length,
          hostedOnly: job.localReplay.hostedOnly.length, unknown: job.localReplay.unknown.length } })) } : {}) })),
    ciCommands: report.ciCommands.map(({ command, lines, scripts, where }) => ({ command, ...(lines ? { lines } : {}), scripts, where: where.slice(0, 2) })),
    engines: report.engines.map(({ id, source, status }) => ({ id, source, status })),
  } : summary && report.findings ? { ...report, findings: report.findings.slice(0, 20),
    findingCount: report.findings.length, findingsTruncated: report.findings.length > 20 } : report;
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exitCode = report.reportStorage.status === 'failed' ? 3
    : ['inventoried', 'passed', 'clear-locally', 'measured'].includes(report.outcome) ? 0 : ['findings', 'failed', 'expected-to-fail'].includes(report.outcome) ? 1 : report.outcome === 'incomplete' ? 3 : 2;
}
