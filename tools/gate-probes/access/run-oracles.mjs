#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CAPABILITY_STATUS, classifyClosure } from './closure-classifier.mjs';

const fixture = JSON.parse(await readFile(new URL('./closure-oracles.json', import.meta.url), 'utf8'));
for (const probeCase of fixture.cases) {
  assert.deepEqual(classifyClosure(probeCase.catalog, probeCase.queryId, probeCase.options), probeCase.expected, probeCase.name);
}
console.log(JSON.stringify({
  probe: 'access-query-closure-policy',
  casesPassed: fixture.cases.length,
  capabilities: CAPABILITY_STATUS,
}, null, 2));
