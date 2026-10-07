import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ACTIONLINT_VERSION = '1.7.12';

// SHA-256 pins from the official v1.7.12 release checksums asset.
const ASSETS = Object.freeze({
  'win32-x64': ['windows_amd64.zip', '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'],
  'win32-arm64': ['windows_arm64.zip', 'cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41'],
  'linux-x64': ['linux_amd64.tar.gz', '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8'],
  'linux-arm64': ['linux_arm64.tar.gz', '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6'],
  'darwin-x64': ['darwin_amd64.tar.gz', '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644'],
  'darwin-arm64': ['darwin_arm64.tar.gz', 'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f'],
});

export function assetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) return null;
  const name = `actionlint_${ACTIONLINT_VERSION}_${asset[0]}`;
  return {
    name,
    sha256: asset[1],
    url: `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${name}`,
    binaryName: platform === 'win32' ? 'actionlint.exe' : 'actionlint',
  };
}

export function verifyArchive(bytes, asset) {
  return createHash('sha256').update(bytes).digest('hex') === asset.sha256;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureActionlint({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = process.env.CI_LOCAL_GUARD_CACHE || path.join(os.homedir(), '.cache', 'ci-local-guard'),
  fetchImpl = fetch,
} = {}) {
  if (process.env.ACTIONLINT_BIN) return path.resolve(process.env.ACTIONLINT_BIN);
  const asset = assetFor(platform, arch);
  if (!asset) throw new Error(`Unsupported actionlint platform ${platform}/${arch}; set ACTIONLINT_BIN to a verified 1.7.12 binary.`);
  const root = path.resolve(cacheRoot);
  const targetDir = path.join(root, `actionlint-${ACTIONLINT_VERSION}-${platform}-${arch}`);
  const binary = path.join(targetDir, asset.binaryName);
  if (await isFile(binary)) return binary;

  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, '.download-'));
  try {
    process.stderr.write(`[ci-local-guard] Downloading checksum-pinned actionlint ${ACTIONLINT_VERSION} (first use only)\n`);
    const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`actionlint download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!verifyArchive(bytes, asset)) throw new Error(`actionlint checksum mismatch: ${asset.name}`);
    const archive = path.join(stage, asset.name);
    await writeFile(archive, bytes);
    execFileSync('tar', ['-xf', archive, '-C', stage], { windowsHide: true, stdio: 'pipe' });
    const extracted = path.join(stage, asset.binaryName);
    if (!(await isFile(extracted))) throw new Error(`actionlint archive missing ${asset.binaryName}`);
    if (platform !== 'win32') await chmod(extracted, 0o755);
    const version = execFileSync(extracted, ['-version'], { encoding: 'utf8', windowsHide: true });
    if (!version.startsWith(`${ACTIONLINT_VERSION}\n`)) throw new Error(`Unexpected actionlint version: ${version.trim()}`);
    await mkdir(targetDir, { recursive: true });
    const pending = path.join(targetDir, `${asset.binaryName}.${process.pid}.tmp`);
    await copyFile(extracted, pending);
    if (platform !== 'win32') await chmod(pending, 0o755);
    try {
      await rename(pending, binary);
    } catch (error) {
      await rm(pending, { force: true });
      if (!(await isFile(binary))) throw error;
    }
    return binary;
  } finally {
    const resolvedStage = path.resolve(stage);
    if (path.dirname(resolvedStage) !== root || !path.basename(resolvedStage).startsWith('.download-')) {
      throw new Error('Refusing to remove an unexpected download directory');
    }
    await rm(resolvedStage, { recursive: true, force: true });
  }
}
