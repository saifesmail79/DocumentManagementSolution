/**
 * Integration tests for the official letter formats (النماذج).
 *
 * The whole story: the switch, what a .docx has to be before it is accepted,
 * how placeholders are discovered, who may use a format, what the fields may be
 * mapped to, and then a real letter — merged, converted by LibreOffice, filed as
 * an ordinary document with its metadata, its provenance row, its audit trail
 * and its approval.
 *
 * The .docx fixtures are built here with pizzip rather than committed as binary
 * files, so what each test is actually feeding the validator is readable in the
 * test: a header part, an external relationship, a DOCTYPE, an unclosed tag.
 *
 * The conversion cases need LibreOffice. They ask the module's own status route
 * and skip when it is absent, exactly as tests/renditions.integration.test.js
 * does — but LibreOffice IS installed on the development machine, so a skipped
 * run there means something is wrong, not that the suite passed.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-forms-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;
process.env.RENDITIONS_ENABLED = 'false';
// One conversion at a time, so the "busy" refusal is reachable from two
// requests rather than from eight.
process.env.FORMS_MAX_CONCURRENT = '1';

let db;
let sql;
let app;
let PERM;
let storage;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};
const ids = {};

let libreOffice = false;

// ── Fixtures ─────────────────────────────────────────────────────────────

/**
 * One paragraph. A string is visible text; `{ raw }` is WordprocessingML written
 * out as it stands, which is how a test builds a real field instruction or the
 * revision attributes Word puts on every paragraph it saves.
 */
