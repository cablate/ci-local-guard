import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../src/project.mjs';
import { withExactCheckout } from '../src/checkout.mjs';

test('uncertain termination retains checkout and original failure', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-retained-'));
  let retained;
  try {
    git(repo, ['init', '-q']);
    writeFileSync(path.join(repo, 'input'), 'fixture');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const failure = Object.assign(new Error('termination uncertain'), { preserveCheckout: true });
    await assert.rejects(withExactCheckout(repo, git(repo, ['rev-parse', 'HEAD']), async () => { throw failure; }), error => {
      assert.equal(error, failure);
      retained = error.retainedCheckout;
      assert.ok(existsSync(retained));
      return true;
    });
  } finally {
    if (retained) { git(repo, ['worktree', 'remove', '--force', retained]); rmSync(path.dirname(retained), { recursive: true, force: true }); }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('locked worktree cleanup failure preserves original error and reports retained location', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-cleanup-'));
  let retained;
  try {
    git(repo, ['init', '-q']);
    writeFileSync(path.join(repo, 'input'), 'fixture');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
    const failure = new Error('product failed');
    await assert.rejects(withExactCheckout(repo, git(repo, ['rev-parse', 'HEAD']), async checkout => {
      retained = checkout;
      git(repo, ['worktree', 'lock', checkout]);
      throw failure;
    }), error => {
      assert.equal(error, failure);
      assert.equal(error.cleanupFailure, 'checkout-cleanup-failed');
      assert.equal(error.retainedCheckout, retained);
      assert.ok(existsSync(retained));
      return true;
    });
  } finally {
    if (retained) {
      git(repo, ['worktree', 'unlock', retained]);
      git(repo, ['worktree', 'remove', '--force', retained]);
      rmSync(path.dirname(retained), { recursive: true, force: true });
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('exact checkout preserves dirty source and cleans itself after failure', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
  let checkout;
  const timings = {};
  try {
    git(repo, ['init', '-q']);
    writeFileSync(path.join(repo, 'input.txt'), 'committed');
    git(repo, ['add', 'input.txt']);
    git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture']);
    const head = git(repo, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(repo, 'input.txt'), 'user dirty');
    writeFileSync(path.join(repo, 'private.txt'), 'untracked');
    await assert.rejects(withExactCheckout(repo, head, async (location) => {
      checkout = location;
      assert.equal(readFileSync(path.join(location, 'input.txt'), 'utf8'), 'committed');
      assert.equal(existsSync(path.join(location, 'private.txt')), false);
      throw new Error('gate failed');
    }, { timings }), /gate failed/);
    assert.equal(timings.checkout.status, 'completed');
    assert.equal(timings.cleanup.status, 'completed');
    assert.ok(Number.isInteger(timings.checkout.durationMs) && timings.checkout.durationMs >= 0);
    assert.ok(Number.isInteger(timings.cleanup.durationMs) && timings.cleanup.durationMs >= 0);
    assert.equal(readFileSync(path.join(repo, 'input.txt'), 'utf8'), 'user dirty');
    assert.equal(readFileSync(path.join(repo, 'private.txt'), 'utf8'), 'untracked');
    assert.equal(existsSync(checkout), false);
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('failed checkout setup is timed separately and never invokes the product action', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'guard-checkout-failure-'));
  const timings = {};
  let invoked = false;
  try {
    git(repo, ['init', '-q']);
    await assert.rejects(withExactCheckout(repo, '1'.repeat(40), () => { invoked = true; }, { timings }), /worktree add.*failed/);
    assert.equal(invoked, false);
    assert.equal(timings.checkout.status, 'failed');
    assert.equal(timings.cleanup.status, 'completed');
    assert.ok(Number.isInteger(timings.checkout.durationMs) && timings.checkout.durationMs >= 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
