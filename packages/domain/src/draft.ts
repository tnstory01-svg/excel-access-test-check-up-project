import { DomainError } from './errors.ts';
import { assertScorePoints, checkedAddScorePoints, type ScorePoints } from './scoring.ts';

export type DraftState = 'pending-user-allocation';
export type DraftCheck = { id: string; enabled: boolean; points: ScorePoints; draftState: DraftState };
export type DraftProblem = { id: string; maxScore: ScorePoints; checks: readonly DraftCheck[] };
export type DraftCheckCandidate = { id: string };

export const EXCEL_WORKBOOK_CANDIDATE_CAP = 50_000;
export const EXCEL_SHEET_CANDIDATE_CAP = 10_000;
export const ACCESS_DATABASE_CANDIDATE_CAP = 20_000;
export const ACCESS_TABLE_CANDIDATE_CAP = 5_000;
export const ACCESS_QUERY_CANDIDATE_CAP = 2_000;

export type DraftCandidateCapDiagnostic = {
  code: 'DRAFT_CANDIDATE_CAP_REACHED'; source: string; candidates: number; emitted: number; omitted: number;
};
export type ExcelDraftCandidateKind = 'value' | 'formula' | 'number-format' | 'font' | 'fill' | 'border' | 'alignment';
export type ExcelDraftCandidate = DraftCheckCandidate & {
  sheetIndex: number; sheetName: string; row: number; column: number; kind: ExcelDraftCandidateKind;
};
export type AccessDraftCandidateKind = 'table' | 'field' | 'primary-key' | 'index' | 'relationship' | 'query-definition';
export type AccessDraftCandidate = DraftCheckCandidate & { kind: AccessDraftCandidateKind; sourceName?: string };
export type DraftCandidateEmission<T extends DraftCheckCandidate> = {
  candidates: readonly T[]; diagnostics: readonly DraftCandidateCapDiagnostic[];
};

const excelKindOrder: Record<ExcelDraftCandidateKind, number> = {
  value: 0, formula: 1, 'number-format': 2, font: 3, fill: 4, border: 5, alignment: 6,
};
const accessKindOrder: Record<AccessDraftCandidateKind, number> = {
  table: 0, field: 1, 'primary-key': 2, index: 3, relationship: 4, 'query-definition': 5,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function assertCandidateId(candidate: DraftCheckCandidate): void {
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft checks require a non-empty id.');
  }
}
function capDiagnostic(source: string, candidates: number, emitted: number): DraftCandidateCapDiagnostic | undefined {
  return candidates > emitted ? { code: 'DRAFT_CANDIDATE_CAP_REACHED', source, candidates, emitted, omitted: candidates - emitted } : undefined;
}

/** Sorts canonical Excel candidates in workbook/cell/check order and applies sheet then workbook caps. */
export function emitExcelDraftCandidates(candidates: readonly ExcelDraftCandidate[]): DraftCandidateEmission<ExcelDraftCandidate> {
  const ordered = [...candidates].sort((left, right) =>
    left.sheetIndex - right.sheetIndex || left.row - right.row || left.column - right.column ||
    excelKindOrder[left.kind] - excelKindOrder[right.kind] || compareText(left.id, right.id));
  for (const candidate of ordered) {
    assertCandidateId(candidate);
    if (!Number.isSafeInteger(candidate.sheetIndex) || candidate.sheetIndex < 0 || !Number.isSafeInteger(candidate.row) ||
      candidate.row < 0 || !Number.isSafeInteger(candidate.column) || candidate.column < 0 ||
      typeof candidate.sheetName !== 'string' || candidate.sheetName.length === 0 || excelKindOrder[candidate.kind] === undefined) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Excel draft candidate is malformed.');
    }
  }
  const totals = new Map<number, { name: string; candidates: number; emitted: number }>();
  const emitted: ExcelDraftCandidate[] = [];
  for (const candidate of ordered) {
    const sheet = totals.get(candidate.sheetIndex) ?? { name: candidate.sheetName, candidates: 0, emitted: 0 };
    if (sheet.name !== candidate.sheetName) throw new DomainError('SCORE_INVARIANT_ERROR', 'Excel sheet index has conflicting names.');
    sheet.candidates += 1;
    if (sheet.emitted < EXCEL_SHEET_CANDIDATE_CAP && emitted.length < EXCEL_WORKBOOK_CANDIDATE_CAP) {
      emitted.push(candidate); sheet.emitted += 1;
    }
    totals.set(candidate.sheetIndex, sheet);
  }
  const diagnostics: DraftCandidateCapDiagnostic[] = [];
  for (const [, sheet] of [...totals].sort(([left], [right]) => left - right)) {
    const diagnostic = capDiagnostic(`sheet:${sheet.name}`, sheet.candidates, sheet.emitted);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  const workbookDiagnostic = capDiagnostic('workbook', ordered.length, emitted.length);
  if (workbookDiagnostic) diagnostics.push(workbookDiagnostic);
  return { candidates: emitted, diagnostics };
}

