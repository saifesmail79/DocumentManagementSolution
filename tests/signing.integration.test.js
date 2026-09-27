/**
 * Integration tests for ink signing (التوقيع).
 *
 * ─── What this suite is actually for ────────────────────────────────────────
 *
 * That `POST /sign` answers 201 proves almost nothing. The failure this
 * feature has to be protected against is a signature that lands in the wrong
 * place: offset by a margin, upside down on a page the printer rotated, or
 * shifted by the distance between a MediaBox origin and a CropBox origin. None
 * of those throws, all of them save cleanly, and every one of them puts
 * somebody's name somewhere they did not put it.
 *
 * So the placement assertions here are the point of the file. Three PDFs are
 * built with pdf-lib — a plain A4, one turned by /Rotate 90, and one whose
 * MediaBox starts at (100, 100) with a CropBox inset 50 points inside it — a
 * black square is drawn into ONE known corner of the overlay, and the signed
 * result is rasterised again through the same Ghostscript path the person drew
 * on. The assertion is that the corner is dark and the opposite corner is
 * still white. That is the only form of the check that would have caught any of
 * the three mistakes above.
 *
 * ─── Why the overlays come from sharp and an SVG ────────────────────────────
 *
 * An overlay has to be a real PNG of an exact pixel size with a mark in an
 * exact place, and it has to be built by something other than the code under
 * test. sharp rasterises an SVG at the size its attributes declare, so the
 * mark's position is arithmetic in the test rather than a fixture nobody can
 * re-derive. sharp also reads the result back with `.raw()`, which is how the
 * corners are counted.
 *
 * Ghostscript is required for every raster assertion and those cases `t.skip`
 * when it is absent, as tests/renditions.integration.test.js does. The
 * database-only cases — the switch, the refusals, the ledger, the audit trail —
 * run either way.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-signing-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;
// Must precede any import of src/config, which reads process.env once and
// freezes it. The renderer's own queue is not wanted here — this suite calls
// the page renderer directly through the route — but Ghostscript's PATH comes
// from the deployment's .env either way.
process.env.RENDITIONS_ENABLED = 'false';
process.env.OCR_ENABLED = 'false';

const renditions = await import('../src/modules/renditions/service.js');
const tools = await renditions.detectTools({ force: true });
const GHOSTSCRIPT = tools.ghostscript.available;
const NO_GHOSTSCRIPT = 'Ghostscript is not installed on this host';

const SKIP = target.configured ? false : target.reason;
const PASSWORD = 'correct-horse-battery-staple';
const DPI = 150;

let db;
let sql;
let app;
let PERM;
let storage;

const id = {};
const doc = {};

// ── Fixture builders ─────────────────────────────────────────────────────

/**
 * A blank PDF of a chosen shape.
 *
 * Blank on purpose: every placement assertion counts non-white pixels, so any
 * ink the fixture itself carries would be indistinguishable from a signature.
 */
async function makePdf({ rotate = 0, origin = 0, size = [595.28, 841.89], cropInset = 0, pages = 1 } = {}) {
  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.create();

  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage(size);
    if (origin) page.setMediaBox(origin, origin, size[0], size[1]);
    if (cropInset) {
      page.setCropBox(
        origin + cropInset,
        origin + cropInset,
        size[0] - 2 * cropInset,
        size[1] - 2 * cropInset,
      );
    }
    if (rotate) page.setRotation(degrees(rotate));
  }

  return Buffer.from(await pdf.save());
}

