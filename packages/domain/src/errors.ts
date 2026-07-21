export const STABLE_ERROR_CODES = [
  'MATCH',
  'VALUE_MISMATCH',
  'LOCATOR_MISSING',
  'CAPABILITY_UNSUPPORTED',
  'PROBE_UNSUPPORTED',
  'POLICY_REJECTED',
  'LIMIT_EXCEEDED',
  'IPC_PROTOCOL_ERROR',
  'WORKER_TIMEOUT',
  'CANCELLED',
  'SCORE_OVERFLOW',
  'SCORE_INVARIANT_ERROR',
  'DRAFT_CANDIDATE_CAP_REACHED',
  'ACCESS_QUERY_ORDER_REQUIRED',
] as const;

export type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

const STABLE_ERROR_CODE_SET = new Set<string>(STABLE_ERROR_CODES);

export function isStableErrorCode(value: unknown): value is StableErrorCode {
  return typeof value === 'string' && STABLE_ERROR_CODE_SET.has(value);
}

export class DomainError extends Error {
  readonly code: StableErrorCode;

  constructor(code: StableErrorCode, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function fail(code: StableErrorCode, message?: string): never {
  throw new DomainError(code, message);
}
