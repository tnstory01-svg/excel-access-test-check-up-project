#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (command, args) => execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const parseLastJson = (output, name) => {
  try { return JSON.parse(output.trim()); }
  catch { throw new Error(`${name} did not emit a JSON result`); }
};

const access = parseLastJson(run(process.execPath, ['tools/gate-probes/access/run-oracles.mjs']), 'Access closure probe');
if (access.probe !== 'access-query-closure-policy' || !Number.isSafeInteger(access.casesPassed) || access.casesPassed <= 0) {
  throw new Error('Access closure probe result is incomplete');
}
for (const [capability, status] of Object.entries(access.capabilities ?? {})) {
  if (typeof status !== 'string' || !status.startsWith('blocked:')) {
    throw new Error(`Access probe must not claim ${capability} is supported without independent evidence`);
  }
}

const python = process.env.PYTHON ?? 'python';
const excel = parseLastJson(run(python, ['tools/gate-probes/excel/check_gate_0a.py']), 'Excel Gate 0A probe');
const requiredExcelCapabilities = [
  'excel.cell.value.v1', 'excel.cell.formula.stored.v1', 'excel.style.number-format.v1',
  'excel.style.font.v1', 'excel.style.fill.v1', 'excel.style.border.v1', 'excel.style.alignment.v1',
];
if (excel.gate !== '0A' || excel.terminal !== 'COMPLETE' || excel.probeStatus !== 'blocked' ||
    !Array.isArray(excel.provenCapabilities) || excel.provenCapabilities.length !== 0 ||
    !Array.isArray(excel.blockedCapabilities) ||
    requiredExcelCapabilities.some((capability) => !excel.blockedCapabilities.includes(capability))) {
  throw new Error('Excel Gate 0A probe must remain blocked until independent POI evidence exists');
}

const gateManifest = JSON.parse(await readFile(path.join(root, 'tools/gate-probes/excel/gate-0a-capabilities-v1.json'), 'utf8'));
if (gateManifest.status !== 'blocked' || gateManifest.matrix.some((row) => row.status !== 'blocked')) {
  throw new Error('Gate 0A manifest claims support without independent fixture evidence');
}
console.log(`Fixture probes verified: ${access.casesPassed} Access closure cases; ${excel.checkedFormatCapabilityPairs} blocked Excel format/capability pairs.`);
