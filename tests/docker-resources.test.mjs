import test from 'node:test';
import assert from 'node:assert/strict';
import { createDockerResources } from '../src/docker-resources.mjs';

const host = 'unix:///var/run/docker.sock';
// A fake daemon: resources are { kind, id, name, labels }.
function fixture(claims = {}) {
  const calls = [];
  const resources = [];
  let failure;
  const scope = createDockerResources({ host, claims, execute: async (binary, args, timeout) => {
    assert.equal(binary, 'docker');
    assert.deepEqual(args.slice(0, 2), ['--host', host]);
    assert.ok(timeout > 0 && timeout <= 15000);
    args = args.slice(2); calls.push(args);
    if (failure?.(args)) throw new Error('PRIVATE_DOCKER_ERROR');
    const [kind, verb] = args;
    if (verb === 'ls') {
      const filter = args.includes('--filter') ? args.at(-1) : null;
      return resources.filter(r => r.kind === kind && (!filter || filter === `label=ci-local-guard.run=${r.labels['ci-local-guard.run']}`))
        .map(r => `${r.id} ${r.name}`).join('\n');
    }
    const resource = resources.find(r => r.id === args.at(-1));
    if (verb === 'inspect') return JSON.stringify([{ Id: resource.id, Name: kind === 'container' ? `/${resource.name}` : resource.name,
      Labels: resource.labels, Config: { Labels: resource.labels } }]);
    if (verb === 'rm') { resources.splice(resources.indexOf(resource), 1); return resource.id; }
    throw new Error('Unexpected command');
  } });
  const add = (kind, name, labels = {}) => resources.push({ kind, id: kind === 'volume' ? name : `${name}-id`, name, labels });
  return { scope, calls, resources, add, own: { 'ci-local-guard.run': scope.runId }, fail: fn => { failure = fn; } };
}
const claims = { container: ['act-job', 'act-job-svc'], volume: ['act-job', 'act-job-env'], network: ['act-job-net'] };

test('cleanup requires a prepared scope and confirmed producer termination', async () => {
  const f = fixture(claims);
  assert.deepEqual((await f.scope.cleanup({ producerStopped: true })).reasons, ['scope-not-prepared']);
  assert.equal(f.calls.length, 0);
  await f.scope.prepare();
  const count = f.calls.length;
  assert.deepEqual((await f.scope.cleanup()).reasons, ['producer-termination-unconfirmed']);
  assert.deepEqual((await f.scope.cleanup({ producerStopped: 'false' })).reasons, ['producer-termination-unconfirmed']);
  assert.equal(f.calls.length, count);
  await assert.rejects(f.scope.prepare());
});

test('a claimed name that already exists is a collision; nothing is removed', async () => {
  const f = fixture(claims);
  f.add('volume', 'act-job-env');
  await assert.rejects(f.scope.prepare(), error => error.collisions?.[0]?.name === 'act-job-env');
  assert.ok(!f.calls.some(args => args[1] === 'rm'));
});

test('labelled and claimed resources are removed in dependency order; unrelated ones survive', async () => {
  const f = fixture(claims); await f.scope.prepare();
  f.add('container', 'act-job', f.own);
  f.add('container', 'act-job-svc'); // services carry no label; claimed by exact name
  f.add('container', 'renamed-by-provider', f.own);
  f.add('network', 'act-job-net'); f.add('volume', 'act-job'); f.add('volume', 'act-job-env');
  f.add('volume', 'act-toolcache'); f.add('container', 'someone-elses-db'); f.add('container', 'act-job-other');
  const report = await f.scope.cleanup({ producerStopped: true });
  assert.equal(report.outcome, 'cleaned');
  assert.deepEqual(f.calls.filter(args => args[1] === 'rm').map(args => args[0]),
    ['container', 'container', 'container', 'network', 'volume', 'volume']);
  assert.ok(f.calls.filter(args => args[0] === 'container' && args[1] === 'rm').every(args => args.includes('--volumes')));
  assert.deepEqual(f.resources.map(r => r.name).sort(), ['act-job-other', 'act-toolcache', 'someone-elses-db']);
  assert.equal((await f.scope.cleanup({ producerStopped: true })).outcome, 'cleaned');
});

test('a claimed name carrying another run label is not removed, and dependencies wait', async () => {
  const f = fixture(claims); await f.scope.prepare();
  f.add('container', 'act-job', { 'ci-local-guard.run': 'different-run' }); f.add('volume', 'act-job');
  const report = await f.scope.cleanup({ producerStopped: true });
  assert.equal(report.outcome, 'incomplete');
  assert.equal(report.remaining.length, 2);
  assert.ok(!f.calls.some(args => args[1] === 'rm'));
});

test('Docker failure stays incomplete and raw diagnostics do not leak', async () => {
  const f = fixture(claims); await f.scope.prepare(); f.add('container', 'act-job', f.own);
  f.fail(args => args[1] === 'rm');
  const report = await f.scope.cleanup({ producerStopped: true });
  assert.equal(report.outcome, 'incomplete');
  assert.deepEqual(report.remaining, [{ kind: 'container', name: 'act-job' }]);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_DOCKER_ERROR'));
  f.fail(args => args[1] === 'ls');
  assert.equal((await f.scope.cleanup({ producerStopped: true })).outcome, 'incomplete');
});

test('invalid inventories, claims and options fail closed', async () => {
  for (const value of ['--all x', 'a b c', '../outside x']) {
    const scope = createDockerResources({ host, execute: async () => value });
    await assert.rejects(scope.prepare(), /inventory/);
  }
  for (const endpoint of [undefined, '', 'tcp://remote:2375', 'unix:///socket\n']) {
    assert.throws(() => createDockerResources({ host: endpoint }));
  }
  assert.throws(() => createDockerResources({ host, claims: { volume: ['../x'] } }));
  const f = fixture();
  for (const timeoutMs of [0, -1, Infinity, 1.5, 120001]) await assert.rejects(f.scope.cleanup({ timeoutMs }));
});

test('overall deadline prevents starting further Docker calls', async () => {
  let slow = false;
  const scope = createDockerResources({ host, execute: async () => {
    if (slow) await new Promise(resolve => setTimeout(resolve, 20));
    return '';
  } });
  await scope.prepare(); slow = true;
  const report = await scope.cleanup({ producerStopped: true, timeoutMs: 5 });
  assert.equal(report.outcome, 'incomplete');
  assert.ok(report.reasons.some(r => r.code === 'resource-verification-unavailable'));
});
