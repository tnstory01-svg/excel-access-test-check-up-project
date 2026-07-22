import { createHash } from 'node:crypto';
import { MAX_EVIDENCE_BYTES, MAX_EVIDENCE_PREVIEW_BYTES, type RedactedEvidence } from '../../domain/src/results.ts';
import { canonicalJson } from './extract.ts';

const encoder = new TextEncoder();
const sensitiveKey = /(?:path|file|data|content|binary|blob|password|token|secret)/i;
const pathLike = /^(?:[a-z]:[\\/]|\\\\|\/)|(?:data:[^,]*,)/i;

export function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return pathLike.test(value) ? '[redacted]' : value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    normalized[key] = sensitiveKey.test(key) ? '[redacted]' : normalizeValue((value as Record<string, unknown>)[key]);
  }
  return normalized;
}

/** Produces a bounded, path-safe wire representation without retaining raw evidence. */
export function redactEvidence(value: unknown): RedactedEvidence {
  const normalized = normalizeValue(value);
  let serialized = canonicalJson(normalized);
  const byteLength = encoder.encode(serialized).byteLength;
  const digest = createHash('sha256').update(serialized).digest('hex');
  const redacted = canonicalJson(value) !== serialized;
  let preview: unknown = normalized;
  let truncated = false;
  if (byteLength > MAX_EVIDENCE_PREVIEW_BYTES) {
    preview = '[truncated]';
    truncated = true;
  }
  if (byteLength > MAX_EVIDENCE_BYTES) {
    serialized = serialized.slice(0, MAX_EVIDENCE_BYTES);
    truncated = true;
  }
  return { digest, preview, byteLength: Math.min(byteLength, MAX_EVIDENCE_BYTES), redacted, truncated };
}

export function equivalentCanonicalValue(expected: unknown, observed: unknown): boolean {
  return canonicalJson(normalizeValue(expected)) === canonicalJson(normalizeValue(observed));
}
