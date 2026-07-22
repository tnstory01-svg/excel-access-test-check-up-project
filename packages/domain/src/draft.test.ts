import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCESS_TABLE_CANDIDATE_CAP,
  EXCEL_SHEET_CANDIDATE_CAP,
  assertDraftAllocation,
  createDraftCheck,
  emitAccessDraftCandidates,
  emitExcelDraftCandidates,
} from './draft.ts';

test('draft candidates start disabled with no points', () => {
  assert.deepEqual(createDraftCheck({ id: 'candidate' }), {
    id: 'candidate', enabled: false, points: 0, draftState: 'pending-user-allocation',
  });
});

test('Excel candidates have deterministic cell and kind order', () => {
  const emission = emitExcelDraftCandidates([
    { id: 'formula', sheetIndex: 1, sheetName: 'B', row: 0, column: 0, kind: 'formula' },
    { id: 'value', sheetIndex: 1, sheetName: 'B', row: 0, column: 0, kind: 'value' },
    { id: 'first-sheet', sheetIndex: 0, sheetName: 'A', row: 9, column: 4, kind: 'fill' },
  ]);
  assert.deepEqual(emission.candidates.map(({ id }) => id), ['first-sheet', 'value', 'formula']);
});

test('candidate caps emit diagnostics instead of silently omitting', () => {
  const excel = emitExcelDraftCandidates(Array.from({ length: EXCEL_SHEET_CANDIDATE_CAP + 1 }, (_, row) => ({
    id: `e-${row}`, sheetIndex: 0, sheetName: 'A', row, column: 0, kind: 'value' as const,
  })));
  assert.equal(excel.candidates.length, EXCEL_SHEET_CANDIDATE_CAP);
  assert.deepEqual(excel.diagnostics[0], {
    code: 'DRAFT_CANDIDATE_CAP_REACHED', source: 'sheet:A', candidates: EXCEL_SHEET_CANDIDATE_CAP + 1,
    emitted: EXCEL_SHEET_CANDIDATE_CAP, omitted: 1,
  });
  const access = emitAccessDraftCandidates(Array.from({ length: ACCESS_TABLE_CANDIDATE_CAP + 1 }, (_, index) => ({
    id: `a-${index}`, kind: 'field' as const, sourceName: 'T',
  })));
  assert.equal(access.candidates.length, ACCESS_TABLE_CANDIDATE_CAP);
  assert.equal(access.diagnostics[0]?.source, 'table:T');
});

test('draft allocation requires enabled points to match each maximum', () => {
  assertDraftAllocation([{ id: 'p', maxScore: 3, checks: [{ id: 'c', enabled: true, points: 3, draftState: 'pending-user-allocation' }] }]);
  assert.throws(() => assertDraftAllocation([{ id: 'p', maxScore: 3, checks: [{ id: 'c', enabled: false, points: 3, draftState: 'pending-user-allocation' }] }]));
});
