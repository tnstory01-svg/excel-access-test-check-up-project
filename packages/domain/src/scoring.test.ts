import assert from 'node:assert/strict';
import test from 'node:test';
import { addScorePoints, percentHalfUp } from './scoring.ts';

test('score addition rejects unsafe inputs and overflow', () => {
  assert.deepEqual(addScorePoints(2, 3), { ok: true, value: 5 });
  assert.equal(addScorePoints(-1, 0).code, 'SCORE_INVARIANT_ERROR');
  assert.equal(addScorePoints(Number.MAX_SAFE_INTEGER, 1).code, 'SCORE_OVERFLOW');
});

test('percentage uses exact half-up hundredths', () => {
  for (const [earned, denominator, expected] of [[0, 1, 0], [1, 6, 16.67], [1, 8, 12.5], [1, 200, 0.5], [199, 200, 99.5], [1, 3, 33.33], [2, 3, 66.67]]) {
    assert.equal(percentHalfUp(earned, denominator), expected);
  }
  assert.equal(percentHalfUp(0, 0), null);
  assert.throws(() => percentHalfUp(2, 1));
});
