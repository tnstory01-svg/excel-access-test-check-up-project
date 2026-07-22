import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hasExactHost, hasExactMutationOrigin, localhostPolicy, type LocalhostPolicy } from './security/host-origin.ts';
import { LauncherAuthenticator } from './launcher-auth.ts';

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
});
const SESSION_COOKIE = 'eag_session';

export type LocalApp = Readonly<{ handler: (request: IncomingMessage, response: ServerResponse) => void; policy: LocalhostPolicy }>;

function send(response: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  response.end(body);
}

function cookieValue(cookie: string | undefined, name: string): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === name && value) return value;
  }
  return undefined;
}

async function readBootstrapBody(request: IncomingMessage): Promise<string | undefined> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1024) return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length === 1 && typeof (parsed as { token?: unknown }).token === 'string') {
      return (parsed as { token: string }).token;
    }
  } catch { /* malformed bootstrap requests are rejected */ }
  return undefined;
}

/** Creates a same-origin-only localhost API. The bootstrap secret is never retained from request data. */
export function createLocalApp(port: number, authenticator: LauncherAuthenticator): LocalApp {
  const policy = localhostPolicy(port);
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      if (!hasExactHost(request.headers, policy)) return send(response, 400);
      const pathname = new URL(request.url ?? '/', policy.origin).pathname;
      if (request.method === 'POST' && pathname === '/bootstrap') {
        if (!hasExactMutationOrigin(request.headers, policy)) return send(response, 403);
        const token = await readBootstrapBody(request);
        const exchange = token === undefined ? undefined : authenticator.exchange(token);
        if (!exchange) return send(response, 401);
        return send(response, 204, undefined, {
          'set-cookie': `${SESSION_COOKIE}=${exchange.sessionId}; HttpOnly; SameSite=Strict; Path=/`,
          'x-csrf-token': exchange.csrfToken,
        });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (!hasExactMutationOrigin(request.headers, policy)) return send(response, 403);
        const session = cookieValue(request.headers.cookie, SESSION_COOKIE);
        const csrf = typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined;
        if (!authenticator.hasValidCsrf(session, csrf)) return send(response, 403);
      }
      if (request.method === 'GET' && pathname === '/health') return send(response, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      return send(response, 404);
    })().catch(() => {
      if (response.headersSent) response.destroy();
      else send(response, 500);
    });
  };
  return Object.freeze({ handler, policy });
}
/** The only supported lifecycle binding: no aliases, IPv6, or public interfaces. */
export async function listenLocalApp(app: LocalApp, port: number): Promise<Server> {
  const server = createServer(app.handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, ipv6Only: true }, resolve);
  });
  return server;
}
