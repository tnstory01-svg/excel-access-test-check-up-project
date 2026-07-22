import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateCheck, bootstrapFromFragment, filterDraft, resultView, scopeLabel, validateDraftForSave, type DraftProblemView } from './workflow.ts';

const draft: readonly DraftProblemView[] = [{
  id: 'sheet-1', sheet: 'Sheet1', maxScore: 5,
  checks: [
    { id: 'a', enabled: false, points: 0, draftState: 'pending-user-allocation', kind: 'formula', capabilityId: 'excel.formula' },
    { id: 'b', enabled: false, points: 0, draftState: 'pending-user-allocation', kind: 'style', capabilityId: 'excel.style' },
  ],
}];

test('allocation is immutable, disables to zero, and save requires exact totals', () => {
  const enabled = allocateCheck(draft, 'a', true, 5);
  assert.equal(draft[0].checks[0].enabled, false);
  assert.equal(enabled[0].checks[0].points, 5);
  validateDraftForSave(enabled);
  const disabled = allocateCheck(enabled, 'a', false, 99);
  assert.equal(disabled[0].checks[0].points, 0);
  assert.throws(() => validateDraftForSave(disabled));
});

test('filters draft views and labels selected runs as non-whole-rule-set', () => {
  assert.deepEqual(filterDraft(draft, { kind: 'style' })[0].checks.map((check) => check.id), ['b']);
  assert.equal(scopeLabel({ executionScope: 'full', representsWholeRuleSet: true }), '전체 규칙 채점');
  assert.match(scopeLabel({ executionScope: 'selected', representsWholeRuleSet: false }), /전체 점수를 나타내지 않음/);
});

test('incomplete summaries do not render a score', () => {
  const view = resultView({
    declaredMax: 10, selectedDeclaredMax: 10, outOfScopePoints: 0, verifiedEarned: 4, failedPoints: 1,
    indeterminatePoints: 5, finalScorePoints: null, finalPercent: null, executionScope: 'full', adjudication: 'incomplete', representsWholeRuleSet: true,
  });
  assert.equal(view.incomplete, true);
  assert.equal(view.score, '채점 미완료');
  assert.match(view.message, /5점/);
});

test('fragment token is posted only to exchange callback and removed from history', async () => {
  const exchanged: string[] = [];
  const replacements: unknown[][] = [];
  const exchangedToken = await bootstrapFromFragment(
    { hash: '#token=one-time-secret', pathname: '/app', search: '?mode=local' } as Location,
    { replaceState: (...args: unknown[]) => { replacements.push(args); } } as History,
    async (token) => { exchanged.push(token); },
  );
  assert.equal(exchangedToken, true);
  assert.deepEqual(exchanged, ['one-time-secret']);
  assert.deepEqual(replacements, [[null, '', '/app?mode=local']]);
});
