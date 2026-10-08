import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const pkg = read('package.json');
const plugin = read('.claude-plugin/plugin.json');
if (process.argv.slice(2).some(arg => arg !== '--write')) throw new Error('Only --write is supported');
if (process.argv.includes('--write')) {
  plugin.version = pkg.version;
  writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify(plugin, null, 2) + '\n');
}
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.notEqual(pkg.private, true);
assert.equal(plugin.name, pkg.name);
assert.equal(plugin.version, pkg.version, 'Run npm run distribution:sync after changing package.json version');
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.publishConfig.tag, 'next', 'Experimental releases must not silently promote latest');
assert.ok(!['preinstall', 'install', 'postinstall', 'prepare'].some(key => pkg.scripts?.[key]));
assert.deepEqual(read('.claude-plugin/marketplace.json').plugins.map(({ name, source, version }) => ({ name, source, version })),
  [{ name: pkg.name, source: './', version: undefined }]);
if (process.env.RELEASE_TAG) {
  assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, 'Tag must match package.json');
  assert.ok(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/).some(line => line.startsWith(`## ${pkg.version} — `)), 'Move Unreleased notes to a versioned CHANGELOG heading before tagging');
}
console.log(JSON.stringify({ version: pkg.version, pluginVersion: plugin.version, registry: pkg.publishConfig.registry,
  distTag: pkg.publishConfig.tag, published: false }));
