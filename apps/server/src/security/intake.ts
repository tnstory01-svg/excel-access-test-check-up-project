import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';

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

export const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export type ZipPreflightLimits = Readonly<{ entries: number; entryBytes: number; totalBytes: number; compressionRatio: number }>;
export const DEFAULT_ZIP_PREFLIGHT_LIMITS: ZipPreflightLimits = Object.freeze({
  entries: 10_000, entryBytes: 64 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, compressionRatio: 100,
});
const COMPOUND_FILE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ACCESS_HEADER_VERSION = Buffer.from([0x00, 0x01, 0x00, 0x00]);
const JET_DATABASE_HEADER = Buffer.from('Standard Jet DB\0', 'ascii');
const ACE_DATABASE_HEADER = Buffer.from('Standard ACE DB\0', 'ascii');
const EXTENSIONS: Readonly<Record<string, readonly [ArtifactFamily, DetectedFormat, 'zip' | 'compound' | 'access']>> = Object.freeze({
  '.xlsx': ['excel', 'xlsx', 'zip'], '.xlsm': ['excel', 'xlsm', 'zip'],
  '.xls': ['excel', 'xls', 'compound'], '.accdb': ['access', 'accdb', 'access'], '.mdb': ['access', 'mdb', 'access'],
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function hasPrefix(value: Buffer, prefix: Buffer): boolean {
  return value.length >= prefix.length && value.subarray(0, prefix.length).equals(prefix);
}

function compoundStreams(bytes: Buffer): Set<string> {
  if (bytes.length < 1024 || !hasPrefix(bytes, COMPOUND_FILE_SIGNATURE) || bytes.readUInt16LE(28) !== 0xfffe
    || ![3, 4].includes(bytes.readUInt16LE(26)) || ![9, 12].includes(bytes.readUInt16LE(30)) || bytes.readUInt16LE(32) !== 6
    || bytes.readUInt16LE(34) !== 0 || bytes.readUInt16LE(36) !== 0 || bytes.readUInt16LE(38) !== 0 || bytes.readUInt16LE(40) !== 0) {
    throw new Error('Invalid compound-file container');
  }
  const version = bytes.readUInt16LE(26); const sectorSize = 1 << bytes.readUInt16LE(30);
  if ((version === 3 && sectorSize !== 512) || (version === 4 && sectorSize !== 4096)
    || (version === 3 && bytes.readUInt32LE(40) !== 0) || bytes.readUInt32LE(56) !== 4096
    || (bytes.readUInt32LE(64) === 0) !== (bytes.readInt32LE(60) === -2)) throw new Error('Corrupt compound-file header');
  if ((bytes.length - 512) % sectorSize !== 0) throw new Error('Corrupt compound-file container');
  const sectorCount = (bytes.length - 512) / sectorSize;
  const sector = (id: number): Buffer => {
    const start = 512 + id * sectorSize;
    if (!Number.isInteger(id) || id < 0 || id >= sectorCount) throw new Error('Corrupt compound-file container');
    return bytes.subarray(start, start + sectorSize);
  };
  const fatCount = bytes.readUInt32LE(44); const fatIds: number[] = [];
  for (let offset = 76; offset < 512; offset += 4) {
    const id = bytes.readInt32LE(offset);
    if (id >= 0) fatIds.push(id);
    else if (id !== -1 && id !== -2) throw new Error('Corrupt compound-file header');
  }
  if (fatCount < 1 || fatIds.length !== fatCount || new Set(fatIds).size !== fatIds.length) throw new Error('Corrupt compound-file container');
  const fat = Buffer.concat(fatIds.map(sector));
  for (const id of fatIds) if (fat.readInt32LE(id * 4) !== -3) throw new Error('Corrupt compound-file FAT');
  const next = (id: number): number => {
    if (id < 0 || id >= sectorCount || id >= fat.length / 4) throw new Error('Corrupt compound-file FAT');
    return fat.readInt32LE(id * 4);
  };
  const directoryIds: number[] = []; const seen = new Set<number>(); let id = bytes.readInt32LE(48);
  while (id !== -2) {
    if (seen.has(id) || directoryIds.length >= sectorCount) throw new Error('Corrupt compound-file directory');
    seen.add(id); directoryIds.push(id); id = next(id);
  }
  if (directoryIds.length === 0) throw new Error('Corrupt compound-file directory');
  const directory = Buffer.concat(directoryIds.map(sector)); const streams = new Set<string>();
  const rootName = directory.subarray(0, 64).toString('utf16le').replace(/\0+$/, '');
  if (rootName !== 'Root Entry' || directory[66] !== 5 || directory.readUInt16LE(64) !== 22) throw new Error('Corrupt compound-file directory');
  for (let offset = 0; offset < directory.length; offset += 128) {
    const nameLength = directory.readUInt16LE(offset + 64); const type = directory[offset + 66];
    if (type === 0) continue;
    if (![1, 2, 5].includes(type) || nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0
      || directory[offset + nameLength - 2] !== 0 || directory[offset + 67] > 1) throw new Error('Corrupt compound-file directory');
    const name = directory.subarray(offset, offset + nameLength - 2).toString('utf16le');
    if (type !== 2) continue;
    const start = directory.readInt32LE(offset + 116); const size = Number(directory.readBigUInt64LE(offset + 120));
    if (!Number.isSafeInteger(size) || size < 1 || start < 0 || size < 4096) throw new Error('Corrupt compound-file stream');
    const required = Math.ceil(size / sectorSize); let streamId = start; const streamSeen = new Set<number>();
    for (let index = 0; index < required; index += 1) {
      if (streamSeen.has(streamId)) throw new Error('Corrupt compound-file stream');
      streamSeen.add(streamId); sector(streamId); streamId = next(streamId);
    }
    if (streamId !== -2) throw new Error('Corrupt compound-file stream');
    streams.add(name);
  }
  return streams;
}

function assertCompoundContainer(bytes: Buffer): void {
  const streams = compoundStreams(bytes); const excel = streams.has('Workbook') || streams.has('Book');
  if (!excel) throw new Error('Compound container is not an Excel workbook');
}

function assertAccessDatabase(format: Extract<DetectedFormat, 'mdb' | 'accdb'>, bytes: Buffer): void {
  const header = format === 'mdb' ? JET_DATABASE_HEADER : ACE_DATABASE_HEADER;
  const otherHeader = format === 'mdb' ? ACE_DATABASE_HEADER : JET_DATABASE_HEADER;
  if (bytes.length >= ACCESS_HEADER_VERSION.length + otherHeader.length
    && hasPrefix(bytes, ACCESS_HEADER_VERSION)
    && bytes.subarray(ACCESS_HEADER_VERSION.length, ACCESS_HEADER_VERSION.length + otherHeader.length).equals(otherHeader)) {
    throw new Error(`${format.toUpperCase()} extension does not match database header`);
  }
  if (bytes.length < ACCESS_HEADER_VERSION.length + header.length
    || !hasPrefix(bytes, ACCESS_HEADER_VERSION)
    || !bytes.subarray(ACCESS_HEADER_VERSION.length, ACCESS_HEADER_VERSION.length + header.length).equals(header)) {
    throw new Error(`Invalid ${format.toUpperCase()} database header`);
  }
}

type ZipEntry = Readonly<{ method: number; compressed: Buffer; uncompressedSize: number; crc32: number }>;

function zipEntries(bytes: Buffer, limits: ZipPreflightLimits): Map<string, ZipEntry> {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid ZIP preflight limits');
  if (!hasPrefix(bytes, ZIP_LOCAL_FILE_SIGNATURE)) throw new Error('Invalid ZIP container');
  const start = Math.max(0, bytes.length - 65_557); let eocd = -1;
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  if (eocd < 0 || eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length || bytes.readUInt16LE(eocd + 4) !== 0
    || bytes.readUInt16LE(eocd + 6) !== 0 || bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)) throw new Error('Invalid ZIP container');
  const count = bytes.readUInt16LE(eocd + 10); const directorySize = bytes.readUInt32LE(eocd + 12); let offset = bytes.readUInt32LE(eocd + 16);
  const directoryEnd = offset + directorySize;
  if (count > limits.entries || directoryEnd !== eocd || directoryEnd > bytes.length) throw new Error('ZIP preflight limit exceeded');
  const entries = new Map<string, ZipEntry>(); let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10); const compressedSize = bytes.readUInt32LE(offset + 20); const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32); const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > directoryEnd || nameLength === 0 || flags & 0x2049 || ![0, 8].includes(method) || uncompressedSize > limits.entryBytes
      || (compressedSize === 0 && uncompressedSize !== 0) || (compressedSize > 0 && uncompressedSize > compressedSize * limits.compressionRatio)
      || total + uncompressedSize > limits.totalBytes || localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid or unsafe ZIP entry');
    const localFlags = bytes.readUInt16LE(localOffset + 6); const localMethod = bytes.readUInt16LE(localOffset + 8); const localCrc32 = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18); const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26); const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method || localCrc32 !== bytes.readUInt32LE(offset + 16) || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize
      || dataStart + compressedSize > offset || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(bytes.subarray(offset + 46, offset + 46 + nameLength))) throw new Error('Corrupt ZIP entry');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || entries.has(name)) throw new Error('Invalid or duplicate ZIP entry');
    entries.set(name, Object.freeze({ method, compressed: bytes.subarray(dataStart, dataStart + compressedSize), uncompressedSize, crc32: localCrc32 }));
    total += uncompressedSize; offset = end;
  }
  if (offset !== directoryEnd) throw new Error('Invalid ZIP central directory');
  return entries;
}