/** A transparent PNG of exactly `width`×`height` with a solid square in one corner. */
async function overlay({ width, height, corner = 'top-left', fraction = 0.25 }) {
  const sharp = (await import('sharp')).default;
  const markWidth = Math.round(width * fraction);
  const markHeight = Math.round(height * fraction);
  const x = corner.endsWith('right') ? width - markWidth : 0;
  const y = corner.startsWith('bottom') ? height - markHeight : 0;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect x="${x}" y="${y}" width="${markWidth}" height="${markHeight}" fill="#000000"/>`
    + '</svg>';

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, width, 'the overlay builder must produce the exact width asked for');
  assert.equal(meta.height, height, 'the overlay builder must produce the exact height asked for');
  return png;
}

function asDataUrl(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** How many pixels in a rectangle are darker than near-white, on every channel. */
async function darkCount(png, corner) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });

  // A twelve-percent square inset two percent from the edges: comfortably
  // inside a quarter-page mark, and far from the provenance line, which sits at
  // the displayed bottom-left and is a few millimetres tall.
  const boxWidth = Math.round(info.width * 0.12);
  const boxHeight = Math.round(info.height * 0.12);
  const left = corner.endsWith('right') ? info.width - boxWidth - Math.round(info.width * 0.02) : Math.round(info.width * 0.02);
  const top = corner.startsWith('bottom') ? info.height - boxHeight - Math.round(info.height * 0.02) : Math.round(info.height * 0.02);

  let dark = 0;
  for (let y = top; y < top + boxHeight; y += 1) {
    for (let x = left; x < left + boxWidth; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      if (data[offset] < 200 && data[offset + 1] < 200 && data[offset + 2] < 200) dark += 1;
    }
  }
  return { dark, total: boxWidth * boxHeight };
}

function expectedRaster(width, height) {
  return { width: Math.round((width / 72) * DPI), height: Math.round((height / 72) * DPI) };
}

// ── Database and HTTP helpers ────────────────────────────────────────────

async function makeUser(username, { superAdmin = false, displayName = null } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${displayName ?? username})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin, email)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0}, ${`${username}@example.test`})
  `.execute(db);
  id[username] = pid;
  return pid;
}

async function makeFolder(name) {
  const r = await sql`
    INSERT INTO dbo.folders (parent_id, name, mpath, depth)
    OUTPUT INSERTED.folder_id AS fid VALUES (NULL, ${name}, '/pending/', 0)
  `.execute(db);
  const fid = r.rows[0].fid;
  await sql`UPDATE dbo.folders SET mpath = ${`/${fid}/`} WHERE folder_id = ${fid}`.execute(db);
  id[name] = fid;
  return fid;
}

async function grant(folder, username, bits) {
  await sql`
    INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
    VALUES (${id[folder]}, ${id[username]}, ${bits}, 0)
  `.execute(db);
}

async function signIn(username) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200, response.body);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

const call = (method, url, cookie, payload) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });

function multipart(files, fields = {}) {
  const boundary = '----dmssigning';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n`
          + `Content-Type: ${file.contentType}\r\n\r\n`,
        'utf8',
      ),
      file.content,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, body: Buffer.concat(chunks) };
}

async function upload(cookie, folder, filename, content, contentType = 'application/pdf') {
  const { boundary, body } = multipart([{ filename, content, contentType }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id[folder]}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

async function uploadMultiFile(cookie, folder, filenames, content) {
  const { boundary, body } = multipart(
    filenames.map((filename) => ({ filename, content, contentType: 'application/pdf' })),
    { mode: 'single', title: 'ملف متعدد' },
  );
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id[folder]}/documents/batch`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  const json = response.json();
  return String(json.documentId ?? json.created?.[0]?.documentId);
}

