import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerDaemonRequirement } from '../src/replay-prerequisites.mjs';
const check = step => dockerDaemonRequirement([{ id: 'test', steps: [{ line: 7, ...step }] }]);
test('detect explicit daemon commands and build actions', () => {
  for (const run of ['docker run image', 'sudo docker compose up', 'set -e; docker build .', 'docker-compose down']) {
    assert.equal(check({ run }).reason, 'docker-daemon-unavailable-in-replay');
  }
  assert.ok(check({ uses: 'docker/setup-buildx-action@sha' }));
  assert.ok(check({ uses: 'docker/build-push-action@sha' }));
});
test('do not mistake comments, echoes, version checks or service declarations for socket use', () => {
  for (const run of ['# docker run image', 'echo "docker run image"', 'docker --version', 'node test.mjs']) assert.equal(check({ run }), null);
  assert.equal(dockerDaemonRequirement([{ id: 'test', services: ['postgres'], steps: [] }]), null);
});
