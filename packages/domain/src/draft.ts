import { DomainError } from './errors.ts';
import { assertScorePoints, checkedAddScorePoints, type ScorePoints } from './scoring.ts';

export type DraftState = 'pending-user-allocation';

export type DraftCheck = {
  id: string;
  enabled: boolean;
  points: ScorePoints;
  draftState: DraftState;
};

export type DraftProblem = {
  id: string;
  maxScore: ScorePoints;
  checks: readonly DraftCheck[];
};

export type DraftCheckCandidate = Omit<DraftCheck, 'enabled' | 'points' | 'draftState'>;

/** Every extractor candidate begins inert; only explicit user allocation can enable it. */
export function createDraftCheck(candidate: DraftCheckCandidate): DraftCheck {
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft checks require a non-empty id.');
  }
  return {
    id: candidate.id,
    enabled: false,
    points: 0,
    draftState: 'pending-user-allocation',
  };
}

/** Computes the enabled allocation with checked addition and rejects malformed draft state. */
export function enabledPoints(checks: readonly DraftCheck[]): ScorePoints {
  let total: ScorePoints = 0;
  for (const check of checks) {
    if (
      typeof check.id !== 'string' ||
      check.id.length === 0 ||
      typeof check.enabled !== 'boolean' ||
      check.draftState !== 'pending-user-allocation'
    ) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft check is malformed.');
    }
    assertScorePoints(check.points);
    if (!check.enabled && check.points !== 0) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Disabled draft checks must have zero points.');
    }
    if (check.enabled) {
      total = checkedAddScorePoints(total, check.points);
    }
  }
  return total;
}

/** Rule saves require exact per-problem allocation and an enabled problem. */
export function assertDraftAllocation(problems: readonly DraftProblem[]): void {
  let enabledProblemCount = 0;
  for (const problem of problems) {
    if (typeof problem.id !== 'string' || problem.id.length === 0) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft problems require a non-empty id.');
    }
    assertScorePoints(problem.maxScore);
    const allocated = enabledPoints(problem.checks);
    if (allocated !== problem.maxScore) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Enabled check points must equal the problem maximum.');
    }
    if (problem.checks.some((check) => check.enabled)) {
      enabledProblemCount += 1;
    }
  }
  if (enabledProblemCount === 0) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Whole-run grading requires at least one enabled problem.');
  }
}
