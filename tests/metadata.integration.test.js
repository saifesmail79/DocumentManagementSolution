/**
 * Integration tests for document types, custom fields and metadata editing.
 *
 * The point of this layer is that a deployment defines its own vocabulary
 * without a schema change — so these check that definitions are data, that
 * values land in the right typed column, and that EDIT_META is what gates them.
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
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-meta-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

let db;
let sql;
let app;
let PERM;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

async function makeUser(username, { superAdmin = false } = {}) {
  const { hashPassword } = await import('../src/modules/auth/passwords.js');
  const hash = await hashPassword(PASSWORD);
  const p = await sql`
    INSERT INTO dbo.principals (principal_type, display_name)
    OUTPUT INSERTED.principal_id AS pid VALUES ('user', ${username})
  `.execute(db);
  const pid = p.rows[0].pid;
  await sql`
    INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin)
    VALUES (${pid}, ${username}, ${hash}, ${superAdmin ? 1 : 0})
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

async function signIn(username) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return `dms_session=${response.cookies.find((c) => c.name === 'dms_session').value}`;
}

const call = (method, url, cookie, payload) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function makeDocument(cookie, title) {
  const boundary = '----dmsmeta0123456789';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.txt"\r\n` +
        'Content-Type: text/plain\r\n\r\n',
      'utf8',
    ),
    Buffer.from('محتوى', 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id.cabinet}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

describe('metadata', { skip: CONFIGURED ? false : target.reason }, () => {
  let bossCookie;
  let editorCookie;
  let readerCookie;
  let typeId;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));

    const { storage } = await import('../src/storage/index.js');
    await storage.init();

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('boss', { superAdmin: true });
    await makeUser('editor');
    await makeUser('reader');
    await makeFolder('cabinet');

    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.editor},
              ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META}, 0)
    `.execute(db);
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.reader}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);

    bossCookie = await signIn('boss');
    editorCookie = await signIn('editor');
    readerCookie = await signIn('reader');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── Definitions are data ───────────────────────────────────────────────

  test('document types are created at runtime, not hardcoded', async () => {
    const created = await call('POST', '/api/metadata/types', bossCookie, {
      name: 'عقد',
      description: 'عقود الإيجار والتوريد',
    });
    assert.equal(created.statusCode, 201);
    typeId = created.json().typeId;

    const list = (await call('GET', '/api/metadata/types', editorCookie)).json();
    assert.ok(list.types.some((t) => t.name === 'عقد'));
  });

  test('defining vocabulary is super-admin only, reading it is not', async () => {
    assert.equal((await call('GET', '/api/metadata/types', readerCookie)).statusCode, 200);
    assert.equal(
      (await call('POST', '/api/metadata/types', readerCookie, { name: 'مرفوض' })).statusCode,
      403,
    );
  });

  test('a duplicate type name is refused', async () => {
    const response = await call('POST', '/api/metadata/types', bossCookie, { name: 'عقد' });
    assert.equal(response.statusCode, 409);
  });

  test('a field can be global or scoped to one type', async () => {
    const global = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'الرقم المرجعي',
      dataType: 'text',
    });
    assert.equal(global.statusCode, 201);

    const scoped = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'قيمة العقد',
      dataType: 'number',
      typeId,
    });
    assert.equal(scoped.statusCode, 201);

    // Asking for one type returns its own fields plus the global ones, which is
    // exactly the set a form for that type needs.
    const forType = (await call('GET', `/api/metadata/fields?typeId=${typeId}`, editorCookie)).json();
    const names = forType.fields.map((f) => f.name);
    assert.ok(names.includes('الرقم المرجعي'), 'global field applies to every type');
    assert.ok(names.includes('قيمة العقد'));
  });

  test('a choice field carries its options', async () => {
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'القسم',
      dataType: 'choice',
      choices: ['القانونية', 'المالية', 'الموارد البشرية'],
    });
    assert.equal(created.statusCode, 201);

    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const field = fields.find((f) => f.name === 'القسم');
    assert.equal(field.choices.length, 3);
    assert.ok(field.choices.every((c) => typeof c.choiceId === 'number'));
  });

  test('a choice field with no options is refused', async () => {
    const response = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'بلا خيارات',
      dataType: 'choice',
      choices: [],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'choices_required');
  });

  test('an unknown data type is refused', async () => {
    const response = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'غريب',
      dataType: 'jsonb',
    });
    assert.equal(response.statusCode, 400);
  });

  test('sensitivity labels are data, ordered by severity', async () => {
    for (const [name, rank] of [
      ['عام', 1],
      ['داخلي', 2],
      ['سري', 3],
    ]) {
      const response = await call('POST', '/api/metadata/labels', bossCookie, {
        name,
        severityRank: rank,
      });
      assert.equal(response.statusCode, 201, `${name} should be creatable`);
    }

    const labels = (await call('GET', '/api/metadata/labels', editorCookie)).json().labels;
    assert.deepEqual(
      labels.map((l) => l.name),
      ['عام', 'داخلي', 'سري'],
    );

    // Two labels at the same level makes "at or above Confidential" meaningless.
    const clash = await call('POST', '/api/metadata/labels', bossCookie, {
      name: 'مكرر',
      severityRank: 2,
    });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().error, 'rank_taken');
  });

  // ── Values on a document ───────────────────────────────────────────────

  test('editing metadata requires EDIT_META, not merely Read', async () => {
    const documentId = await makeDocument(editorCookie, 'وثيقة للتعديل');

    const refused = await call('PATCH', `/api/documents/${documentId}/metadata`, readerCookie, {
      title: 'محاولة',
    });
    assert.equal(refused.statusCode, 403, 'read does not imply edit');

    const allowed = await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      title: 'عنوان محدَّث',
    });
    assert.equal(allowed.statusCode, 200);
  });

  /**
   * The title and its normalised copy must move together. Writing one without
   * the other makes the document unfindable by its own new title — the kind of
   * bug that surfaces weeks later as "search is broken".
   */
  test('renaming a document keeps it findable by the new title', async () => {
    const documentId = await makeDocument(editorCookie, 'الاسم الأصلي');

    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      title: 'مكتبة الأرشيف',
    });

    // Searched with the ه spelling, stored with ة — only the normalised copy
    // closes that, and only if it was rewritten.
    const found = (await call('GET', '/api/search?q=مكتبه', editorCookie)).json();
    assert.ok(found.results.some((r) => r.documentId === documentId));
  });

  test('values land in the typed column and compare correctly', async () => {
    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const numberField = fields.find((f) => f.name === 'قيمة العقد');

    const cheap = await makeDocument(editorCookie, 'عقد صغير');
    const dear = await makeDocument(editorCookie, 'عقد كبير');

    await call('PATCH', `/api/documents/${cheap}/metadata`, editorCookie, {
      typeId,
      fields: [{ fieldId: numberField.fieldId, value: 900 }],
    });
    await call('PATCH', `/api/documents/${dear}/metadata`, editorCookie, {
      typeId,
      fields: [{ fieldId: numberField.fieldId, value: 5000 }],
    });

    const stored = await sql`
      SELECT value_number, value_text FROM dbo.document_field_values
       WHERE document_id = ${dear} AND field_id = ${numberField.fieldId}
    `.execute(db);
    assert.equal(Number(stored.rows[0].value_number), 5000);
    assert.equal(stored.rows[0].value_text, null, 'only the typed column is populated');

    // '900' > '5000' as text. One result means the comparison was numeric.
    const search = await call(
      'GET',
      `/api/search/fields/${numberField.fieldId}?min=1000`,
      editorCookie,
    );
    assert.equal(search.json().results.length, 1);
    assert.equal(search.json().results[0].documentId, dear);
  });

  test('a date value survives the round trip exactly', async () => {
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'تاريخ التوقيع',
      dataType: 'date',
    });
    const fieldId = created.json().fieldId;
    const documentId = await makeDocument(editorCookie, 'وثيقة بتاريخ');

    // A millisecond SQL Server's legacy `datetime` cannot represent. If the value
    // were bound as a JS Date it would be rounded and this would fail.
    const when = '2026-08-29T09:00:00.001Z';
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId, value: when }],
    });

    const stored = await sql`
      SELECT value_date FROM dbo.document_field_values
       WHERE document_id = ${documentId} AND field_id = ${fieldId}
    `.execute(db);

    assert.equal(new Date(stored.rows[0].value_date).toISOString(), when);
  });

  test('changing a value clears the previously used column', async () => {
    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const textField = fields.find((f) => f.name === 'الرقم المرجعي');
    const documentId = await makeDocument(editorCookie, 'وثيقة مرجعية');

    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: textField.fieldId, value: 'L-2026-118' }],
    });
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: textField.fieldId, value: 'L-2026-119' }],
    });

    const stored = await sql`
      SELECT value_text FROM dbo.document_field_values
       WHERE document_id = ${documentId} AND field_id = ${textField.fieldId}
    `.execute(db);
    assert.equal(stored.rows[0].value_text, 'L-2026-119');
  });

  test('clearing a value removes the row rather than storing an empty one', async () => {
    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const textField = fields.find((f) => f.name === 'الرقم المرجعي');
    const documentId = await makeDocument(editorCookie, 'وثيقة ستُفرَّغ');

    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: textField.fieldId, value: 'TEMP' }],
    });
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: textField.fieldId, value: null }],
    });

    const stored = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_field_values
       WHERE document_id = ${documentId} AND field_id = ${textField.fieldId}
    `.execute(db);
    // The CHECK requires exactly one populated column, so "no value" has to be
    // no row at all.
    assert.equal(Number(stored.rows[0].n), 0);
  });

  test('a value of the wrong shape is refused before anything is written', async () => {
    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const numberField = fields.find((f) => f.name === 'قيمة العقد');
    const documentId = await makeDocument(editorCookie, 'وثيقة بقيمة خاطئة');

    const response = await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      title: 'عنوان لن يُحفظ',
      fields: [{ fieldId: numberField.fieldId, value: 'ليس رقماً' }],
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_value');

    // Validation happens before the transaction, so the title must be untouched:
    // a half-applied metadata change is worse than none.
    const document = (await call('GET', `/api/documents/${documentId}`, editorCookie)).json();
    assert.equal(document.title, 'وثيقة بقيمة خاطئة');
  });

  test('an unknown field id is refused', async () => {
    const documentId = await makeDocument(editorCookie, 'وثيقة');
    const response = await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: 999999, value: 'x' }],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'unknown_field');
  });

  test('the document detail response carries its field values', async () => {
    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const choiceField = fields.find((f) => f.name === 'القسم');
    const documentId = await makeDocument(editorCookie, 'وثيقة بحقول');

    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId: choiceField.fieldId, value: choiceField.choices[0].choiceId }],
    });

    const document = (await call('GET', `/api/documents/${documentId}`, editorCookie)).json();
    const value = document.fields.find((f) => f.fieldId === choiceField.fieldId);

    assert.ok(value, 'the field should be present');
    assert.equal(value.choiceLabel, choiceField.choices[0].label, 'resolved for display');
  });

  test('deactivating a type hides it without touching documents that use it', async () => {
    const documentId = await makeDocument(editorCookie, 'وثيقة مصنفة');
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, { typeId });

    await call('POST', `/api/metadata/types/${typeId}/active`, bossCookie, { active: false });

    const visible = (await call('GET', '/api/metadata/types', editorCookie)).json();
    assert.ok(!visible.types.some((t) => t.typeId === typeId), 'hidden from the picker');

    // The document keeps its classification: deleting the type would either
    // orphan it or cascade the classification away.
    const document = (await call('GET', `/api/documents/${documentId}`, editorCookie)).json();
    assert.equal(document.typeId, typeId);

    await call('POST', `/api/metadata/types/${typeId}/active`, bossCookie, { active: true });
  });

  test('metadata edits are recorded in the audit trail', async () => {
    const documentId = await makeDocument(editorCookie, 'وثيقة مدققة');
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, { title: 'بعد التعديل' });

    const entries = await sql`
      SELECT actor_username FROM dbo.audit_log
       WHERE action = 'document.metadata_changed' AND target_id = ${documentId}
    `.execute(db);

    assert.equal(entries.rows.length, 1);
    assert.equal(entries.rows[0].actor_username, 'editor');
  });

  // ── Definition mutations (PATCH / active toggle) ───────────────────────

  test('renaming a type shows in the list; a name clash answers 409 name_taken', async () => {
    // Create a second type so we have something to clash with.
    const second = await call('POST', '/api/metadata/types', bossCookie, { name: 'مراسلات' });
    assert.equal(second.statusCode, 201);

    // Rename the main type.
    const renamed = await call('PATCH', `/api/metadata/types/${typeId}`, bossCookie, {
      name: 'عقود محدَّثة',
    });
    assert.equal(renamed.statusCode, 200);

    const list = (await call('GET', '/api/metadata/types', editorCookie)).json();
    assert.ok(list.types.some((t) => t.name === 'عقود محدَّثة'), 'new name appears in list');
    assert.ok(!list.types.some((t) => t.name === 'عقد'), 'old name is gone');

    // Restore the original name so later tests keep working.
    await call('PATCH', `/api/metadata/types/${typeId}`, bossCookie, { name: 'عقد' });

    // Clash with the second type's name.
    const clash = await call('PATCH', `/api/metadata/types/${typeId}`, bossCookie, {
      name: 'مراسلات',
    });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().error, 'name_taken');
  });

  test('editing a field flips isRequired/isSearchable and renames it; reading reflects all three', async () => {
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'حقل للتعديل',
      dataType: 'text',
      isRequired: false,
      isSearchable: true,
    });
    assert.equal(created.statusCode, 201);
    const fieldId = created.json().fieldId;

    const patched = await call('PATCH', `/api/metadata/fields/${fieldId}`, bossCookie, {
      name: 'حقل معدَّل',
      isRequired: true,
      isSearchable: false,
    });
    assert.equal(patched.statusCode, 200);

    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const field = fields.find((f) => f.fieldId === fieldId);
    assert.ok(field, 'edited field should appear in the list');
    assert.equal(field.name, 'حقل معدَّل', 'name updated');
    assert.equal(field.isRequired, true, 'isRequired flipped');
    assert.equal(field.isSearchable, false, 'isSearchable flipped');
  });

  test('choices survive an edit: kept option keeps its choiceId, dropped one is deactivated, new one appears, document still reads the kept value', async () => {
    // Create a choice field with three options.
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'تصنيف الوثيقة',
      dataType: 'choice',
      choices: ['الأول', 'الثاني', 'الثالث'],
    });
    assert.equal(created.statusCode, 201);
    const fieldId = created.json().fieldId;

    const fields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const field = fields.find((f) => f.fieldId === fieldId);
    assert.equal(field.choices.length, 3);
    const keptChoice = field.choices.find((c) => c.label === 'الأول');
    const droppedChoice = field.choices.find((c) => c.label === 'الثاني');
    const droppedChoice2 = field.choices.find((c) => c.label === 'الثالث');
    assert.ok(keptChoice);
    assert.ok(droppedChoice);
    assert.ok(droppedChoice2);

    // Set the first choice on a document so we can verify it survives.
    const documentId = await makeDocument(editorCookie, 'وثيقة باختيار');
    await call('PATCH', `/api/documents/${documentId}/metadata`, editorCookie, {
      fields: [{ fieldId, value: keptChoice.choiceId }],
    });

    // PATCH: keep 'الأول', drop 'الثاني' and 'الثالث', add 'الرابع'.
    const patched = await call('PATCH', `/api/metadata/fields/${fieldId}`, bossCookie, {
      choices: ['الأول', 'الرابع'],
    });
    assert.equal(patched.statusCode, 200);

    const afterFields = (await call('GET', '/api/metadata/fields', editorCookie)).json().fields;
    const afterField = afterFields.find((f) => f.fieldId === fieldId);

    // Kept option preserves its choice_id.
    const afterKept = afterField.choices.find((c) => c.label === 'الأول');
    assert.ok(afterKept, 'kept choice still appears');
    assert.equal(afterKept.choiceId, keptChoice.choiceId, 'kept choice preserves its id');

    // New option appears.
    assert.ok(afterField.choices.find((c) => c.label === 'الرابع'), 'new choice appears');

    // Both dropped choices are deactivated in the DB (not deleted — FK references must stay valid).
    const droppedRow = await sql`
      SELECT is_active FROM dbo.custom_field_choices WHERE choice_id = ${droppedChoice.choiceId}
    `.execute(db);
    assert.equal(Number(droppedRow.rows[0].is_active), 0, 'dropped choice الثاني is_active = 0');

    const droppedRow2 = await sql`
      SELECT is_active FROM dbo.custom_field_choices WHERE choice_id = ${droppedChoice2.choiceId}
    `.execute(db);
    assert.equal(Number(droppedRow2.rows[0].is_active), 0, 'dropped choice الثالث is_active = 0');

    // Neither dropped choice appears in GET /api/metadata/fields.
    assert.ok(!afterField.choices.find((c) => c.label === 'الثاني'), 'dropped choice الثاني hidden from list');
    assert.ok(!afterField.choices.find((c) => c.label === 'الثالث'), 'dropped choice الثالث hidden from list');

    // The document still reads back the kept choice value.
    const document = (await call('GET', `/api/documents/${documentId}`, editorCookie)).json();
    const fieldValue = document.fields.find((f) => f.fieldId === fieldId);
    assert.ok(fieldValue, 'document still carries the field value');
    assert.equal(fieldValue.choiceLabel, 'الأول', 'document reads back the kept choice label');
  });

  test('label edit changes name/rank/colour; deactivate hides it; ?inactive=true lists it; reactivate restores it; rank clash answers 409', async () => {
    const created = await call('POST', '/api/metadata/labels', bossCookie, {
      name: 'تجريبي',
      severityRank: 10,
    });
    assert.equal(created.statusCode, 201);
    const labelId = created.json().labelId;

    // Edit name and colour.
    const patched = await call('PATCH', `/api/metadata/labels/${labelId}`, bossCookie, {
      name: 'تجريبي معدَّل',
      colour: '#FF5733',
    });
    assert.equal(patched.statusCode, 200);

    const labels = (await call('GET', '/api/metadata/labels', editorCookie)).json().labels;
    const label = labels.find((l) => l.labelId === labelId);
    assert.ok(label, 'updated label appears');
    assert.equal(label.name, 'تجريبي معدَّل', 'name updated');
    assert.equal(label.colour, '#FF5733', 'colour updated');

    // Deactivate: should vanish from the default listing.
    const deactivated = await call('POST', `/api/metadata/labels/${labelId}/active`, bossCookie, {
      active: false,
    });
    assert.equal(deactivated.statusCode, 200);

    const hidden = (await call('GET', '/api/metadata/labels', editorCookie)).json().labels;
    assert.ok(!hidden.find((l) => l.labelId === labelId), 'deactivated label not in default list');

    // ?inactive=true still lists it with isActive = false.
    const all = (await call('GET', '/api/metadata/labels?inactive=true', editorCookie)).json().labels;
    const inactiveLabel = all.find((l) => l.labelId === labelId);
    assert.ok(inactiveLabel, 'deactivated label in ?inactive=true list');
    assert.equal(inactiveLabel.isActive, false, 'isActive is false');

    // Reactivating brings it back to the default listing.
    await call('POST', `/api/metadata/labels/${labelId}/active`, bossCookie, { active: true });
    const restored = (await call('GET', '/api/metadata/labels', editorCookie)).json().labels;
    assert.ok(restored.find((l) => l.labelId === labelId), 'reactivated label reappears');

    // Rank clash: 'عام' already occupies rank 1.
    const rankClash = await call('PATCH', `/api/metadata/labels/${labelId}`, bossCookie, {
      severityRank: 1,
    });
    assert.equal(rankClash.statusCode, 409);
    assert.equal(rankClash.json().error, 'rank_taken');
  });

  test('dbo.audit_log has metadata.definition_changed rows for boss after definition mutations', async () => {
    const entries = await sql`
      SELECT action, actor_username FROM dbo.audit_log
       WHERE action = 'metadata.definition_changed' AND actor_username = 'boss'
    `.execute(db);

    assert.ok(entries.rows.length > 0, 'audit trail carries metadata.definition_changed rows from boss');
  });
});
