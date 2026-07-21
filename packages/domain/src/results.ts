import { DomainError } from './errors.ts';
import { assertScorePoints, checkedAddScorePoints, percentHalfUp, type ScorePoints } from './scoring.ts';

export type ExecutionScope = 'full' | 'selected';
export type Adjudication = 'final' | 'incomplete' | 'empty';
export type CheckStatus = 'pass' | 'fail' | 'unsupported' | 'error' | 'skipped';
export type ProblemStatus = 'final' | 'incomplete' | 'empty' | 'out-of-scope';

export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_PREVIEW_BYTES = 64 * 1024;

export type RedactedEvidence = {
  digest: string;
  preview?: unknown;
  byteLength: number;
  redacted: boolean;
  truncated: boolean;
};

export type CheckResultWire = {
  checkId: string;
  problemId: string;
  status: CheckStatus;
  declaredPoints: ScorePoints;
  awardedPoints: ScorePoints | null;
  capabilityId: string;
  locator: Record<string, unknown>;
  location: string;
  reasonCode: string;
  diagnosticCode?: string;
  expected?: RedactedEvidence;
  observed?: RedactedEvidence;
};

export type ProblemResultWire = {
  problemId: string;
  title: string;
  declaredPoints: ScorePoints;
  awardedPoints: ScorePoints | null;
  status: ProblemStatus;
  checks: CheckResultWire[];
};

export type GradeSummaryWire = {
  declaredMax: ScorePoints;
  selectedDeclaredMax: ScorePoints;
  outOfScopePoints: ScorePoints;
  verifiedEarned: ScorePoints;
  failedPoints: ScorePoints;
  indeterminatePoints: ScorePoints;
  finalScorePoints: ScorePoints | null;
  finalPercent: number | null;
  executionScope: ExecutionScope;
  adjudication: Adjudication;
  representsWholeRuleSet: boolean;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new DomainError('SCORE_INVARIANT_ERROR', message);
  }
}

export function assertRedactedEvidence(evidence: unknown): asserts evidence is RedactedEvidence {
  invariant(evidence !== null && typeof evidence === 'object', 'Evidence must be an object.');
  const wire = evidence as RedactedEvidence;
  invariant(typeof wire.digest === 'string' && wire.digest.length > 0, 'Evidence digest is required.');
  assertScorePoints(wire.byteLength);
  invariant(wire.byteLength <= MAX_EVIDENCE_BYTES, 'Evidence exceeds the job payload cap.');
  invariant(typeof wire.redacted === 'boolean' && typeof wire.truncated === 'boolean', 'Evidence flags are invalid.');
  if (wire.preview !== undefined) {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(wire.preview);
    } catch {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Evidence preview must be serializable.');
    }
    invariant(serialized !== undefined, 'Evidence preview must be JSON-serializable.');
    invariant(new TextEncoder().encode(serialized).byteLength <= MAX_EVIDENCE_PREVIEW_BYTES, 'Evidence preview exceeds the per-check cap.');
  }
}

/** Validates the score/scope/adjudication contract before a summary crosses a wire boundary. */
export function assertGradeSummaryWire(summary: unknown): asserts summary is GradeSummaryWire {
  invariant(summary !== null && typeof summary === 'object', 'Grade summary must be an object.');
  const wire = summary as GradeSummaryWire;
  assertScorePoints(wire.declaredMax);
  assertScorePoints(wire.selectedDeclaredMax);
  assertScorePoints(wire.outOfScopePoints);
  assertScorePoints(wire.verifiedEarned);
  assertScorePoints(wire.failedPoints);
  assertScorePoints(wire.indeterminatePoints);
  invariant(wire.executionScope === 'full' || wire.executionScope === 'selected', 'Unknown execution scope.');
  invariant(wire.adjudication === 'final' || wire.adjudication === 'incomplete' || wire.adjudication === 'empty', 'Unknown adjudication.');
  invariant(typeof wire.representsWholeRuleSet === 'boolean', 'Whole-rule-set flag is invalid.');
  invariant(wire.representsWholeRuleSet === (wire.executionScope === 'full'), 'Whole-rule-set flag conflicts with execution scope.');
  invariant(wire.declaredMax === checkedAddScorePoints(wire.selectedDeclaredMax, wire.outOfScopePoints), 'Declared maximum does not match its scope buckets.');

  if (wire.executionScope === 'full') {
    invariant(wire.outOfScopePoints === 0, 'Full scope cannot have out-of-scope points.');
  } else {
    invariant(wire.outOfScopePoints > 0, 'A selected run with every enabled item must normalize to full scope.');
  }

  const adjudicated = checkedAddScorePoints(
    checkedAddScorePoints(wire.verifiedEarned, wire.failedPoints),
    wire.indeterminatePoints,
  );
  if (wire.adjudication === 'empty') {
    invariant(wire.selectedDeclaredMax === 0 && adjudicated === 0, 'Empty adjudication must have no selected points.');
    invariant(wire.finalScorePoints === null && wire.finalPercent === null, 'Empty adjudication has no final score.');
    return;
  }

  invariant(wire.selectedDeclaredMax > 0, 'Non-empty adjudication requires selected points.');
  invariant(wire.selectedDeclaredMax === adjudicated, 'Selected maximum does not match adjudication buckets.');
  if (wire.adjudication === 'incomplete') {
    invariant(wire.indeterminatePoints > 0, 'Incomplete adjudication requires indeterminate points.');
    invariant(wire.finalScorePoints === null && wire.finalPercent === null, 'Incomplete adjudication has no final score.');
    return;
  }

  invariant(wire.indeterminatePoints === 0, 'Final adjudication cannot contain indeterminate points.');
  invariant(wire.finalScorePoints === wire.verifiedEarned, 'Final score must equal verified earned points.');
  invariant(wire.finalPercent === percentHalfUp(wire.verifiedEarned, wire.selectedDeclaredMax), 'Final percent is not exact half-up hundredths.');
}
