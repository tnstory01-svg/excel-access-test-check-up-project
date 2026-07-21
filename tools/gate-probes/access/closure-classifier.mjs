#!/usr/bin/env node
/**
 * Source-only Gate 0B policy probe. This is not a Jackcess/UCanAccess adapter and
 * must not be used to advertise Access query-result support.
 */
import { readFile } from 'node:fs/promises';

export const CAPABILITY_STATUS = Object.freeze({
  'access.query.definition.v1': 'blocked: requires Jackcess catalog/parser evidence',
  'access.query.result.v1': 'blocked: requires UCanAccess parity fixtures and execution evidence',
});

const VOLATILE = new Set(['NOW', 'DATE', 'TIME', 'TIMER', 'RND', 'RANDOMIZE', 'ENVIRON', 'CURRENTUSER']);
const SAFE_FUNCTIONS = new Set(['ABS', 'AVG', 'COUNT', 'MAX', 'MIN', 'SUM']);

function key(value) {
  return String(value).normalize('NFC').toLocaleLowerCase('en-US');
}

// Removes comments and literals while retaining keyword/function structure.
function sqlTokens(sql) {
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) { i = sql.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (sql.startsWith('/*', i)) { i = sql.indexOf('*/', i + 2); if (i < 0) return null; i += 2; continue; }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i++] === "'") break; }
      if (i > sql.length || sql[i - 1] !== "'") return null;
      tokens.push('LITERAL'); continue;
    }
    if (sql[i] === '[') { const end = sql.indexOf(']', i + 1); if (end < 0) return null; tokens.push('IDENTIFIER'); i = end + 1; continue; }
    const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
    if (match) { tokens.push(match[0].toUpperCase()); i += match[0].length; continue; }
    if (!/\s/.test(sql[i])) tokens.push(sql[i]);
    i++;
  }
  return tokens;
}

function rejectSql(query) {
  const tokens = sqlTokens(query.sql ?? '');
  if (!tokens || !tokens.length) return 'UNSUPPORTED_QUERY_SHAPE';
  if (tokens.includes('TRANSFORM')) return 'TRANSFORM_QUERY';
  if (tokens[0] !== 'SELECT') return 'UNSUPPORTED_QUERY_SHAPE';
  if (tokens.includes('PARAMETERS') || tokens.includes('?')) return 'PARAMETER_QUERY';
  if (tokens.includes('INTO')) return 'SELECT_INTO_QUERY';
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index + 1] === '(' && /^[A-Z_][A-Z0-9_$]*$/.test(tokens[index])) {
      if (VOLATILE.has(tokens[index])) return 'VOLATILE_FUNCTION';
      if (!SAFE_FUNCTIONS.has(tokens[index])) return 'UDF_OR_UNAPPROVED_FUNCTION';
    }
  }
  return null;
}

function validateOrder(orderBy) {
  if (!Array.isArray(orderBy) || orderBy.length === 0) return 'ORDER_REQUIRED';
  const seen = new Set();
  for (const column of orderBy) {
    if (!column || typeof column.name !== 'string' || column.name.length === 0 || column.nullable !== false || column.unique !== true) return 'AMBIGUOUS_ORDER_KEY';
    const columnKey = key(column.name);
    if (seen.has(columnKey)) return 'AMBIGUOUS_ORDER_KEY';
    seen.add(columnKey);
  }
  return null;
}

/** Returns fail-closed closure evidence for one immutable query id. */
export function classifyClosure(catalog, queryId, { queryResult = false, orderBy } = {}) {
  const queries = new Map();
  for (const query of catalog.queries ?? []) {
    const queryKey = key(query.id);
    if (queries.has(queryKey)) return { state: 'unsupported', reason: 'AMBIGUOUS_QUERY_IDENTIFIER' };
    queries.set(queryKey, query);
  }
  const tables = new Map();
  for (const table of catalog.tables ?? []) {
    const tableKey = key(table.id);
    if (tables.has(tableKey)) return { state: 'unsupported', reason: 'AMBIGUOUS_TABLE_IDENTIFIER' };
    tables.set(tableKey, table);
  }
  if (queryResult) {
    const orderFailure = validateOrder(orderBy);
    if (orderFailure) return { state: 'unsupported', reason: orderFailure };
  }
  const visiting = new Set();
  const visited = new Set();
  const walk = (id) => {
    const idKey = key(id);
    if (visiting.has(idKey)) return 'DEPENDENCY_CYCLE';
    if (visited.has(idKey)) return null;
    const query = queries.get(idKey);
    if (!query) return 'UNRESOLVED_REFERENCE';
    if (query.type !== 'SELECT' && query.type !== 'UNION') return 'UNSUPPORTED_QUERY_TYPE';
    if (query.passThrough === true) return 'PASS_THROUGH_QUERY';
    if (query.parameters === true) return 'PARAMETER_QUERY';
    if (query.udf === true) return 'UDF_OR_UNAPPROVED_FUNCTION';
    if (query.volatile === true) return 'VOLATILE_FUNCTION';
    const sqlFailure = rejectSql(query);
    if (sqlFailure) return sqlFailure;
    visiting.add(idKey);
    for (const dependency of query.dependencies ?? []) {
      if (dependency.kind === 'table') {
        const table = tables.get(key(dependency.id));
        if (!table) return 'UNRESOLVED_REFERENCE';
        if (table.linked === true || table.external === true) return 'EXTERNAL_OR_LINKED_REFERENCE';
      } else if (dependency.kind === 'query') {
        const failure = walk(dependency.id);
        if (failure) return failure;
      } else return 'UNRESOLVED_REFERENCE';
    }
    visiting.delete(idKey); visited.add(idKey);
    return null;
  };
  const failure = walk(queryId);
  return failure ? { state: 'unsupported', reason: failure } : { state: 'supported', reason: 'STATIC_LOCAL_SELECT_UNION_CLOSURE' };
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(classifyClosure(input.catalog, input.queryId, input.options), null, 2));
}
