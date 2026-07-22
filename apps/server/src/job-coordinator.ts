import type { IpcResponseWire } from '../../../packages/domain/src/ipc.ts';
import { WORKER_LIMITS } from './security/limits.ts';

export class JobQueueFullError extends Error {
  readonly code = 'LIMIT_EXCEEDED';
  constructor() {
    super('Worker job queue is full');
    this.name = 'JobQueueFullError';
  }
}

export type JobCoordinatorOptions = Readonly<{ concurrency?: number; queue?: number }>;

type QueuedJob<T> = Readonly<{
  execute: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}>;

/** A deliberately single-worker coordinator: at most one untrusted worker process is active. */
export class JobCoordinator {
  readonly #concurrency: number;
  readonly #queueLimit: number;
  readonly #queue: QueuedJob<unknown>[] = [];
  #active = 0;

  constructor(options: JobCoordinatorOptions = WORKER_LIMITS) {
    this.#concurrency = options.concurrency ?? WORKER_LIMITS.concurrency;
    this.#queueLimit = options.queue ?? WORKER_LIMITS.queue;
    if (this.#concurrency !== 1 || !Number.isSafeInteger(this.#queueLimit) || this.#queueLimit < 0 || this.#queueLimit > WORKER_LIMITS.queue) {
      throw new Error(`Worker coordination is fixed at concurrency 1 and queue capacity 0 through ${WORKER_LIMITS.queue}`);
    }
  }

  enqueue<T>(execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#queue.length >= this.#queueLimit && this.#active >= this.#concurrency) return Promise.reject(new JobQueueFullError());
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = { execute, controller, resolve, reject };
      this.#queue.push(job as QueuedJob<unknown>);
      this.#drain();
    });
  }

  get active(): number { return this.#active; }
  get queued(): number { return this.#queue.length; }

  #drain(): void {
    if (this.#active >= this.#concurrency) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active += 1;
    Promise.resolve().then(() => job.execute(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
      this.#active -= 1;
      this.#drain();
    });
  }
}

export type WorkerJob = Readonly<{ response: IpcResponseWire }>;
