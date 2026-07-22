import assert from 'node:assert/strict';
import { gradeCanonicalEvidence, type GradeRequest } from './grade.ts';
import { redactEvidence } from './normalization.ts';

const locator = { sheet: 'Scores', cell: 'A1' };
const request = (value: unknown, status: 'ok' | 'unsupported' | 'error' = 'ok'): GradeRequest => ({
  problems: [{ id: 'p1', title: 'One', maxScore: 2, checks: [{ id: 'c1', enabled: true, points: 2, capabilityId: 'excel.cell.value.v1', locator, expected: { value: 7 } }] }],
  evidence: [{ capabilityId: 'excel.cell.value.v1', locator, status, value }],
});
let result = gradeCanonicalEvidence(request({ value: 7 }));
assert.equal(result.problems[0].checks[0].status, 'pass');
assert.equal(result.summary.finalScorePoints, 2);
result = gradeCanonicalEvidence(request({ value: 8 }));
assert.equal(result.problems[0].checks[0].reasonCode, 'CANONICAL_EVIDENCE_MISMATCH');
assert.equal(result.summary.failedPoints, 2);
result = gradeCanonicalEvidence(request(undefined, 'unsupported'));
assert.equal(result.summary.adjudication, 'incomplete');
assert.equal(result.problems[0].checks[0].status, 'unsupported');
result = gradeCanonicalEvidence(request(undefined, 'error'));
assert.equal(result.problems[0].checks[0].status, 'error');
const selected: GradeRequest = { ...request({ value: 7 }), problems: [request({ value: 7 }).problems[0], { id: 'p2', title: 'Two', maxScore: 1, checks: [{ id: 'c2', enabled: true, points: 1, capabilityId: 'excel.cell.value.v1', locator: { cell: 'B1' }, expected: 1 }] }], selectedProblemIds: ['p1'] };
result = gradeCanonicalEvidence(selected);
assert.equal(result.summary.executionScope, 'selected');
assert.equal(result.summary.outOfScopePoints, 1);
const oversized = redactEvidence({ path: 'C:\\secret.xlsx', data: 'x'.repeat(70 * 1024), value: 'y'.repeat(70 * 1024) });
assert.equal(oversized.redacted, true);
assert.equal(oversized.truncated, true);
assert.equal(JSON.stringify(oversized.preview).includes('secret'), false);
const leakedLocator = gradeCanonicalEvidence({ ...request({ value: 7 }), problems: [{ ...request({ value: 7 }).problems[0], checks: [{ ...request({ value: 7 }).problems[0].checks[0], locator: { path: 'C:\\secret.xlsx' } }] }], evidence: [{ capabilityId: 'excel.cell.value.v1', locator: { path: 'C:\\secret.xlsx' }, status: 'ok', value: { value: 7 } }] });
assert.equal(JSON.stringify(leakedLocator.problems[0].checks[0]).includes('secret'), false);
