import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, releaseNotes } from '../tools/docs.mjs';

const cli = fileURLToPath(new URL('../tools/docs.mjs', import.meta.url));
const en = '# Guide\n[繁體中文](README.zh-TW.md)\n\n## Start\n- Use `--help`.\n```sh\nnode cli.mjs --help\n```\n';
const zh = '# 指引\n[English](README.md)\n\n## 開始\n- 使用 `--help`。\n```sh\nnode cli.mjs --help\n```\n';

test('bilingual structure checks reject missing guidance and changed executable examples', () => {
  assert.deepEqual(compare(en, zh), []);
  for (const altered of [
    zh.replace('## 開始', '### 開始'),
    zh.replace('- 使用', '使用'),
    zh.replace('`--help`', '`--version`'),
    zh.replace('node cli.mjs --help', 'node cli.mjs preflight'),
    zh + '\n[Extra](extra.md)\n',
    zh.slice(0, -4),
  ]) assert.ok(compare(en, altered).length, 'drift must not pass');
});

test('documentation CLI fails closed for missing translations and passes an isolated paired consumer', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 });
  writeFileSync(path.join(root, 'README.md'), en);
  assert.equal(run('check').status, 1);
  writeFileSync(path.join(root, 'README.zh-TW.md'), zh);
  assert.equal(run('check').status, 0);
  writeFileSync(path.join(root, 'README.zh-TW.md'), zh.replace('node cli.mjs --help', 'node other.mjs --help'));
  assert.equal(run('check').status, 1);
  assert.equal(run('unknown').status, 2);
});

test('changelog pairs preserve versions, classifications and generated release content', () => {
  const english = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const chinese = readFileSync(new URL('../CHANGELOG.zh-TW.md', import.meta.url), 'utf8');
  assert.deepEqual(compare(english, chinese, { changelog: true }), []);
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  const notes = releaseNotes(english, chinese, version);
  assert.ok(notes.includes('### 繁體中文'));
  assert.match(notes, /https:\/\/github\.com\/cablate\/ci-local-guard\/(?:compare|releases\/tag)\//);
  assert.equal(releaseNotes(english, chinese, '999.0.0'), undefined);
  assert.ok(compare(english, chinese.replace('### 安全性', '### 新增'), { changelog: true }).length);
});
