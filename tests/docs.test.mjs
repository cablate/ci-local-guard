import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, releaseNotes } from '../tools/docs.mjs';

const cli = fileURLToPath(new URL('../tools/docs.mjs', import.meta.url));
test('all public bilingual owners pass the same documentation check used by CI', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'check', root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('public guides resolve relative links and the README offline example produces its claimed evidence', t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of ['README.md', 'README.zh-TW.md', 'docs/reference.md', 'docs/reference.zh-TW.md']) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(path.resolve(root, path.dirname(file), target)), `${file} has a broken link: ${target}`);
    }
  }
  const temp = mkdtempSync(path.join(os.tmpdir(), 'guard-readme-demo-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
  const block = [...readme.matchAll(/```sh\r?\n([\s\S]*?)\r?\n```/g)]
    .map(match => match[1]).find(text => text.includes("writeFileSync('demo-runs.json'"));
  assert.ok(block, 'README must provide an executable, nonempty offline example');
  const lines = block.split(/\r?\n/);
  const code = lines[0].match(/^node --input-type=module -e "(.+)"$/)?.[1];
  assert.ok(code);
  const generated = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: temp, encoding: 'utf8', timeout: 10000 });
  assert.equal(generated.status, 0, generated.stderr);
  assert.deepEqual(lines.slice(1), ['node cli.mjs inspect-runs --input demo-runs.json', 'node cli.mjs audit-runs --input demo-runs.json']);
  for (const verb of ['inspect-runs', 'audit-runs']) {
    const result = spawnSync(process.execPath, [path.join(root, 'cli.mjs'), verb, '--input', 'demo-runs.json'], { cwd: temp, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.savings, null);
    if (verb === 'inspect-runs') {
      assert.equal(report.runs[0].executionWallSeconds, 60);
      assert.equal(report.runs[0].jobSumSeconds, 80);
    }
  }
});
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
