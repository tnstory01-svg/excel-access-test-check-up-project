import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SERVER_LIMITS } from '../config.ts';

export type PrivateJobWorkspace = Readonly<{
  jobDirectory: string;
  inputPath: string;
}>;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
const reservedScratchBytes = new Map<string, number>();

async function accountedScratchBytes(directory: string, maximum: number): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink()) throw new Error('Scratch storage contains a reparse point');
    if (stat.isDirectory()) total += await accountedScratchBytes(entryPath, maximum - total);
    else if (stat.isFile()) total += stat.size;
    else throw new Error('Scratch storage contains an unsafe entry');
    if (!Number.isSafeInteger(total) || total > maximum) throw new Error('Scratch storage limit exceeded');
  }
  return total;
}

function validScratchLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Scratch limit must be a positive safe integer');
  return value;
}

async function assertSafeDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Private job path contains a reparse point or non-directory');
    }
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error('Private job path is not canonical');
  return canonical;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

/** Creates a server-owned, UUID-named cwd containing only a fixed read-only input.bin. */
export async function materializePrivateJobInput(options: Readonly<{
  artifactPath: string;
  artifactSize: number;
  artifactSha256: string;
  tmpRoot: string;
  scratchBytes?: number;
}>): Promise<PrivateJobWorkspace> {
  if (!Number.isSafeInteger(options.artifactSize) || options.artifactSize < 0) {
    throw new Error('Artifact size must be a non-negative safe integer');
  }
  const source = await lstat(options.artifactPath);
  if (!source.isFile() || source.isSymbolicLink() || source.size !== options.artifactSize) {
    throw new Error('Artifact storage entry is unsafe');
  }
  const canonicalSource = await realpath(options.artifactPath);
  const tmpRoot = path.resolve(options.tmpRoot);
  const scratchLimit = validScratchLimit(options.scratchBytes ?? SERVER_LIMITS.scratchBytes);
  if (options.artifactSize > scratchLimit) throw new Error('Scratch storage limit exceeded');
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  const canonicalTmpRoot = await assertSafeDirectory(tmpRoot);
  const accounted = await accountedScratchBytes(canonicalTmpRoot, scratchLimit);
  const reserved = reservedScratchBytes.get(canonicalTmpRoot) ?? 0;
  if (accounted > scratchLimit - reserved - options.artifactSize) throw new Error('Scratch storage limit exceeded');
  reservedScratchBytes.set(canonicalTmpRoot, reserved + options.artifactSize);
  const jobDirectory = path.join(canonicalTmpRoot, `job-${randomUUID()}`);
  try {
    await mkdir(jobDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    reservedScratchBytes.set(canonicalTmpRoot, reserved);
    throw error;
  }
  const canonicalJobDirectory = await assertSafeDirectory(jobDirectory);
  const inputPath = path.join(canonicalJobDirectory, 'input.bin');

  try {
    await copyFile(canonicalSource, inputPath, constants.COPYFILE_EXCL);
    await chmod(inputPath, 0o444);
    const input = await lstat(inputPath);
    if (!input.isFile() || input.isSymbolicLink() || input.size !== options.artifactSize
      || await sha256File(inputPath) !== options.artifactSha256) {
      throw new Error('Private input does not match immutable artifact metadata');
    }
  } catch (error) {
    await unlink(inputPath).catch(() => undefined);
    await rm(canonicalJobDirectory, { recursive: true, force: true }).catch(() => undefined);
    reservedScratchBytes.set(canonicalTmpRoot, reserved);
    throw error;
  }
  reservedScratchBytes.set(canonicalTmpRoot, reserved);
  return Object.freeze({ jobDirectory: canonicalJobDirectory, inputPath });
}

/** Removes only a UUID private cwd under tmpRoot; it never follows a path outside it. */
export async function cleanupPrivateJobWorkspace(workspace: PrivateJobWorkspace, tmpRoot: string): Promise<void> {
  const canonicalTmpRoot = await assertSafeDirectory(path.resolve(tmpRoot));
  const jobDirectory = path.resolve(workspace.jobDirectory);
  if (!isContained(canonicalTmpRoot, jobDirectory) || path.dirname(workspace.inputPath) !== jobDirectory
    || path.basename(workspace.inputPath) !== 'input.bin' || !/^job-[0-9a-f-]{36}$/i.test(path.basename(jobDirectory))) {
    throw new Error('Refusing to clean a path outside the private job workspace');
  }
  await rm(jobDirectory, { recursive: true, force: true, maxRetries: 3 });
}