function assertZipOfficeContainer(format: DetectedFormat, bytes: Buffer, limits: ZipPreflightLimits): void {
  const entries = zipEntries(bytes, limits); const contentTypes = entries.get('[Content_Types].xml');
  if (!contentTypes || !entries.has('_rels/.rels') || !entries.has('xl/workbook.xml') || !entries.has('xl/_rels/workbook.xml.rels')) {
    throw new Error('ZIP container is not an Excel workbook');
  }
  let types: Buffer | undefined;
  for (const [name, entry] of entries) {
    const inflated = entry.method === 0 ? entry.compressed : inflateRawSync(entry.compressed, { maxOutputLength: entry.uncompressedSize });
    if (inflated.length !== entry.uncompressedSize || crc32(inflated) !== entry.crc32) throw new Error('Corrupt ZIP entry');
    if (name === '[Content_Types].xml') types = inflated;
  }
  if (!types || (format === 'xlsm') !== types.toString('utf8').includes('macroEnabled')) throw new Error('Excel extension does not match workbook container');
}

function assertSafeDirectory(directory: string): Promise<void> {
  return (async () => {
    const resolved = path.resolve(directory);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Artifact storage contains a reparse point');
    }
  })();
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact path escapes its storage root');
}

export function detectFormat(fileName: string, bytes: Buffer, zipLimits: ZipPreflightLimits = DEFAULT_ZIP_PREFLIGHT_LIMITS): Readonly<{ family: ArtifactFamily; detectedFormat: DetectedFormat }> {
  const expected = EXTENSIONS[path.extname(fileName).toLowerCase()];
  if (!expected) throw new Error('Unsupported artifact extension');
  const [family, detectedFormat, signatureKind] = expected;
  if (signatureKind === 'zip') assertZipOfficeContainer(detectedFormat, bytes, zipLimits);
  else if (signatureKind === 'compound') assertCompoundContainer(bytes);
  else assertAccessDatabase(detectedFormat as Extract<DetectedFormat, 'mdb' | 'accdb'>, bytes);
  return Object.freeze({ family, detectedFormat });
}

