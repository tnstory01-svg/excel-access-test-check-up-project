import { type CapabilityId, isCapabilityId } from "./capabilities.ts";

export const IPC_PROTOCOL_VERSION = 1 as const;
export const IPC_MAX_FRAME_BYTES = 1 * 1024 * 1024;
export const IPC_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const IPC_MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const IPC_MAX_STDERR_BYTES = 256 * 1024;

export type IpcOperation = "extract" | "grade";
export type IpcResponseStatus = "ok" | "unsupported" | "error" | "cancelled";

export type IpcBudget = Readonly<{
  maxEvidenceBytes: number;
  maxChecks: number;
  maxRows: number;
}>;

export type IpcRequestWire = Readonly<{
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  requestId: string;
  operation: IpcOperation;
  artifactHandle: string;
  capabilityIds: readonly CapabilityId[];
  deadlineEpochMs: number;
  budget: IpcBudget;
  cancelToken: string;
}>;

export type IpcResponseWire = Readonly<{
  protocolVersion: typeof IPC_PROTOCOL_VERSION;
  requestId: string;
  status: IpcResponseStatus;
  result?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  diagnosticCode?: string;
}>;

export class IpcProtocolError extends Error {
  readonly code = "IPC_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "IpcProtocolError";
  }
}

const textEncoder = new TextEncoder();
const requestKeys = ["protocolVersion", "requestId", "operation", "artifactHandle", "capabilityIds", "deadlineEpochMs", "budget", "cancelToken"];
const responseKeys = ["protocolVersion", "requestId", "status", "result", "evidence", "diagnosticCode"];

function fail(message: string): never {
  throw new IpcProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedString(value: unknown, field: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(`${field} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    fail(`${field} must be a positive safe integer no greater than ${maximum}`);
  }
  return value as number;
}

function validateBudget(value: unknown): IpcBudget {
  if (!isRecord(value) || !hasOnlyKeys(value, ["maxEvidenceBytes", "maxChecks", "maxRows"])) {
    fail("budget must contain only maxEvidenceBytes, maxChecks, and maxRows");
  }
  return {
    maxEvidenceBytes: positiveSafeInteger(value.maxEvidenceBytes, "budget.maxEvidenceBytes", IPC_MAX_EVIDENCE_BYTES),
    maxChecks: positiveSafeInteger(value.maxChecks, "budget.maxChecks", 1_000_000),
    maxRows: positiveSafeInteger(value.maxRows, "budget.maxRows", 1_000_000),
  };
}

function validateVersion(value: unknown): typeof IPC_PROTOCOL_VERSION {
  if (value !== IPC_PROTOCOL_VERSION) fail(`Unsupported protocol version: ${String(value)}`);
  return IPC_PROTOCOL_VERSION;
}

export function validateIpcRequest(value: unknown): IpcRequestWire {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) fail("Request must be an object with only protocol fields");
  if (!Array.isArray(value.capabilityIds) || value.capabilityIds.length > 256 || !value.capabilityIds.every(isCapabilityId)) {
    fail("capabilityIds must contain at most 256 canonical capability IDs");
  }
  if (new Set(value.capabilityIds).size !== value.capabilityIds.length) fail("capabilityIds must not contain duplicates");
  if (value.operation !== "extract" && value.operation !== "grade") fail("Unsupported operation");
  return {
    protocolVersion: validateVersion(value.protocolVersion),
    requestId: boundedString(value.requestId, "requestId", 128),
    operation: value.operation,
    artifactHandle: boundedString(value.artifactHandle, "artifactHandle", 512),
    capabilityIds: Object.freeze([...value.capabilityIds]),
    deadlineEpochMs: positiveSafeInteger(value.deadlineEpochMs, "deadlineEpochMs", Number.MAX_SAFE_INTEGER),
    budget: validateBudget(value.budget),
    cancelToken: boundedString(value.cancelToken, "cancelToken", 512),
  };
}

export function validateIpcResponse(value: unknown): IpcResponseWire {
  if (!isRecord(value) || !hasOnlyKeys(value, responseKeys)) fail("Response must be an object with only protocol fields");
  if (value.status !== "ok" && value.status !== "unsupported" && value.status !== "error" && value.status !== "cancelled") fail("Invalid response status");
  if (value.result !== undefined && !isRecord(value.result)) fail("result must be an object when present");
  if (value.evidence !== undefined && !isRecord(value.evidence)) fail("evidence must be an object when present");
  if (value.evidence !== undefined && textEncoder.encode(JSON.stringify(value.evidence)).byteLength > IPC_MAX_EVIDENCE_BYTES) {
    fail("evidence exceeds 8 MiB");
  }
  if (value.diagnosticCode !== undefined) boundedString(value.diagnosticCode, "diagnosticCode", 128);
  return {
    protocolVersion: validateVersion(value.protocolVersion),
    requestId: boundedString(value.requestId, "requestId", 128),
    status: value.status,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence }),
    ...(value.diagnosticCode === undefined ? {} : { diagnosticCode: value.diagnosticCode }),
  };
}

export function parseJsonlFrame(frame: string): unknown {
  if (textEncoder.encode(frame).byteLength > IPC_MAX_FRAME_BYTES) fail("JSONL frame exceeds 1 MiB");
  if (frame.includes("\n") || frame.includes("\r")) fail("JSONL frame must contain exactly one line");
  try {
    return JSON.parse(frame);
  } catch {
    fail("Malformed JSONL frame");
  }
}

export class IpcProtocolSession {
  #totalBytes = 0;
  #requestIds = new Set<string>();
  #responseIds = new Set<string>();

  private consume(frame: string): void {
    const bytes = textEncoder.encode(frame).byteLength;
    if (bytes > IPC_MAX_FRAME_BYTES) fail("JSONL frame exceeds 1 MiB");
    this.#totalBytes += bytes;
    if (this.#totalBytes > IPC_MAX_TOTAL_BYTES) fail("JSONL request/response total exceeds 16 MiB");
  }

  acceptRequestFrame(frame: string): IpcRequestWire {
    this.consume(frame);
    const request = validateIpcRequest(parseJsonlFrame(frame));
    if (this.#requestIds.has(request.requestId)) fail("Duplicate requestId");
    this.#requestIds.add(request.requestId);
    return request;
  }

  acceptResponseFrame(frame: string): IpcResponseWire {
    this.consume(frame);
    const response = validateIpcResponse(parseJsonlFrame(frame));
    if (!this.#requestIds.has(response.requestId)) fail("Response requestId was not requested");
    if (this.#responseIds.has(response.requestId)) fail("Duplicate response requestId");
    this.#responseIds.add(response.requestId);
    return response;
  }
}
