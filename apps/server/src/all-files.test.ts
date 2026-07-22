import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(serverRoot, 'src');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(candidate);
  }
  return files;
}

function checkFiles(files: readonly string[]): void {
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--check', file], {
      cwd: serverRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${path.relative(serverRoot, file)}\n${result.stderr}`);
  }
}

test('every server TypeScript source and test file parses under Node', async () => {
  checkFiles(await sourceFiles(sourceRoot));
});

function run(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { cwd: serverRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  return { command: [command, ...args].join(' '), status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: readonly string[], input?: string): string | null {
  const result = spawnSync('git', args, { cwd: serverRoot, encoding: 'utf8', input });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function writeQaReport(): Promise<void> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const results = [run(npm, ['run', 'typecheck']), run(npm, ['run', 'test:unit'])];
  const report = {
    gitTree: git(['rev-parse', 'HEAD^{tree}']),
    gitDiffHash: git(['hash-object', '--stdin'], git(['diff', '--binary']) ?? ''),
    nodeVersion: process.version,
    results,
  };
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const reportHash = createHash('sha256').update(body).digest('hex');
  const output = `${JSON.stringify({ ...report, reportHash }, null, 2)}\n`;
  const outputDirectory = path.join(serverRoot, 'tmp');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'qa-report.json'), output, 'utf8');
  if (results.some((result) => result.status !== 0)) process.exitCode = 1;
}

if (process.argv[2] === '--qa-report') await writeQaReport();
