import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export type ArtifactFamily = 'excel' | 'access';
export type DetectedFormat = 'xlsx' | 'xlsm' | 'xls' | 'accdb' | 'mdb';

export type IntakeMetadata = Readonly<{
  id: string;
  sha256: string;
  family: ArtifactFamily;
  detectedFormat: DetectedFormat;
  size: number;
  createdAt: string;
}>;

const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EXTENSIONS: Readonly<Record<string, readonly [ArtifactFamily, DetectedFormat, 'zip' | 'compound']>> = Object.freeze({
  '.xlsx': ['excel', 'xlsx', 'zip'],
  '.xlsm': ['excel', 'xlsm', 'zip'],
  '.xls': ['excel', 'xls', 'compound'],
  '.accdb': ['access', 'accdb', 'compound'],
  '.mdb': ['access', 'mdb', 'compound'],
});

function hasPrefix(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

async function readSignature(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(8);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Artifact path escapes its storage root');
  }
}

export function detectFormat(fileName: string, signature: Buffer): Readonly<{ family: ArtifactFamily; detectedFormat: DetectedFormat }> {
  const extension = path.extname(fileName).toLowerCase();
  const expected = EXTENSIONS[extension];
  if (!expected) throw new Error('Unsupported artifact extension');
  const [family, detectedFormat, signatureKind] = expected;
  const matches = signatureKind === 'zip'
    ? hasPrefix(signature, ZIP_LOCAL_FILE_SIGNATURE)
    : hasPrefix(signature, COMPOUND_FILE_SIGNATURE);
  if (!matches) throw new Error('Artifact extension and file signature do not match');
  return Object.freeze({ family, detectedFormat });
}

/**
 * Copies an upload into an ID-only artifact store while hashing it. The returned
 * metadata is the only value suitable for callers outside the storage boundary.
 */
export async function intakeArtifact(options: Readonly<{
  sourcePath: string;
  originalName: string;
  artifactDirectory: string;
  maxBytes: number;
  now?: () => Date;
}>): Promise<IntakeMetadata> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new Error('Invalid upload limit');
  const source = await lstat(options.sourcePath);
  if (!source.isFile() || source.isSymbolicLink()) throw new Error('Upload source must be a regular non-symlink file');
  if (source.size < 1 || source.size > options.maxBytes) throw new Error('Upload exceeds policy limit');

  const format = detectFormat(options.originalName, await readSignature(options.sourcePath));
  const artifactDirectory = path.resolve(options.artifactDirectory);
  await mkdir(artifactDirectory, { recursive: true });
  const id = randomUUID();
  const destination = path.resolve(artifactDirectory, id);
  assertContained(artifactDirectory, destination);
  const temporary = `${destination}.partial`;
  const hash = createHash('sha256');

  try {
    const { createWriteStream } = await import('node:fs');
    await pipeline(
      createReadStream(options.sourcePath, { flags: 'r' }),
      async function* (sourceStream: AsyncIterable<Buffer>) {
        let copied = 0;
        for await (const chunk of sourceStream) {
          copied += chunk.length;
          if (copied > options.maxBytes) throw new Error('Upload changed or exceeds policy limit');
          hash.update(chunk);
          yield chunk;
        }
        if (copied !== source.size) throw new Error('Upload changed during intake');
      },
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    await chmod(temporary, 0o444);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  const metadata: IntakeMetadata = {
    id,
    sha256: hash.digest('hex'),
    family: format.family,
    detectedFormat: format.detectedFormat,
    size: source.size,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  return Object.freeze(metadata);
}
