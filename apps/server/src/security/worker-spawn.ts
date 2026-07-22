import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  IPC_PROTOCOL_VERSION,
  IpcProtocolError,
  IpcProtocolSession,
  parseJsonlFrame,
  validateIpcResponse,
  validateIpcRequest,
  type IpcRequestWire,
  type IpcResponseWire,
} from '../../../../packages/domain/src/ipc.ts';
import { WORKER_LIMITS, type WorkerLimits } from './limits.ts';

export type WorkerProcess = Readonly<{
  writeStdin(data: string): void;
  closeStdin(): void;
  /** Sends the worker's cooperative cancellation token when supported by the launcher. */
  cancel?(cancelToken: string): void;
  kill(): void;
  onStdout(listener: (chunk: Uint8Array) => void): void;
  onStdoutEof(listener: () => void): void;
  onStderr(listener: (chunk: Uint8Array) => void): void;
  onStderrEof(listener: () => void): void;
  onExit(listener: (code: number | null) => void): void;
}>;

/** Injectable boundary; production supplies the native process implementation. */
export type WorkerProcessAdapter = Readonly<{
  launch(command: string, args: readonly string[], options: Readonly<{ cwd: string }>): WorkerProcess;
}>;

export type WorkerSpawnConfig = Readonly<{
  jobLauncherPath: string;
  inspectorPath: string;
}>;

export type WorkerRequest = Omit<IpcRequestWire, 'protocolVersion' | 'requestId' | 'cancelToken'> & Partial<Pick<IpcRequestWire, 'requestId' | 'cancelToken'>>;

export class WorkerExecutionError extends Error {
  readonly code: 'IPC_PROTOCOL_ERROR' | 'WORKER_EXECUTION_ERROR' | 'WORKER_TIMEOUT' | 'CANCELLED';

