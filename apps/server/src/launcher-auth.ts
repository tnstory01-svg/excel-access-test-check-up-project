import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import type { Readable } from 'node:stream';

const TOKEN_HEX_LENGTH = 64;
const BOOTSTRAP_PREFIX = 'BOOTSTRAP ';
const BOOTSTRAP_TIMEOUT_MS = 60_000;

export type BootstrapExchange = Readonly<{ sessionId: string; csrfToken: string }>;

function tokenBytes(token: string): Buffer | undefined {
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
  return Buffer.from(token, 'hex');
}

/** Reads exactly one 256-bit launcher token from the private stdin pipe. */
export async function readLauncherBootstrapToken(input: Readable, timeoutMs = BOOTSTRAP_TIMEOUT_MS): Promise<string> {
  let received = '';
  const onData = (chunk: Buffer | string) => { received += chunk.toString(); };
  input.on('data', onData);
  const timeout = setTimeout(() => input.destroy(new Error('Bootstrap token was not received in time')), timeoutMs);
  try {
    await once(input, 'end');
  } finally {
    clearTimeout(timeout);
    input.off('data', onData);
  }
  if (!received.startsWith(BOOTSTRAP_PREFIX) || !received.endsWith('\n') || received.indexOf('\n') !== received.length - 1) {
    throw new Error('Invalid bootstrap pipe message');
  }
  const token = received.slice(BOOTSTRAP_PREFIX.length, -1);
  if (!tokenBytes(token)) throw new Error('Bootstrap token must be 256 bits of lowercase hexadecimal');
  return token;
}

export class LauncherAuthenticator {
  readonly #expectedToken: Buffer;
  readonly #expiresAt: number;
  #used = false;
  readonly #sessions = new Map<string, string>();

  constructor(token: string, now = Date.now(), ttlMs = BOOTSTRAP_TIMEOUT_MS) {
    const bytes = tokenBytes(token);
    if (!bytes || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid bootstrap authentication configuration');
    this.#expectedToken = bytes;
    this.#expiresAt = now + ttlMs;
  }

  exchange(token: string, now = Date.now()): BootstrapExchange | undefined {
    const supplied = tokenBytes(token);
    if (this.#used || now >= this.#expiresAt || !supplied || !timingSafeEqual(this.#expectedToken, supplied)) return undefined;
    this.#used = true;
    const sessionId = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    this.#sessions.set(sessionId, csrfToken);
    return Object.freeze({ sessionId, csrfToken });
  }

  hasValidCsrf(sessionId: string | undefined, csrfToken: string | undefined): boolean {
    return typeof sessionId === 'string' && typeof csrfToken === 'string' && this.#sessions.get(sessionId) === csrfToken;
  }
}
