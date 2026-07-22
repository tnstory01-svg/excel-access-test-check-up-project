import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ArtifactRegistry, workerArtifactHandle } from '../artifact-registry.ts';
import { loadServerLimits } from '../config.ts';
import { materializePrivateJobInput } from './job-workspace.ts';

function metadata(id: string, bytes: Buffer) {
  return { id, sha256: createHash('sha256').update(bytes).digest('hex'), family: 'excel' as const, detectedFormat: 'xlsx' as const, size: bytes.length, createdAt: '2026-01-01T00:00:00.000Z' };
}

test('registry materializes fixed private input.bin and deterministically cleans it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eag-workspace-'));
  const artifacts = path.join(root, 'LocalAppData', 'uploads'); const tmp = path.join(root, 'LocalAppData', 'tmp');
  const bytes = Buffer.from('immutable artifact bytes'); const id = randomUUID();
  await writeFile(path.join(root, 'placeholder'), '');
  await (await import('node:fs/promises')).mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, id), bytes);
  const registry = new ArtifactRegistry(artifacts); const handle = registry.register(metadata(id, bytes));
  const plan = await registry.materializePrivateInput(handle, tmp);
  assert.match(path.basename(plan.jobDirectory), /^job-[0-9a-f-]{36}$/i);
  assert.equal(path.basename(plan.inputPath), 'input.bin');
  assert.deepEqual(await readFile(plan.inputPath), bytes);
  assert.equal(workerArtifactHandle(plan), id);
  assert.equal('inputPath' in registry.metadata(handle), false);
  await registry.cleanupPrivateInput(plan, tmp);
  await assert.rejects(stat(plan.jobDirectory));
});

test('workspace refuses cleanup escapes and reparse tmp roots', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eag-workspace-escape-'));
  const artifacts = path.join(root, 'uploads'); const tmp = path.join(root, 'tmp'); const bytes = Buffer.from('bytes'); const id = randomUUID();
  await (await import('node:fs/promises')).mkdir(artifacts, { recursive: true }); await writeFile(path.join(artifacts, id), bytes);
  const registry = new ArtifactRegistry(artifacts); const handle = registry.register(metadata(id, bytes)); const plan = await registry.materializePrivateInput(handle, tmp);
  await assert.rejects(registry.cleanupPrivateInput({ ...plan, jobDirectory: root }, tmp), /outside/);
  const link = path.join(root, 'tmp-link');
  try { await symlink(tmp, link, 'junction'); } catch { t.skip('Junction creation is unavailable on this Windows host'); return; }
  await assert.rejects(registry.materializePrivateInput(handle, link), /reparse|canonical/i);
  await registry.cleanupPrivateInput(plan, tmp);
});

test('limits are immutable, lower-only, and reject raised or unsafe overrides', () => {
  const limits = loadServerLimits({ EAG_UPLOAD_BYTES: '1024', EAG_WORKER_QUEUE: '1' });
  assert.equal(limits.uploadBytes, 1024);
  assert.equal(limits.workerQueue, 1);
  assert.equal(Object.isFrozen(limits), true);
  assert.throws(() => loadServerLimits({ EAG_UPLOAD_BYTES: String(128 * 1024 * 1024 + 1) }), /only lower/);
  assert.throws(() => loadServerLimits({ EAG_SCRATCH_BYTES: '9007199254740992' }), /only lower/);
});

test('workspace accounts existing scratch files and rejects copies above its scratch cap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eag-workspace-limit-'));
  const artifacts = path.join(root, 'uploads'); const tmp = path.join(root, 'tmp');
  const bytes = Buffer.from('1234'); const id = randomUUID();
  await (await import('node:fs/promises')).mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, id), bytes);
  await assert.rejects(materializePrivateJobInput({
    artifactPath: path.join(artifacts, id),
    artifactSize: bytes.length,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
    tmpRoot: tmp,
    scratchBytes: 3,
  }), /Scratch storage limit exceeded/);
  await (await import('node:fs/promises')).mkdir(tmp, { recursive: true });
  await writeFile(path.join(tmp, 'accounted.bin'), '123');
  await assert.rejects(materializePrivateJobInput({
    artifactPath: path.join(artifacts, id),
    artifactSize: bytes.length,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
    tmpRoot: tmp,
    scratchBytes: 6,
  }), /Scratch storage limit exceeded/);
});
