#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const text = (command, args) => execFileSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gitPaths = (args) => text('git', args).split('\0').filter(Boolean);
const candidates = new Set([
  ...gitPaths(['ls-files', '-z']),
  ...gitPaths(['diff', '--name-only', '-z']),
  ...gitPaths(['diff', '--cached', '--name-only', '-z']),
  ...gitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
]);

const rootFiles = new Set([
  '.gitignore', '.nvmrc', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'rust-toolchain.toml', 'README.md',
]);
const sourceRoots = /^(?:apps|packages|scripts|tests|tools)\//;
const documentation = /^docs\/[A-Za-z0-9._/-]+\.(?:md|json|ya?ml)$/;
const workflow = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const binaryExtension = /\.(?:7z|apk|bin|class|dll|dmg|exe|gif|gz|ico|jar|jpeg|jpg|msi|node|pdf|png|pyc|rar|so|tar|tgz|wasm|zip)$/i;
const artifactSegment = /(?:^|\/)(?:\.gjc|\.gradle|\.pnpm-store|\.venv|coverage|dist|build|out|artifacts?|reports?|logs?|tmp|temp|node_modules|target)(?:\/|$)/i;
const runtimeSegment = /(?:^|\/)(?:jre|runtime|runtimes?|node-v?\d|portable|vendor)(?:\/|$)/i;

function allowed(file) {
  if (!file || path.posix.isAbsolute(file) || file.includes('..') || file.includes('\\')) return false;
  if (artifactSegment.test(file) || runtimeSegment.test(file) || binaryExtension.test(file)) return false;
  return rootFiles.has(file) || sourceRoots.test(file) || documentation.test(file) || workflow.test(file);
}

const invalid = [...candidates].filter((file) => {
  if (!allowed(file)) return true;
  const fullPath = path.join(root, file);
  return existsSync(fullPath) && !lstatSync(fullPath).isFile();
});
if (invalid.length) {
  throw new Error(`Publication candidates outside the source-only allowlist: ${invalid.sort().join(', ')}`);
}
console.log(`Source-only allowlist verified for ${candidates.size} tracked, staged, modified, or publishable path(s).`);
