import { mkdtempSync, rmSync, existsSync, symlinkSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { git } from './project.mjs';

// Sampled local Git state only: not a sandbox or hosted provenance attestation.
export function observeCheckout(repo) {
  const [head, tree] = git(repo, ['show', '--no-patch', '--no-show-signature', '--format=%H%n%T', 'HEAD']).split(/\r?\n/);
  if (![head, tree].every((value) => /^[a-f0-9]{40}$/.test(value))) throw new Error('Unsupported checkout identity');
  return { head, tree, trackedDirty: Boolean(git(repo, ['status', '--porcelain', '--untracked-files=no'])),
    observedAt: new Date().toISOString() };
}

// Run project gates against the pushed commit, never the user's dirty worktree.
export async function withExactCheckout(repo, head, action, { timings } = {}) {
  if (!/^[a-f0-9]{40}$/.test(head || '') || typeof action !== 'function') throw new Error('Invalid exact checkout request');
  const started = performance.now();
  const record = (phase, start, status) => {
    if (timings) timings[phase] = { status, durationMs: Math.floor(performance.now() - start) };
  };
  let temporaryRoot;
  let checkout;
  let attached = false;
  let linkedDependencies = false;
  let prepared = false;
  let actionError;
  try {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'ci-local-guard-'));
    checkout = path.join(temporaryRoot, 'checkout');
    git(repo, ['worktree', 'add', '--detach', checkout, head]);
    attached = true;
    const dependencies = path.join(repo, 'node_modules');
    const lock = path.join(repo, 'package-lock.json');
    const targetLock = path.join(checkout, 'package-lock.json');
    if (existsSync(dependencies) && existsSync(lock) && existsSync(targetLock)
      && readFileSync(lock).equals(readFileSync(targetLock))) {
      symlinkSync(dependencies, path.join(checkout, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      linkedDependencies = true;
    }
    prepared = true;
    record('checkout', started, 'completed');
    return await action(checkout);
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    if (!prepared) record('checkout', started, 'failed');
    const cleanupStarted = performance.now();
    if (actionError?.preserveCheckout) {
      actionError.retainedCheckout = checkout;
      record('cleanup', cleanupStarted, 'retained');
      throw actionError;
    }
    // This path is created above under the OS temp directory, never supplied by a user.
    // If Git removal fails, preserve it for diagnosis rather than deleting Git metadata.
    try {
      if (linkedDependencies) unlinkSync(path.join(checkout, 'node_modules'));
      if (attached) git(repo, ['worktree', 'remove', '--force', checkout]);
      if (temporaryRoot) {
        rmSync(temporaryRoot, { recursive: true, force: true });
        record('cleanup', cleanupStarted, 'completed');
      }
    } catch (error) {
      record('cleanup', cleanupStarted, 'failed');
      const failure = actionError || error;
      failure.retainedCheckout = checkout || temporaryRoot;
      failure.cleanupFailure = 'checkout-cleanup-failed';
      if (failure.executionFailure) failure.executionFailure.causes.push('checkout-cleanup-failed');
      throw failure;
    }
  }
}
