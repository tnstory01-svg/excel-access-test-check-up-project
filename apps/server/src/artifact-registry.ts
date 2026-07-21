import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { IntakeMetadata } from './security/intake.ts';

export type ArtifactHandle = string & { readonly __artifactHandle: unique symbol };
type StoredArtifact = Readonly<{ metadata: IntakeMetadata; filePath: string }>;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function assertSafeDirectory(directory: string): Promise<void> {
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
}
async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}


/** Server-only registry: its filesystem paths never leave this module's boundary. */
export class ArtifactRegistry {
  readonly #artifactDirectory: string;
  readonly #artifacts = new Map<string, StoredArtifact>();

  constructor(artifactDirectory: string) {
    this.#artifactDirectory = path.resolve(artifactDirectory);
  }

  register(metadata: IntakeMetadata): ArtifactHandle {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.id)) {
      throw new Error('Artifact ID is not an opaque UUID');
    }
    const filePath = path.resolve(this.#artifactDirectory, metadata.id);
    if (!contained(this.#artifactDirectory, filePath) || this.#artifacts.has(metadata.id)) {
      throw new Error('Invalid or duplicate artifact registration');
    }
    this.#artifacts.set(metadata.id, Object.freeze({ metadata, filePath }));
    return metadata.id as ArtifactHandle;
  }

  metadata(handle: ArtifactHandle): IntakeMetadata {
    const artifact = this.#artifacts.get(handle);
    if (!artifact) throw new Error('Unknown artifact handle');
    return artifact.metadata;
  }

  async materializePrivateInput(handle: ArtifactHandle, tmpRoot: string): Promise<PrivateJobPlan> {
    const artifact = this.#artifacts.get(handle);
    if (!artifact) throw new Error('Unknown artifact handle');
    await assertSafeDirectory(this.#artifactDirectory);
    const source = await lstat(artifact.filePath);
    if (!source.isFile() || source.isSymbolicLink() || source.size !== artifact.metadata.size) {
      throw new Error('Artifact storage entry is unsafe');
    }
    const canonicalSource = await realpath(artifact.filePath);
    const canonicalArtifacts = await realpath(this.#artifactDirectory);
    if (!contained(canonicalArtifacts, canonicalSource)) throw new Error('Artifact storage entry escaped its root');

    const resolvedTmpRoot = path.resolve(tmpRoot);
    await mkdir(resolvedTmpRoot, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(resolvedTmpRoot);
    const jobDirectory = path.join(resolvedTmpRoot, `job-${randomUUID()}`);
    await mkdir(jobDirectory, { recursive: false, mode: 0o700 });
    await assertSafeDirectory(jobDirectory);
    const inputPath = path.join(jobDirectory, 'input.bin');
    try {
      await copyFile(canonicalSource, inputPath, constants.COPYFILE_EXCL);
      await chmod(inputPath, 0o444);
      const input = await lstat(inputPath);
      if (!input.isFile() || input.isSymbolicLink() || input.size !== artifact.metadata.size
        || await sha256File(inputPath) !== artifact.metadata.sha256) {
        throw new Error('Private input does not match immutable artifact metadata');
      }
    } catch (error) {
      await unlink(inputPath).catch(() => undefined);
      throw error;
    }
    return Object.freeze({ jobDirectory, inputPath, artifactHandle: handle });
  }
}

/** Server-side execution plan. Do not serialize file paths into worker requests. */
export type PrivateJobPlan = Readonly<{
  jobDirectory: string;
  inputPath: string;
  artifactHandle: ArtifactHandle;
}>;

/** The sole artifact value allowed in a worker protocol request. */
export function workerArtifactHandle(plan: PrivateJobPlan): string {
  return plan.artifactHandle;
}
