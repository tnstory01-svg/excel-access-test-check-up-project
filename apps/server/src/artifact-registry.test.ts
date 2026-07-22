import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ArtifactRegistry } from './artifact-registry.ts';
import { loadServerLimits } from './config.ts';
import type { IntakeMetadata } from './security/intake.ts';

function metadata(size: number, id = randomUUID()): IntakeMetadata {
  return Object.freeze({
    id,
    sha256: 'a'.repeat(64),
    family: 'excel',
    detectedFormat: 'xlsx',
    size,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

test('artifact store cap accepts the exact boundary and rejects the next artifact', () => {
  const registry = new ArtifactRegistry('C:\\artifacts', 3);
  registry.register(metadata(2));
  registry.register(metadata(1));
  assert.throws(() => registry.register(metadata(1)), /Artifact storage limit exceeded/);
});

test('artifact store reservation is dedupe-safe and cannot be overrun by concurrent registrations', async () => {
  const registry = new ArtifactRegistry('C:\\artifacts', 3);
  const first = metadata(2);
  registry.register(first);
  assert.throws(() => registry.register(first), /Invalid or duplicate artifact registration/);
  registry.register(metadata(1));

  const concurrent = new ArtifactRegistry('C:\\artifacts', 3);
  const results = await Promise.allSettled([metadata(2), metadata(2), metadata(2)].map(async (entry) => concurrent.register(entry)));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
});
test('artifact storage reservation rolls back when registration fails after reserving', () => {
  const registry = new ArtifactRegistry('C:\\artifacts', 3);
  const id = randomUUID();
  const failing = {
    id,
    get sha256(): string { throw new Error('metadata failure'); },
    family: 'excel',
    detectedFormat: 'xlsx',
    size: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as IntakeMetadata;

  assert.throws(() => registry.register(failing), /metadata failure/);
  registry.register(metadata(3));
});

test('artifact storage cap can be injected from the lower-only configuration', () => {
  const limits = loadServerLimits({ EAG_ARTIFACT_STORE_BYTES: '3' });
  const registry = new ArtifactRegistry('C:\\artifacts', limits.artifactStoreBytes);
  registry.register(metadata(3));
  assert.throws(() => registry.register(metadata(1)), /Artifact storage limit exceeded/);
  assert.throws(() => loadServerLimits({ EAG_ARTIFACT_STORE_BYTES: '2147483649' }), /may only lower/);
});
