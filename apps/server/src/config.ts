import path from 'node:path';

export const LOOPBACK_HOST = '127.0.0.1' as const;
export const APP_DIRECTORY_NAME = 'ExcelAccessGrader' as const;

export type ServerLimits = Readonly<{
  uploadBytes: number;
  artifactStoreBytes: number;
  zipEntries: number;
  zipEntryBytes: number;
  zipTotalBytes: number;
  zipCompressionRatio: number;
  apiJsonBytes: number;
  scratchBytes: number;
}>;

const DEFAULT_LIMITS: ServerLimits = Object.freeze({
  uploadBytes: 128 * 1024 * 1024,
  artifactStoreBytes: 2 * 1024 * 1024 * 1024,
  zipEntries: 10_000,
  zipEntryBytes: 64 * 1024 * 1024,
  zipTotalBytes: 512 * 1024 * 1024,
  zipCompressionRatio: 100,
  apiJsonBytes: 1024 * 1024,
  scratchBytes: 768 * 1024 * 1024,
});

function lowerOnlyLimit(name: string, defaultValue: number, value: string | undefined): number {
  if (value === undefined || value === '') return defaultValue;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > defaultValue) {
    throw new Error(`${name} may only lower its default limit`);
  }
  return parsed;
}

export function loadServerLimits(env: NodeJS.ProcessEnv = process.env): ServerLimits {
  return Object.freeze({
    uploadBytes: lowerOnlyLimit('EAG_UPLOAD_BYTES', DEFAULT_LIMITS.uploadBytes, env.EAG_UPLOAD_BYTES),
    artifactStoreBytes: lowerOnlyLimit('EAG_ARTIFACT_STORE_BYTES', DEFAULT_LIMITS.artifactStoreBytes, env.EAG_ARTIFACT_STORE_BYTES),
    zipEntries: lowerOnlyLimit('EAG_ZIP_ENTRIES', DEFAULT_LIMITS.zipEntries, env.EAG_ZIP_ENTRIES),
    zipEntryBytes: lowerOnlyLimit('EAG_ZIP_ENTRY_BYTES', DEFAULT_LIMITS.zipEntryBytes, env.EAG_ZIP_ENTRY_BYTES),
    zipTotalBytes: lowerOnlyLimit('EAG_ZIP_TOTAL_BYTES', DEFAULT_LIMITS.zipTotalBytes, env.EAG_ZIP_TOTAL_BYTES),
    zipCompressionRatio: lowerOnlyLimit('EAG_ZIP_COMPRESSION_RATIO', DEFAULT_LIMITS.zipCompressionRatio, env.EAG_ZIP_COMPRESSION_RATIO),
    apiJsonBytes: lowerOnlyLimit('EAG_API_JSON_BYTES', DEFAULT_LIMITS.apiJsonBytes, env.EAG_API_JSON_BYTES),
    scratchBytes: lowerOnlyLimit('EAG_SCRATCH_BYTES', DEFAULT_LIMITS.scratchBytes, env.EAG_SCRATCH_BYTES),
  });
}

export type LocalAppPaths = Readonly<{
  root: string;
  artifacts: string;
  tmp: string;
  data: string;
}>;

export function localAppPaths(env: NodeJS.ProcessEnv = process.env): LocalAppPaths {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error('LOCALAPPDATA must be an absolute path');
  }
  const root = path.resolve(localAppData, APP_DIRECTORY_NAME);
  if (path.dirname(root) !== path.resolve(localAppData)) {
    throw new Error('Local application root escapes LOCALAPPDATA');
  }
  return Object.freeze({ root, artifacts: path.join(root, 'uploads'), tmp: path.join(root, 'tmp'), data: path.join(root, 'data') });
}

export type LoopbackServerConfig = Readonly<{ host: typeof LOOPBACK_HOST; port: 0 }>;

/** Port zero delegates selection to the OS; callers must use the bound port for policy checks. */
export function loopbackServerConfig(): LoopbackServerConfig {
  return Object.freeze({ host: LOOPBACK_HOST, port: 0 });
}
