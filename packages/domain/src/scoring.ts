import { DomainError, type StableErrorCode } from './errors.ts';

/** A non-negative integer representable exactly by JavaScript Number. */
export type ScorePoints = number;

export type ScoreResult =
  | { readonly ok: true; readonly value: ScorePoints }
  | { readonly ok: false; readonly code: StableErrorCode };

export function isScorePoints(value: unknown): value is ScorePoints {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function assertScorePoints(value: unknown): asserts value is ScorePoints {
  if (!isScorePoints(value)) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Score points must be a non-negative safe integer.');
  }
}

/** Adds score points without ever returning an imprecise or negative total. */
export function addScorePoints(left: ScorePoints, right: ScorePoints): ScoreResult {
  if (!isScorePoints(left) || !isScorePoints(right)) {
    return { ok: false, code: 'SCORE_INVARIANT_ERROR' };
  }
  if (left > Number.MAX_SAFE_INTEGER - right) {
    return { ok: false, code: 'SCORE_OVERFLOW' };
  }
  return { ok: true, value: left + right };
}

export function checkedAddScorePoints(left: ScorePoints, right: ScorePoints): ScorePoints {
  const result = addScorePoints(left, right);
  if (!result.ok) {
    throw new DomainError(result.code);
  }
  return result.value;
}

/**
 * Returns an exact percentage rounded half-up to hundredths, or null for a
 * zero denominator. Invalid score relationships fail closed.
 */
export function percentHalfUp(earned: ScorePoints, denominator: ScorePoints): number | null {
  assertScorePoints(earned);
  assertScorePoints(denominator);
  if (denominator === 0) {
    return null;
  }
  if (earned > denominator) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Earned points cannot exceed the denominator.');
  }

  const numerator = BigInt(earned) * 10000n + BigInt(denominator) / 2n;
  const hundredths = numerator / BigInt(denominator);
  if (hundredths < 0n || hundredths > 10000n) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Percentage is outside the inclusive range 0 to 100.');
  }
  return Number(hundredths) / 100;
}
