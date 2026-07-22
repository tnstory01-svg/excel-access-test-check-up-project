import { createLocalApp, listenLocalApp } from './app.ts';
import { LauncherAuthenticator, readLauncherBootstrapToken } from './launcher-auth.ts';

function requestedPort(args: readonly string[]): number {
  if (args.length !== 3 || args[0] !== '--loopback-port' || args[2] !== '--bootstrap-stdin' || !/^\d+$/.test(args[1])) {
    throw new Error('Usage: server --loopback-port <port> --bootstrap-stdin');
  }
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Loopback port must be valid');
  return port;
}

async function main(): Promise<void> {
  const port = requestedPort(process.argv.slice(2));
  const token = await readLauncherBootstrapToken(process.stdin);
  const app = createLocalApp(port, new LauncherAuthenticator(token));
  await listenLocalApp(app, port);
  // Readiness is an acknowledgement only; the bootstrap secret remains stdin-only.
  process.stdout.write('READY\n');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Server startup failed';
  process.stderr.write(`server startup failed: ${message}\n`);
  process.exitCode = 1;
});
