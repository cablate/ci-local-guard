import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
test('one version owner, explicit release identity and no plugin execution layer', t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'guard-distribution-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(path.join(temp, '.claude-plugin'));
  for (const name of ['package.json', 'CHANGELOG.md', 'CHANGELOG.zh-TW.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
    writeFileSync(path.join(temp, name), readFileSync(path.join(root, name)));
  }
  mkdirSync(path.join(temp, 'quality'));
  writeFileSync(path.join(temp, 'quality/distribution.mjs'), readFileSync(path.join(root, 'quality/distribution.mjs')));
  const run = (args = [], tag = '') => spawnSync(process.execPath, ['quality/distribution.mjs', ...args], { cwd: temp, encoding: 'utf8', timeout: 10000, env: { ...process.env, RELEASE_TAG: tag } });
  assert.equal(run().status, 0);
  assert.notEqual(run([], 'v999.0.0').status, 0);
  const pkg = JSON.parse(readFileSync(path.join(temp, 'package.json')));
  pkg.version = '0.1.1'; writeFileSync(path.join(temp, 'package.json'), JSON.stringify(pkg));
  assert.notEqual(run().status, 0, 'version drift blocks release');
  assert.equal(run(['--write']).status, 0);
  assert.notEqual(run([], 'v0.1.1').status, 0, 'missing versioned notes block tag');
  writeFileSync(path.join(temp, 'CHANGELOG.md'), '## 0.1.1 — experimental\nRelease notes.\n');
  assert.notEqual(run([], 'v0.1.1').status, 0, 'missing translated release notes block tag');
  writeFileSync(path.join(temp, 'CHANGELOG.zh-TW.md'), '## 0.1.1 — experimental\n版本說明。\n');
  assert.equal(run([], 'v0.1.1').status, 0);
  const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin/plugin.json')));
  for (const key of ['hooks', 'mcpServers', 'agents', 'dependencies', 'settings']) assert.equal(manifest[key], undefined);
  const skill = readFileSync(path.join(root, 'skills/ci/SKILL.md'), 'utf8');
  assert.match(skill, /\$\{CLAUDE_PLUGIN_ROOT\}\/cli\.mjs/);
  assert.doesNotMatch(skill, /npx .*@latest/);
});

test('release notes derive both languages and workflow cannot publish npm', () => {
  const result = spawnSync(process.execPath, ['quality/release-notes.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Install from GitHub/);
  assert.match(result.stdout, /## 繁體中文/);
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.doesNotMatch(workflow, /npm publish|id-token:|NPM_TOKEN|NODE_AUTH_TOKEN/);
  assert.match(workflow, /needs: verify/);
  assert.match(workflow, /merge-base --is-ancestor HEAD origin\/main/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag --prerelease/);
});
