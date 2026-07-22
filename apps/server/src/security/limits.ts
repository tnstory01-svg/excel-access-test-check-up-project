import { SERVER_LIMITS } from '../config.ts';

export type WorkerLimits = Readonly<{
  concurrency: number;
  queue: number;
  frameBytes: number;
  totalBytes: number;
  evidenceBytes: number;
  stderrBytes: number;
  cancelGraceMs: number;
}>;

export const WORKER_LIMITS: WorkerLimits = Object.freeze({
  concurrency: SERVER_LIMITS.workerConcurrency,
  queue: SERVER_LIMITS.workerQueue,
  frameBytes: SERVER_LIMITS.workerFrameBytes,
  totalBytes: SERVER_LIMITS.workerTotalBytes,
  evidenceBytes: SERVER_LIMITS.workerEvidenceBytes,
  stderrBytes: SERVER_LIMITS.workerStderrBytes,
  cancelGraceMs: SERVER_LIMITS.workerCancelGraceMs,
});