  constructor(code: 'IPC_PROTOCOL_ERROR' | 'WORKER_EXECUTION_ERROR' | 'WORKER_TIMEOUT' | 'CANCELLED', message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkerExecutionError';
  }
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}
function absoluteFile(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute bundled path`);
  return path.resolve(value);
}


/** Launches only the bundled Job Object helper and bundled Java inspector. */
export class WorkerSpawner {
  readonly #launcher: string;
  readonly #inspector: string;
  readonly #adapter: WorkerProcessAdapter;
  readonly #limits: WorkerLimits;

  constructor(config: WorkerSpawnConfig, adapter: WorkerProcessAdapter, limits: WorkerLimits = WORKER_LIMITS) {
    this.#launcher = absoluteFile(config.jobLauncherPath, 'jobLauncherPath');
    this.#inspector = absoluteFile(config.inspectorPath, 'inspectorPath');
    this.#adapter = adapter;
    this.#limits = limits;
  }

  run(cwd: string, request: WorkerRequest, signal?: AbortSignal): Promise<IpcResponseWire> {
    if (!path.isAbsolute(cwd)) return Promise.reject(new Error('Worker cwd must be private and absolute'));
    const requestId = request.requestId ?? randomUUID();
    const cancelToken = request.cancelToken ?? randomUUID();
    const wire: IpcRequestWire = {
      ...request,
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId,
      cancelToken,
    };
    const requestLine = JSON.stringify(wire);
    if (byteLength(requestLine) > this.#limits.frameBytes || byteLength(requestLine) + 1 > this.#limits.totalBytes) {
      return Promise.reject(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker request exceeds protocol limits'));
    }
    if (!Number.isSafeInteger(wire.deadlineEpochMs) || wire.deadlineEpochMs <= Date.now()) {
      return Promise.reject(new WorkerExecutionError('WORKER_TIMEOUT', 'Worker deadline has elapsed'));
    }

    try {
      validateIpcRequest(wire);
    } catch (error) {
      return Promise.reject(new WorkerExecutionError('IPC_PROTOCOL_ERROR', error instanceof Error ? error.message : 'Invalid worker request'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let evidenceBytes = 0;
      let responseSeen = false;
      let response: IpcResponseWire | undefined;
      let exitCode: number | null | undefined;
      let stdoutEnded = false;
      let stderrEnded = false;
      const stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
      const stderrDecoder = new TextDecoder('utf-8', { fatal: true });
      const session = new IpcProtocolSession();
      try {
        session.acceptRequestFrame(requestLine);
      } catch (error) {
        reject(new WorkerExecutionError('IPC_PROTOCOL_ERROR', error instanceof Error ? error.message : 'Invalid worker request'));
        return;
      }
      const fail = (error: WorkerExecutionError, cooperative = false) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (cooperative && process.cancel !== undefined) {
          try {
            process.cancel(wire.cancelToken);
          } catch {
            process.kill();
          }
          setTimeout(() => process.kill(), this.#limits.cancelGraceMs);
        } else {
          process.kill();
        }
        reject(error);
      };
      const succeed = () => {
        if (settled || response === undefined) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(response);
      };
      const completeWhenDrained = () => {
        if (settled || exitCode === undefined || !stdoutEnded || !stderrEnded) return;
        if (exitCode !== 0) {
          fail(new WorkerExecutionError('WORKER_EXECUTION_ERROR', 'Worker exited unexpectedly'));
        } else if (stdout.length !== 0) {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker stdout ended with an unterminated JSONL frame'));
        } else if (response === undefined) {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker exited without response'));
        } else {
          succeed();
        }
      };
      let process: WorkerProcess;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        process = this.#adapter.launch(this.#launcher, Object.freeze([
          '--timeout-ms', String(Math.max(1, wire.deadlineEpochMs - Date.now())), '--', this.#inspector,
        ]), Object.freeze({ cwd: path.resolve(cwd) }));
      } catch (error) {
        reject(new WorkerExecutionError('WORKER_EXECUTION_ERROR', error instanceof Error ? error.message : 'Unable to launch worker'));
        return;
      }
      timer = setTimeout(() => fail(new WorkerExecutionError('WORKER_TIMEOUT', 'Worker deadline exceeded'), true), Math.max(1, wire.deadlineEpochMs - Date.now()));
      const cancel = () => fail(new WorkerExecutionError('CANCELLED', 'Worker cancelled'), true);
      if (signal?.aborted) return cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      process.onStderr((chunk) => {
        if (settled) return;
        try {
          stderrBytes += chunk.byteLength;
          stderrDecoder.decode(chunk, { stream: true });
          if (stderrBytes > this.#limits.stderrBytes) fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker stderr exceeds limit'));
        } catch {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker stderr is not valid UTF-8'));
        }
      });
      process.onStdout((chunk) => {
        if (settled) return;
        try {
          stdout += stdoutDecoder.decode(chunk, { stream: true });
          stdoutBytes += chunk.byteLength;
          if (byteLength(requestLine) + 1 + stdoutBytes > this.#limits.totalBytes) throw new IpcProtocolError('Worker request/response total exceeds limit');
          let newline: number;
          while ((newline = stdout.indexOf('\n')) >= 0) {
            const frame = stdout.slice(0, newline);
            stdout = stdout.slice(newline + 1);
            const frameBytes = byteLength(frame);
            if (frameBytes > this.#limits.frameBytes) throw new IpcProtocolError('JSONL frame exceeds configured limit');
            const responseFrame = validateIpcResponse(parseJsonlFrame(frame));
            session.acceptResponseFrame(frame);
            if (responseFrame.requestId !== requestId || responseSeen) throw new IpcProtocolError('Unexpected or duplicate worker response');
            const frameEvidenceBytes = responseFrame.evidence === undefined ? 0 : byteLength(JSON.stringify(responseFrame.evidence));
            evidenceBytes += frameEvidenceBytes;
            if (evidenceBytes > Math.min(this.#limits.evidenceBytes, wire.budget.maxEvidenceBytes)) throw new IpcProtocolError('Worker evidence exceeds limit');
            responseSeen = true;
            if (responseFrame.status === 'cancelled') return fail(new WorkerExecutionError('CANCELLED', 'Worker cancelled'), true);
            response = responseFrame;
          }
          if (byteLength(stdout) > this.#limits.frameBytes) throw new IpcProtocolError('JSONL frame exceeds configured limit');
        } catch (error) {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', error instanceof Error ? error.message : 'Invalid worker response'));
        }
      });
      process.onStdoutEof(() => {
        if (settled) return;
        try {
          stdout += stdoutDecoder.decode();
          if (stdout.length > this.#limits.frameBytes) throw new IpcProtocolError('JSONL frame exceeds configured limit');
          stdoutEnded = true;
          completeWhenDrained();
        } catch {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker stdout is not valid UTF-8'));
        }
      });
      process.onStderrEof(() => {
        if (settled) return;
        try {
          stderrDecoder.decode();
          stderrEnded = true;
          completeWhenDrained();
        } catch {
          fail(new WorkerExecutionError('IPC_PROTOCOL_ERROR', 'Worker stderr is not valid UTF-8'));
        }
      });
      process.onExit((code) => {
        if (settled) return;
        exitCode = code;
        completeWhenDrained();
      });
      try {
        process.writeStdin(`${requestLine}\n`);
        process.closeStdin();
      } catch (error) {
        fail(new WorkerExecutionError('WORKER_EXECUTION_ERROR', error instanceof Error ? error.message : 'Unable to send worker request'));
      }
    });
  }
}

export const WORKER_PROTOCOL_LIMITS = Object.freeze({
  frameBytes: WORKER_LIMITS.frameBytes,
  totalBytes: WORKER_LIMITS.totalBytes,
  evidenceBytes: WORKER_LIMITS.evidenceBytes,
  stderrBytes: WORKER_LIMITS.stderrBytes,
  cancelGraceMs: WORKER_LIMITS.cancelGraceMs,
});
