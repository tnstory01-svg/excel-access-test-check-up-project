import { assertCapabilityId, type CapabilityId } from '../../domain/src/capabilities.ts';
import { checkedAddScorePoints, percentHalfUp, type ScorePoints } from '../../domain/src/scoring.ts';
import type { CheckResultWire, GradeSummaryWire, ProblemResultWire } from '../../domain/src/results.ts';
import { evidenceKey, indexCanonicalEvidence, type CanonicalEvidenceSet } from './extract.ts';
import { equivalentCanonicalValue, normalizeValue, redactEvidence } from './normalization.ts';

export type GradeCheck = {
  id: string;
  enabled: boolean;
  points: ScorePoints;
  capabilityId: CapabilityId;
  locator: Record<string, unknown>;
  expected: unknown;
};
export type GradeProblem = { id: string; title: string; maxScore: ScorePoints; checks: readonly GradeCheck[] };
export type GradeRequest = { problems: readonly GradeProblem[]; evidence: CanonicalEvidenceSet; selectedProblemIds?: readonly string[] };
export type GradeResult = { problems: ProblemResultWire[]; summary: GradeSummaryWire };

const REASON = { pass: 'CANONICAL_EVIDENCE_MATCH', fail: 'CANONICAL_EVIDENCE_MISMATCH', unsupported: 'CAPABILITY_UNSUPPORTED', error: 'EXTRACTION_ERROR' } as const;

function add(a: ScorePoints, b: ScorePoints): ScorePoints { return checkedAddScorePoints(a, b); }
function stableLocation(capabilityId: string, locator: Record<string, unknown>): string {
  return `${capabilityId}:${Object.keys(locator).sort().map((key) => `${key}=${JSON.stringify(locator[key])}`).join(',')}`;
}

export function gradeCanonicalEvidence(request: GradeRequest): GradeResult {
  const selected = request.selectedProblemIds === undefined ? undefined : new Set(request.selectedProblemIds);
  const knownIds = new Set(request.problems.map((problem) => problem.id));
  if (selected && ([...selected].some((id) => !knownIds.has(id)) || selected.size !== request.selectedProblemIds!.length)) throw new Error('INVALID_SELECTED_PROBLEMS');
  const evidence = indexCanonicalEvidence(request.evidence);
  let declaredMax: ScorePoints = 0, selectedDeclaredMax: ScorePoints = 0, outOfScopePoints: ScorePoints = 0;
  let verifiedEarned: ScorePoints = 0, failedPoints: ScorePoints = 0, indeterminatePoints: ScorePoints = 0;
  const problems: ProblemResultWire[] = [];

  for (const problem of request.problems) {
    declaredMax = add(declaredMax, problem.maxScore);
    const inScope = selected === undefined || selected.has(problem.id);
    if (inScope) selectedDeclaredMax = add(selectedDeclaredMax, problem.maxScore); else outOfScopePoints = add(outOfScopePoints, problem.maxScore);
    const checks: CheckResultWire[] = [];
    for (const check of problem.checks) {
      assertCapabilityId(check.capabilityId);
      if (!check.enabled) continue;
      const item = inScope ? evidence.get(evidenceKey(check.capabilityId, check.locator)) : undefined;
      const safeLocator = normalizeValue(check.locator) as Record<string, unknown>;
      const location = stableLocation(check.capabilityId, safeLocator);
      if (!inScope) continue;
      if (!item || item.status === 'error' || item.status === 'unsupported') {
        const status = item?.status === 'unsupported' ? 'unsupported' : 'error';
        indeterminatePoints = add(indeterminatePoints, check.points);
        checks.push({ checkId: check.id, problemId: problem.id, status, declaredPoints: check.points, awardedPoints: null, capabilityId: check.capabilityId, locator: safeLocator, location, reasonCode: item?.reasonCode ?? REASON[status], diagnosticCode: item?.diagnosticCode, expected: redactEvidence(check.expected), observed: item?.value === undefined ? undefined : redactEvidence(item.value) });
        continue;
      }
      const passed = equivalentCanonicalValue(check.expected, item.value);
      if (passed) verifiedEarned = add(verifiedEarned, check.points); else failedPoints = add(failedPoints, check.points);
      checks.push({ checkId: check.id, problemId: problem.id, status: passed ? 'pass' : 'fail', declaredPoints: check.points, awardedPoints: passed ? check.points : 0, capabilityId: check.capabilityId, locator: safeLocator, location, reasonCode: passed ? REASON.pass : REASON.fail, expected: redactEvidence(check.expected), observed: redactEvidence(item.value) });
    }
    const enabledPoints = problem.checks.filter((check) => check.enabled).reduce((total, check) => add(total, check.points), 0 as ScorePoints);
    if (enabledPoints !== problem.maxScore) throw new Error('INVALID_PROBLEM_ALLOCATION');
    const status = !inScope ? 'out-of-scope' : checks.length === 0 ? 'empty' : checks.some((check) => check.status === 'unsupported' || check.status === 'error') ? 'incomplete' : 'final';
    const awardedPoints = status === 'final' ? checks.reduce((total, check) => add(total, check.awardedPoints ?? 0), 0 as ScorePoints) : null;
    problems.push({ problemId: problem.id, title: problem.title, declaredPoints: problem.maxScore, awardedPoints, status, checks });
  }
  const executionScope = selected === undefined || outOfScopePoints === 0 ? 'full' : 'selected';
  const adjudication = selectedDeclaredMax === 0 ? 'empty' : indeterminatePoints > 0 ? 'incomplete' : 'final';
  const finalScorePoints = adjudication === 'final' ? verifiedEarned : null;
  return { problems, summary: { declaredMax, selectedDeclaredMax, outOfScopePoints, verifiedEarned, failedPoints, indeterminatePoints, finalScorePoints, finalPercent: finalScorePoints === null ? null : percentHalfUp(finalScorePoints, selectedDeclaredMax), executionScope, adjudication, representsWholeRuleSet: executionScope === 'full' } };
}
