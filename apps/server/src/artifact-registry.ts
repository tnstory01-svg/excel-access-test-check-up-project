import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { IntakeMetadata } from './security/intake.ts';
import { SERVER_LIMITS } from './config.ts';
import { cleanupPrivateJobWorkspace, materializePrivateJobInput, type PrivateJobWorkspace } from './security/job-workspace.ts';

export type ArtifactHandle = string & { readonly __artifactHandle: unique symbol };
type StoredArtifact = Readonly<{ metadata: IntakeMetadata; filePath: string }>;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function immutableMetadata(metadata: IntakeMetadata): IntakeMetadata {
  return Object.freeze({
    id: metadata.id,
    sha256: metadata.sha256,
    family: metadata.family,
    detectedFormat: metadata.detectedFormat,
    size: metadata.size,
    createdAt: metadata.createdAt,
  });
}

/** Server-only registry: filesystem paths never leave this module's boundary. */
export class ArtifactRegistry {
  readonly #artifactDirectory: string;
  readonly #artifactStoreBytes: number;
  readonly #artifacts = new Map<string, StoredArtifact>();
  #reservedBytes = 0;

  constructor(artifactDirectory: string, artifactStoreBytes = SERVER_LIMITS.artifactStoreBytes) {
    if (!Number.isSafeInteger(artifactStoreBytes) || artifactStoreBytes < 1) {
      throw new Error('Invalid artifact storage limit');
    }
    this.#artifactDirectory = path.resolve(artifactDirectory);
    this.#artifactStoreBytes = artifactStoreBytes;
  }

  register(metadata: IntakeMetadata): ArtifactHandle {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(metadata.id)) {
      throw new Error('Artifact ID is not an opaque UUID');
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 1) {
      throw new Error('Artifact size is invalid');
    }
    const filePath = path.resolve(this.#artifactDirectory, metadata.id);
    if (!contained(this.#artifactDirectory, filePath) || this.#artifacts.has(metadata.id)) {
      throw new Error('Invalid or duplicate artifact registration');
    }
    if (metadata.size > this.#artifactStoreBytes - this.#reservedBytes) {
      throw new Error('Artifact storage limit exceeded');
    }

    this.#reservedBytes += metadata.size;
    try {
      this.#artifacts.set(metadata.id, Object.freeze({ metadata: immutableMetadata(metadata), filePath }));
      return metadata.id as ArtifactHandle;
    } catch (error) {
      this.#reservedBytes -= metadata.size;
      throw error;
    }
  }

  metadata(handle: ArtifactHandle): IntakeMetadata {
    const artifact = this.#artifacts.get(handle);
    if (!artifact) throw new Error('Unknown artifact handle');
    return artifact.metadata;
  }

  async materializePrivateInput(handle: ArtifactHandle, tmpRoot: string): Promise<PrivateJobPlan> {
    const artifact = this.#artifacts.get(handle);
    if (!artifact) throw new Error('Unknown artifact handle');
    await mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    const source = await lstat(artifact.filePath);
    if (!source.isFile() || source.isSymbolicLink() || source.size !== artifact.metadata.size) {
      throw new Error('Artifact storage entry is unsafe');
    }
    const [canonicalArtifacts, canonicalSource] = await Promise.all([
      realpath(this.#artifactDirectory), realpath(artifact.filePath),
    ]);
    if (!contained(canonicalArtifacts, canonicalSource)) throw new Error('Artifact storage entry escaped its root');
    const workspace = await materializePrivateJobInput({
      artifactPath: canonicalSource,
      artifactSize: artifact.metadata.size,
      artifactSha256: artifact.metadata.sha256,
      tmpRoot,
    });
    return Object.freeze({ ...workspace, artifactHandle: handle });
  }

  async cleanupPrivateInput(plan: PrivateJobPlan, tmpRoot: string): Promise<void> {
    if (!this.#artifacts.has(plan.artifactHandle)) throw new Error('Unknown artifact handle');
    await cleanupPrivateJobWorkspace(plan, tmpRoot);
  }
}

/** Server-side execution plan. Do not serialize file paths into worker requests. */
export type PrivateJobPlan = Readonly<PrivateJobWorkspace & { artifactHandle: ArtifactHandle }>;

/** The sole artifact value allowed in a worker protocol request. */
export function workerArtifactHandle(plan: PrivateJobPlan): string {
  return plan.artifactHandle;
}