function para(text) {
  if (text && typeof text === 'object' && typeof text.raw === 'string') return text.raw;
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * The smallest thing LibreOffice and docxtemplater both accept as a Word
 * document: the content types, the package relationship, a body, and
 * optionally a header part referenced from the section properties.
 */
function buildDocx({ body = [], header = null, extra = {}, externalRel = false, doctype = false } = {}) {
  const zip = new PizZip();

  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    header
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
      : '',
  ].join('');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`,
  );

  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );

  const sectPr = header
    ? '<w:sectPr><w:headerReference xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId10" w:type="default"/></w:sectPr>'
    : '';
  const prologue = doctype
    ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE w:document [<!ENTITY x "y">]>'
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  zip.file(
    'word/document.xml',
    // w14 and mc are declared as Word declares them, so a fixture can carry the
    // w14:paraId / w14:textId attributes every Word-saved paragraph has.
    `${prologue}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"` +
      ` xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"` +
      ` xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"` +
      ` mc:Ignorable="w14"><w:body>${body.map(para).join('')}${sectPr}</w:body></w:document>`,
  );

  if (header || externalRel) {
    const relationships = [
      header
        ? '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
        : '',
      externalRel
        ? '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://example.invalid/logo.png" TargetMode="External"/>'
        : '',
    ].join('');
    zip.file(
      'word/_rels/document.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    );
  }

  if (header) {
    zip.file(
      'word/header1.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${header
        .map(para)
        .join('')}</w:hdr>`,
    );
  }

  for (const [name, content] of Object.entries(extra)) zip.file(name, content);

  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The format the whole suite uses: a body with four tags and a header with one. */
function letterTemplate() {
  return buildDocx({
    body: [
      'To {{addressee}}',
      'Subject: {{subject}}',
      '{{body}}',
      'Date {{date}} ({{date_iso}}) by {{author}}',
    ],
    header: ['Ref {{reference}}'],
  });
}

// ── Plumbing ─────────────────────────────────────────────────────────────

async function makeUser(username, { superAdmin = false } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin, email)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0}, ${`${username}@example.test`})
  `.execute(db);
  id[username] = pid;
  return pid;
}

async function makeGroup(name, members = []) {
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('group', ${name})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`INSERT INTO dbo.groups (group_id, name) VALUES (${pid}, ${name})`.execute(db);
  for (const member of members) {
    await sql`INSERT INTO dbo.group_members (group_id, member_principal_id) VALUES (${pid}, ${member})`.execute(db);
  }
  id[name] = pid;
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

async function grant(folderName, principalName, bits) {
  await sql`
    INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
    VALUES (${id[folderName]}, ${id[principalName]}, ${bits}, 0)
  `.execute(db);
}

async function makeType(name) {
  const r = await sql`
    INSERT INTO dbo.document_types (name) OUTPUT INSERTED.type_id AS tid VALUES (${name})
  `.execute(db);
  return Number(r.rows[0].tid);
}

async function makeField(name, dataType, { typeId = null, required = false } = {}) {
  const r = await sql`
    INSERT INTO dbo.custom_field_defs (type_id, name, data_type, is_required)
    OUTPUT INSERTED.field_id AS fid
    VALUES (${typeId}, ${name}, ${dataType}, ${required ? 1 : 0})
  `.execute(db);
  return Number(r.rows[0].fid);
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

/** A multipart body with the scalar fields first, exactly as the routes require. */
function multipart(fields, file) {
  const boundary = '----dmsforms';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}\r\n\r\n`,
        'utf8',
      ),
      file.buffer,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { boundary, payload: Buffer.concat(chunks) };
}

function uploadTemplate(cookie, fields, file, { method = 'POST', url = '/api/admin/forms/templates' } = {}) {
  const { boundary, payload } = multipart(fields, file);
  return app.inject({
    method,
    url,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

/** The text layer of a PDF, for proving what actually reached the page. */
async function pdfText(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const parts = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      parts.push(content.items.map((item) => (typeof item.str === 'string' ? item.str : '')).join(' '));
      page.cleanup();
    }
    return parts.join('\n');
  } finally {
    await task.destroy().catch(() => {});
  }
}

describe('official letter formats', { skip: CONFIGURED ? false : target.reason }, () => {
  let boss;
  let kateb;
  let outsider;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();

    // Settings survive resetDatabase on purpose; a previous run's switch must
    // not decide what "disabled" means in this one.
    await sql`DELETE FROM dbo.app_settings WHERE setting_key LIKE 'forms.%'`.execute(db);
    await sql`DELETE FROM dbo.app_settings WHERE setting_key = 'upload.duplicate_policy'`.execute(db);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('kateb');
    await makeUser('mudeer');
    await makeUser('outsider');
    await makeUser('boss', { superAdmin: true });

    await makeGroup('قسم الكتب', [id.kateb]);

    await makeFolder('letters');
    await makeFolder('closed');
    await grant('letters', 'قسم الكتب', PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE);
    await grant('letters', 'mudeer', PERM.BROWSE | PERM.READ);

    ids.typeOfficial = await makeType('كتاب رسمي');
    ids.typeOther = await makeType('نوع آخر');
    ids.fieldSubject = await makeField('الموضوع', 'text', { typeId: ids.typeOfficial });
    ids.fieldReference = await makeField('رقم الإشارة', 'text', {
      typeId: ids.typeOfficial,
      required: true,
    });
    ids.fieldClassification = await makeField('التصنيف', 'choice');
    ids.fieldForeign = await makeField('حقل نوع آخر', 'text', { typeId: ids.typeOther });

    boss = await signIn('boss');
    kateb = await signIn('kateb');
    outsider = await signIn('outsider');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The switch ─────────────────────────────────────────────────────────

  test('while the switch is off, status says so and nothing else answers', async () => {
    const status = await call('GET', '/api/forms/status', kateb);
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { enabled: false });

    const templates = await call('GET', '/api/forms/templates', kateb);
    assert.equal(templates.statusCode, 409);
    assert.equal(templates.json().error, 'forms_disabled');

    const generated = await call('POST', '/api/forms/generate', kateb, {
      templateId: '1',
      folderId: String(id.letters),
      title: 'x',
      values: {},
    });
    assert.equal(generated.statusCode, 409);
    assert.equal(generated.json().error, 'forms_disabled');

    const admin = await call('GET', '/api/admin/forms/templates', boss);
    assert.equal(admin.statusCode, 409);
    assert.equal(admin.json().error, 'forms_disabled');

    // The admin status route answers regardless: the readiness line is how an
    // administrator learns LibreOffice is missing BEFORE turning the switch on.
    const adminStatus = await call('GET', '/api/admin/forms/status', boss);
    assert.equal(adminStatus.statusCode, 200);
    assert.equal(adminStatus.json().enabled, false);
  });

  test('the switch turns on through the ordinary settings surface', async () => {
    const set = await call('PUT', '/api/settings/forms.enabled', boss, { value: true });
    assert.equal(set.statusCode, 200, set.body);

    const status = await call('GET', '/api/forms/status', kateb);
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().templates, 0);
    assert.equal(typeof status.json().ready, 'boolean');

    const adminStatus = await call('GET', '/api/admin/forms/status', boss);
    libreOffice = adminStatus.json().libreOffice === true;
    assert.equal(adminStatus.json().enabled, true);
  });

  test('only a super admin configures formats', async () => {
    const refused = await call('GET', '/api/admin/forms/templates', kateb);
    assert.equal(refused.statusCode, 403);
  });

  // ── What a .docx has to be ─────────────────────────────────────────────

  test('a file that is not a .docx is refused before anything is parsed', async () => {
    const wrongExtension = await uploadTemplate(
      boss,
      { name: 'نموذج' },
      { filename: 'letter.doc', buffer: Buffer.from('not a zip') },
    );
    assert.equal(wrongExtension.statusCode, 415);
    assert.equal(wrongExtension.json().error, 'blocked_extension');

    const notAZip = await uploadTemplate(
      boss,
      { name: 'نموذج' },
      { filename: 'letter.docx', buffer: Buffer.from('still not a zip') },
    );
    assert.equal(notAZip.statusCode, 400);
    assert.equal(notAZip.json().error, 'template_invalid');
    assert.match(notAZip.json().detail, /Word/);
  });

  test('a template with no file at all says so', async () => {
    const { boundary, payload } = multipart({ name: 'نموذج' }, null);
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/forms/templates',
      headers: { cookie: boss, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'no_file');
  });

  test('an external relationship, a DOCTYPE, a stray part and a field code are each refused by name', async () => {
    const external = await uploadTemplate(
      boss,
      { name: 'خارجي' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['{{a}}'], externalRel: true }) },
    );
    assert.equal(external.statusCode, 400);
    assert.equal(external.json().error, 'template_invalid');
    assert.match(external.json().detail, /External/);

    const entities = await uploadTemplate(
      boss,
      { name: 'كيانات' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['{{a}}'], doctype: true }) },
    );
    assert.equal(entities.statusCode, 400);
    assert.match(entities.json().detail, /DOCTYPE/);

    const stray = await uploadTemplate(
      boss,
      { name: 'زائد' },
      {
        filename: 'x.docx',
        buffer: buildDocx({ body: ['{{a}}'], extra: { 'payload.exe': 'MZ' } }),
      },
    );
    assert.equal(stray.statusCode, 400);
    assert.match(stray.json().detail, /payload\.exe/);

    // A real field code lives in a <w:instrText> run between two fldChars, which
    // is the only place the scan looks — the same words typed as ordinary text
    // are just words, and Word gives no way to remove them from a letterhead.
    const fieldCode = await uploadTemplate(
      boss,
      { name: 'حقل' },
      {
        filename: 'x.docx',
        buffer: buildDocx({
          body: [
            '{{a}}',
            {
              raw:
                '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
                '<w:r><w:instrText xml:space="preserve"> INCLUDETEXT "c:/secret.docx" </w:instrText></w:r>' +
                '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
            },
          ],
        }),
      },
    );
    assert.equal(fieldCode.statusCode, 400);
    assert.match(fieldCode.json().detail, /INCLUDETEXT/);

    // The same instruction split across two runs, as Word writes it after an
    // edit: the runs are concatenated before the scan, so it is still caught.
    const splitField = await uploadTemplate(
      boss,
      { name: 'حقل مقسوم' },
      {
        filename: 'x.docx',
        buffer: buildDocx({
          body: [
            '{{a}}',
            {
              raw:
                '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
                '<w:r><w:instrText xml:space="preserve"> INCLUDE</w:instrText></w:r>' +
                '<w:r><w:instrText xml:space="preserve">PICTURE "http://x.invalid/a.png" </w:instrText></w:r>' +
                '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
            },
          ],
        }),
      },
    );
    assert.equal(splitField.statusCode, 400);
    assert.match(splitField.json().detail, /INCLUDEPICTURE/);
  });


  test('a bad tag name and an unclosed tag are refused with an explanation', async () => {
    const spaced = await uploadTemplate(
      boss,
      { name: 'مسافة' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['{{ spaced }}'] }) },
    );
    assert.equal(spaced.statusCode, 400);
    assert.equal(spaced.json().error, 'template_invalid');
    assert.match(spaced.json().detail, /مسافة/);

    const prefixed = await uploadTemplate(
      boss,
      { name: 'بادئة' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['{{@raw}}'] }) },
    );
    assert.equal(prefixed.statusCode, 400);
    assert.equal(prefixed.json().error, 'template_invalid');

    const unclosed = await uploadTemplate(
      boss,
      { name: 'غير مغلق' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['hello {{oops'] }) },
    );
    assert.equal(unclosed.statusCode, 400);
    assert.equal(unclosed.json().error, 'template_invalid');
    // docxtemplater's own explanation, not a message this module invented.
    assert.match(unclosed.json().detail, /unclosed/i);

    const empty = await uploadTemplate(
      boss,
      { name: 'بلا حقول' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['a letter with no fields'] }) },
    );
    assert.equal(empty.statusCode, 400);
    assert.match(empty.json().detail, /\{\{/);

    // Nothing was stored for any of them.
    const rows = await sql`SELECT COUNT(*) AS n FROM dbo.form_templates`.execute(db);
    assert.equal(Number(rows.rows[0].n), 0);
  });

  test('a letterhead Word itself saved is accepted, paragraph ids and English prose and all', async () => {
    // Everything in this fixture used to refuse the upload, and none of it is a
    // field: w14:paraId / w14:textId / w:rsidR are random uppercase hex, so «DDE»
    // turns up in them by chance on any long document; w:fill="DDEBF7" is
    // Office's own Accent-1 shading; and «Important», «FORBIDDEN» and
    // «CAN_IMPORT» are just words that contain IMPORT or DDE. An administrator
    // cannot remove any of them from a document Word saved.
    const response = await uploadTemplate(
      boss,
      { name: 'ترويسة حقيقية' },
      {
        filename: 'letterhead.docx',
        buffer: buildDocx({
          body: [
            {
              raw:
                '<w:p w14:paraId="1ECE7DDE" w14:textId="1F894DDE" w:rsidR="00B12DDE">' +
                '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="DDEBF7"/></w:pPr>' +
                '<w:r><w:t xml:space="preserve">Important: FORBIDDEN, CAN_IMPORT — {{subject}}</w:t></w:r></w:p>',
            },
            'To {{addressee}}',
          ],
        }),
      },
    );
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(
      response.json().template.fields.map((field) => field.placeholder),
      ['subject', 'addressee'],
    );

    // A fixture, not part of the story the rest of the suite tells: there is no
    // delete route for a format, so its rows go directly.
    const fixtureId = Number(response.json().template.templateId);
    await sql`DELETE FROM dbo.form_template_fields WHERE template_id = ${fixtureId}`.execute(db);
    await sql`DELETE FROM dbo.form_templates WHERE template_id = ${fixtureId}`.execute(db);
  });

  test('an upload past the size limit is refused and drained', async () => {
    const { config } = await import('../src/config/index.js');
    const oversized = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(config.forms.maxTemplateBytes + 1024, 0x41),
    ]);
    const response = await uploadTemplate(
      boss,
      { name: 'كبير' },
      { filename: 'big.docx', buffer: oversized },
    );
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error, 'too_large');
  });

  // ── Discovery ──────────────────────────────────────────────────────────

  test('discovery finds the body tags and the header tag, in order, and marks the built-ins', async () => {
    const response = await uploadTemplate(
      boss,
      {
        name: 'كتاب رسمي',
        description: 'نموذج الكتب الرسمية',
        typeId: String(ids.typeOfficial),
      },
      { filename: 'كتاب.docx', buffer: letterTemplate() },
    );
    assert.equal(response.statusCode, 201, response.body);

    const template = response.json().template;
    ids.template = template.templateId;

    assert.deepEqual(
      template.fields.map((field) => field.placeholder),
      ['addressee', 'subject', 'body', 'date', 'date_iso', 'author', 'reference'],
    );
    assert.deepEqual(
      template.fields.filter((field) => field.builtIn).map((field) => field.placeholder),
      ['date', 'date_iso', 'author'],
    );
    // The default label is the placeholder itself, so nothing is ever unlabelled
    // by accident — only by an administrator clearing it.
    assert.equal(template.fields[0].label, 'addressee');
    assert.equal(template.unlabelled, 0);
    // Created inactive: activation is where the publishing rules are enforced.
    assert.equal(template.isActive, false);
    assert.equal(template.typeId, ids.typeOfficial);
    assert.deepEqual(template.access, []);
    // The type demands رقم الإشارة and nothing maps to it yet.
    assert.deepEqual(template.unmappedRequired, ['رقم الإشارة']);

    const stored = await sql`
      SELECT storage_path, sha256, bytes, original_filename FROM dbo.form_templates
       WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    assert.match(stored.rows[0].storage_path, /^templates\/.+\.docx$/);
    assert.equal(await storage.exists(stored.rows[0].storage_path), true);
    assert.equal(stored.rows[0].original_filename, 'كتاب.docx');

    const audit = await sql`
      SELECT COUNT(*) AS n FROM dbo.audit_log
       WHERE action = 'form_template.created' AND target_id = ${String(ids.template)}
    `.execute(db);
    assert.equal(Number(audit.rows[0].n), 1);
  });

  // ── Field rules ────────────────────────────────────────────────────────

  test('a placeholder that is not in the file cannot be configured', async () => {
    const response = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [{ placeholder: 'invented', label: 'مخترع' }],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'unknown_placeholder');
  });

  test('only text, number and date fields of this type (or global) may be mapped', async () => {
    const choice = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [{ placeholder: 'subject', label: 'الموضوع', fieldId: ids.fieldClassification }],
    });
    assert.equal(choice.statusCode, 400);
    assert.equal(choice.json().error, 'field_unmappable');
    assert.equal(choice.json().detail.placeholder, 'subject');

    const foreign = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [{ placeholder: 'subject', label: 'الموضوع', fieldId: ids.fieldForeign }],
    });
    assert.equal(foreign.statusCode, 400);
    assert.equal(foreign.json().error, 'field_not_in_type');
  });

  test('two placeholders on the same field are refused by name, not blamed on the data type', async () => {
    const twice = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [
        { placeholder: 'subject', label: 'الموضوع', fieldId: ids.fieldSubject, sortOrder: 0 },
        { placeholder: 'body', label: 'النص', fieldId: ids.fieldSubject, sortOrder: 1 },
      ],
    });
    assert.equal(twice.statusCode, 400);
    // Its own reason: it used to borrow `field_unmappable`, so the administrator
    // was told the field could not be mapped at all — about a field the select
    // had just offered — and the detail was an object the client dropped.
    assert.equal(twice.json().error, 'field_mapped_twice');
    assert.equal(typeof twice.json().detail, 'string');
    assert.match(twice.json().detail, /subject/);
    assert.match(twice.json().detail, /body/);

    // The save is refused whole, so nothing was written.
    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.form_template_fields
       WHERE template_id = ${Number(ids.template)} AND field_id IS NOT NULL
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 0);
  });

  test('a format cannot be published while a field a person will see has no label', async () => {
    const cleared = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [{ placeholder: 'addressee', label: '' }],
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().template.unlabelled, 1);

    const activation = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      isActive: true,
    });
    assert.equal(activation.statusCode, 400);
    assert.equal(activation.json().error, 'fields_unlabelled');
    assert.match(activation.json().detail, /addressee/);
  });

  test('a format cannot be published while a required field of its type is unreachable', async () => {
    const labelled = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [
        { placeholder: 'addressee', label: 'الجهة', required: true, sortOrder: 0 },
        { placeholder: 'subject', label: 'الموضوع', sortOrder: 1 },
        { placeholder: 'body', label: 'النص', multiline: true, sortOrder: 2 },
        { placeholder: 'reference', label: 'رقم الإشارة', sortOrder: 3 },
      ],
    });
    assert.equal(labelled.statusCode, 200, labelled.body);
    assert.equal(labelled.json().template.unlabelled, 0);

    const activation = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      isActive: true,
    });
    assert.equal(activation.statusCode, 400);
    assert.equal(activation.json().error, 'type_requires_fields');
    assert.match(activation.json().detail, /رقم الإشارة/);
  });

  test('a mapped label, then publication', async () => {
    const mapped = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [
        { placeholder: 'addressee', label: 'الجهة', required: true, sortOrder: 0 },
        { placeholder: 'subject', label: 'الموضوع', fieldId: ids.fieldSubject, sortOrder: 1 },
        { placeholder: 'body', label: 'النص', multiline: true, sortOrder: 2 },
        { placeholder: 'reference', label: 'رقم الإشارة', fieldId: ids.fieldReference, sortOrder: 3 },
      ],
    });
    assert.equal(mapped.statusCode, 200, mapped.body);
    assert.deepEqual(mapped.json().template.unmappedRequired, []);
    // A mapped text value must fit value_text, and the client is told so.
    const subject = mapped.json().template.fields.find((field) => field.placeholder === 'subject');
    assert.equal(subject.maxLength, 1000);
    assert.equal(subject.dataType, 'text');

    const activated = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      isActive: true,
    });
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal(activated.json().template.isActive, true);
  });

  // ── Access ─────────────────────────────────────────────────────────────

  test('a format nobody was given is invisible, not forbidden', async () => {
    const list = await call('GET', '/api/forms/templates', kateb);
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().templates, []);

    const one = await call('GET', `/api/forms/templates/${ids.template}`, kateb);
    assert.equal(one.statusCode, 404);
    assert.equal(one.json().error, 'not_found');

    const status = await call('GET', '/api/forms/status', kateb);
    assert.equal(status.json().templates, 0);
  });

  test('membership of a group on the access list is enough, and the built-ins are hidden', async () => {
    const access = await call('PUT', `/api/admin/forms/templates/${ids.template}/access`, boss, {
      principalIds: [String(id['قسم الكتب'])],
    });
    assert.equal(access.statusCode, 200, access.body);
    assert.deepEqual(
      access.json().template.access.map((entry) => entry.kind),
      ['group'],
    );

    const list = await call('GET', '/api/forms/templates', kateb);
    assert.equal(list.json().templates.length, 1);
    assert.equal(list.json().templates[0].name, 'كتاب رسمي');

    const one = await call('GET', `/api/forms/templates/${ids.template}`, kateb);
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(
      one.json().template.fields.map((field) => field.placeholder),
      ['addressee', 'subject', 'body', 'reference'],
    );

    // Someone outside the group still sees nothing at all.
    const denied = await call('GET', `/api/forms/templates/${ids.template}`, outsider);
    assert.equal(denied.statusCode, 404);

    const status = await call('GET', '/api/forms/status', kateb);
    assert.equal(status.json().templates, 1);
  });

  test('a placeholder mapped to a field the type demands is required on the form itself', async () => {
    // The administrator never ticked «إلزامي» on «رقم الإشارة» — it is required
    // because the type says its own field is. Without that derivation the control
    // carried no asterisk, nothing stopped the person leaving it blank, and the
    // refusal came back naming the custom field's name rather than the label on
    // the screen — a field they could not find.
    const stored = await sql`
      SELECT is_required FROM dbo.form_template_fields
       WHERE template_id = ${Number(ids.template)} AND placeholder = 'reference'
    `.execute(db);
    assert.equal(Number(stored.rows[0].is_required), 0, 'nothing was ticked in the admin dialog');

    const form = await call('GET', `/api/forms/templates/${ids.template}`, kateb);
    assert.equal(form.statusCode, 200, form.body);
    const reference = form.json().template.fields.find((field) => field.placeholder === 'reference');
    assert.equal(reference.required, true);
    assert.equal(reference.label, 'رقم الإشارة');

    // An unmapped, unticked placeholder is still optional.
    const body = form.json().template.fields.find((field) => field.placeholder === 'body');
    assert.equal(body.required, false);
  });

  test('a deactivated format tells the person who holds access why', async () => {
    const off = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, { isActive: false });
    assert.equal(off.statusCode, 200);

    // 409, not 404: this person DOES hold access, so "it is switched off" is
    // information they are entitled to and can act on.
    const refused = await call('GET', `/api/forms/templates/${ids.template}`, kateb);
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'template_inactive');

    const listed = await call('GET', '/api/forms/templates', kateb);
    assert.deepEqual(listed.json().templates, [], 'and it is not offered in the picker');

    const generated = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب',
      values: { addressee: 'A', reference: '1' },
    });
    assert.equal(generated.statusCode, 409);
    assert.equal(generated.json().error, 'template_inactive');

    const on = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, { isActive: true });
    assert.equal(on.statusCode, 200, on.body);
  });

  // ── Refusals before any conversion ─────────────────────────────────────

  test('every field refusal happens before a conversion and names the Arabic label', async () => {
    const base = {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب إلى المالية',
    };

    const missing = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      values: { subject: 'x', reference: '1' },
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, 'missing_value');
    assert.equal(missing.json().detail.label, 'الجهة');
    assert.equal(missing.json().detail.placeholder, 'addressee');

    // «رقم الإشارة» is a required field of the type, and a placeholder carries
    // it, so the refusal names the placeholder and the label the person is
    // looking at — not the custom field's own name from the metadata layer.
    const required = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      values: { addressee: 'A', subject: 'x' },
    });
    assert.equal(required.statusCode, 400);
    assert.equal(required.json().error, 'missing_value');
    assert.equal(required.json().detail.placeholder, 'reference');
    assert.equal(required.json().detail.label, 'رقم الإشارة');

    const tooLong = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      values: { addressee: 'A', reference: '1', subject: 'ص'.repeat(1001) },
    });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json().error, 'value_too_long');
    assert.equal(tooLong.json().detail.label, 'الموضوع');
    assert.equal(tooLong.json().detail.limit, 1000);

    const unknown = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      values: { addressee: 'A', reference: '1', invented: 'x' },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, 'unknown_placeholder');

    const invisibleFolder = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      folderId: String(id.closed),
      values: { addressee: 'A', reference: '1' },
    });
    assert.equal(invisibleFolder.statusCode, 404, 'a folder the person cannot browse is not confirmed');

    const mudeer = await signIn('mudeer');
    const noTemplateAccess = await call('POST', '/api/forms/generate', mudeer, {
      ...base,
      values: { addressee: 'A', reference: '1' },
    });
    assert.equal(noTemplateAccess.statusCode, 404, 'the format itself is not confirmed to them');

    // Given the format, but holding only BROWSE and READ on the folder: the
    // answer becomes `forbidden`, because the folder is one they can see.
    await call('PUT', `/api/admin/forms/templates/${ids.template}/access`, boss, {
      principalIds: [String(id['قسم الكتب']), String(id.mudeer)],
    });
    const readOnlyFolder = await call('POST', '/api/forms/generate', mudeer, {
      ...base,
      values: { addressee: 'A', reference: '1' },
    });
    assert.equal(readOnlyFolder.statusCode, 403);
    assert.equal(readOnlyFolder.json().error, 'forbidden');

    // Nothing was filed by any of them.
    const documents = await sql`SELECT COUNT(*) AS n FROM dbo.documents`.execute(db);
    assert.equal(Number(documents.rows[0].n), 0);
  });

  test('a template file that no longer matches its recorded hash refuses the letter', async () => {
    const original = await sql`
      SELECT sha256 FROM dbo.form_templates WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    await sql`
      UPDATE dbo.form_templates SET sha256 = ${'0'.repeat(64)} WHERE template_id = ${Number(ids.template)}
    `.execute(db);

    const response = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب',
      values: { addressee: 'A', reference: '1' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'template_missing');

    await sql`
      UPDATE dbo.form_templates SET sha256 = ${original.rows[0].sha256}
       WHERE template_id = ${Number(ids.template)}
    `.execute(db);
  });

  // ── The letter itself ──────────────────────────────────────────────────

  test('a letter is merged, converted, filed with its metadata and recorded', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const response = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب إلى المالية',
      values: {
        addressee: 'Ahmed Ali',
        subject: 'Budget 2026',
        body: 'The first line.\nThe second line.',
        reference: 'REF-483',
        // A client trying to set the author and the date of an official letter.
        author: 'someone else',
        date: '01/01/1990',
      },
    });
    assert.equal(response.statusCode, 201, response.body);

    const body = response.json();
    ids.document = body.documentId;
    assert.equal(body.version, 1);
    assert.equal(body.approval, null, 'no approval template is bound yet');

    const document = await sql`
      SELECT folder_id, type_id, title, current_version FROM dbo.documents WHERE document_id = ${ids.document}
    `.execute(db);
    assert.equal(String(document.rows[0].folder_id), String(id.letters));
    assert.equal(Number(document.rows[0].type_id), ids.typeOfficial);
    assert.equal(document.rows[0].title, 'كتاب إلى المالية');
    assert.equal(Number(document.rows[0].current_version), 1);

    const version = await sql`
      SELECT mime_type, original_filename, file_size_bytes FROM dbo.document_versions
       WHERE document_id = ${ids.document} AND version_number = 1
    `.execute(db);
    assert.equal(version.rows[0].mime_type, 'application/pdf');
    assert.match(version.rows[0].original_filename, /\.pdf$/);
    assert.ok(Number(version.rows[0].file_size_bytes) > 1000);

    // The mapped values are metadata, not only ink on the page.
    const values = await sql`
      SELECT field_id, value_text FROM dbo.document_field_values WHERE document_id = ${ids.document}
    `.execute(db);
    const byField = new Map(values.rows.map((row) => [Number(row.field_id), row.value_text]));
    assert.equal(byField.get(ids.fieldSubject), 'Budget 2026');
    assert.equal(byField.get(ids.fieldReference), 'REF-483');

    // Provenance: which format, which values, and the server's own built-ins.
    const letter = await sql`
      SELECT template_id, values_json, created_by FROM dbo.form_letters WHERE document_id = ${ids.document}
    `.execute(db);
    assert.equal(Number(letter.rows[0].template_id), Number(ids.template));
    assert.equal(String(letter.rows[0].created_by), String(id.kateb));
    const merged = JSON.parse(letter.rows[0].values_json);
    assert.equal(merged.addressee, 'Ahmed Ali');
    // The caller's attempt to set the author and the date was DELETED, not used.
    assert.equal(merged.author, 'kateb');
    assert.notEqual(merged.date, '01/01/1990');
    assert.match(merged.date, /^\d{2}\/\d{2}\/\d{4}$/);
    assert.match(merged.date_iso, /^\d{4}-\d{2}-\d{2}$/);

    const audit = await sql`
      SELECT action FROM dbo.audit_log
       WHERE target_id = ${ids.document} AND target_type = 'document'
       ORDER BY audit_id
    `.execute(db);
    const actions = audit.rows.map((row) => row.action);
    assert.ok(actions.includes('document.created'), actions.join(','));
    assert.ok(actions.includes('form_letter.created'), actions.join(','));

    // And the page itself carries what the server decided, not what was posted.
    const content = await call('GET', `/api/documents/${ids.document}/content`, kateb);
    assert.equal(content.statusCode, 200);
    const text = await pdfText(content.rawPayload);
    assert.match(text, /Ahmed Ali/);
    assert.match(text, /Budget 2026/);
    assert.match(text, /REF-483/, 'the header tag was filled too');
    assert.match(text, /by kateb/);
    assert.doesNotMatch(text, /someone else/);
    assert.doesNotMatch(text, /1990/);
  });

  test('the second of two simultaneous letters is told the machine is busy', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const request = (title) =>
      call('POST', '/api/forms/generate', kateb, {
        templateId: ids.template,
        folderId: String(id.letters),
        title,
        values: { addressee: 'Busy Test', reference: 'REF-1', subject: 'S', body: 'B' },
      });

    const [first, second] = await Promise.all([request('كتاب متزامن ١'), request('كتاب متزامن ٢')]);
    const codes = [first.statusCode, second.statusCode].sort();
    assert.deepEqual(codes, [201, 503], `${first.statusCode}/${second.statusCode}`);
    const refused = first.statusCode === 503 ? first : second;
    assert.equal(refused.json().error, 'busy');
  });

  test('an approval bound to the format starts by itself, after the letter exists', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const approval = await sql`
      INSERT INTO dbo.approval_templates (type_id, name) OUTPUT INSERTED.template_id AS tid
      VALUES (${ids.typeOfficial}, ${'موافقة الكتب'})
    `.execute(db);
    ids.approvalTemplate = Number(approval.rows[0].tid);
    await sql`
      INSERT INTO dbo.approval_steps (template_id, step_order, approver_id)
      VALUES (${ids.approvalTemplate}, 1, ${id.mudeer})
    `.execute(db);

    const bound = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      approvalTemplateId: ids.approvalTemplate,
    });
    assert.equal(bound.statusCode, 200, bound.body);

    const response = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب يحتاج موافقة',
      values: { addressee: 'Approver Test', reference: 'REF-777', subject: 'S', body: 'B' },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().approval.ok, true);

    const requests = await sql`
      SELECT status, template_id FROM dbo.approval_requests WHERE document_id = ${response.json().documentId}
    `.execute(db);
    assert.equal(requests.rows.length, 1);
    assert.equal(requests.rows[0].status, 'pending');
    assert.equal(Number(requests.rows[0].template_id), ids.approvalTemplate);

    const audit = await sql`
      SELECT COUNT(*) AS n FROM dbo.audit_log
       WHERE action = 'approval.requested' AND target_id = ${response.json().documentId}
    `.execute(db);
    assert.equal(Number(audit.rows[0].n), 1);

    // Unbound again so the later cases are not slowed by an approval each.
    await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      approvalTemplateId: null,
    });
  });

  test('the duplicate policy is the document path own rule, not a second copy of it', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const blocked = await call('PUT', '/api/settings/upload.duplicate_policy', boss, { value: 'block' });
    assert.equal(blocked.statusCode, 200, blocked.body);

    const response = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب مكرر',
      values: { addressee: 'Ahmed Ali', subject: 'Budget 2026', body: 'Same text.', reference: 'REF-483' },
    });

    // The same format with the same values still produces DIFFERENT bytes,
    // because LibreOffice writes a creation timestamp into every PDF it makes.
    // So a genuine duplicate cannot be provoked through this route; what is
    // asserted is that generation neither re-implements the policy nor trips
    // over it — the refusal and the `duplicateOf` report both come from
    // createDocument, and the response carries them through untouched.
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.json().duplicateOf, undefined);

    const shas = await sql`
      SELECT v.sha256 FROM dbo.document_versions v
        JOIN dbo.documents d ON d.document_id = v.document_id
       WHERE d.folder_id = ${id.letters} AND d.title IN (${'كتاب إلى المالية'}, ${'كتاب مكرر'})
    `.execute(db);
    assert.equal(new Set(shas.rows.map((row) => row.sha256)).size, shas.rows.length);

    await call('PUT', '/api/settings/upload.duplicate_policy', boss, { value: 'warn' });
  });

  // ── The assigned folders ───────────────────────────────────────────────
  //
  // A format assigned to folders may be filed ONLY into those, and the fill
  // screen offers only the ones the person holds UPLOAD on. An empty list is the
  // old behaviour — any folder they may upload into — and these tests end by
  // restoring it, so nothing after them sees a restricted format.

  test('an assigned format offers only the folders the person may file into', async () => {
    await makeFolder('archive');
    // «archive» is granted to nobody: it is assigned to the format, so the
    // administrator sees it, and no ordinary user may file into it.

    const assigned = await call('PUT', `/api/admin/forms/templates/${ids.template}/folders`, boss, {
      folderIds: [String(id.letters), String(id.archive)],
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.deepEqual(
      assigned.json().template.folders.map((folder) => folder.folderId).sort(),
      [String(id.letters), String(id.archive)].sort(),
    );
    // The admin payload names each folder by the path an administrator reads.
    assert.deepEqual(
      assigned.json().template.folders.map((folder) => folder.path).sort(),
      ['archive', 'letters'],
    );

    const audit = await sql`
      SELECT detail FROM dbo.audit_log
       WHERE action = 'form_template.folders_changed' AND target_id = ${String(ids.template)}
    `.execute(db);
    assert.equal(audit.rows.length, 1);
    assert.match(audit.rows[0].detail, /letters/);

    // kateb may upload into «letters» only, so that is the only destination the
    // fill screen is given — «archive» is assigned but not theirs to file into.
    const list = await call('GET', '/api/forms/templates', kateb);
    assert.equal(list.json().templates.length, 1);
    assert.deepEqual(
      list.json().templates[0].folders.map((folder) => folder.folderId),
      [String(id.letters)],
    );

    const one = await call('GET', `/api/forms/templates/${ids.template}`, kateb);
    assert.equal(one.statusCode, 200, one.body);
    assert.deepEqual(
      one.json().template.folders.map((folder) => folder.name),
      ['letters'],
    );

    const status = await call('GET', '/api/forms/status', kateb);
    assert.equal(status.json().templates, 1);

    // mudeer holds the format but may upload into NEITHER assigned folder, so
    // the format is not usable by them at all: not listed, not counted, and not
    // confirmed — rather than offered and then refused at the last step.
    const mudeer = await signIn('mudeer');
    const theirs = await call('GET', '/api/forms/templates', mudeer);
    assert.deepEqual(theirs.json().templates, []);

    const theirStatus = await call('GET', '/api/forms/status', mudeer);
    assert.equal(theirStatus.json().templates, 0);

    const refused = await call('GET', `/api/forms/templates/${ids.template}`, mudeer);
    assert.equal(refused.statusCode, 404);

    // A super admin may upload anywhere, so both assigned folders are offered.
    const bossList = await call('GET', '/api/forms/templates', boss);
    const mine = bossList.json().templates.find((entry) => entry.templateId === String(ids.template));
    assert.equal(mine.folders.length, 2);
  });

  test('a letter into a folder the format is not assigned to is refused before anything is spent', async () => {
    const base = {
      templateId: ids.template,
      folderId: String(id.closed),
      title: 'كتاب في المكان الخطأ',
      values: { addressee: 'A', reference: 'REF-NO', subject: 'S', body: 'B' },
    };

    const elsewhere = await call('POST', '/api/forms/generate', kateb, base);
    assert.equal(elsewhere.statusCode, 403, elsewhere.body);
    assert.equal(elsewhere.json().error, 'folder_not_allowed');

    // An ASSIGNED folder this person cannot file into is refused by the folder's
    // own permission instead — «not_found», because they cannot even browse it.
    // Which proves the order: the format's own rule is read first and did not
    // stand in the way here.
    const notTheirs = await call('POST', '/api/forms/generate', kateb, {
      ...base,
      folderId: String(id.archive),
    });
    assert.equal(notTheirs.statusCode, 404, notTheirs.body);

    const documents = await sql`
      SELECT COUNT(*) AS n FROM dbo.documents WHERE folder_id = ${id.closed}
    `.execute(db);
    assert.equal(Number(documents.rows[0].n), 0);
  });

  test('a letter into an assigned folder is filed exactly as before', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const response = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب إلى المجلد المخصّص',
      values: { addressee: 'Assigned Folder', reference: 'REF-ASG', subject: 'S', body: 'B' },
    });
    assert.equal(response.statusCode, 201, response.body);

    const document = await sql`
      SELECT folder_id FROM dbo.documents WHERE document_id = ${response.json().documentId}
    `.execute(db);
    assert.equal(String(document.rows[0].folder_id), String(id.letters));
  });

  test('a format may be assigned its folders as it is created', async () => {
    const response = await uploadTemplate(
      boss,
      {
        name: 'نموذج بمجلدات',
        folderIds: JSON.stringify([String(id.letters), String(id.archive), String(id.letters)]),
      },
      { filename: 'مخصّص.docx', buffer: buildDocx({ body: ['To {{addressee}}'] }) },
    );
    assert.equal(response.statusCode, 201, response.body);
    // The repeated id collapsed: the administrator meant that folder once.
    assert.equal(response.json().template.folders.length, 2);

    const fixtureId = Number(response.json().template.templateId);
    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.form_template_folders WHERE template_id = ${fixtureId}
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 2);

    // A malformed list is refused whole rather than read as «any folder».
    const malformed = await uploadTemplate(
      boss,
      { name: 'قائمة خاطئة', folderIds: 'not json' },
      { filename: 'x.docx', buffer: buildDocx({ body: ['{{a}}'] }) },
    );
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error, 'invalid_value');

    // A fixture, not part of the story the rest of the suite tells.
    await sql`DELETE FROM dbo.form_template_folders WHERE template_id = ${fixtureId}`.execute(db);
    await sql`DELETE FROM dbo.form_template_fields WHERE template_id = ${fixtureId}`.execute(db);
    await sql`DELETE FROM dbo.form_templates WHERE template_id = ${fixtureId}`.execute(db);
  });

  test('the assigned list is replaced whole, and a folder that is not there is refused', async () => {
    const missing = await call('PUT', `/api/admin/forms/templates/${ids.template}/folders`, boss, {
      folderIds: [String(id.letters), '999999999'],
    });
    assert.equal(missing.statusCode, 404, missing.body);
    assert.equal(missing.json().error, 'not_found');
    assert.match(missing.json().detail, /999999999/);

    const notAnId = await call('PUT', `/api/admin/forms/templates/${ids.template}/folders`, boss, {
      folderIds: ['abc'],
    });
    assert.equal(notAnId.statusCode, 400);
    assert.equal(notAnId.json().error, 'invalid_value');

    // Neither refusal touched the stored set.
    const untouched = await sql`
      SELECT COUNT(*) AS n FROM dbo.form_template_folders WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    assert.equal(Number(untouched.rows[0].n), 2);

    // An empty list is meaningful: it restores «any folder this person may upload
    // into», which is what every format did before assignment existed.
    const cleared = await call('PUT', `/api/admin/forms/templates/${ids.template}/folders`, boss, {
      folderIds: [],
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json().template.folders, []);

    const list = await call('GET', '/api/forms/templates', kateb);
    assert.equal(list.json().templates.length, 1);
    assert.deepEqual(list.json().templates[0].folders, []);

    // And the destination the format used to refuse is refused by the folder's
    // own permission again, not by the format.
    const anywhere = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.closed),
      title: 'كتاب',
      values: { addressee: 'A', reference: 'REF-ANY' },
    });
    assert.equal(anywhere.statusCode, 404, anywhere.body);
  });

  test('the preview is a PDF and files nothing', async (t) => {
    if (!libreOffice) return t.skip('LibreOffice is not installed on this machine');

    const before = await sql`SELECT COUNT(*) AS n FROM dbo.documents`.execute(db);

    const response = await call('GET', `/api/admin/forms/templates/${ids.template}/preview`, boss);
    assert.equal(response.statusCode, 200, response.body?.slice?.(0, 200));
    assert.match(response.headers['content-type'], /application\/pdf/);
    assert.equal(response.rawPayload.subarray(0, 4).toString('latin1'), '%PDF');

    const posted = await call('POST', `/api/admin/forms/templates/${ids.template}/preview`, boss);
    assert.equal(posted.statusCode, 200);

    const after = await sql`SELECT COUNT(*) AS n FROM dbo.documents`.execute(db);
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));
  });

  test('the .docx itself comes back for an administrator who wants to edit it', async () => {
    const response = await call('GET', `/api/admin/forms/templates/${ids.template}/file`, boss);
    assert.equal(response.statusCode, 200);
    assert.equal(response.rawPayload.subarray(0, 4).toString('latin1'), 'PK\u0003\u0004');
    assert.match(response.headers['content-disposition'], /attachment/);
  });

  // ── Replacing the file ─────────────────────────────────────────────────

  test('replacing the file reports what was added, kept and lost', async () => {
    const replacement = buildDocx({
      body: ['To {{addressee}}', 'Subject: {{subject}}', 'Signed by {{author}} on {{date}}'],
      header: ['Ref {{reference}}', 'Copy to {{copy_to}}'],
    });

    const response = await uploadTemplate(
      boss,
      {},
      { filename: 'كتاب-٢.docx', buffer: replacement },
      { method: 'PUT', url: `/api/admin/forms/templates/${ids.template}/file` },
    );
    assert.equal(response.statusCode, 200, response.body);

    const { diff, template } = response.json();
    assert.deepEqual(diff.added, ['copy_to']);
    assert.deepEqual(diff.removed.sort(), ['body', 'date_iso']);
    assert.ok(diff.kept.includes('addressee'));
    assert.ok(diff.kept.includes('reference'));

    // A label and a mapping that were typed in Arabic survived the new file.
    const subject = template.fields.find((field) => field.placeholder === 'subject');
    assert.equal(subject.label, 'الموضوع');
    assert.equal(subject.fieldId, ids.fieldSubject);
    const added = template.fields.find((field) => field.placeholder === 'copy_to');
    assert.equal(added.label, 'copy_to');
    assert.equal(added.fieldId, null);

    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.form_template_fields WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 6);

    const audit = await sql`
      SELECT COUNT(*) AS n FROM dbo.audit_log
       WHERE action = 'form_template.file_replaced' AND target_id = ${String(ids.template)}
    `.execute(db);
    assert.equal(Number(audit.rows[0].n), 1);
  });

  test('changing the type clears the mappings that no longer make sense', async () => {
    const response = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      typeId: ids.typeOther,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().clearedMappings.sort(), ['reference', 'subject']);

    const remaining = await sql`
      SELECT COUNT(*) AS n FROM dbo.form_template_fields
       WHERE template_id = ${Number(ids.template)} AND field_id IS NOT NULL
    `.execute(db);
    assert.equal(Number(remaining.rows[0].n), 0);
  });

  test('a type change that would leave a live format unfillable is refused, not applied', async () => {
    // The format is live, and its mappings were just cleared. Moving it back to
    // «كتاب رسمي» — whose «رقم الإشارة» nothing now carries — would leave it
    // published and impossible to fill: it would keep appearing on /forms and
    // every «إنشاء الكتاب» would come back naming a field with no control. The
    // publishing rules are about what is live, so they run here too.
    const refused = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      typeId: ids.typeOfficial,
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, 'type_requires_fields');
    assert.match(refused.json().detail, /رقم الإشارة/);

    const untouched = await sql`
      SELECT type_id, is_active FROM dbo.form_templates WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    assert.equal(Number(untouched.rows[0].type_id), ids.typeOther, 'the type did not move');
    assert.equal(Number(untouched.rows[0].is_active), 1, 'and it is still the live format it was');

    // The way through is the one the administrator is told to take: take it
    // offline, change the type, map the fields, publish again.
    const off = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, { isActive: false });
    assert.equal(off.statusCode, 200, off.body);

    const moved = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, {
      typeId: ids.typeOfficial,
    });
    assert.equal(moved.statusCode, 200, moved.body);

    const remapped = await call('PUT', `/api/admin/forms/templates/${ids.template}/fields`, boss, {
      fields: [
        { placeholder: 'subject', label: 'الموضوع', fieldId: ids.fieldSubject, sortOrder: 1 },
        { placeholder: 'reference', label: 'رقم الإشارة', fieldId: ids.fieldReference, sortOrder: 3 },
      ],
    });
    assert.equal(remapped.statusCode, 200, remapped.body);

    const on = await call('PATCH', `/api/admin/forms/templates/${ids.template}`, boss, { isActive: true });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().template.isActive, true);
  });

  // ── The upload path's own rules, applied here too ───────────────────────

  test('a required field covered by the folder defaults is satisfied, exactly as on an upload', async () => {
    // An ordinary upload into «letters» succeeds because createDocument fills the
    // blanks from folder_field_defaults BEFORE it checks what the type requires.
    // A letter that skipped that step was refused where dragging the same file
    // into the same folder was accepted.
    const department = await makeField('القسم', 'text', { typeId: ids.typeOfficial, required: true });
    const base = {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب بقيمة افتراضية',
      values: { addressee: 'A', reference: 'REF-DEF', subject: 'S' },
    };

    // With no default, it is refused up front — before any conversion.
    const refused = await call('POST', '/api/forms/generate', kateb, base);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().error, 'required_field');
    assert.match(refused.json().detail, /القسم/);

    await sql`
      INSERT INTO dbo.folder_field_defaults (folder_id, field_id, value_text)
      VALUES (${id.letters}, ${department}, ${'الشؤون الإدارية'})
    `.execute(db);

    const accepted = await call('POST', '/api/forms/generate', kateb, base);
    if (libreOffice) {
      assert.equal(accepted.statusCode, 201, accepted.body);
      // And the default was written by createDocument, as on any upload.
      const values = await sql`
        SELECT value_text FROM dbo.document_field_values
         WHERE document_id = ${accepted.json().documentId} AND field_id = ${department}
      `.execute(db);
      assert.equal(values.rows[0].value_text, 'الشؤون الإدارية');
    } else {
      // Without LibreOffice it cannot be converted — but it got past the
      // required-field gate, which is what this test is about.
      assert.equal(accepted.json().error, 'libreoffice_missing', accepted.body);
    }

    // Left behind, the default would change what every later test may file.
    await sql`
      DELETE FROM dbo.folder_field_defaults WHERE folder_id = ${id.letters} AND field_id = ${department}
    `.execute(db);
    await sql`UPDATE dbo.custom_field_defs SET is_required = 0 WHERE field_id = ${department}`.execute(db);
  });

  test('replacing the file takes a live format offline when it costs a required mapping', async () => {
    // The corrected .docx accidentally lost {{reference}} — the only placeholder
    // carrying the type's required «رقم الإشارة». Left published, the format
    // would refuse every letter with a field nobody could fill.
    const replacement = buildDocx({
      body: ['To {{addressee}}', 'Subject: {{subject}}', 'Signed by {{author}}'],
    });

    const response = await uploadTemplate(
      boss,
      {},
      { filename: 'كتاب-٣.docx', buffer: replacement },
      { method: 'PUT', url: `/api/admin/forms/templates/${ids.template}/file` },
    );
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().deactivated, ['رقم الإشارة']);
    assert.ok(response.json().diff.removed.includes('reference'));
    assert.equal(response.json().template.isActive, false);

    const row = await sql`
      SELECT is_active FROM dbo.form_templates WHERE template_id = ${Number(ids.template)}
    `.execute(db);
    assert.equal(Number(row.rows[0].is_active), 0);

    // So the person filling it is told the format is off — something an
    // administrator can act on — instead of meeting an unfillable refusal.
    const attempt = await call('POST', '/api/forms/generate', kateb, {
      templateId: ids.template,
      folderId: String(id.letters),
      title: 'كتاب',
      values: { addressee: 'A' },
    });
    assert.equal(attempt.statusCode, 409);
    assert.equal(attempt.json().error, 'template_inactive');

    // And the audit line says what happened to it.
    const audit = await sql`
      SELECT TOP (1) detail FROM dbo.audit_log
       WHERE action = 'form_template.file_replaced' AND target_id = ${String(ids.template)}
       ORDER BY audit_id DESC
    `.execute(db);
    assert.match(audit.rows[0].detail, /عُطّل النموذج/);
  });

  // ── The purge ──────────────────────────────────────────────────────────

  test('the purge clears a letter values, so its text does not outlive the letter', async (t) => {
    if (!ids.document) return t.skip('no letter was generated (LibreOffice absent)');

    const before = await sql`
      SELECT values_json FROM dbo.form_letters WHERE document_id = ${ids.document}
    `.execute(db);
    assert.notEqual(before.rows[0].values_json, '{}');

    const deleted = await call('DELETE', `/api/documents/${ids.document}`, kateb);
    assert.equal(deleted.statusCode, 200, deleted.body);

    const { purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js');
    const result = await purgeDeletedDocuments({ graceDays: 0 });
    assert.ok(result.purged >= 1, JSON.stringify(result));

    const after = await sql`
      SELECT values_json, template_id FROM dbo.form_letters WHERE document_id = ${ids.document}
    `.execute(db);
    // The row stays, naming the format; only the text is gone.
    assert.equal(after.rows[0].values_json, '{}');
    assert.equal(Number(after.rows[0].template_id), Number(ids.template));
  });
});
