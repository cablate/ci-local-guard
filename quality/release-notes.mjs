import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const section = file => {
  const content = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## ${version} — `));
  if (start < 0) throw new Error(`Missing release notes in ${file}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
};
process.stdout.write(section('CHANGELOG.md') + '\n\n## 繁體中文\n\n' + section('CHANGELOG.zh-TW.md') + '\n');
