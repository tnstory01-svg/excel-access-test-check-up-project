#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const NODE_VERSION = '22.14.0';
const PNPM_VERSION = '10.13.1';
const RUST_VERSION = '1.88.0';
const RUST_TARGET = 'x86_64-pc-windows-msvc';
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const failures = [];
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const require = (condition, message) => { if (!condition) failures.push(message); };

const rootPackage = await readJson(path.join(root, 'package.json'));
require(rootPackage.packageManager === `pnpm@${PNPM_VERSION}`, `package.json packageManager must be pnpm@${PNPM_VERSION}`);
require(rootPackage.engines?.node === NODE_VERSION, `package.json engines.node must be ${NODE_VERSION}`);
require(rootPackage.engines?.pnpm === PNPM_VERSION, `package.json engines.pnpm must be ${PNPM_VERSION}`);
require((await readFile(path.join(root, '.nvmrc'), 'utf8')).trim() === NODE_VERSION, `.nvmrc must be ${NODE_VERSION}`);
const rustToolchain = await readFile(path.join(root, 'rust-toolchain.toml'), 'utf8');
require(new RegExp(`^channel\\s*=\\s*["']${RUST_VERSION}["']`, 'm').test(rustToolchain), `rust-toolchain.toml must pin Rust ${RUST_VERSION}`);
require(new RegExp(`^targets\\s*=\\s*\\[.*["']${RUST_TARGET}["'].*\\]`, 'm').test(rustToolchain), `rust-toolchain.toml must pin ${RUST_TARGET}`);
const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
require(/^lockfileVersion:\s*['"]?9\.0['"]?\s*$/m.test(lockfile), 'pnpm-lock.yaml must use lockfileVersion 9.0');

async function packageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.gjc') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await packageFiles(fullPath));
    else if (entry.isFile() && entry.name === 'package.json') files.push(fullPath);
  }
  return files;
}

for (const packageFile of await packageFiles(root)) {
  const manifest = await readJson(packageFile);
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      require(typeof version === 'string' && exactVersion.test(version), `${path.relative(root, packageFile)} ${field}.${name} must use an exact version, not ${JSON.stringify(version)}`);
    }
  }
}

if (existsSync(path.join(root, 'gradle/wrapper/gradle-wrapper.properties'))) {
  const wrapper = await readFile(path.join(root, 'gradle/wrapper/gradle-wrapper.properties'), 'utf8');
  require(/distributionUrl=.*gradle-8\.14\.3-bin\.zip/.test(wrapper), 'Gradle wrapper must pin 8.14.3');
  require(/distributionSha256Sum=[0-9a-f]{64}/i.test(wrapper), 'Gradle wrapper must declare an official SHA-256');
}

if (failures.length) throw new Error(`Dependency pin verification failed:\n- ${failures.join('\n- ')}`);
console.log(`Dependency pins verified: Node ${NODE_VERSION}, pnpm ${PNPM_VERSION}, Rust ${RUST_VERSION} (${RUST_TARGET}).`);
