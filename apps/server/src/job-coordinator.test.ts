import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerLimits } from './config.ts';
import { JobCoordinator, JobQueueFullError } from './job-coordinator.ts';

test('runs one worker at a time and admits only ten waiting jobs', async () => {
  const coordinator = new JobCoordinator();
  let release!: () => void; let active = 0; let maximum = 0;
  const first = coordinator.enqueue(async () => new Promise<void>((resolve) => { active += 1; maximum = Math.max(maximum, active); release = () => { active -= 1; resolve(); }; }));
  const rest = Array.from({ length: 10 }, () => coordinator.enqueue(async () => { active += 1; maximum = Math.max(maximum, active); active -= 1; }));
  await assert.rejects(coordinator.enqueue(async () => undefined), JobQueueFullError);
  release();
  await Promise.all([first, ...rest]);
  assert.equal(maximum, 1);
  assert.equal(coordinator.active, 0);
  assert.equal(coordinator.queued, 0);
});
test('accepts zero queue capacity without admitting waiting work', async () => {
  const coordinator = new JobCoordinator({ queue: 0 });
  let release!: () => void;
  const first = coordinator.enqueue(async () => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  await assert.rejects(coordinator.enqueue(async () => undefined), JobQueueFullError);
  release();
  await first;
});

test('enforces a lowered queue capacity exactly', async () => {
  const coordinator = new JobCoordinator({ queue: 2 });
  let release!: () => void;
  const first = coordinator.enqueue(async () => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  const waiting = [coordinator.enqueue(async () => undefined), coordinator.enqueue(async () => undefined)];
  await assert.rejects(coordinator.enqueue(async () => undefined), JobQueueFullError);
  release();
  await Promise.all([first, ...waiting]);
});

test('parses zero, lowered, and default queue capacities while rejecting raised and unsafe values', () => {
  assert.equal(loadServerLimits({ EAG_WORKER_QUEUE: '0' }).workerQueue, 0);
  assert.equal(loadServerLimits({ EAG_WORKER_QUEUE: '2' }).workerQueue, 2);
  assert.equal(loadServerLimits({}).workerQueue, 10);
  assert.throws(() => loadServerLimits({ EAG_WORKER_QUEUE: '11' }));
  assert.throws(() => loadServerLimits({ EAG_WORKER_QUEUE: '9007199254740992' }));
});

test('rejects concurrency other than one and queue capacity above the parsed limit', () => {
  assert.throws(() => new JobCoordinator({ concurrency: 2 }));
  assert.throws(() => new JobCoordinator({ queue: 11 }));
});
