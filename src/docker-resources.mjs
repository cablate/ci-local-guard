import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const labelKey = 'ci-local-guard.run';
const kinds = ['container', 'network', 'volume'];
const validName = name => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name);

// Ownership for one run: containers carrying this run's label, plus exact
// resource names the caller claims. A claim is only accepted when nothing with
// that name exists before the run, so cleanup never touches older resources.
// Never prune, match by prefix, or remove resources outside this scope.
export function createDockerResources({ host, claims = {}, binary = 'docker', execute = dockerCommand } = {}) {
  if (typeof host !== 'string' || !/^(unix:\/\/\/|npipe:\/\/\/\/)[^\r\n\0]+$/.test(host)) {
    throw new Error('An explicit local Docker endpoint is required');
  }
  const claimed = Object.fromEntries(kinds.map(kind => [kind, [...new Set(claims[kind] || [])]]));
  if (kinds.some(kind => !claimed[kind].every(validName)) || Object.values(claimed).flat().length > 4096) {
    throw new Error('Invalid Docker resource claims');
  }
  const runId = randomUUID();
  const label = `${labelKey}=${runId}`;
  let prepared = false;
  const call = (args, timeoutMs) => execute(binary, ['--host', host, ...args], timeoutMs);
  // Full name inventory of one kind: [{ id, name }].
  const list = async (kind, timeoutMs, filter) => {
    const args = kind === 'container' ? ['container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}} {{.Names}}']
      : kind === 'network' ? ['network', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Name}}']
        : ['volume', 'ls', '--format', '{{.Name}} {{.Name}}'];
    const raw = await call([...args, ...(filter ? ['--filter', filter] : [])], timeoutMs);
    const rows = raw.split(/\r?\n/).filter(Boolean).map(line => {
      const [id, name, extra] = line.trim().split(' ');
      if (extra !== undefined || !validName(id) || !name || !name.split(',').every(validName)) throw new Error('Invalid Docker resource inventory');
      return { id, name };
    });
    if (rows.length > 100000) throw new Error('Invalid Docker resource inventory');
    return rows;
  };
  const owned = async (kind, timeoutMs) => {
    const names = new Set(claimed[kind]);
    const rows = (await list(kind, timeoutMs)).filter(row => row.name.split(',').some(name => names.has(name)));
    if (kind === 'container') {
      for (const row of await list(kind, timeoutMs, `label=${label}`)) if (!rows.some(item => item.id === row.id)) rows.push(row);
    }
    return rows;
  };
  return {
    runId, label, claims: claimed,
    // Returns names present now, e.g. to report shared caches; not ownership.
    async present(kind, names, timeoutMs = 5000) {
      const wanted = new Set(names);
      return (await list(kind, timeoutMs)).filter(row => wanted.has(row.name)).map(row => row.name);
    },
    async prepare() {
      if (prepared) throw new Error('Resource scope already prepared');
      const collisions = [];
      for (const kind of kinds) collisions.push(...(await owned(kind, 10000)).map(row => ({ kind, name: row.name })));
      if (collisions.length) throw Object.assign(new Error('Resource ownership collision'), { collisions });
      prepared = true;
    },
    async cleanup({ producerStopped = false, timeoutMs = 30000 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new Error('Invalid cleanup deadline');
      const report = { runId, label, scope: 'labelled-or-claimed-names', outcome: 'incomplete', removed: [], remaining: [], reasons: [] };
      if (!prepared || producerStopped !== true) {
        report.reasons.push(!prepared ? 'scope-not-prepared' : 'producer-termination-unconfirmed');
        return report;
      }
      const deadline = Date.now() + timeoutMs;
      const remainingTime = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error('Cleanup deadline exceeded');
        return Math.min(ms, 15000);
      };
      let containerFailure = false;
      // Containers first: networks and volumes cannot be removed while in use.
      for (const kind of kinds) {
        if (kind !== 'container' && containerFailure) break;
        try {
          for (const row of await owned(kind, remainingTime())) {
            try {
              const details = JSON.parse(await call([kind, 'inspect', row.id], remainingTime()));
              const resource = details?.[0];
              const labels = (kind === 'container' ? resource?.Config?.Labels : resource?.Labels) || {};
              const name = kind === 'container' ? String(resource?.Name || '').replace(/^\//, '') : resource?.Name;
              const identity = kind === 'volume' ? resource?.Name : resource?.Id;
              const byLabel = labels[labelKey] === runId;
              const byClaim = claimed[kind].includes(name) && (labels[labelKey] === undefined || byLabel);
              if (!Array.isArray(details) || details.length !== 1 || identity !== row.id || !(byLabel || byClaim)) {
                throw new Error('Resource ownership mismatch');
              }
              // Never force-remove volumes or networks.
              // --volumes removes only this container's anonymous volumes (image VOLUME
              // declarations, e.g. a database service), never named volumes.
              await call([kind, 'rm', ...(kind === 'container' ? ['--force', '--volumes'] : []), row.id], remainingTime());
              report.removed.push({ kind, name });
            } catch {
              report.reasons.push({ code: 'resource-removal-unconfirmed', kind, name: row.name });
              if (kind === 'container') containerFailure = true;
            }
          }
        } catch {
          report.reasons.push({ code: 'resource-inventory-unavailable', kind });
          if (kind === 'container') containerFailure = true;
        }
      }
      for (const kind of kinds) {
        try {
          report.remaining.push(...(await owned(kind, remainingTime())).map(row => ({ kind, name: row.name })));
        } catch {
          report.reasons.push({ code: 'resource-verification-unavailable', kind });
        }
      }
      if (!report.reasons.length && !report.remaining.length) report.outcome = 'cleaned';
      return report;
    },
  };
}

export function dockerCommand(binary, args, timeoutMs) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp)$/i.test(key)));
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => error ? reject(new Error('Docker command failed')) : resolve(stdout));
  });
}