async function readPreflight(filePath: string): Promise<Buffer> {
  const source = await open(filePath, 'r');
  try {
    const stat = await source.stat();
    const bytes = Buffer.alloc(stat.size);
    await source.read(bytes, 0, bytes.length, 0);
    return bytes;
  } finally { await source.close(); }
}

function sameSourceSnapshot(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.isFile() && !left.isSymbolicLink() && right.isFile() && !right.isSymbolicLink()
    && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Copies an upload once into an ID-only read-only artifact store while hashing it. */
export async function intakeArtifact(options: Readonly<{
  sourcePath: string; originalName: string; artifactDirectory: string; maxBytes?: number; zipLimits: ZipPreflightLimits; now?: () => Date;
}>): Promise<IntakeMetadata> {
  const maxBytes = options.maxBytes ?? MAX_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) throw new Error('Invalid upload limit');
  const initial = await lstat(options.sourcePath);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('Upload source must be a regular non-symlink file');
  if (initial.size < 1 || initial.size > maxBytes) throw new Error('Upload exceeds policy limit');
  const artifactDirectory = path.resolve(options.artifactDirectory);
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(artifactDirectory);
  const id = randomUUID();
  const destination = path.resolve(artifactDirectory, id);
  assertContained(artifactDirectory, destination);
  const temporary = `${destination}.partial`;
  const hash = createHash('sha256');
  const source = await open(options.sourcePath, 'r');
  try {
    const snapshot = await source.stat();
    if (!sameSourceSnapshot(initial, snapshot)) throw new Error('Upload source changed before intake');
    await pipeline(source.createReadStream({ autoClose: false }), async function* (stream: AsyncIterable<Buffer>) {
      let copied = 0;
      for await (const chunk of stream) {
        copied += chunk.length;
        if (copied > maxBytes) throw new Error('Upload changed or exceeds policy limit');
        hash.update(chunk);
        yield chunk;
      }
      if (copied !== snapshot.size) throw new Error('Upload changed during intake');
    }, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (!sameSourceSnapshot(snapshot, await source.stat())) throw new Error('Upload changed during intake');
    const copiedBytes = await readPreflight(temporary);
    if (copiedBytes.length !== snapshot.size) throw new Error('Upload changed during intake');
    const format = detectFormat(options.originalName, copiedBytes, options.zipLimits);
    await chmod(temporary, 0o444);
    await rename(temporary, destination);
    return Object.freeze({ id, sha256: hash.digest('hex'), family: format.family, detectedFormat: format.detectedFormat, size: snapshot.size, createdAt: (options.now ?? (() => new Date()))().toISOString() });
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
}
