import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CAPABILITY_STATUS, classifyClosure } from './closure-classifier.mjs';

const fixtureUrl = new URL('./closure-oracles.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));

test('independent synthetic closure-policy oracle cases are fail-closed', () => {
  for (const probeCase of fixture.cases) {
    assert.deepEqual(
      classifyClosure(probeCase.catalog, probeCase.queryId, probeCase.options),
      probeCase.expected,
      probeCase.name,
    );
  }
});

test('unproven parser and query-result capabilities remain explicitly blocked', () => {
  assert.match(CAPABILITY_STATUS['access.query.definition.v1'], /^blocked:/);
  assert.match(CAPABILITY_STATUS['access.query.result.v1'], /^blocked:/);
  assert.match(fixture.capabilities['access.query.definition.v1'], /^blocked:/);
  assert.match(fixture.capabilities['access.query.result.v1'], /^blocked:/);
});