/** Sorts Access catalog candidates in canonical kind/name/id order and applies source then database caps. */
export function emitAccessDraftCandidates(candidates: readonly AccessDraftCandidate[]): DraftCandidateEmission<AccessDraftCandidate> {
  const ordered = [...candidates].sort((left, right) =>
    accessKindOrder[left.kind] - accessKindOrder[right.kind] ||
    compareText(left.sourceName ?? '', right.sourceName ?? '') || compareText(left.id, right.id));
  for (const candidate of ordered) {
    assertCandidateId(candidate);
    if (accessKindOrder[candidate.kind] === undefined ||
      (candidate.sourceName !== undefined && (typeof candidate.sourceName !== 'string' || candidate.sourceName.length === 0))) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Access draft candidate is malformed.');
    }
  }
  const totals = new Map<string, { candidates: number; emitted: number; cap: number }>();
  const emitted: AccessDraftCandidate[] = [];
  for (const candidate of ordered) {
    const source = candidate.kind === 'query-definition' ? `query:${candidate.sourceName ?? candidate.id}`
      : candidate.kind === 'relationship' ? 'database' : `table:${candidate.sourceName ?? candidate.id}`;
    const cap = candidate.kind === 'query-definition' ? ACCESS_QUERY_CANDIDATE_CAP
      : candidate.kind === 'relationship' ? ACCESS_DATABASE_CANDIDATE_CAP : ACCESS_TABLE_CANDIDATE_CAP;
    const total = totals.get(source) ?? { candidates: 0, emitted: 0, cap };
    total.candidates += 1;
    if (total.emitted < total.cap && emitted.length < ACCESS_DATABASE_CANDIDATE_CAP) {
      emitted.push(candidate); total.emitted += 1;
    }
    totals.set(source, total);
  }
  const diagnostics: DraftCandidateCapDiagnostic[] = [];
  for (const [source, total] of [...totals].sort(([left], [right]) => compareText(left, right))) {
    const diagnostic = capDiagnostic(source, total.candidates, total.emitted);
    if (diagnostic) diagnostics.push(diagnostic);
  }
  const databaseDiagnostic = capDiagnostic('database', ordered.length, emitted.length);
  if (databaseDiagnostic) diagnostics.push(databaseDiagnostic);
  return { candidates: emitted, diagnostics };
}

/** Every extractor candidate begins inert; only explicit user allocation can enable it. */
export function createDraftCheck(candidate: DraftCheckCandidate): DraftCheck {
  assertCandidateId(candidate);
  return { id: candidate.id, enabled: false, points: 0, draftState: 'pending-user-allocation' };
}

/** Computes enabled allocation with checked addition and rejects malformed draft state. */
export function enabledPoints(checks: readonly DraftCheck[]): ScorePoints {
  let total: ScorePoints = 0;
  for (const check of checks) {
    if (typeof check.id !== 'string' || check.id.length === 0 || typeof check.enabled !== 'boolean' ||
      check.draftState !== 'pending-user-allocation') throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft check is malformed.');
    assertScorePoints(check.points);
    if (!check.enabled && check.points !== 0) throw new DomainError('SCORE_INVARIANT_ERROR', 'Disabled draft checks must have zero points.');
    if (check.enabled) total = checkedAddScorePoints(total, check.points);
  }
  return total;
}

/** Rule saves require exact per-problem allocation and an enabled problem. */
export function assertDraftAllocation(problems: readonly DraftProblem[]): void {
  let enabledProblemCount = 0;
  for (const problem of problems) {
    if (typeof problem.id !== 'string' || problem.id.length === 0 || !Array.isArray(problem.checks)) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Draft problems require a non-empty id and checks.');
    }
    assertScorePoints(problem.maxScore);
    if (enabledPoints(problem.checks) !== problem.maxScore) {
      throw new DomainError('SCORE_INVARIANT_ERROR', 'Enabled check points must equal the problem maximum.');
    }
    if (problem.checks.some((check) => check.enabled)) enabledProblemCount += 1;
  }
  if (enabledProblemCount === 0) throw new DomainError('SCORE_INVARIANT_ERROR', 'Whole-run grading requires at least one enabled problem.');
}