async function addVersionThrough(cookie, documentId, filename, content) {
  const { boundary, body } = multipart([{ filename, content, contentType: 'application/pdf' }]);
  const response = await app.inject({
    method: 'POST',
    url: `/api/documents/${documentId}/versions`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().version;
}

/** The PNG the server rendered for a page, plus its pixel size. */
async function fetchPage(cookie, documentId, page, version) {
  const query = version ? `?version=${version}` : '';
  const response = await call('GET', `/api/signing/documents/${documentId}/pages/${page}${query}`, cookie);
  assert.equal(response.statusCode, 200, response.body?.slice?.(0, 300) ?? '');
  assert.equal(response.headers['content-type'], 'image/png');
  const sharp = (await import('sharp')).default;
  const png = response.rawPayload;
  const meta = await sharp(png).metadata();
  return { png, width: meta.width, height: meta.height };
}

describe('ink signing (التوقيع)', { skip: SKIP }, () => {
  let signer;
  let reader;
  let browser;
  let other;
  let boss;
  let outsider;
  let arabicSigner;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();

    // Settings survive resetDatabase on purpose; a previous run's switch state
    // must not decide what "disabled" means in this one. The upload policy is
    // cleared too, because one case below sets it and a crash mid-run would
    // otherwise leave every later upload refused.
    await sql`DELETE FROM dbo.app_settings WHERE setting_key IN ('signing.enabled', 'upload.allowed_extensions')`.execute(db);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('signer');
    await makeUser('reader');
    await makeUser('browser');
    await makeUser('other');
    await makeUser('outsider');
    await makeUser('boss', { superAdmin: true });
    await makeUser('arabic', { displayName: 'علي عبد الله الموسوي' });

    await makeFolder('signing');
    await grant('signing', 'signer', PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('signing', 'reader', PERM.BROWSE | PERM.READ);
    await grant('signing', 'browser', PERM.BROWSE);
    await grant('signing', 'other', PERM.BROWSE | PERM.READ | PERM.UPLOAD);
    await grant('signing', 'arabic', PERM.BROWSE | PERM.READ | PERM.UPLOAD);

    signer = await signIn('signer');
    reader = await signIn('reader');
    browser = await signIn('browser');
    other = await signIn('other');
    boss = await signIn('boss');
    outsider = await signIn('outsider');
    arabicSigner = await signIn('arabic');

    const plain = await makePdf();
    const rotated = await makePdf({ rotate: 90 });
    const cropped = await makePdf({ origin: 100, cropInset: 50 });
    const twoPage = await makePdf({ pages: 2 });

    doc.plain = await upload(signer, 'signing', 'letter.pdf', plain);
    doc.rotated = await upload(signer, 'signing', 'rotated.pdf', rotated);
    doc.cropped = await upload(signer, 'signing', 'cropped.pdf', cropped);
    doc.twoPage = await upload(signer, 'signing', 'two-pages.pdf', twoPage);
    doc.flip = await upload(signer, 'signing', 'flip.pdf', await makePdf());
    doc.arabic = await upload(arabicSigner, 'signing', 'قرار إداري.pdf', await makePdf());
    doc.held = await upload(signer, 'signing', 'held.pdf', await makePdf());
    doc.lockedDoc = await upload(signer, 'signing', 'locked.pdf', await makePdf());
    doc.text = await upload(signer, 'signing', 'notes.txt', Buffer.from('نص عادي', 'utf8'), 'text/plain');
    // The largest page PDF permits: 14400 × 14400 points, which at 150 dpi is a
    // 30000 × 30000 = 900 megapixel raster. Every ceiling in the module has to
    // refuse it, and refuse it before Ghostscript is asked to make it.
    doc.huge = await upload(signer, 'signing', 'plan.pdf', await makePdf({ size: [14400, 14400] }));
    // Four pages, used by the concurrency case alone so that no earlier test
    // has put any of them in the page cache.
    doc.parallel = await upload(signer, 'signing', 'parallel.pdf', await makePdf({ pages: 4 }));
    doc.multi = await uploadMultiFile(signer, 'signing', ['a.pdf', 'b.pdf'], plain);

    const held = await call('POST', `/api/documents/${doc.held}/legal-hold`, boss, {
      hold: true,
      reason: 'قضية',
    });
    assert.equal(held.statusCode, 200, held.body);

    const lock = await call('POST', `/api/documents/${doc.lockedDoc}/checkout`, other);
    assert.equal(lock.statusCode, 200, lock.body);
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The switch ─────────────────────────────────────────────────────────

  test('while the switch is off, status says so and nothing else answers', async () => {
    const status = await call('GET', '/api/signing/status', signer);
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().enabled, false);

    const described = await call('GET', `/api/signing/documents/${doc.plain}`, signer);
    assert.equal(described.statusCode, 409);
    assert.equal(described.json().error, 'signing_disabled');

    const geometry = await call('GET', `/api/signing/documents/${doc.plain}/pages`, signer);
    assert.equal(geometry.statusCode, 409);

    const page = await call('GET', `/api/signing/documents/${doc.plain}/pages/1`, signer);
    assert.equal(page.statusCode, 409);

    const signed = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [],
    });
    assert.equal(signed.statusCode, 409);
    assert.equal(signed.json().error, 'signing_disabled');
  });

  test('the switch turns on through the ordinary settings surface', async () => {
    const set = await call('PUT', '/api/settings/signing.enabled', boss, { value: true });
    assert.equal(set.statusCode, 200, set.body);

    const status = await call('GET', '/api/signing/status', signer);
    assert.equal(status.json().enabled, true);
  });

  // ── describe ───────────────────────────────────────────────────────────

  test('a browse-only caller learns nothing but the refusal', async () => {
    const response = await call('GET', `/api/signing/documents/${doc.plain}`, browser);
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.enabled, true);
    assert.equal(body.canRead, false);
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'forbidden');

    // Nothing about the document itself: not its name, not how many versions it
    // has, and above all not who has signed it.
    assert.equal(body.filename, undefined);
    assert.equal(body.version, undefined);
    assert.equal(body.signatures, undefined);
    assert.equal(body.title, undefined);
  });

  test('a reader without upload permission is refused, but sees the document', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.plain}`, reader)).json();
    assert.equal(body.canRead, true);
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'forbidden');
    assert.equal(body.version, 1);
    assert.equal(body.filename, 'letter.pdf');
    assert.deepEqual(body.signatures, []);
  });

  test('someone who cannot see the folder gets not_found, never a refusal', async () => {
    const response = await call('GET', `/api/signing/documents/${doc.plain}`, outsider);
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'not_found');
  });

  test('a multi-file document is refused by name', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.multi}`, signer)).json();
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'multi_file_document');
  });

  test('a document that is not a PDF is refused by name', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.text}`, signer)).json();
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'not_pdf');
  });

  test('a document under legal hold cannot be signed', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.held}`, signer)).json();
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'legal_hold');
  });

  test('a document checked out by somebody else names the holder', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.lockedDoc}`, signer)).json();
    assert.equal(body.canSign, false);
    assert.equal(body.reason, 'locked');
    assert.equal(body.lockedBy.name, 'other');
    assert.ok(body.lockedBy.since, 'the refusal should say since when');
  });

  test('a single-file PDF the caller may upload to can be signed', async () => {
    const body = (await call('GET', `/api/signing/documents/${doc.plain}`, signer)).json();
    assert.equal(body.enabled, true);
    assert.equal(body.canRead, true);
    assert.equal(body.canSign, true);
    assert.equal(body.reason, undefined);
    assert.equal(body.version, 1);
    assert.deepEqual(body.signatures, []);
  });

  test('an install whose extension list excludes pdf says so before anyone draws', async () => {
    const set = await call('PUT', '/api/settings/upload.allowed_extensions', boss, { value: ['txt'] });
    assert.equal(set.statusCode, 200, set.body);

    try {
      const body = (await call('GET', `/api/signing/documents/${doc.plain}`, signer)).json();
      assert.equal(body.canSign, false);
      assert.equal(body.reason, 'pdf_not_allowed');

      const refused = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
        version: 1,
        pages: [{ number: 1, image: 'data:image/png;base64,AAAA' }],
      });
      assert.equal(refused.statusCode, 415);
      assert.equal(refused.json().error, 'pdf_not_allowed');
    } finally {
      const cleared = await call('DELETE', '/api/settings/upload.allowed_extensions', boss);
      assert.equal(cleared.statusCode, 200, cleared.body);
    }
  });

  // ── Geometry ───────────────────────────────────────────────────────────

  test('geometry reports A4 as displayed, unrotated', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const response = await call('GET', `/api/signing/documents/${doc.plain}/pages`, signer);
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.equal(body.pageCount, 1);
    assert.equal(body.dpi, DPI);
    assert.equal(body.pages[0].number, 1);
    assert.equal(body.pages[0].rotation, 0);
    assert.ok(Math.abs(body.pages[0].width - 595.28) < 0.1, `width ${body.pages[0].width}`);
    assert.ok(Math.abs(body.pages[0].height - 841.89) < 0.1, `height ${body.pages[0].height}`);
  });

  test('geometry swaps width and height for a page turned by 90 degrees', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const body = (await call('GET', `/api/signing/documents/${doc.rotated}/pages`, signer)).json();
    assert.equal(body.pages[0].rotation, 90);
    assert.ok(Math.abs(body.pages[0].width - 841.89) < 0.1, `width ${body.pages[0].width}`);
    assert.ok(Math.abs(body.pages[0].height - 595.28) < 0.1, `height ${body.pages[0].height}`);
  });

  test('geometry reports the CropBox, not the MediaBox', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const body = (await call('GET', `/api/signing/documents/${doc.cropped}/pages`, signer)).json();
    assert.equal(body.pages[0].rotation, 0);
    assert.ok(Math.abs(body.pages[0].width - (595.28 - 100)) < 0.1, `width ${body.pages[0].width}`);
    assert.ok(Math.abs(body.pages[0].height - (841.89 - 100)) < 0.1, `height ${body.pages[0].height}`);
  });

  /*
   * The point of this case: the ceiling on an overlay's pixels used to be read
   * only when the finished ink arrived, so a large-format page was described as
   * drawable, rendered, drawn on, and only then refused — with a message whose
   * advice ("refresh and redraw") produced the identical refusal every time.
   * Geometry is the answer the panel sizes its canvas from, so it is the place
   * that has to say "not this page".
   */
  test('a page too big to raster is reported as unsignable, not as drawable', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const response = await call('GET', `/api/signing/documents/${doc.huge}/pages`, signer);
    assert.equal(response.statusCode, 200, response.body);

    const body = response.json();
    assert.ok(body.maxPixels > 0, 'the ceiling must be published, not guessed at by the client');
    assert.equal(body.pages[0].signable, false);
    assert.equal(body.pages[0].reason, 'too_large');
    assert.ok(
      body.pages[0].pixels > body.maxPixels,
      `${body.pages[0].pixels} pixels should be over the ${body.maxPixels} ceiling`,
    );

    // And an ordinary page is still offered, flagged the other way.
    const ordinary = (await call('GET', `/api/signing/documents/${doc.plain}/pages`, signer)).json();
    assert.equal(ordinary.pages[0].signable, true);
    assert.equal(ordinary.pages[0].reason, undefined);
    assert.ok(ordinary.pages[0].pixels <= ordinary.maxPixels);
  });

  test('geometry is refused to somebody who cannot read the document', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const response = await call('GET', `/api/signing/documents/${doc.plain}/pages`, browser);
    assert.equal(response.statusCode, 404);
  });

  test('a page number that is not a small integer is refused before any work', async () => {
    const bad = await call('GET', `/api/signing/documents/${doc.plain}/pages/abc`, signer);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_page');

    const zero = await call('GET', `/api/signing/documents/${doc.plain}/pages/0`, signer);
    assert.equal(zero.statusCode, 400);

    const huge = await call('GET', `/api/signing/documents/${doc.plain}/pages/99999`, signer);
    assert.equal(huge.statusCode, 400);

    const badVersion = await call('GET', `/api/signing/documents/${doc.plain}/pages/1?version=x`, signer);
    assert.equal(badVersion.statusCode, 400);
  });

  // ── Page images ────────────────────────────────────────────────────────

  test('a page comes back as a PNG of the size the contract promises', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const response = await call('GET', `/api/signing/documents/${doc.plain}/pages/1`, signer);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.match(response.headers['cache-control'], /immutable/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');

    const sharp = (await import('sharp')).default;
    const meta = await sharp(response.rawPayload).metadata();
    const want = expectedRaster(595.28, 841.89);
    assert.ok(Math.abs(meta.width - want.width) <= 2, `${meta.width} vs ${want.width}`);
    assert.ok(Math.abs(meta.height - want.height) <= 2, `${meta.height} vs ${want.height}`);
  });

  test('a rotated page is rendered in the orientation it is displayed in', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(signer, doc.rotated, 1);
    assert.ok(rendered.width > rendered.height, `${rendered.width}×${rendered.height} should be landscape`);
  });

  /*
   * The render end has to refuse the same page the save end would.
   *
   * Asserted by the clock as well as by the status: Ghostscript needs minutes
   * for a 900 megapixel page and is killed at `signing.timeoutMs` (60 s), so an
   * answer inside a couple of seconds is the evidence that nothing was spawned.
   */
  test('a page too big to raster is refused before Ghostscript is spawned', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const started = Date.now();
    const response = await call('GET', `/api/signing/documents/${doc.huge}/pages/1`, signer);
    const elapsed = Date.now() - started;

    assert.equal(response.statusCode, 413, response.body);
    const body = response.json();
    assert.equal(body.error, 'too_large');
    assert.ok(body.limit > 0, 'the refusal says what the ceiling is');
    assert.ok(elapsed < 10_000, `refused in ${elapsed} ms — a render would have taken far longer`);
  });

  /*
   * Renders are the one per-request subprocess spawn in the system, so they are
   * capped at two at a time. What must hold under parallel load: no request is
   * left without an answer, a refusal is the named `busy` and not a crash, and —
   * the regression that would be invisible otherwise — the slots are handed
   * back, so the next render still works.
   */
  test('parallel page renders are bounded, and the slots are given back', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const responses = await Promise.all(
      [1, 2, 3, 4].map((page) =>
        call('GET', `/api/signing/documents/${doc.parallel}/pages/${page}`, signer),
      ),
    );

    for (const response of responses) {
      assert.ok(
        response.statusCode === 200 || response.statusCode === 503,
        `unexpected ${response.statusCode}: ${response.body?.slice?.(0, 200) ?? ''}`,
      );
      if (response.statusCode === 503) assert.equal(response.json().error, 'busy');
    }
    assert.ok(
      responses.some((response) => response.statusCode === 200),
      'at least two slots were free, so at least one render must have succeeded',
    );

    const after = await call('GET', `/api/signing/documents/${doc.parallel}/pages/1`, signer);
    assert.equal(after.statusCode, 200, `a leaked slot would refuse for ever: ${after.body?.slice?.(0, 200) ?? ''}`);
  });

  test('a page image is refused to somebody who cannot read the document', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const response = await call('GET', `/api/signing/documents/${doc.plain}/pages/1`, browser);
    assert.equal(response.statusCode, 404);
  });

  // ── Refusals on the way to a signature ─────────────────────────────────

  test('signing a version that is no longer current is a conflict', async () => {
    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 7,
      pages: [{ number: 1, image: 'data:image/png;base64,AAAA' }],
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'conflict');
    assert.equal(response.json().version, 1);
  });

  test('a request with no pages is no_strokes', async () => {
    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'no_strokes');
  });

  test('more pages than one save may carry is too_many_pages', async () => {
    const pages = [];
    for (let number = 1; number <= 21; number += 1) {
      pages.push({ number, image: 'data:image/png;base64,AAAA' });
    }

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages,
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error, 'too_many_pages');
  });

  test('the same page twice is refused rather than drawn twice', async () => {
    // A real PNG, so the refusal is about the repeated page and not about the
    // bytes: the duplicate is caught while reading the list, before any image
    // is measured against a page.
    const small = asDataUrl(await overlay({ width: 40, height: 40 }));

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [
        { number: 1, image: small },
        { number: 1, image: small },
      ],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_page');
  });

  test('an overlay of the wrong pixel size is refused, not stretched', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(signer, doc.plain, 1);
    const wrong = await overlay({ width: rendered.width - 40, height: rendered.height });

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [{ number: 1, image: asDataUrl(wrong) }],
    });
    assert.equal(response.statusCode, 400, response.body);

    const body = response.json();
    assert.equal(body.error, 'invalid_image');
    assert.match(body.detail, /expected/);
  });

  test('a PNG whose header declares an enormous image is refused before any decoder runs', async () => {
    const small = await overlay({ width: 40, height: 40 });

    // The IHDR sits at a fixed offset, so the declared size can be rewritten
    // without touching anything else. The CRC is now wrong — deliberately: this
    // must be refused on the twelve bytes of the header, long before a decoder
    // would have had the chance to notice.
    const lying = Buffer.from(small);
    lying.writeUInt32BE(40000, 16);
    lying.writeUInt32BE(40000, 20);

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [{ number: 1, image: asDataUrl(lying) }],
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid_image');
    assert.match(response.json().detail, /pixels/);
  });

  test('bytes that are not a PNG at all are invalid_image', async () => {
    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [{ number: 1, image: Buffer.from('this is not an image at all, not even close').toString('base64') }],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_image');
  });

  test('a page past the end of the document is invalid_page', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(signer, doc.plain, 1);
    const mark = await overlay({ width: rendered.width, height: rendered.height });

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: 1,
      pages: [{ number: 4, image: asDataUrl(mark) }],
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, 'invalid_page');
  });

  test('a document under legal hold refuses the save as well as the offer', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(signer, doc.plain, 1);
    const mark = await overlay({ width: rendered.width, height: rendered.height });

    const response = await call('POST', `/api/signing/documents/${doc.held}/sign`, signer, {
      version: 1,
      pages: [{ number: 1, image: asDataUrl(mark) }],
    });
    assert.equal(response.statusCode, 423, response.body);
    assert.equal(response.json().error, 'legal_hold');
  });

  // ── The signature itself ───────────────────────────────────────────────

  test('signing creates a new version, a ledger row and an audit trail', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const before = (await call('GET', `/api/signing/documents/${doc.plain}`, signer)).json();
    const rendered = await fetchPage(signer, doc.plain, 1);
    const mark = await overlay({ width: rendered.width, height: rendered.height });

    const response = await call('POST', `/api/signing/documents/${doc.plain}/sign`, signer, {
      version: before.version,
      note: 'موافق على الصرف',
      pages: [{ number: 1, image: asDataUrl(mark) }],
    });
    assert.equal(response.statusCode, 201, response.body);

    const body = response.json();
    assert.equal(body.version, 2);
    assert.equal(body.ledger, true);
    assert.ok(body.signatureId);
    assert.match(body.sha256, /^[0-9a-f]{64}$/);
    assert.match(body.fromSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(body.sha256, body.fromSha256, 'the signed bytes must differ from the ones signed');
    assert.deepEqual(body.pages, [1]);

    // The version row exists and is the current one, with the ink's own hash.
    const versions = await sql`
      SELECT version_number, sha256, mime_type, original_filename, comment
        FROM dbo.document_versions
       WHERE document_id = ${doc.plain} ORDER BY version_number
    `.execute(db);
    assert.equal(versions.rows.length, 2);
    assert.equal(Number(versions.rows[1].version_number), 2);
    assert.equal(versions.rows[1].sha256, body.sha256);
    assert.equal(versions.rows[1].mime_type, 'application/pdf');
    assert.match(versions.rows[1].original_filename, /\.pdf$/);
    assert.match(versions.rows[1].comment, /^توقيع:/);

    const current = await sql`
      SELECT current_version FROM dbo.documents WHERE document_id = ${doc.plain}
    `.execute(db);
    assert.equal(Number(current.rows[0].current_version), 2);

    // The ledger carries both hashes, so "which bytes were signed" needs no join.
    const ledger = await sql`
      SELECT version_number, pages_json, note, from_sha256, sha256, signed_by
        FROM dbo.document_signatures WHERE document_id = ${doc.plain}
    `.execute(db);
    assert.equal(ledger.rows.length, 1);
    assert.equal(Number(ledger.rows[0].version_number), 2);
    assert.equal(ledger.rows[0].pages_json, '[1]');
    assert.equal(ledger.rows[0].note, 'موافق على الصرف');
    assert.equal(ledger.rows[0].from_sha256, body.fromSha256);
    assert.equal(ledger.rows[0].from_sha256, versions.rows[0].sha256);
    assert.equal(ledger.rows[0].sha256, body.sha256);
    assert.equal(String(ledger.rows[0].signed_by), String(id.signer));

    const audit = await sql`
      SELECT action, detail FROM dbo.audit_log
       WHERE target_id = ${String(doc.plain)} AND actor_username = 'signer'
       ORDER BY audit_id
    `.execute(db);
    const actions = audit.rows.map((row) => row.action);
    assert.ok(actions.includes('document.version_added'), actions.join(','));
    assert.ok(actions.includes('document.signed'), actions.join(','));

    const signedRow = audit.rows.find((row) => row.action === 'document.signed');
    assert.match(signedRow.detail, /^v2 pages \[1\]/);
    assert.match(signedRow.detail, /sha256 [0-9a-f]{64} from [0-9a-f]{64}/);
  });

  test('the signature is listed, and stops being current when a later version arrives', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(signer, doc.flip, 1);
    const mark = await overlay({ width: rendered.width, height: rendered.height });

    const signed = await call('POST', `/api/signing/documents/${doc.flip}/sign`, signer, {
      version: 1,
      note: 'توقيع أولي',
      pages: [{ number: 1, image: asDataUrl(mark) }],
    });
    assert.equal(signed.statusCode, 201, signed.body);

    const listed = (await call('GET', `/api/signing/documents/${doc.flip}`, signer)).json();
    assert.equal(listed.version, 2);
    assert.equal(listed.signatures.length, 1);

    const [signature] = listed.signatures;
    assert.equal(signature.version, 2);
    assert.equal(signature.signedBy, 'signer');
    assert.deepEqual(signature.pages, [1]);
    assert.equal(signature.note, 'توقيع أولي');
    assert.equal(signature.isCurrent, true);
    assert.match(signature.signedAt, /^\d{4}-\d{2}-\d{2}T/);

    // Somebody uploads an ordinary new version afterwards. The signature is
    // still a true record of version 2, and must now say so.
    const version = await addVersionThrough(signer, doc.flip, 'replacement.pdf', await makePdf());
    assert.equal(version, 3);

    const after = (await call('GET', `/api/signing/documents/${doc.flip}`, signer)).json();
    assert.equal(after.version, 3);
    assert.equal(after.signatures.length, 1);
    assert.equal(after.signatures[0].isCurrent, false);
  });

  test('two pages of one document can be signed in a single save', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const first = await fetchPage(signer, doc.twoPage, 1);
    const second = await fetchPage(signer, doc.twoPage, 2);

    const response = await call('POST', `/api/signing/documents/${doc.twoPage}/sign`, signer, {
      version: 1,
      pages: [
        { number: 2, image: asDataUrl(await overlay({ width: second.width, height: second.height })) },
        { number: 1, image: asDataUrl(await overlay({ width: first.width, height: first.height })) },
      ],
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json().pages, [1, 2], 'the ledger records the pages in order');
  });

  test('an Arabic display name does not break the provenance line', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);

    const rendered = await fetchPage(arabicSigner, doc.arabic, 1);
    const mark = await overlay({ width: rendered.width, height: rendered.height });

    const response = await call('POST', `/api/signing/documents/${doc.arabic}/sign`, arabicSigner, {
      version: 1,
      pages: [{ number: 1, image: asDataUrl(mark) }],
    });
    assert.equal(response.statusCode, 201, response.body);

    // The name is kept where it renders — the version comment and the ledger —
    // and never handed to a standard PDF font.
    const listed = (await call('GET', `/api/signing/documents/${doc.arabic}`, arabicSigner)).json();
    assert.equal(listed.signatures[0].signedBy, 'علي عبد الله الموسوي');
  });

  // ── Placement: the assertions this file exists for ──────────────────────

  /**
   * Sign one page with a mark in `corner` and re-render the signed version,
   * then assert the mark is where it was drawn and nowhere else.
   */
  async function provePlacement(cookie, documentId, { corner = 'top-left', opposite = 'bottom-right' } = {}) {
    const before = (await call('GET', `/api/signing/documents/${documentId}`, cookie)).json();
    const rendered = await fetchPage(cookie, documentId, 1, before.version);

    const cleanCorner = await darkCount(rendered.png, corner);
    assert.equal(cleanCorner.dark, 0, 'the fixture page must start blank in the corner being tested');

    const mark = await overlay({ width: rendered.width, height: rendered.height, corner });
    const response = await call('POST', `/api/signing/documents/${documentId}/sign`, cookie, {
      version: before.version,
      pages: [{ number: 1, image: asDataUrl(mark) }],
    });
    assert.equal(response.statusCode, 201, response.body);

    const after = await fetchPage(cookie, documentId, 1, response.json().version);
    assert.equal(after.width, rendered.width, 'signing must not resize the page');
    assert.equal(after.height, rendered.height, 'signing must not resize the page');

    const inked = await darkCount(after.png, corner);
    const untouched = await darkCount(after.png, opposite);

    assert.ok(
      inked.dark > inked.total * 0.9,
      `the ${corner} corner should be covered by the signature (${inked.dark} of ${inked.total})`,
    );
    assert.equal(
      untouched.dark,
      0,
      `the ${opposite} corner should be untouched (${untouched.dark} dark pixels)`,
    );
  }

  test('ink lands where it was drawn on an ordinary page', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);
    const documentId = await upload(signer, 'signing', 'place-plain.pdf', await makePdf());
    await provePlacement(signer, documentId);
  });

  test('ink lands where it was drawn on a page turned by 90 degrees', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);
    const documentId = await upload(signer, 'signing', 'place-rotated.pdf', await makePdf({ rotate: 90 }));
    await provePlacement(signer, documentId);
  });

  test('ink lands inside the CropBox, not the MediaBox', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);
    const documentId = await upload(
      signer,
      'signing',
      'place-cropped.pdf',
      await makePdf({ origin: 100, cropInset: 50 }),
    );
    await provePlacement(signer, documentId);
  });

  test('ink drawn in the bottom-right lands in the bottom-right', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);
    const documentId = await upload(signer, 'signing', 'place-corner.pdf', await makePdf());
    await provePlacement(signer, documentId, { corner: 'bottom-right', opposite: 'top-right' });
  });

  test('ink drawn on a rotated page in the bottom-right lands there too', async (t) => {
    if (!GHOSTSCRIPT) return t.skip(NO_GHOSTSCRIPT);
    const documentId = await upload(
      signer,
      'signing',
      'place-rotated-corner.pdf',
      await makePdf({ rotate: 90 }),
    );
    await provePlacement(signer, documentId, { corner: 'bottom-right', opposite: 'top-right' });
  });
});
