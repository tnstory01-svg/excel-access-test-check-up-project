import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerExecutionError, WorkerSpawner, type WorkerProcess, type WorkerProcessAdapter } from './worker-spawn.ts';
import { WORKER_LIMITS } from './limits.ts';

const encoder = new TextEncoder();

class FakeProcess implements WorkerProcess {
  stdout?: (chunk: Uint8Array) => void;
  stdoutEof?: () => void;
  stderr?: (chunk: Uint8Array) => void;
  stderrEof?: () => void;
  exit?: (code: number | null) => void;
  killed = false;
  stdin = '';
  writeStdin(data: string): void { this.stdin += data; }
  closeStdin(): void {}
  kill(): void { this.killed = true; }
  onStdout(listener: (chunk: Uint8Array) => void): void { this.stdout = listener; }
  onStdoutEof(listener: () => void): void { this.stdoutEof = listener; }
  onStderr(listener: (chunk: Uint8Array) => void): void { this.stderr = listener; }
  onStderrEof(listener: () => void): void { this.stderrEof = listener; }
  onExit(listener: (code: number | null) => void): void { this.exit = listener; }
  writeStdout(value: string | Uint8Array): void { this.stdout?.(typeof value === 'string' ? encoder.encode(value) : value); }
  writeStderr(value: string | Uint8Array): void { this.stderr?.(typeof value === 'string' ? encoder.encode(value) : value); }
  drain(): void { this.stdoutEof?.(); this.stderrEof?.(); }
}

function setup(limits = WORKER_LIMITS) {
  const child = new FakeProcess();
  let command = ''; let args: readonly string[] = []; let cwd = '';
  const adapter: WorkerProcessAdapter = { launch(c, a, o) { command = c; args = a; cwd = o.cwd; return child; } };
  return {
    child,
    spawned: new WorkerSpawner(
      { jobLauncherPath: 'C:\\bundle\\win-job-launcher.exe', inspectorPath: 'C:\\bundle\\office-inspector.exe' },
      adapter,
      limits,
    ),
    seen: () => ({ command, args, cwd }),
  };
}

function request(budget = { maxEvidenceBytes: 64, maxChecks: 1, maxRows: 1 }) {
  return {
    operation: 'extract' as const,
    artifactHandle: 'opaque-only',
    capabilityIds: [],
    deadlineEpochMs: Date.now() + 500,
    budget,
  };
}

