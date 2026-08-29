import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  sanitizeTitle, sanitizeExtension, buildRelativePath, parseRelativePath, assertSafeRelativePath,
} from '../src/storage/paths.js';
import { FilesystemDriver, StorageError } from '../src/storage/filesystem-driver.js';

// ---------- paths ----------

test('sanitizeTitle preserves Arabic and removes illegal characters', () => {
  assert.equal(sanitizeTitle('عقد إيجار'), 'عقد_إيجار');
  assert.equal(sanitizeTitle('a/b\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeTitle('trailing dots...'), 'trailing_dots');
  assert.equal(sanitizeTitle('   '), 'document');
  assert.equal(sanitizeTitle(''), 'document');
  assert.equal(sanitizeTitle(null), 'document');
});

test('sanitizeTitle refuses Windows reserved device names', () => {
  assert.equal(sanitizeTitle('CON'), 'document');
  assert.equal(sanitizeTitle('lpt1'), 'document');
  assert.equal(sanitizeTitle('nul.txt'), 'document');
});

test('sanitizeTitle truncates without leaving trailing junk', () => {
  const long = 'ع'.repeat(500);
  assert.equal(sanitizeTitle(long, 50).length, 50);
  assert.ok(!sanitizeTitle('x'.repeat(40) + '   ', 42).endsWith(' '));
});

test('sanitizeExtension normalises', () => {
  assert.equal(sanitizeExtension('report.PDF'), '.pdf');
  assert.equal(sanitizeExtension('.docx'), '.docx');
  assert.equal(sanitizeExtension('noextension'), '');
  assert.equal(sanitizeExtension(''), '');
  assert.equal(sanitizeExtension(null), '');
});

test('buildRelativePath produces the Option C layout', () => {
  const p = buildRelativePath({
    documentId: 10432, version: 2, title: 'عقد إيجار مبنى الإدارة',
    originalFilename: 'scan.pdf', createdAt: new Date(2026, 7, 14),
  });
  assert.equal(p, '2026/08/10432_v2_عقد_إيجار_مبنى_الإدارة.pdf');
});

test('buildRelativePath rejects bad input', () => {
  const base = { documentId: 1, version: 1, title: 't', createdAt: new Date() };
  assert.throws(() => buildRelativePath({ ...base, documentId: null }), TypeError);
  assert.throws(() => buildRelativePath({ ...base, version: 0 }), TypeError);
  assert.throws(() => buildRelativePath({ ...base, createdAt: 'nope' }), TypeError);
});

test('parseRelativePath round-trips', () => {
  const parsed = parseRelativePath('2026/08/10432_v2_عقد_إيجار.pdf');
  assert.equal(parsed.documentId, 10432);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.extension, '.pdf');
  assert.equal(parseRelativePath('garbage'), null);
});

test('assertSafeRelativePath blocks traversal and absolute paths', () => {
  assert.equal(assertSafeRelativePath('2026/08/a.pdf'), '2026/08/a.pdf');
  assert.throws(() => assertSafeRelativePath('../../etc/passwd'), /escapes/);
  assert.throws(() => assertSafeRelativePath('2026/../../../x'), /escapes/);
  assert.throws(() => assertSafeRelativePath('C:\Windows\System32'), /absolute/);
  assert.throws(() => assertSafeRelativePath('\\nas\share'), /absolute/);
  assert.throws(() => assertSafeRelativePath('/etc/passwd'), /absolute/);
  assert.throws(() => assertSafeRelativePath('a\u0000b'), /null byte/);
  assert.throws(() => assertSafeRelativePath(''), /empty/);
});

// ---------- driver ----------

async function withDriver(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'dms-store-'));
  const driver = new FilesystemDriver({ root });
  await driver.init();
  try { return await fn(driver, root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('put stores the file, returns the real hash, and verifies', async () => {
  await withDriver(async (driver, root) => {
    const payload = Buffer.from('محتوى المستند التجريبي', 'utf8');
    const expected = createHash('sha256').update(payload).digest('hex');

    const result = await driver.put(Readable.from([payload]), {
      relativePath: '2026/08/1_v1_عقد.pdf',
    });

    assert.equal(result.sha256, expected);
    assert.equal(result.bytes, payload.length);
    assert.deepEqual(await readFile(path.join(root, '2026', '08', '1_v1_عقد.pdf')), payload);
    assert.equal((await driver.verify(result.relativePath, expected)).ok, true);
    assert.equal((await driver.verify(result.relativePath, 'deadbeef')).ok, false);
  });
});

test('put enforces maxBytes and leaves nothing behind', async () => {
  await withDriver(async (driver) => {
    await assert.rejects(
      driver.put(Readable.from([Buffer.alloc(5000)]), { relativePath: '2026/08/2_v1_big.bin', maxBytes: 1000 }),
      (e) => e instanceof StorageError && e.code === 'upload_too_large',
    );
    assert.equal(await driver.exists('2026/08/2_v1_big.bin'), false);
    // The failed put cleans up its own temp file, so the sweep has nothing left to find.
    assert.equal((await driver.cleanupTemp({ olderThanMs: -1 })).removed, 0);
  });
});

test('put rejects a zero-byte upload', async () => {
  await withDriver(async (driver) => {
    await assert.rejects(
      driver.put(Readable.from([]), { relativePath: '2026/08/3_v1_empty.pdf' }),
      (e) => e.code === 'empty_upload',
    );
  });
});

test('put refuses to escape the storage root', async () => {
  await withDriver(async (driver) => {
    await assert.rejects(
      driver.put(Readable.from([Buffer.from('x')]), { relativePath: '../escape.pdf' }),
      /escapes/,
    );
  });
});

test('range reads return the requested slice', async () => {
  await withDriver(async (driver) => {
    await driver.put(Readable.from([Buffer.from('0123456789')]), { relativePath: '2026/08/4_v1_r.txt' });
    const chunks = [];
    for await (const c of driver.createReadStream('2026/08/4_v1_r.txt', { start: 2, end: 5 })) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), '2345');
  });
});

test('stat and exists behave on missing files', async () => {
  await withDriver(async (driver) => {
    assert.equal(await driver.exists('2026/08/nope.pdf'), false);
    await assert.rejects(driver.stat('2026/08/nope.pdf'), (e) => e.code === 'not_found');
  });
});

test('a failed put never deletes an existing file at the destination', async () => {
  await withDriver(async (driver, root) => {
    const rel = '2026/08/5_v1_keep.pdf';
    const original = Buffer.from('original content');
    await driver.put(Readable.from([original]), { relativePath: rel });

    const failing = new Readable({ read() { this.destroy(new Error('network dropped')); } });
    await assert.rejects(driver.put(failing, { relativePath: rel }));

    // The pre-existing file must survive a failed concurrent write.
    assert.deepEqual(await readFile(path.join(root, '2026', '08', '5_v1_keep.pdf')), original);
  });
});
