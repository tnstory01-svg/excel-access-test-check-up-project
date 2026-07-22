import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalApp, listenLocalApp } from '../app.ts';
import { LauncherAuthenticator } from '../launcher-auth.ts';
import { hasExactHost, hasExactMutationOrigin, localhostPolicy } from './host-origin.ts';

const token = 'a'.repeat(64);

test('host and mutation origin require the exact bound IPv4 authority', () => {
  const policy = localhostPolicy(43123);
  assert.equal(hasExactHost({ host: '127.0.0.1:43123' }, policy), true);
  assert.equal(hasExactHost({ host: 'localhost:43123' }, policy), false);
  assert.equal(hasExactHost({ host: '127.0.0.1' }, policy), false);
  assert.equal(hasExactHost({ host: ['127.0.0.1:43123'] }, policy), false);
  assert.equal(hasExactHost({ host: '0.0.0.0:43123' }, policy), false);
  assert.equal(hasExactMutationOrigin({ origin: 'http://127.0.0.1:43123' }, policy), true);
  assert.equal(hasExactMutationOrigin({ origin: 'http://localhost:43123' }, policy), false);
  assert.equal(hasExactMutationOrigin({ origin: 'http://127.0.0.1:43123/' }, policy), false);
});

test('bootstrap exchange expires, rejects mismatches and cannot replay', () => {
  const auth = new LauncherAuthenticator(token, 1_000, 60_000);
  assert.equal(auth.exchange('b'.repeat(64), 1_001), undefined);
  const exchange = auth.exchange(token, 60_999);
  assert.ok(exchange);
  assert.equal(auth.exchange(token, 60_999), undefined);
  const expired = new LauncherAuthenticator(token, 1_000, 60_000);
  assert.equal(expired.exchange(token, 61_000), undefined);
});

async function startApp() {
  const provisional = createServer();
  await new Promise<void>((resolve) => provisional.listen(0, '127.0.0.1', resolve));
  const port = (provisional.address() as { port: number }).port;
  await new Promise<void>((resolve) => provisional.close(() => resolve()));
  const app = createLocalApp(port, new LauncherAuthenticator(token));
  const server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port };
}

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer | string) => { responseBody += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function availablePort(): Promise<number> {
  const provisional = createServer();
  await new Promise<void>((resolve) => provisional.listen(0, '127.0.0.1', resolve));
  const { port } = provisional.address() as { port: number };
  await new Promise<void>((resolve) => provisional.close(() => resolve()));
  return port;
}

async function exitOutput(input: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../main.ts', import.meta.url)), '--loopback-port', '43125', '--bootstrap-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.stdin.end(input);
  await once(child, 'exit');
  return { stdout, stderr };
}

test('bootstrap creates strict session and CSRF guards mutations without CORS', async (t) => {
  const { server, port } = await startApp();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const denied = await call(port, 'POST', '/anything', { host, origin });
  assert.equal(denied.status, 403);
  const bootstrap = await call(port, 'POST', '/bootstrap', { host, origin, 'content-type': 'application/json' }, JSON.stringify({ token }));
  assert.equal(bootstrap.status, 204);
  assert.equal(bootstrap.headers['access-control-allow-origin'], undefined);
  assert.match(String(bootstrap.headers['set-cookie']), /HttpOnly; SameSite=Strict; Path=\//);
  const cookie = String(bootstrap.headers['set-cookie']).split(';', 1)[0];
  const csrf = String(bootstrap.headers['x-csrf-token']);
  const rejectedOrigin = await call(port, 'POST', '/anything', { host, origin: 'http://localhost:' + port, cookie, 'x-csrf-token': csrf });
  assert.equal(rejectedOrigin.status, 403);
  const accepted = await call(port, 'POST', '/anything', { host, origin, cookie, 'x-csrf-token': csrf });
  assert.equal(accepted.status, 404);
});

test('bootstrap token is absent from response bodies and malformed input remains a client error', async (t) => {
  const { server, port } = await startApp();
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const malformed = await call(port, 'POST', '/bootstrap', { host, origin, 'content-type': 'application/json' }, `{ "token": "${token}"`);
  assert.equal(malformed.status, 401);
  assert.equal(malformed.body.includes(token), false);
});

test('unexpected handler failures return a redacted 500 response', async (t) => {
  const port = await availablePort();
  const authenticator = {
    exchange(): never { throw new Error(`/private/${token}`); },
    hasValidCsrf(): boolean { return false; },
  } as unknown as LauncherAuthenticator;
  const server = createServer(createLocalApp(port, authenticator).handler);
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const response = await call(port, 'POST', '/bootstrap', {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
  }, JSON.stringify({ token }));
  assert.equal(response.status, 500);
  assert.equal(response.body.includes(token), false);
  assert.equal(response.body.includes('/private'), false);
});

test('readiness acknowledgement and startup errors never write the bootstrap token', async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../main.ts', import.meta.url)), '--loopback-port', String(port), '--bootstrap-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });
  child.stdin.end(`BOOTSTRAP ${token}\n`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not become ready')), 5_000);
    child.stdout.on('data', () => {
      if (stdout === 'READY\n') {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before readiness with code ${code}`));
    });
  });
  assert.equal(stdout, 'READY\n');
  assert.equal(stdout.includes(token), false);
  assert.equal(stderr.includes(token), false);
  child.kill();
  await once(child, 'exit');

  const failed = await exitOutput(`BOOTSTRAP ${token} extra\n`);
  assert.equal(failed.stdout.includes(token), false);
  assert.equal(failed.stderr.includes(token), false);
});

test('lifecycle binds only the configured IPv4 loopback interface', async (t) => {
  const port = 43124;
  const server = await listenLocalApp(createLocalApp(port, new LauncherAuthenticator(token)), port);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port });
});