function response(child: FakeProcess, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ protocolVersion: 1, requestId: JSON.parse(child.stdin).requestId, status: 'ok', ...extra })}\n`;
}

test('launches only bundled launcher with opaque JSONL request and private cwd', async () => {
  const { child, spawned, seen } = setup();
  const pending = spawned.run('C:\\private\\job-x', request());
  const wire = JSON.parse(child.stdin);
  child.writeStdout(response(child));
  child.exit?.(0);
  child.drain();
  await pending;
  assert.equal(seen().command, 'C:\\bundle\\win-job-launcher.exe');
  assert.deepEqual(seen().args.slice(0, 4), ['--timeout-ms', seen().args[1], '--', 'C:\\bundle\\office-inspector.exe']);
  assert.equal(seen().cwd, 'C:\\private\\job-x');
  assert.equal(wire.artifactHandle, 'opaque-only');
  assert.equal(JSON.stringify(seen().args).includes('opaque-only'), false);
});

test('requires process exit and both output EOF notifications before resolving', async () => {
  const { child, spawned } = setup();
  let settled = false;
  const pending = spawned.run('C:\\private\\job-x', request()).then(() => { settled = true; });
  child.writeStdout(response(child));
  child.exit?.(0);
  await Promise.resolve();
  assert.equal(settled, false);
  child.stdoutEof?.();
  await Promise.resolve();
  assert.equal(settled, false);
  child.stderrEof?.();
  await pending;
  assert.equal(settled, true);
});

test('kills and fails closed on malformed or duplicate frames', async () => {
  const malformed = setup();
  const malformedPending = malformed.spawned.run('C:\\private\\job-x', request());
  malformed.child.writeStdout('{not json}\n');
  await assert.rejects(malformedPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');
  assert.equal(malformed.child.killed, true);

  const duplicate = setup();
  const duplicatePending = duplicate.spawned.run('C:\\private\\job-x', request());
  const frame = response(duplicate.child);
  duplicate.child.writeStdout(`${frame}${frame}`);
  await assert.rejects(duplicatePending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');
  assert.equal(duplicate.child.killed, true);
});

test('cancellation kills the worker', async () => {
  const { child, spawned } = setup();
  const controller = new AbortController();
  const pending = spawned.run('C:\\private\\job-x', request(), controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'CANCELLED');
  assert.equal(child.killed, true);
});
test('classifies launch, write, and non-zero exit failures as execution errors', async () => {
  const launchAdapter: WorkerProcessAdapter = { launch() { throw new Error('launch failed'); } };
  const launch = new WorkerSpawner({ jobLauncherPath: 'C:\\bundle\\win-job-launcher.exe', inspectorPath: 'C:\\bundle\\office-inspector.exe' }, launchAdapter);
  await assert.rejects(launch.run('C:\\private\\job-x', request()), (error: unknown) => error instanceof WorkerExecutionError && error.code === 'WORKER_EXECUTION_ERROR');

  const write = setup();
  write.child.writeStdin = () => { throw new Error('write failed'); };
  await assert.rejects(write.spawned.run('C:\\private\\job-x', request()), (error: unknown) => error instanceof WorkerExecutionError && error.code === 'WORKER_EXECUTION_ERROR');

  const exited = setup();
  const exitedPending = exited.spawned.run('C:\\private\\job-x', request());
  exited.child.exit?.(1);
  exited.child.drain();
  await assert.rejects(exitedPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'WORKER_EXECUTION_ERROR');
});

test('uses injected lowered frame, total, evidence, stderr, and request evidence budgets', async () => {
  const frame = setup({ ...WORKER_LIMITS, frameBytes: 256 });
  const framePending = frame.spawned.run('C:\\private\\job-x', request());
  frame.child.writeStdout(`${'x'.repeat(257)}\n`);
  await assert.rejects(framePending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');

  const total = setup({ ...WORKER_LIMITS, totalBytes: 300, evidenceBytes: 10_000 });
  const totalPending = total.spawned.run('C:\\private\\job-x', request());
  total.child.writeStdout(response(total.child, { evidence: 'x'.repeat(200) }));
  await assert.rejects(totalPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');

  const evidence = setup({ ...WORKER_LIMITS, evidenceBytes: 256 });
  const evidencePending = evidence.spawned.run('C:\\private\\job-x', request({ maxEvidenceBytes: 8, maxChecks: 1, maxRows: 1 }));
  evidence.child.writeStdout(response(evidence.child, { evidence: 'x'.repeat(16) }));
  await assert.rejects(evidencePending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');

  const stderr = setup({ ...WORKER_LIMITS, stderrBytes: 8 });
  const stderrPending = stderr.spawned.run('C:\\private\\job-x', request());
  stderr.child.writeStderr('x'.repeat(9));
  await assert.rejects(stderrPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');
});

test('uses fatal UTF-8 decoding for byte chunks', async () => {
  const stdout = setup();
  const stdoutPending = stdout.spawned.run('C:\\private\\job-x', request());
  stdout.child.writeStdout(new Uint8Array([0xc3]));
  stdout.child.exit?.(0);
  stdout.child.drain();
  await assert.rejects(stdoutPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');

  const stderr = setup();
  const stderrPending = stderr.spawned.run('C:\\private\\job-x', request());
  stderr.child.writeStderr(new Uint8Array([0xc3]));
  stderr.child.stderrEof?.();
  await assert.rejects(stderrPending, (error: unknown) => error instanceof WorkerExecutionError && error.code === 'IPC_PROTOCOL_ERROR');
});
