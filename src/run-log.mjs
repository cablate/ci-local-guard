import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { cleanGitEnvironment, git, readProjectReceipt } from './project.mjs';

// Keep enough trailing text to mask values split across stream chunks.
export function createRedactor(env, write) {
  const values = [...new Set(Object.entries(env)
    .filter(([name, value]) => /secret|token|password|passwd|private.?key|api.?key|credential|authorization|cookie/i.test(name)
      && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value))].sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const tail = values[0]?.length ?? 1;
  let pending = '';
  return (text, final = false) => {
    pending += text;
    const cut = final ? pending.length : Math.max(0, pending.length - tail + 1);
    if (!cut) return;
    let consumed = 0;
    let output = '';
    if (pattern) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(pending)) && match.index < cut) {
        output += pending.slice(consumed, match.index) + '[REDACTED]';
        consumed = match.index + match[0].length;
      }
    }
    const end = Math.max(cut, consumed);
    output += pending.slice(consumed, end);
    pending = pending.slice(end);
    if (output) write(output);
  };
}

// Logs live outside disposable checkouts. Successful logs are removed by default;
// failures keep bounded, best-effort-redacted output without echoing it to chat.
export async function runLogged(command, args, repo, {
  logRepo = repo, stage = 'check', env = process.env, maxBytes = 24 * 1024 * 1024,
  timeoutMs = executionTimeout(env),
  collectDirectory,
  receiptIdentity,
  receiptSchema,
  requireReceipt = false,
  validateAfter,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid execution timeout');
  if (!/^[a-z][a-z0-9-]*$/.test(stage)) throw new Error('Invalid log stage');
  if (validateAfter !== undefined && typeof validateAfter !== 'function') throw new Error('Invalid post-execution validator');
  if (collectDirectory !== undefined && collectDirectory !== 'tmp/preflight') throw new Error('Unsupported child log directory');
  const common = path.resolve(logRepo, git(logRepo, ['rev-parse', '--git-common-dir']));
  const root = env.CI_LOCAL_GUARD_LOG_DIR ? path.resolve(env.CI_LOCAL_GUARD_LOG_DIR) : path.join(common, 'ci-local-guard', 'logs');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const logFile = path.join(root, `${stage}-${randomUUID()}.log`);
  const fd = openSync(logFile, 'wx', 0o600);
  const started = performance.now();
  let bytes = 0;
  let failure;
  let loggingFailed = false;
  let collectedLogs = { status: 'not-requested', count: 0 };
  let collectionFinished = false;
  const logRanges = new Map();
  let projectReceipt = { status: 'unavailable' };
  let exitCode = null;
  let exitSignal = null;
  let processStarted = false;
  let phase = 'process';
  const causes = new Set();
  let child;
  let stop = () => {};
  let terminationUncertain = false;
  const write = (text) => {
    if (loggingFailed) return;
    let cause = 'log-write-failed';
    try {
      const size = Buffer.byteLength(text);
      if (bytes + size > maxBytes) {
        cause = 'log-budget-exceeded';
        writeSync(fd, '\n[ci-local-guard] Log size limit exceeded; check stopped, not PASS.\n');
        throw new Error('log size limit exceeded');
      }
      const buffer = Buffer.from(text);
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (!written) throw new Error('Log write made no progress');
        offset += written;
        bytes += written;
      }
    } catch (error) {
      causes.add(cause);
      failure = error;
      loggingFailed = true;
      stop(cause);
    }
  };
  write(`[ci-local-guard] stage: ${stage}\n`); // Never serialize argv or environment.
  try {
    let termination;
    if (!failure) await new Promise((resolve) => {
      let settled = false;
      let deadline;
      let drainDeadline;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(drainDeadline);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        resolve();
      };
      const cancel = () => stop('execution-cancelled');
      stop = (cause) => {
        if (settled || termination) return;
        causes.add(cause);
        failure ??= new Error(cause);
        termination = terminateTree(child).catch(() => {
          terminationUncertain = true;
          causes.add('process-tree-termination-unverified');
        });
        drainDeadline = setTimeout(() => {
          terminationUncertain = true;
          causes.add('process-drain-timeout');
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        }, 5000);
      };
      child = spawn(command, args, { cwd: repo, env: cleanGitEnvironment(env),
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      process.on('SIGINT', cancel);
      process.on('SIGTERM', cancel);
      deadline = setTimeout(() => stop('execution-timeout'), timeoutMs);
      // Keep redactor-delayed tails from splicing stdout/stderr inside a line.
      // Bound unterminated lines too; this is not a total-order stream replay.
      const lineSink = () => {
        let pending = '';
        const drain = (text, final = false) => {
          pending += text;
          let end;
          while ((end = pending.indexOf('\n')) >= 0 || pending.length >= 65536) {
            const size = end >= 0 && end < 65536 ? end + 1 : 65536;
            write(pending.slice(0, size));
            pending = pending.slice(size);
          }
          if (final && pending) { write(pending); pending = ''; }
        };
        return drain;
      };
      const stdoutLines = lineSink();
      const stderrLines = lineSink();
      const stdout = createRedactor(env, stdoutLines);
      const stderr = createRedactor(env, stderrLines);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', stdout);
      child.stderr.on('data', stderr);
      child.on('spawn', () => { processStarted = true; });
      child.on('error', () => {
        causes.add(processStarted ? 'process-execution-failed' : 'process-start-failed');
        failure ??= new Error(processStarted ? 'process execution error' : 'process could not start');
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        exitCode = code;
        exitSignal = signal;
        stdout('', true);
        stderr('', true);
        stdoutLines('', true);
        stderrLines('', true);
        if (code !== 0) {
          if (signal) causes.add('process-terminated');
          else if (processStarted && Number.isInteger(code)) causes.add('child-exit-nonzero');
          failure ??= new Error(signal ? `terminated by ${signal}` : `exit code ${code}`);
        }
        finish();
      });
    });
    await termination;
    // The child has closed, but the exact checkout still exists. Append complete
    // inner logs even after a child failure, using the same redactor and budget.
    phase = 'child-log-collection';
    if (collectDirectory && !loggingFailed) {
      collectedLogs = { status: 'unavailable', count: 0 };
      let directory = repo;
      let present = true;
      for (const part of collectDirectory.split('/')) {
        directory = path.join(directory, part);
        let info;
        try { info = lstatSync(directory); }
        catch (error) { if (error.code === 'ENOENT') { present = false; break; } throw error; }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe child log directory');
      }
      if (present) {
        const names = readdirSync(directory).sort();
        if (names.length > 64) throw new Error('Too many child log entries');
        collectedLogs.status = 'captured';
        for (const name of names.filter((entry) => entry.endsWith('.log'))) {
          const file = path.join(directory, name);
          const info = lstatSync(file);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe child log file');
          const input = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const startByte = bytes;
            const redact = createRedactor(env, write);
            const decoder = new StringDecoder('utf8');
            redact(`\n[ci-local-guard] child log: ${name}\n`);
            const buffer = Buffer.alloc(64 * 1024);
            let size;
            while (!loggingFailed && (size = readSync(input, buffer, 0, buffer.length, null)) > 0) {
              redact(decoder.write(buffer.subarray(0, size)));
            }
            redact(decoder.end(), true);
            if (loggingFailed) throw failure;
            logRanges.set(name, { startByte, endByte: bytes });
            collectedLogs.count += 1;
          } finally { closeSync(input); }
        }
      }
      collectionFinished = true;
    }
    phase = 'receipt-validation';
    if (receiptIdentity && !causes.has('execution-timeout') && !causes.has('execution-cancelled') && !terminationUncertain) {
      projectReceipt = { status: 'invalid' };
      projectReceipt = readProjectReceipt(repo, receiptIdentity, exitCode, receiptSchema);
      if (requireReceipt && projectReceipt.status === 'unavailable') {
        causes.add('receipt-unavailable');
        throw new Error('Configured project receipt is unavailable; check stopped, not PASS');
      }
      if (projectReceipt.status === 'validated') {
        let redactedMetadata = false;
        const mask = (value) => {
          if (typeof value !== 'string') return value;
          let output = '';
          createRedactor(env, (part) => { output += part; })(value, true);
          redactedMetadata ||= output !== value;
          return output;
        };
        const receipt = projectReceipt.receipt;
        receipt.changedFiles = receipt.changedFiles.map(mask);
        receipt.unverified = receipt.unverified.map(mask);
        receipt.checks = receipt.checks.map((check) => ({ ...check,
          ...Object.fromEntries(['id', 'owner', 'why', 'blockedBy', 'log'].map((key) => [key, mask(check[key])])) }));
        projectReceipt.redactedMetadata = redactedMetadata;
        // Only validated, unambiguous receipt IDs locate fully collected sections.
        // These byte ranges cover redacted output including its section header,
        // not a guessed error line or root cause.
        collectedLogs.checkLocations = redactedMetadata ? [] : receipt.checks.flatMap(check => {
          const range = logRanges.get(check.log);
          return range ? [{ checkId: check.id, ...range }] : [];
        });
      }
    }
    if (failure) throw failure;
  } catch (error) {
    // Preserve simultaneous transport/receipt problems, not just the first
    // exception. Codes describe observed failure boundaries, not root causes.
    if (error !== failure) {
      if (phase === 'receipt-validation' && !causes.has('receipt-unavailable')) causes.add('receipt-invalid');
      else if (phase === 'child-log-collection') causes.add('child-log-collection-failed');
      else if (phase === 'process') causes.add('process-execution-failed');
    }
    if (collectDirectory && !collectionFinished && collectedLogs.status !== 'not-requested') collectedLogs.status = 'incomplete';
    failure ??= error;
  } finally {
    // Validate before discarding success logs; preserve the original child failure.
    try { if (validateAfter) await validateAfter(); }
    catch (error) {
      causes.add('post-execution-validation-failed');
      failure ??= error;
      try { write('[ci-local-guard] post-execution validation failed\n'); } catch { /* failure already retained */ }
    }
    try { closeSync(fd); } catch (error) { causes.add('log-close-failed'); failure ??= error; }
  }
  const durationMs = Math.round(performance.now() - started);
  if (failure) {
    const error = new Error(`${stage} failed (${failure.message}); log: ${logFile}`);
    error.logFile = logFile;
    error.stage = stage;
    error.durationMs = durationMs;
    error.collectedLogs = collectedLogs;
    error.projectReceipt = projectReceipt;
    error.preserveCheckout = terminationUncertain;
    error.executionFailure = { schemaVersion: 'ci-local-guard/execution-failure/v1', stage,
      processStarted, exitCode: processStarted && Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null,
      transportCloseCode: Number.isInteger(exitCode) ? exitCode : null, signal: exitSignal || null,
      causes: [...causes], receiptStatus: projectReceipt.status,
      failedChecks: projectReceipt.status === 'validated' ? projectReceipt.receipt.checks
        .filter((check) => check.status === 'ran' && check.result === 'failure')
        .map(({ id, owner }) => ({ id, owner })) : [],
      limitation: 'Observed execution and validation boundaries only; failed checks are receipt-declared, not inferred from logs. No root cause, hosted verdict or retry authorization is established.' };
    throw error;
  }
  let retained = Boolean(env.CI_LOCAL_GUARD_KEEP_LOGS);
  if (!retained) {
    try { unlinkSync(logFile); } catch { retained = true; }
  }
  return { durationMs, logFile: retained ? logFile : null, collectedLogs, projectReceipt };
}

export function executionTimeout(env = process.env) {
  const value = env.CI_LOCAL_GUARD_TIMEOUT_SECONDS ?? '900';
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483) {
    throw new Error('CI_LOCAL_GUARD_TIMEOUT_SECONDS must be a positive integer (1..2147483)');
  }
  return Number(value) * 1000;
}

// Only the process tree owned by this invocation; never kill by executable name.
async function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 4000, maxBuffer: 65536 }, error => error ? reject(error) : resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
