import { assertDraftAllocation, type DraftCheck, type DraftProblem } from '../../../packages/domain/src/draft.ts';
import type { GradeSummaryWire } from '../../../packages/domain/src/results.ts';

export type UploadMetadata = Readonly<{
  id: string;
  sha256: string;
  family: string;
  detectedFormat: string;
  size: number;
  createdAt: string;
}>;

export type DraftFilter = Readonly<{ sheet?: string; kind?: string; capabilityId?: string }>;
export type DraftCheckView = Readonly<DraftCheck & { sheet?: string; kind?: string; capabilityId?: string }>;
export type DraftProblemView = Readonly<Omit<DraftProblem, 'checks'> & { sheet?: string; checks: readonly DraftCheckView[] }>;

/** Filters only display candidates; it never alters the saved draft. */
export function filterDraft(problems: readonly DraftProblemView[], filter: DraftFilter): DraftProblemView[] {
  return problems.map((problem) => ({
    ...problem,
    checks: problem.checks.filter((check) =>
      (filter.sheet === undefined || problem.sheet === filter.sheet) &&
      (filter.kind === undefined || check.kind === filter.kind) &&
      (filter.capabilityId === undefined || check.capabilityId === filter.capabilityId)),
  })).filter((problem) => problem.checks.length > 0);
}

/** Allocation is immutable and makes a disabled check inert regardless of the supplied points. */
export function allocateCheck(problems: readonly DraftProblemView[], checkId: string, enabled: boolean, points: number): DraftProblemView[] {
  return problems.map((problem) => ({
    ...problem,
    checks: problem.checks.map((check) => check.id !== checkId ? check : {
      ...check,
      enabled,
      points: enabled ? points : 0,
    }),
  }));
}

/** Uses the shared domain invariant before draft persistence or grading. */
export function validateDraftForSave(problems: readonly DraftProblemView[]): void {
  assertDraftAllocation(problems);
}

export function scopeLabel(summary: Pick<GradeSummaryWire, 'executionScope' | 'representsWholeRuleSet'>): string {
  return summary.executionScope === 'full' && summary.representsWholeRuleSet
    ? '전체 규칙 채점'
    : '선택 규칙 채점 (전체 점수를 나타내지 않음)';
}

export type ResultView = Readonly<{
  scope: string;
  score: string;
  incomplete: boolean;
  message: string;
}>;

/** Never turn a partial verification result into a numeric grade. */
export function resultView(summary: GradeSummaryWire): ResultView {
  const scope = scopeLabel(summary);
  if (summary.adjudication === 'incomplete') {
    return { scope, incomplete: true, score: '채점 미완료', message: `확인 불가 ${summary.indeterminatePoints}점이 있어 최종 점수를 표시하지 않습니다.` };
  }
  if (summary.adjudication === 'empty') {
    return { scope, incomplete: false, score: '채점할 항목 없음', message: '선택된 채점 항목이 없습니다.' };
  }
  return { scope, incomplete: false, score: `${summary.finalScorePoints}점 (${summary.finalPercent}%)`, message: '채점이 완료되었습니다.' };
}

/** Safe for text interpolation into the minimal HTML renderer. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

/** Exchanges a fragment-only launcher secret and removes it even when exchange fails. */
export async function bootstrapFromFragment(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  exchange: (token: string) => Promise<void>,
): Promise<boolean> {
  const fragment = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const token = fragment.get('token');
  if (!token) return false;
  try {
    await exchange(token);
    return true;
  } finally {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
}
