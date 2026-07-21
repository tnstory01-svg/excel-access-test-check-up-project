import { LOOPBACK_HOST } from '../config.ts';

export type LocalhostPolicy = Readonly<{ host: string; origin: string }>;

export function localhostPolicy(port: number): LocalhostPolicy {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Bound port must be a valid TCP port');
  }
  const host = `${LOOPBACK_HOST}:${port}`;
  return Object.freeze({ host, origin: `http://${host}` });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Rejects host aliases, IPv6, missing ports, and forwarded/multiple header values. */
export function hasExactHost(headers: Readonly<{ host?: string | string[] }>, policy: LocalhostPolicy): boolean {
  return singleHeader(headers.host) === policy.host;
}

/** All state-changing requests must have this exact origin; CORS is intentionally not allowed. */
export function hasExactMutationOrigin(
  headers: Readonly<{ origin?: string | string[] }>,
  policy: LocalhostPolicy,
): boolean {
  return singleHeader(headers.origin) === policy.origin;
}
