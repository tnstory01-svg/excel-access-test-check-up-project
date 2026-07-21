import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const matrixPath = new URL("./support-matrix.json", import.meta.url);
const capabilityIds = new Set([
  "excel.cell.value.v1", "excel.cell.formula.stored.v1", "excel.style.number-format.v1", "excel.style.font.v1", "excel.style.fill.v1", "excel.style.border.v1", "excel.style.alignment.v1",
  "access.table.schema.v1", "access.field.property.v1", "access.primary-key.v1", "access.index.v1", "access.relationship.v1", "access.query.definition.v1", "access.query.result.v1",
]);
const excelFormats = new Set(["xlsx", "xlsm", "xls"]);
const accessFormats = new Set(["accdb", "mdb"]);
const statuses = new Set(["supported", "unsupported"]);
const sha256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`Support matrix validation failed: ${message}`);
}

function record(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${name} has unexpected or missing fields`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function matrixDigest(matrix) {
  const unsigned = { ...matrix };
  delete unsigned.canonicalMatrixSha256;
  return createHash("sha256").update(canonicalize(unsigned)).digest("hex");
}

function validateOracle(oracle, name) {
  record(oracle, name);
  exactKeys(oracle, ["fixtureId", "oracleRef", "oracleSha256"], name);
  nonEmptyString(oracle.fixtureId, `${name}.fixtureId`);
  nonEmptyString(oracle.oracleRef, `${name}.oracleRef`);
  if (typeof oracle.oracleSha256 !== "string" || !sha256.test(oracle.oracleSha256)) fail(`${name}.oracleSha256 must be a lowercase SHA-256`);
}

function validateSupportedProof(proof, rowName) {
  record(proof, `${rowName}.fixtureProof`);
  exactKeys(proof, ["positive", "boundary", "negative"], `${rowName}.fixtureProof`);
  for (const kind of ["positive", "boundary", "negative"]) validateOracle(proof[kind], `${rowName}.fixtureProof.${kind}`);
  const references = new Set([proof.positive.oracleRef, proof.boundary.oracleRef, proof.negative.oracleRef]);
  const fixtures = new Set([proof.positive.fixtureId, proof.boundary.fixtureId, proof.negative.fixtureId]);
  if (references.size !== 3 || fixtures.size !== 3) fail(`${rowName}.fixtureProof must use independent positive, boundary, and negative oracles`);
}

function validateRow(row, index) {
  const name = `rows[${index}]`;
  record(row, name);
  const base = ["formatSignature", "formatGeneration", "answerFormat", "submissionFormat", "capabilityId", "parserVersion", "normalizerVersion", "status", "limitation"];
  const expected = row.status === "supported" ? [...base, "fixtureProof"] : base;
  exactKeys(row, expected, name);
  for (const key of base) nonEmptyString(row[key], `${name}.${key}`);
  if (!capabilityIds.has(row.capabilityId)) fail(`${name}.capabilityId is not canonical`);
  if (!statuses.has(row.status)) fail(`${name}.status is invalid`);
  const formats = row.capabilityId.startsWith("excel.") ? excelFormats : accessFormats;
  if (!formats.has(row.answerFormat) || !formats.has(row.submissionFormat)) fail(`${name} uses an incompatible format pair`);
  if (row.status === "supported") validateSupportedProof(row.fixtureProof, name);
}

export function validateSupportMatrix(matrix) {
  record(matrix, "matrix");
  exactKeys(matrix, ["matrixRevision", "canonicalMatrixSha256", "rows"], "matrix");
  if (!Number.isSafeInteger(matrix.matrixRevision) || matrix.matrixRevision < 1) fail("matrixRevision must be a positive safe integer");
  if (typeof matrix.canonicalMatrixSha256 !== "string" || !sha256.test(matrix.canonicalMatrixSha256)) fail("canonicalMatrixSha256 must be a lowercase SHA-256");
  if (!Array.isArray(matrix.rows) || matrix.rows.length === 0) fail("rows must be a non-empty array");
  const keys = new Set();
  for (const [index, row] of matrix.rows.entries()) {
    validateRow(row, index);
    const key = [row.answerFormat, row.submissionFormat, row.formatSignature, row.formatGeneration, row.capabilityId, row.parserVersion, row.normalizerVersion].join("\u0000");
    if (keys.has(key)) fail(`rows[${index}] duplicates a format/capability/version row`);
    keys.add(key);
  }
  const digest = matrixDigest(matrix);
  if (digest !== matrix.canonicalMatrixSha256) fail("canonicalMatrixSha256 does not match canonical matrix content");
  return matrix;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
  validateSupportMatrix(matrix);
  process.stdout.write(`Support matrix valid: ${matrix.rows.length} rows, revision ${matrix.matrixRevision}\n`);
}
