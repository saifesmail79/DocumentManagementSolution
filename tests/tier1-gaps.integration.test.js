/**
 * Integration tests for the Tier 1 features that were missing.
 *
 * These correspond one-to-one with rows in the blueprint's "Core — MANDATORY"
 * table: duplicate detection, the recycle bin, required-field validation at
 * upload, multi-criteria attribute search, the two remaining field types, and
 * the runtime configuration panel.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-tier1-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;

let db;
let sql;
let app;
let PERM;
let storage;
let settings;

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

/** Uploads, optionally with a type and metadata part. */
async function upload(cookie, folderName, filename, content, { typeId, fields } = {}) {
  const boundary = '----dmstier1';
  const parts = [];

  if (typeId !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="typeId"\r\n\r\n${typeId}\r\n`,
        'utf8',
      ),
    );
  }
  if (fields !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="fields"\r\n\r\n${JSON.stringify(fields)}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/plain\r\n\r\n',
      'utf8',
    ),
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );

  return app.inject({
    method: 'POST',
    url: `/api/folders/${id[folderName]}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
}

describe('Tier 1 gaps', { skip: CONFIGURED ? false : target.reason }, () => {
  let cookie;
  let bossCookie;
  let typeId;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();
    settings = await import('../src/modules/settings/service.js');
    settings.resetSettingsCache();

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('clerk');
    await makeUser('boss', { superAdmin: true });
    await makeFolder('cabinet');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.clerk},
              ${PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE}, 0)
    `.execute(db);

    cookie = await signIn('clerk');
    bossCookie = await signIn('boss');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── Duplicate detection at upload ──────────────────────────────────────

  test('an identical file is reported as a duplicate, not silently filed', async () => {
    const content = 'محتوى مطابق تماما للاختبار';
    const first = await upload(cookie, 'cabinet', 'original.txt', content);
    assert.equal(first.statusCode, 201);

    const second = await upload(cookie, 'cabinet', 'copy.txt', content);
    assert.equal(second.statusCode, 201, 'the default policy warns rather than blocks');

    const body = second.json();
    assert.ok(body.duplicateOf?.length >= 1, 'the existing document should be named');
    assert.equal(body.duplicateOf[0].documentId, first.json().documentId);
  });

  test('a different file is not reported as a duplicate', async () => {
    const response = await upload(cookie, 'cabinet', 'unique.txt', 'محتوى مختلف تماما');
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().duplicateOf, undefined);
  });

  test('the block policy refuses the upload and stores nothing', async () => {
    await settings.setSetting({ key: 'upload.duplicate_policy', value: 'block' });
    settings.resetSettingsCache();

    const content = 'محتوى سيُرفض عند التكرار';
    assert.equal((await upload(cookie, 'cabinet', 'a.txt', content)).statusCode, 201);

    const blocked = await upload(cookie, 'cabinet', 'b.txt', content);
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'duplicate');
    assert.ok(blocked.json().duplicates.length >= 1, 'and says which document it matches');

    // The staged copy must be discarded, or a blocked upload leaks disk on every
    // attempt.
    const { readdir } = await import('node:fs/promises');
    const staging = await readdir(path.join(STORAGE_ROOT, '.staging')).catch(() => []);
    assert.equal(staging.length, 0);

    await settings.setSetting({ key: 'upload.duplicate_policy', value: 'warn' });
    settings.resetSettingsCache();
  });

  test('duplicates can be checked by hash before uploading', async () => {
    const content = 'محتوى للتحقق المسبق';
    await upload(cookie, 'cabinet', 'prechecked.txt', content);

    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    const response = await call('GET', `/api/documents/duplicates/${sha256}`, cookie);

    assert.equal(response.statusCode, 200);
    assert.ok(response.json().duplicates.length >= 1, 'a 200MB duplicate need never be transferred');
  });

  test('a duplicate in a folder the user cannot see is not revealed', async () => {
    await makeFolder('private');
    const content = 'محتوى سري مكرر';

    // Filed by an administrator into a folder the clerk has no grant on.
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.private}, ${id.boss}, ${PERM.BROWSE | PERM.READ | PERM.UPLOAD}, 0)
    `.execute(db);
    await upload(bossCookie, 'private', 'secret.txt', content);

    const response = await upload(cookie, 'cabinet', 'mine.txt', content);
    assert.equal(response.statusCode, 201);
    // Naming it would leak both its existence and its title.
    assert.equal(response.json().duplicateOf, undefined);
  });

  // ── Recycle bin ────────────────────────────────────────────────────────

  test('a deleted document appears in the recycle bin and can be restored', async () => {
    const created = await upload(cookie, 'cabinet', 'oops.txt', 'حُذف بالخطأ');
    const documentId = created.json().documentId;

    await call('DELETE', `/api/documents/${documentId}`, cookie);

    const bin = (await call('GET', '/api/recycle-bin', cookie)).json();
    const entry = bin.documents.find((d) => d.documentId === documentId);
    assert.ok(entry, 'the deleted document should be listed');
    assert.equal(entry.deletedBy, 'clerk');
    assert.equal(entry.restorable, true);

    const restored = await call('POST', `/api/documents/${documentId}/restore`, cookie);
    assert.equal(restored.statusCode, 200);

    // Back in the folder listing, and openable again.
    const listing = (await call('GET', `/api/folders/${id.cabinet}`, cookie)).json();
    assert.ok(listing.documents.some((d) => d.documentId === documentId));
    assert.equal((await call('GET', `/api/documents/${documentId}/content`, cookie)).statusCode, 200);
  });

  test('the recycle bin needs Delete, not merely Read', async () => {
    await makeUser('reader');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.reader}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);
    const readerCookie = await signIn('reader');

    const created = await upload(cookie, 'cabinet', 'binned.txt', 'محتوى محذوف');
    await call('DELETE', `/api/documents/${created.json().documentId}`, cookie);

    // Otherwise the bin becomes a record of what colleagues throw away.
    const bin = (await call('GET', '/api/recycle-bin', readerCookie)).json();
    assert.equal(bin.documents.length, 0);
  });

  test('restoring a document whose content was purged is refused', async () => {
    const created = await upload(cookie, 'cabinet', 'gone.txt', 'سيُمحى نهائيا');
    const documentId = created.json().documentId;

    await call('DELETE', `/api/documents/${documentId}`, cookie);
    await sql`
      UPDATE dbo.documents SET deleted_at = DATEADD(day, -60, SYSUTCDATETIME())
       WHERE document_id = ${documentId}
    `.execute(db);

    const purge = await import('../src/modules/storage-maintenance/purge.js');
    await purge.purgeDeletedDocuments({ graceDays: 30 });

    // Restoring would produce a document that lists and then fails to open.
    const restored = await call('POST', `/api/documents/${documentId}/restore`, cookie);
    assert.equal(restored.statusCode, 410);
    assert.equal(restored.json().error, 'content_purged');

    const bin = (await call('GET', '/api/recycle-bin', cookie)).json();
    const entry = bin.documents.find((d) => d.documentId === documentId);
    assert.equal(entry.restorable, false, 'and it is shown as unrestorable');
  });

  test('restoring is recorded in the audit trail', async () => {
    const created = await upload(cookie, 'cabinet', 'audited-restore.txt', 'محتوى');
    const documentId = created.json().documentId;
    await call('DELETE', `/api/documents/${documentId}`, cookie);
    await call('POST', `/api/documents/${documentId}/restore`, cookie);

    const entries = await sql`
      SELECT actor_username FROM dbo.audit_log
       WHERE action = 'document.restored' AND target_id = ${documentId}
    `.execute(db);

    // "This came back and nobody knows who did it" is exactly what an audit gets
    // asked about.
    assert.equal(entries.rows.length, 1);
    assert.equal(entries.rows[0].actor_username, 'clerk');
  });

  // ── Required fields at upload ──────────────────────────────────────────

  test('a required field blocks the upload before any byte is stored', async () => {
    const type = await call('POST', '/api/metadata/types', bossCookie, { name: 'عقد رسمي' });
    typeId = type.json().typeId;

    const field = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'رقم العقد',
      dataType: 'text',
      typeId,
      isRequired: true,
    });
    const fieldId = field.json().fieldId;

    const refused = await upload(cookie, 'cabinet', 'incomplete.txt', 'محتوى', { typeId });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, 'required_field');
    assert.match(refused.json().detail, /رقم العقد/, 'it should name the missing field');

    // Nothing staged: rejecting after the transfer would waste the upload.
    const { readdir } = await import('node:fs/promises');
    const staging = await readdir(path.join(STORAGE_ROOT, '.staging')).catch(() => []);
    assert.equal(staging.length, 0);

    const accepted = await upload(cookie, 'cabinet', 'complete.txt', 'محتوى', {
      typeId,
      fields: [{ fieldId, value: 'C-2026-1' }],
    });
    assert.equal(accepted.statusCode, 201);
  });

  test('a document with no type has no required fields', async () => {
    const response = await upload(cookie, 'cabinet', 'untyped.txt', 'محتوى بلا نوع');
    assert.equal(response.statusCode, 201, 'the type is what carries the obligation');
  });

  // ── New field types ────────────────────────────────────────────────────

  test('a multi-select field holds several values at once', async () => {
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'الأقسام المعنية',
      dataType: 'multiselect',
      choices: ['القانونية', 'المالية', 'الهندسية'],
    });
    assert.equal(created.statusCode, 201);
    const fieldId = created.json().fieldId;

    const fields = (await call('GET', '/api/metadata/fields', cookie)).json().fields;
    const definition = fields.find((f) => f.fieldId === fieldId);
    assert.equal(definition.choices.length, 3);

    const documentId = (await upload(cookie, 'cabinet', 'multi.txt', 'محتوى')).json().documentId;
    const chosen = [definition.choices[0].choiceId, definition.choices[2].choiceId];

    const saved = await call('PATCH', `/api/documents/${documentId}/metadata`, cookie, {
      fields: [{ fieldId, value: chosen }],
    });
    assert.equal(saved.statusCode, 200);

    const document = (await call('GET', `/api/documents/${documentId}`, cookie)).json();
    const value = document.fields.find((f) => f.fieldId === fieldId);
    assert.deepEqual(value.value.sort(), chosen.sort());
    assert.equal(value.choiceLabel.length, 2, 'labels are resolved for display');
  });

  test('a multi-select can be narrowed and cleared', async () => {
    const fields = (await call('GET', '/api/metadata/fields', cookie)).json().fields;
    const field = fields.find((f) => f.name === 'الأقسام المعنية');
    const documentId = (await upload(cookie, 'cabinet', 'multi2.txt', 'محتوى')).json().documentId;

    await call('PATCH', `/api/documents/${documentId}/metadata`, cookie, {
      fields: [{ fieldId: field.fieldId, value: field.choices.map((c) => c.choiceId) }],
    });
    await call('PATCH', `/api/documents/${documentId}/metadata`, cookie, {
      fields: [{ fieldId: field.fieldId, value: [field.choices[1].choiceId] }],
    });

    const rows = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_field_selections
       WHERE document_id = ${documentId} AND field_id = ${field.fieldId}
    `.execute(db);
    assert.equal(Number(rows.rows[0].n), 1, 'the set is replaced, not appended to');

    await call('PATCH', `/api/documents/${documentId}/metadata`, cookie, {
      fields: [{ fieldId: field.fieldId, value: [] }],
    });
    const cleared = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_field_selections WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(cleared.rows[0].n), 0);
  });

  test('a user-picker field stores a principal', async () => {
    const created = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'المسؤول',
      dataType: 'user',
    });
    const fieldId = created.json().fieldId;
    const documentId = (await upload(cookie, 'cabinet', 'owner.txt', 'محتوى')).json().documentId;

    const saved = await call('PATCH', `/api/documents/${documentId}/metadata`, cookie, {
      fields: [{ fieldId, value: String(id.clerk) }],
    });
    assert.equal(saved.statusCode, 200);

    const document = (await call('GET', `/api/documents/${documentId}`, cookie)).json();
    const value = document.fields.find((f) => f.fieldId === fieldId);
    assert.equal(value.value, String(id.clerk));
    assert.equal(value.choiceLabel, 'clerk', 'resolved to a name for display');
  });

  // ── Multi-criteria search ──────────────────────────────────────────────

  test('criteria combine: type AND field value AND date range', async () => {
    const amount = await call('POST', '/api/metadata/fields', bossCookie, {
      name: 'المبلغ',
      dataType: 'number',
      typeId,
    });
    const amountId = amount.json().fieldId;
    const refField = (await call('GET', '/api/metadata/fields', cookie))
      .json()
      .fields.find((f) => f.name === 'رقم العقد');

    const cheap = (
      await upload(cookie, 'cabinet', 'cheap.txt', 'عقد صغير', {
        typeId,
        fields: [{ fieldId: refField.fieldId, value: 'C-1' }],
      })
    ).json().documentId;
    const dear = (
      await upload(cookie, 'cabinet', 'dear.txt', 'عقد كبير', {
        typeId,
        fields: [{ fieldId: refField.fieldId, value: 'C-2' }],
      })
    ).json().documentId;

    await call('PATCH', `/api/documents/${cheap}/metadata`, cookie, {
      fields: [{ fieldId: amountId, value: 900 }],
    });
    await call('PATCH', `/api/documents/${dear}/metadata`, cookie, {
      fields: [{ fieldId: amountId, value: 5000 }],
    });

    const response = await call('POST', '/api/search/advanced', cookie, {
      typeId,
      fields: [{ fieldId: amountId, op: 'number', min: 1000 }],
      createdFrom: new Date(Date.now() - 3_600_000).toISOString(),
    });

    assert.equal(response.statusCode, 200);
    const ids = response.json().results.map((r) => r.documentId);
    assert.ok(ids.includes(dear));
    assert.ok(!ids.includes(cheap), 'the amount criterion must actually narrow');
  });

  test('two field criteria AND together rather than widening', async () => {
    const fields = (await call('GET', '/api/metadata/fields', cookie)).json().fields;
    const amountId = fields.find((f) => f.name === 'المبلغ').fieldId;
    const refId = fields.find((f) => f.name === 'رقم العقد').fieldId;

    const both = await call('POST', '/api/search/advanced', cookie, {
      fields: [
        { fieldId: amountId, op: 'number', min: 1000 },
        { fieldId: refId, value: 'C-2' },
      ],
    });
    assert.equal(both.json().results.length, 1);

    // The same two criteria where no document satisfies both.
    const contradictory = await call('POST', '/api/search/advanced', cookie, {
      fields: [
        { fieldId: amountId, op: 'number', min: 1000 },
        { fieldId: refId, value: 'C-1' },
      ],
    });
    assert.equal(contradictory.json().results.length, 0);
  });

  test('advanced search stays permission-filtered', async () => {
    const response = await call('POST', '/api/search/advanced', cookie, {
      q: 'سري',
      folderId: String(id.private),
    });
    // The clerk has no grant on `private`, so the scope resolves to nothing.
    assert.deepEqual(response.json().results, []);
  });

  test('advanced search with no criteria still only returns permitted documents', async () => {
    await makeUser('stranger');
    const strangerCookie = await signIn('stranger');

    const response = await call('POST', '/api/search/advanced', strangerCookie, {});
    assert.deepEqual(response.json().results, []);
  });

  // ── Configuration panel ────────────────────────────────────────────────

  test('settings list their effective value and where it came from', async () => {
    const response = await call('GET', '/api/settings', bossCookie);
    assert.equal(response.statusCode, 200);

    const list = response.json().settings;
    const lockout = list.find((s) => s.key === 'auth.lockout_minutes');
    assert.equal(typeof lockout.value, 'number');
    // Telling stored from environment is what makes "I changed it and nothing
    // happened" diagnosable.
    assert.ok(['database', 'environment'].includes(lockout.source));
  });

  test('a setting can be changed and read back without a restart', async () => {
    const response = await call('PUT', '/api/settings/auth.lockout_minutes', bossCookie, { value: 30 });
    assert.equal(response.statusCode, 200);

    settings.resetSettingsCache();
    assert.equal(await settings.getSetting('auth.lockout_minutes'), 30);

    const list = (await call('GET', '/api/settings', bossCookie)).json().settings;
    assert.equal(list.find((s) => s.key === 'auth.lockout_minutes').source, 'database');
  });

  test('an out-of-range or unknown setting is refused', async () => {
    /*
     * 0, not 2.
     *
     * The minimum password length used to refuse anything under 8, and this
     * asserted that. The floor was removed deliberately — it is the
     * administrator's policy to set, and a control that refuses the decision it
     * exists to record is not a setting. 2 is now a legal, if unwise, policy.
     *
     * What remains is the bound that cannot be satisfied rather than the one
     * that is merely lax: 0 characters is not a password, and a minimum above
     * the longest password the system will hash would lock every account out of
     * changing its own.
     */
    const tooLow = await call('PUT', '/api/settings/auth.min_password_length', bossCookie, { value: 0 });
    assert.equal(tooLow.statusCode, 400);
    assert.equal(tooLow.json().error, 'out_of_range');

    // The bounds come back with the refusal, so the message can name them
    // instead of leaving the reader to find the limit by trial and error.
    assert.equal(tooLow.json().min, 1);
    assert.equal(typeof tooLow.json().max, 'number');

    const tooHigh = await call('PUT', '/api/settings/auth.min_password_length', bossCookie, {
      value: 100000,
    });
    assert.equal(tooHigh.statusCode, 400);
    assert.equal(tooHigh.json().error, 'out_of_range');

    // And the policy the owner asked for is accepted.
    const short = await call('PUT', '/api/settings/auth.min_password_length', bossCookie, { value: 4 });
    assert.equal(short.statusCode, 200, short.body);
    await call('DELETE', '/api/settings/auth.min_password_length', bossCookie);

    const unknown = await call('PUT', '/api/settings/not.a.real.setting', bossCookie, { value: 'x' });
    assert.equal(unknown.statusCode, 404);

    const badOption = await call('PUT', '/api/settings/upload.duplicate_policy', bossCookie, {
      value: 'explode',
    });
    assert.equal(badOption.statusCode, 400);
  });

  test('clearing a setting returns it to the environment default', async () => {
    await call('PUT', '/api/settings/auth.session_ttl_hours', bossCookie, { value: 48 });
    settings.resetSettingsCache();
    assert.equal(await settings.getSetting('auth.session_ttl_hours'), 48);

    await call('DELETE', '/api/settings/auth.session_ttl_hours', bossCookie);
    settings.resetSettingsCache();

    const { config } = await import('../src/config/index.js');
    assert.equal(await settings.getSetting('auth.session_ttl_hours'), config.auth.sessionTtlHours);
  });

  test('settings are super-admin only, including reading them', async () => {
    // The values include lockout thresholds and password policy, which tell an
    // attacker exactly how much room they have.
    assert.equal((await call('GET', '/api/settings', cookie)).statusCode, 403);
    assert.equal(
      (await call('PUT', '/api/settings/organisation.name', cookie, { value: 'x' })).statusCode,
      403,
    );
  });

  test('a settings change is recorded with the value it was set to', async () => {
    await call('PUT', '/api/settings/organisation.name', bossCookie, { value: 'وزارة الاختبار' });

    const entries = await sql`
      SELECT detail, actor_username FROM dbo.audit_log
       WHERE action = 'settings.changed' AND target_id = 'organisation.name'
       ORDER BY audit_id DESC
    `.execute(db);

    assert.ok(entries.rows.length >= 1);
    assert.equal(entries.rows[0].detail, 'وزارة الاختبار');
    assert.equal(entries.rows[0].actor_username, 'boss');
  });
});
