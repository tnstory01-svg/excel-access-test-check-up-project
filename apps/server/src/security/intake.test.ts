import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_ZIP_PREFLIGHT_LIMITS, detectFormat, intakeArtifact, type ZipPreflightLimits } from './intake.ts';

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function workbookZip(macro = false): Buffer {
  const entries = [
    ['[Content_Types].xml', `<Types>${macro ? 'macroEnabled' : 'sheet'}</Types>`],
    ['_rels/.rels', '<Relationships/>'],
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships/>'],
  ] as const;
  const parts: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name); const valueBytes = Buffer.from(value); const checksum = crc32(valueBytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(checksum, 14); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt32LE(valueBytes.length, 18); local.writeUInt32LE(valueBytes.length, 22);
    parts.push(local, nameBytes, valueBytes);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt32LE(checksum, 16); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(valueBytes.length, 20); record.writeUInt32LE(valueBytes.length, 24); record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes); offset += local.length + nameBytes.length + valueBytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

function compoundFile(streams: readonly string[]): Buffer {
  const sectorCount = streams.length * 8 + 2; const bytes = Buffer.alloc(512 + sectorCount * 512, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);
  bytes.writeUInt16LE(0xfffe, 28); bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(9, 30); bytes.writeUInt16LE(6, 32);
  bytes.writeUInt32LE(1, 44); bytes.writeInt32LE(0, 48); bytes.writeUInt32LE(4096, 56); bytes.writeInt32LE(-2, 60); bytes.writeUInt32LE(0, 64);
  bytes.writeInt32LE(sectorCount - 1, 76); for (let offset = 80; offset < 512; offset += 4) bytes.writeInt32LE(-1, offset);
  const root = Buffer.from('Root Entry\0', 'utf16le'); root.copy(bytes, 512); bytes.writeUInt16LE(root.length, 512 + 64); bytes[512 + 66] = 5; bytes.writeInt32LE(streams.length ? 1 : -1, 512 + 76);
  for (let index = 0; index < streams.length; index += 1) {
    const name = Buffer.from(`${streams[index]}\0`, 'utf16le'); const offset = 512 + (index + 1) * 128;
    name.copy(bytes, offset); bytes.writeUInt16LE(name.length, offset + 64); bytes[offset + 66] = 2; bytes.writeInt32LE(index * 8 + 1, offset + 116); bytes.writeBigUInt64LE(4096n, offset + 120);
  }
  const fat = 512 + (sectorCount - 1) * 512;
  bytes.writeInt32LE(-2, fat);
  for (let index = 0; index < streams.length; index += 1) {
    const start = index * 8 + 1;
    for (let sector = start; sector < start + 7; sector += 1) bytes.writeInt32LE(sector + 1, fat + sector * 4);
    bytes.writeInt32LE(-2, fat + (start + 7) * 4);
  }
  bytes.writeInt32LE(-3, fat + (sectorCount - 1) * 4); for (let offset = sectorCount * 4; offset < 512; offset += 4) bytes.writeInt32LE(-1, fat + offset);
  return bytes;
}
function accessDatabase(engine: 'Jet' | 'ACE'): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x00, 0x01, 0x00, 0x00]).copy(bytes);
  Buffer.from(`Standard ${engine} DB\0`, 'ascii').copy(bytes, 4);
  bytes.writeUInt32LE(1, 20);
  return bytes;
}

const tinyZipLimits: ZipPreflightLimits = { entries: 1, entryBytes: 64, totalBytes: 64, compressionRatio: 100 };

test('intake copies immutable xlsx bytes and returns opaque metadata only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eag-intake-'));
  const source = path.join(root, 'source.xlsx'); const bytes = workbookZip();
  await writeFile(source, bytes);
  const metadata = await intakeArtifact({ sourcePath: source, originalName: 'answer.xlsx', artifactDirectory: path.join(root, 'LocalAppData', 'uploads'), zipLimits: DEFAULT_ZIP_PREFLIGHT_LIMITS });
  assert.deepEqual(await readFile(source), bytes);
  assert.deepEqual(Object.keys(metadata).sort(), ['createdAt', 'detectedFormat', 'family', 'id', 'sha256', 'size']);
  assert.equal(metadata.detectedFormat, 'xlsx');
  assert.equal((await readFile(path.join(root, 'LocalAppData', 'uploads', metadata.id))).equals(bytes), true);
});

test('intake rejects extension/container mismatches and reparse sources', async (t) => {
  assert.throws(() => detectFormat('bad.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04])), /ZIP container/);
  assert.throws(() => detectFormat('macro.xlsm', workbookZip()), /extension does not match/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'eag-intake-link-'));
  const source = path.join(root, 'source.xlsx'); const link = path.join(root, 'source-link.xlsx');
  await writeFile(source, workbookZip());
  try { await symlink(source, link); } catch { t.skip('Symlink creation is unavailable on this Windows host'); return; }
  await assert.rejects(intakeArtifact({ sourcePath: link, originalName: 'source.xlsx', artifactDirectory: path.join(root, 'uploads'), zipLimits: DEFAULT_ZIP_PREFLIGHT_LIMITS }), /non-symlink/);
});
test('ZIP preflight rejects entry-count boundaries, encryption, and corrupt local metadata', () => {
  assert.throws(() => detectFormat('book.xlsx', workbookZip(), tinyZipLimits), /preflight limit/);
  const encrypted = workbookZip(); const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(1, 6); encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => detectFormat('book.xlsx', encrypted), /unsafe ZIP entry/);
  const corrupt = workbookZip(); corrupt.writeUInt16LE(3, 26);
  assert.throws(() => detectFormat('book.xlsx', corrupt), /Corrupt ZIP entry/);
});
test('ZIP and compound preflight reject forged payload metadata', () => {
  const zip = workbookZip(); zip[30 + Buffer.byteLength('[Content_Types].xml')] ^= 1;
  assert.throws(() => detectFormat('book.xlsx', zip), /Corrupt ZIP entry/);
  const forged = compoundFile(['Workbook']); forged.writeBigUInt64LE(0n, 512 + 128 + 120);
  assert.throws(() => detectFormat('book.xls', forged), /Corrupt compound-file stream/);
});

test('compound files require Excel markers; Access uses bounded Jet and ACE database headers', () => {
  const excel = compoundFile(['Workbook']);
  const mdb = accessDatabase('Jet');
  const accdb = accessDatabase('ACE');
  assert.equal(detectFormat('book.xls', excel).detectedFormat, 'xls');
  assert.equal(detectFormat('database.mdb', mdb).detectedFormat, 'mdb');
  assert.equal(detectFormat('database.accdb', accdb).detectedFormat, 'accdb');
  assert.throws(() => detectFormat('database.mdb', accdb), /MDB extension does not match/);
  assert.throws(() => detectFormat('database.accdb', mdb), /ACCDB extension does not match/);
  assert.throws(() => detectFormat('database.mdb', excel), /Invalid MDB database header/);
  assert.throws(() => detectFormat('book.xls', mdb), /Invalid compound-file container/);
  const wrongVersion = accessDatabase('Jet'); wrongVersion[1] = 0;
  const corruptHeader = accessDatabase('ACE'); corruptHeader[12] = 0;
  assert.throws(() => detectFormat('database.mdb', wrongVersion), /Invalid MDB database header/);
  assert.throws(() => detectFormat('database.accdb', corruptHeader), /Invalid ACCDB database header/);
});
