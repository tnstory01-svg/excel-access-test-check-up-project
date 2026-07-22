import type { CapabilityId } from '../../domain/src/capabilities.ts';

/** Canonical extractor output. This package never opens or parses Office files. */
export type CanonicalEvidence = {
  capabilityId: CapabilityId;
  locator: Record<string, unknown>;
  status: 'ok' | 'unsupported' | 'error';
  value?: unknown;
  reasonCode?: string;
  diagnosticCode?: string;
};

export type CanonicalEvidenceSet = readonly CanonicalEvidence[];

export function evidenceKey(capabilityId: string, locator: Record<string, unknown>): string {
  return `${capabilityId}\u0000${canonicalJson(locator)}`;
}

export function indexCanonicalEvidence(evidence: CanonicalEvidenceSet): ReadonlyMap<string, CanonicalEvidence> {
  const indexed = new Map<string, CanonicalEvidence>();
  for (const item of evidence) {
    const key = evidenceKey(item.capabilityId, item.locator);
    if (indexed.has(key)) throw new Error('DUPLICATE_CANONICAL_EVIDENCE');
    indexed.set(key, item);
  }
  return indexed;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
