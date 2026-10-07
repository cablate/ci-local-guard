import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIONLINT_VERSION, assetFor, verifyArchive } from '../src/actionlint.mjs';

test('official release assets are pinned for supported platforms', () => {
  for (const [platform, arch] of [
    ['win32', 'x64'], ['win32', 'arm64'],
    ['linux', 'x64'], ['linux', 'arm64'],
    ['darwin', 'x64'], ['darwin', 'arm64'],
  ]) {
    const asset = assetFor(platform, arch);
    assert.match(asset.url, new RegExp(`/v${ACTIONLINT_VERSION}/actionlint_`));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(assetFor('freebsd', 'x64'), null);
});

test('archive checksum mismatch is not accepted', () => {
  assert.equal(verifyArchive(Buffer.from('wrong'), assetFor('win32', 'x64')), false);
});
