/**
 * Integration tests for the correspondence register (الوارد والصادر).
 *
 * The whole phase-1 story: the switch, the mail-room role, registration with
 * book numbers drawn from yearly counters, routing to units, the queue and its
 * receive/close gestures, المتابعة, annulment, and the counter's paper-book
 * migration path.
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

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-mail-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;
process.env.RENDITIONS_ENABLED = 'false';

let db;
let sql;
let app;
let PERM;
let storage;

const PASSWORD = 'correct-horse-battery-staple';
const YEAR = new Date().getUTCFullYear();
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
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });

async function upload(cookie, folderName, filename, content) {
  const boundary = '----dmsmail';
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id[folderName]}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
        'utf8',
      ),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

/**
 * Posts a rescanned paper as a new version of its letter.
 *
 * The text fields go BEFORE the file part on purpose: @fastify/multipart cannot
 * read a field that arrives after the stream the handler is already consuming,
 * so a client that sends them last gets an un-named version and no trail entry.
 * The test sends them in the order the route documents.
 */
async function addLetterVersion(cookie, letterId, fields, filename, content) {
  const boundary = '----dmsmailtrail';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
        + 'Content-Type: text/plain\r\n\r\n',
      'utf8',
    ),
  );
  parts.push(Buffer.from(content, 'utf8'));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return app.inject({
    method: 'POST',
    url: `/api/correspondence/letters/${letterId}/versions`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
}

describe('the correspondence register', { skip: CONFIGURED ? false : target.reason }, () => {
  let postman;
  let fin1;
  let fin2;
  let hr1;
  let boss;
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

    // Settings survive resetDatabase on purpose; a previous run's switch state
    // must not decide what "disabled" means in this one.
    await sql`DELETE FROM dbo.app_settings WHERE setting_key LIKE 'correspondence.%'`.execute(db);

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('postman');
    await makeUser('fin1');
    await makeUser('fin2');
    await makeUser('hr1');
    await makeUser('outsider');
    await makeUser('boss', { superAdmin: true });

    await makeGroup('قلم الوارد', [id.postman]);
    await makeGroup('المالية', [id.fin1, id.fin2]);
    await makeGroup('الموارد البشرية', [id.hr1]);

    await makeFolder('intake');
    const readOnly = PERM.BROWSE | PERM.READ;
    const mailroomBits = readOnly | PERM.UPLOAD | PERM.EDIT_META;
    for (const [principal, bits] of [
      ['قلم الوارد', mailroomBits],
      // Finance may upload, HR may only read — the two halves of the paper-trail
      // permission story. A department holding the letter is allowed to record
      // what happened in its own hands, but only the FOLDER decides whether it
      // may add a scan, so these two units must differ in exactly that bit.
      ['المالية', readOnly | PERM.UPLOAD],
      ['الموارد البشرية', readOnly],
    ]) {
      await sql`
        INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
        VALUES (${id.intake}, ${id[principal]}, ${bits}, 0)
      `.execute(db);
    }

    postman = await signIn('postman');
    fin1 = await signIn('fin1');
    fin2 = await signIn('fin2');
    hr1 = await signIn('hr1');
    boss = await signIn('boss');
    outsider = await signIn('outsider');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── The switch ─────────────────────────────────────────────────────────

  test('while the switch is off, status says so and nothing else answers', async () => {
    const status = await call('GET', '/api/correspondence/status', postman);
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().enabled, false);
    // Off means off: no role, no units, no `member` flag for the menu to read.
    assert.deepEqual(status.json(), { enabled: false });

    const refused = await call('POST', '/api/correspondence/register', boss, {
      documentId: '1',
      direction: 'in',
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'correspondence_disabled');
  });

  test('the switch turns on through the ordinary settings surface', async () => {
    const set = await call('PUT', '/api/settings/correspondence.enabled', boss, { value: true });
    assert.equal(set.statusCode, 200, set.body);
    const group = await call('PUT', '/api/settings/correspondence.mailroom_group', boss, {
      value: Number(id['قلم الوارد']),
    });
    assert.equal(group.statusCode, 200, group.body);

    const status = await call('GET', '/api/correspondence/status', postman);
    assert.equal(status.json().enabled, true);
    assert.equal(status.json().registrar, true);
  });

  // ── Units ──────────────────────────────────────────────────────────────

  test('units are super-admin configuration, name-unique while live', async () => {
    for (const [name, group] of [
      ['الشؤون المالية', 'المالية'],
      ['الموارد البشرية', 'الموارد البشرية'],
    ]) {
      const created = await call('POST', '/api/admin/correspondence/units', boss, {
        name,
        groupId: String(id[group]),
      });
      assert.equal(created.statusCode, 200, created.body);
      id[`unit:${name}`] = created.json().unitId;
    }

    const duplicate = await call('POST', '/api/admin/correspondence/units', boss, {
      name: 'الشؤون المالية',
      groupId: String(id['المالية']),
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, 'name_taken');

    const forbidden = await call('GET', '/api/admin/correspondence/units', postman);
    assert.equal(forbidden.statusCode, 403);
  });

  // ── Registration ───────────────────────────────────────────────────────

  test('only the mail room registers, and the book numbers count from one', async () => {
    const documentId = await upload(postman, 'intake', 'wared-1.txt', 'كتاب وارد');

    const refused = await call('POST', '/api/correspondence/register', fin1, {
      documentId,
      direction: 'in',
    });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error, 'not_registrar');

    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
      subject: 'طلب بيانات الموازنة',
      externalParty: 'وزارة التخطيط',
      externalRef: '١٢٣٤/٥',
      externalDate: '2026-09-01',
      transfers: [
        { unitId: id['unit:الشؤون المالية'], purpose: 'action', dueDate: '2026-09-12' },
        { unitId: id['unit:الموارد البشرية'], purpose: 'info' },
      ],
    });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().bookNumber, 1);
    assert.equal(registered.json().reference, `1/${YEAR}`);
    id.letter1 = registered.json().letterId;
    id.doc1 = documentId;

    const again = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
    });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'already_registered');

    const second = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'wared-2.txt', 'كتاب ثانٍ'),
      direction: 'in',
      subject: 'تعميم إجازات',
    });
    assert.equal(second.json().bookNumber, 2, 'the book counts sequentially');
    id.letter2 = second.json().letterId;
  });

  test('routing a letter notifies every member of the unit', async () => {
    const inbox = await call('GET', '/api/notifications?unread=true', fin2);
    const kinds = inbox.json().notifications.map((n) => n.kind);
    assert.ok(kinds.includes('mail.assigned'), `fin2 was not told: ${kinds.join(', ')}`);
  });

  // ── The queue and the gestures ─────────────────────────────────────────

  test('the queue shows a unit its open transfers, and nobody else theirs', async () => {
    const finance = await call('GET', '/api/correspondence/queue', fin1);
    assert.equal(finance.statusCode, 200);
    const mine = finance.json().transfers;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].reference, `1/${YEAR}`);
    assert.equal(mine[0].purpose, 'action');
    assert.equal(mine[0].canRead, true);
    id.finTransfer = mine[0].transferId;

    const hr = await call('GET', '/api/correspondence/queue', hr1);
    assert.equal(hr.json().transfers.length, 1);
    assert.equal(hr.json().transfers[0].purpose, 'info');
    id.hrTransfer = hr.json().transfers[0].transferId;

    const nobody = await call('GET', '/api/correspondence/queue', outsider);
    assert.deepEqual(nobody.json().transfers, []);

    // The badge: how many letters wait on this person's units.
    const finStatus = (await call('GET', '/api/correspondence/status', fin1)).json();
    const outsiderStatus = (await call('GET', '/api/correspondence/status', outsider)).json();
    assert.equal(finStatus.queueCount, 1);
    assert.equal(outsiderStatus.queueCount, 0);

    // And `member` — belonging to a live unit — is a separate answer from the
    // badge, because it decides whether «الوارد إليّ» exists for this person
    // rather than what it contains. The menu cannot read it off queueCount: a
    // zero there means "nothing waiting today" for fin1 and "no inbox at all"
    // for outsider, and those two must not look the same.
    assert.equal(finStatus.member, true);
    assert.equal(outsiderStatus.member, false, 'in no unit, so no inbox at all');
    assert.equal(
      (await call('GET', '/api/correspondence/status', postman)).json().member,
      false,
      'the mail room keeps the book without belonging to a unit',
    );
    assert.equal(
      (await call('GET', '/api/correspondence/status', boss)).json().member,
      false,
      'no super-admin override: a super admin in no unit genuinely has no inbox',
    );

    const stranger = await call(
      'POST',
      `/api/correspondence/transfers/${id.finTransfer}/receive`,
      hr1,
      {},
    );
    assert.equal(stranger.statusCode, 404, 'another unit cannot act on the transfer');
  });

  test('an information copy closes on acknowledgement; action needs receive then close', async () => {
    const seen = await call('POST', `/api/correspondence/transfers/${id.hrTransfer}/receive`, hr1, {});
    assert.equal(seen.statusCode, 200, seen.body);
    assert.deepEqual((await call('GET', '/api/correspondence/queue', hr1)).json().transfers, []);

    // The closed transfer is still reachable as the unit's own archive.
    const archive = await call('GET', '/api/correspondence/queue?scope=all', hr1);
    assert.equal(archive.json().transfers.length, 1);
    assert.equal(archive.json().transfers[0].status, 'done');
    const searched = await call(
      'GET',
      `/api/correspondence/queue?scope=all&q=${encodeURIComponent('الموازنة')}`,
      hr1,
    );
    assert.equal(searched.json().transfers.length, 1, 'the archive answers a subject search');

    assert.equal(
      (await call('POST', `/api/correspondence/transfers/${id.finTransfer}/receive`, fin1, {}))
        .statusCode,
      200,
    );
    const closed = await call('POST', `/api/correspondence/transfers/${id.finTransfer}/close`, fin2, {
      note: 'أُعدّ الرد وأُرسل للتوقيع',
    });
    assert.equal(closed.statusCode, 200, closed.body);

    // Both transfers settled, so the letter itself is done.
    const letter = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.equal(letter.json().letter.status, 'done');
    assert.equal(letter.json().transfers.find((t) => t.purpose === 'action').closeNote,
      'أُعدّ الرد وأُرسل للتوقيع');
  });

  test('the register and المتابعة belong to the mail room', async () => {
    assert.equal((await call('GET', '/api/correspondence/letters', fin1)).statusCode, 403);
    assert.equal((await call('GET', '/api/correspondence/followup', fin1)).statusCode, 403);

    const letters = await call('GET', `/api/correspondence/letters?direction=in&year=${YEAR}`, postman);
    assert.equal(letters.statusCode, 200);
    assert.equal(letters.json().letters.length, 2);

    // The register answers "which department is it with?" per letter — the
    // letter-level status compresses the transfers, so the rows carry them.
    const first = letters.json().letters.find((l) => l.reference === `1/${YEAR}`);
    assert.equal(first.transfers.length, 2);
    assert.ok(first.transfers.every((t) => t.status === 'done'));
    assert.ok(first.transfers.some((t) => t.unitName === 'الشؤون المالية'));

    // letter2 was registered without transfers and is still just registered.
    const followup = await call('GET', '/api/correspondence/followup', postman);
    assert.deepEqual(followup.json().transfers, [], 'everything routed so far is closed');
  });

  test('forwarding again is one live transfer per unit, withdrawable by the mail room', async () => {
    const routed = await call('POST', `/api/correspondence/letters/${id.letter2}/transfers`, postman, {
      transfers: [{ unitId: id['unit:الشؤون المالية'], purpose: 'action' }],
    });
    assert.equal(routed.statusCode, 200, routed.body);

    const duplicate = await call('POST', `/api/correspondence/letters/${id.letter2}/transfers`, postman, {
      transfers: [{ unitId: id['unit:الشؤون المالية'], purpose: 'action' }],
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error, 'already_routed_to_unit');

    const open = (await call('GET', '/api/correspondence/followup', postman)).json().transfers;
    assert.equal(open.length, 1);

    // Withdrawing demands a substantive reason — a blank correction teaches
    // nobody anything when the book is read later.
    const bare = await call(
      'POST',
      `/api/correspondence/transfers/${open[0].transferId}/cancel`,
      postman,
      { reason: 'خطأ' },
    );
    assert.equal(bare.statusCode, 400);
    assert.equal(bare.json().error, 'reason_too_short');

    const cancelled = await call(
      'POST',
      `/api/correspondence/transfers/${open[0].transferId}/cancel`,
      postman,
      { reason: 'أُحيل إلى القسم الخطأ' },
    );
    assert.equal(cancelled.statusCode, 200);

    // With its only routing withdrawn and nothing ever done, the letter goes
    // back to plain registered rather than pretending someone finished it.
    const letter = await call('GET', `/api/correspondence/letters/${id.letter2}`, postman);
    assert.equal(letter.json().letter.status, 'registered');
  });

  test('a transfer already received can still be withdrawn and rerouted', async () => {
    // The wrong-department case AFTER the wrong department pressed تسلّم: the
    // mail room can still pull it back, and the letter is routable again.
    await call('POST', `/api/correspondence/letters/${id.letter2}/transfers`, postman, {
      transfers: [{ unitId: id['unit:الموارد البشرية'], purpose: 'action' }],
    });
    const queued = (await call('GET', '/api/correspondence/queue', hr1)).json().transfers;
    const wrong = queued.find((t) => t.letterId === id.letter2);
    assert.equal(
      (await call('POST', `/api/correspondence/transfers/${wrong.transferId}/receive`, hr1, {}))
        .statusCode,
      200,
    );

    const pulled = await call(
      'POST',
      `/api/correspondence/transfers/${wrong.transferId}/cancel`,
      postman,
      { reason: 'أُحيل إلى القسم الخطأ' },
    );
    assert.equal(pulled.statusCode, 200, pulled.body);

    const rerouted = await call('POST', `/api/correspondence/letters/${id.letter2}/transfers`, postman, {
      transfers: [{ unitId: id['unit:الشؤون المالية'], purpose: 'action' }],
    });
    assert.equal(rerouted.statusCode, 200, 'the withdrawn unit no longer blocks re-routing');

    // Leave letter2 unrouted again for the annulment test below.
    const open = (await call('GET', '/api/correspondence/followup', postman)).json().transfers;
    await call('POST', `/api/correspondence/transfers/${open[0].transferId}/cancel`, postman, {
      reason: 'إحالة تجريبية تُسحب لإعادة الحالة',
    });
  });

  // ── The document panel's view ──────────────────────────────────────────

  test('the register entry rides with the document for anyone who can read it', async () => {
    const seen = await call('GET', `/api/correspondence/documents/${id.doc1}/letter`, fin1);
    assert.equal(seen.statusCode, 200);
    assert.equal(seen.json().registered, true);
    assert.equal(seen.json().letter.reference, `1/${YEAR}`);

    // The panel offers gestures only on the caller's own unit's transfers.
    const byUnit = new Map(seen.json().transfers.map((t) => [t.unitName, t.mine]));
    assert.equal(byUnit.get('الشؤون المالية'), true, 'fin1 acts for finance');
    assert.equal(byUnit.get('الموارد البشرية'), false, 'fin1 does not act for HR');

    const blind = await call('GET', `/api/correspondence/documents/${id.doc1}/letter`, outsider);
    assert.equal(blind.statusCode, 404, 'no folder READ, no register entry');
  });

  // ── Outgoing, counters, annulment ──────────────────────────────────────

  test('the outgoing book starts where the paper book left off', async () => {
    const start = await call('PUT', '/api/admin/correspondence/counters', boss, {
      direction: 'out',
      year: YEAR,
      nextNumber: 500,
    });
    assert.equal(start.statusCode, 200, start.body);

    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'sader-1.txt', 'كتاب صادر'),
      direction: 'out',
      subject: 'رد على وزارة التخطيط',
      externalParty: 'وزارة التخطيط',
      unitId: id['unit:الشؤون المالية'],
    });
    assert.equal(registered.json().bookNumber, 500, registered.body);
    id.outLetter = registered.json().letterId;

    // The counter can never be pushed back under a number already issued.
    const rewind = await call('PUT', '/api/admin/correspondence/counters', boss, {
      direction: 'out',
      year: YEAR,
      nextNumber: 100,
    });
    assert.equal(rewind.statusCode, 409);
    assert.equal(rewind.json().error, 'below_issued');
    assert.equal(rewind.json().highestIssued, 500);
  });

  test('an outgoing letter is marked sent after actual dispatch', async () => {
    const sent = await call('POST', `/api/correspondence/letters/${id.outLetter}/status`, postman, {
      status: 'sent',
    });
    assert.equal(sent.statusCode, 200, sent.body);

    const letter = await call('GET', `/api/correspondence/letters/${id.outLetter}`, postman);
    assert.equal(letter.json().letter.status, 'sent');
  });

  test('annulment strikes the entry through and never reuses the number', async () => {
    const bare = await call('POST', `/api/correspondence/letters/${id.letter2}/annul`, postman, {});
    assert.equal(bare.statusCode, 400, 'a reason is not optional');

    const annulled = await call('POST', `/api/correspondence/letters/${id.letter2}/annul`, postman, {
      reason: 'سُجّل بالخطأ في دفتر الوارد',
    });
    assert.equal(annulled.statusCode, 200, annulled.body);

    const letter = await call('GET', `/api/correspondence/letters/${id.letter2}`, postman);
    assert.equal(letter.json().letter.status, 'annulled');

    const next = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'wared-3.txt', 'كتاب ثالث'),
      direction: 'in',
      subject: 'بعد الإلغاء',
    });
    assert.equal(next.json().bookNumber, 3, 'the annulled number 2 stays spent');
  });

  test('a unit with open transfers cannot be deactivated', async () => {
    await call('POST', `/api/correspondence/letters/${id.letter1}/transfers`, postman, {
      transfers: [{ unitId: id['unit:الموارد البشرية'], purpose: 'action' }],
    });

    const refused = await call(
      'POST',
      `/api/admin/correspondence/units/${id['unit:الموارد البشرية']}/active`,
      boss,
      { active: false },
    );
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error, 'unit_has_open_transfers');

    const open = (await call('GET', '/api/correspondence/followup', postman)).json().transfers;
    await call('POST', `/api/correspondence/transfers/${open[0].transferId}/cancel`, postman, {
      reason: 'سحب قبل تعطيل القسم',
    });

    const allowed = await call(
      'POST',
      `/api/admin/correspondence/units/${id['unit:الموارد البشرية']}/active`,
      boss,
      { active: false },
    );
    assert.equal(allowed.statusCode, 200, allowed.body);

    // Put it back so no later test meets a surprise.
    await call('POST', `/api/admin/correspondence/units/${id['unit:الموارد البشرية']}/active`, boss, {
      active: true,
    });
  });

  test('deactivating a unit ends the membership of its people', async () => {
    const unit = id['unit:الموارد البشرية'];
    const memberOf = async (cookie) =>
      (await call('GET', '/api/correspondence/status', cookie)).json().member;

    // hr1's inbox is empty by now, and that is the point: membership, not the
    // count, is what keeps «الوارد إليّ» on the menu for the next letter.
    assert.equal((await call('GET', '/api/correspondence/queue', hr1)).json().transfers.length, 0);
    assert.equal(await memberOf(hr1), true);

    const off = await call('POST', `/api/admin/correspondence/units/${unit}/active`, boss, {
      active: false,
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(await memberOf(hr1), false, 'a retired unit is no unit');

    const on = await call('POST', `/api/admin/correspondence/units/${unit}/active`, boss, {
      active: true,
    });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(await memberOf(hr1), true);
  });

  test('the intake list names what was scanned but never entered the book', async () => {
    // Unconfigured is a state, not an error.
    const before = await call('GET', '/api/correspondence/intake', postman);
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().configured, false);

    const set = await call('PUT', '/api/settings/correspondence.intake_folder', boss, {
      value: Number(id.intake),
    });
    assert.equal(set.statusCode, 200, set.body);

    const strayId = await upload(postman, 'intake', 'stray.txt', 'كتاب ممسوح بلا قيد');

    assert.equal(
      (await call('GET', '/api/correspondence/intake', fin1)).statusCode,
      403,
      'the intake work list is the mail room\'s',
    );

    const listed = await call('GET', '/api/correspondence/intake', postman);
    assert.equal(listed.json().configured, true);
    assert.ok(
      listed.json().documents.some((doc) => doc.documentId === strayId),
      'the unregistered scan is on the work list',
    );

    // Registering it clears it from the list — the book has no strays.
    await call('POST', '/api/correspondence/register', postman, {
      documentId: strayId,
      direction: 'in',
      subject: 'كتاب كان بلا قيد',
    });
    const after = await call('GET', '/api/correspondence/intake', postman);
    assert.ok(after.json().documents.every((doc) => doc.documentId !== strayId));
  });

  // ── The paper trail: رحلة الورقة ────────────────────────────────────────
  //
  // The paper travels — to the deputy, to the director who writes his تهميش,
  // between departments — and every trip may be rescanned. All of those scans
  // are versions of ONE letter, each named by what was done on the paper.

  test('registration writes «كما ورد» as the first entry in the trail', async () => {
    const letter = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.equal(letter.statusCode, 200, letter.body);
    const trail = letter.json().trail;
    assert.equal(trail.length, 1, 'the trail starts at the scan that was registered');
    assert.equal(trail[0].action, 'received');
    assert.equal(trail[0].versionNumber, 1);
    assert.equal(trail[0].recordedBy, 'postman');

    // And the same word in the CORE version comment, so the ordinary version
    // list still says what the scan is with the whole area switched off.
    const document = await call('GET', `/api/documents/${id.doc1}`, postman);
    const first = document.json().versions.find((v) => v.version === 1);
    assert.equal(first.comment, 'كما ورد');

    // Nothing is out yet, and a letter with no custody rows is in the mail room.
    assert.deepEqual(letter.json().location, { state: 'in' });
    assert.deepEqual(letter.json().movements, []);
    assert.equal(letter.json().canRecord, true, 'the mail room keeps the trail');
  });

  test('a returned paper becomes a NEW VERSION named by what was done on it', async () => {
    const added = await addLetterVersion(
      postman,
      id.letter1,
      { action: 'instruction', personName: 'د. حسين', note: 'الموارد البشرية للإجراء' },
      'wared-1-tahmeesh.txt',
      'كتاب وارد بعد التهميش',
    );
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().version, 2, 'the same document, a second version');
    assert.equal(added.json().documentId, id.doc1, 'never a new document');

    const letter = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    const trail = letter.json().trail;
    assert.equal(trail.length, 2);
    assert.equal(trail[1].action, 'instruction');
    assert.equal(trail[1].personName, 'د. حسين');
    assert.equal(trail[1].note, 'الموارد البشرية للإجراء');

    const document = await call('GET', `/api/documents/${id.doc1}`, postman);
    const second = document.json().versions.find((v) => v.version === 2);
    assert.equal(
      second.comment,
      'تهميش — د. حسين: الموارد البشرية للإجراء',
      'the core version comment carries the same words',
    );

    // An act nobody named is not allowed to invent one, and 'received' is the
    // register's own word — a person may not post it.
    const bad = await addLetterVersion(
      postman,
      id.letter1,
      { action: 'received' },
      'nope.txt',
      'لا',
    );
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'invalid_action');
  });

  test('the custody log answers where the paper itself is', async () => {
    const out = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'out',
      personName: 'مدير الإدارة',
      note: 'بيد الساعي',
    });
    assert.equal(out.statusCode, 201, out.body);

    const letter = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.equal(letter.json().location.state, 'out');
    assert.equal(letter.json().location.personName, 'مدير الإدارة');
    assert.equal(letter.json().movements.length, 1);
    assert.equal(letter.json().movements[0].note, 'بيد الساعي');

    // The intake screen's picker: the letters whose paper is in somebody's hands.
    const listed = await call('GET', '/api/correspondence/letters?location=out', postman);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().letters.map((l) => l.letterId),
      [id.letter1],
      'only the letter that actually left',
    );
    assert.equal(listed.json().letters[0].location.personName, 'مدير الإدارة');

    const typo = await call('GET', '/api/correspondence/letters?location=anywhere', postman);
    assert.equal(typo.statusCode, 400, 'a typo refuses rather than widening to the whole book');

    // A return needs no typing: the log already knows whose hands it is in.
    const back = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'back',
    });
    assert.equal(back.statusCode, 201, back.body);
    assert.equal(back.json().movement.personName, 'مدير الإدارة');

    const settled = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.deepEqual(settled.json().location, { state: 'in' });
    assert.equal(
      (await call('GET', '/api/correspondence/letters?location=out', postman)).json().letters.length,
      0,
    );

    // Handing the paper out with no name records nothing at all, and a kind the
    // log does not know is refused rather than stored.
    const nameless = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'out',
    });
    assert.equal(nameless.statusCode, 400);
    assert.equal(nameless.json().error, 'person_required');

    const nonsense = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'sideways',
      personName: 'أحد',
    });
    assert.equal(nonsense.statusCode, 400);
    assert.equal(nonsense.json().error, 'invalid_kind');
  });

  test('a returned copy records the return in the same step, with defaults', async () => {
    await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'out',
      personName: 'د. حسين',
    });

    // Nothing stated: the act defaults to التهميش and the person to whoever the
    // paper was last handed to. This is the whole "less discipline" promise.
    const added = await addLetterVersion(
      postman,
      id.letter1,
      { returned: 'true' },
      'wared-1-raja3.txt',
      'عاد بعد التهميش الثاني',
    );
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().version, 3);
    assert.equal(added.json().action, 'instruction');
    assert.equal(added.json().personName, 'د. حسين');

    const letter = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.deepEqual(letter.json().location, { state: 'in' }, 'the paper came back in one gesture');
    assert.equal(letter.json().movements.length, 4);
    assert.equal(letter.json().movements.at(-1).kind, 'back');
    assert.equal(letter.json().movements.at(-1).personName, 'د. حسين');
    assert.equal(letter.json().trail.at(-1).versionNumber, 3);
  });

  test('a department holding the letter records too, within its folder rights', async () => {
    const documentId = await upload(postman, 'intake', 'wared-5.txt', 'كتاب للأقسام');
    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
      subject: 'كتاب يتنقل بين الأقسام',
      transfers: [
        { unitId: id['unit:الشؤون المالية'], purpose: 'action', note: 'للإجراء مع إشعارنا' },
        { unitId: id['unit:الموارد البشرية'], purpose: 'action' },
      ],
    });
    assert.equal(registered.statusCode, 200, registered.body);
    id.letterPaper = registered.json().letterId;
    id.docPaper = documentId;

    // The director's instruction, typed where the department reads it.
    const queue = (await call('GET', '/api/correspondence/queue', fin1)).json().transfers;
    const mine = queue.find((t) => t.letterId === id.letterPaper);
    assert.equal(mine.note, 'للإجراء مع إشعارنا', 'the queue shows the instruction');

    // The panel tells each viewer whether they may add to the trail at all.
    const finPanel = await call('GET', `/api/correspondence/documents/${documentId}/letter`, fin1);
    assert.equal(finPanel.json().canRecord, true, 'a unit holding the letter may record');
    const hrOther = await call('GET', `/api/correspondence/documents/${id.doc1}/letter`, hr1);
    assert.equal(hrOther.json().canRecord, false, 'no live transfer on that letter, no recording');

    // HR holds this letter but has no UPLOAD on the folder: the CORE refusal
    // comes through by its own name, not disguised as a register objection.
    const hrTried = await addLetterVersion(
      hr1,
      id.letterPaper,
      { action: 'rescan' },
      'hr-scan.txt',
      'مسح من الموارد البشرية',
    );
    assert.equal(hrTried.statusCode, 403);
    assert.equal(hrTried.json().error, 'forbidden', 'the folder decides, not the register');

    // Finance holds it and may upload, so the paper's journey through finance is
    // recorded by finance — the mail room never saw this sheet.
    const finAdded = await addLetterVersion(
      fin1,
      id.letterPaper,
      { action: 'endorsement', personName: 'معاون المدير الإداري' },
      'fin-scan.txt',
      'مسح بعد التأشير',
    );
    assert.equal(finAdded.statusCode, 201, finAdded.body);
    assert.equal(finAdded.json().version, 2);

    const letter = await call('GET', `/api/correspondence/letters/${id.letterPaper}`, postman);
    assert.equal(letter.json().trail.length, 2);
    assert.equal(letter.json().trail[1].action, 'endorsement');
    assert.equal(letter.json().trail[1].recordedBy, 'fin1');
    assert.equal(letter.json().transfers.find((t) => t.unitName === 'الشؤون المالية').note,
      'للإجراء مع إشعارنا');

    // A department may move the paper on, too.
    const moved = await call('POST', `/api/correspondence/letters/${id.letterPaper}/movements`, fin1, {
      kind: 'out',
      personName: 'الموارد البشرية',
    });
    assert.equal(moved.statusCode, 201, moved.body);

    // And anybody else is simply not part of this letter's story.
    const stranger = await addLetterVersion(
      outsider,
      id.letterPaper,
      { action: 'rescan' },
      'stranger.txt',
      'لا شأن له',
    );
    assert.equal(stranger.statusCode, 403);
    assert.equal(stranger.json().error, 'not_allowed');

    const strangerMove = await call(
      'POST',
      `/api/correspondence/letters/${id.letterPaper}/movements`,
      outsider,
      { kind: 'back', personName: 'أحد' },
    );
    assert.equal(strangerMove.statusCode, 403);
    assert.equal(strangerMove.json().error, 'not_allowed');
  });

  test('forwarding later carries the instruction to every department', async () => {
    const routed = await call('POST', `/api/correspondence/letters/${id.letter1}/transfers`, postman, {
      transfers: [
        { unitId: id['unit:الموارد البشرية'], purpose: 'action', note: 'بحسب تهميش السيد المدير' },
      ],
    });
    assert.equal(routed.statusCode, 200, routed.body);

    const queue = (await call('GET', '/api/correspondence/queue', hr1)).json().transfers;
    const mine = queue.find((t) => t.letterId === id.letter1);
    assert.equal(mine.note, 'بحسب تهميش السيد المدير');
  });

  // ── The reply link ──────────────────────────────────────────────────────

  test('an outgoing letter registered as a reply links to the letter it answers', async () => {
    const documentId = await upload(postman, 'intake', 'sader-2.txt', 'رد على الوارد');
    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'out',
      subject: 'رد على طلب بيانات الموازنة',
      replyToLetterId: id.letter1,
    });
    assert.equal(registered.statusCode, 200, registered.body);
    id.replyLetter = registered.json().letterId;

    const outgoing = await call('GET', `/api/correspondence/letters/${id.replyLetter}`, postman);
    assert.equal(outgoing.json().replyTo.letterId, id.letter1);
    assert.equal(outgoing.json().replyTo.documentId, id.doc1);

    const incoming = await call('GET', `/api/correspondence/letters/${id.letter1}`, postman);
    assert.equal(incoming.json().answeredBy.length, 1);
    assert.equal(incoming.json().answeredBy[0].letterId, id.replyLetter);
    assert.equal(incoming.json().answeredBy[0].number, outgoing.json().letter.bookNumber);

    // The register list says so without a second request per row.
    const listed = await call('GET', '/api/correspondence/letters?direction=in', postman);
    const row = listed.json().letters.find((l) => l.letterId === id.letter1);
    assert.equal(row.answered, true);
    assert.equal(
      listed.json().letters.find((l) => l.letterId === id.letterPaper).answered,
      false,
    );

    // It is a CORE relation, so it outlives the whole correspondence area.
    const relation = await sql`
      SELECT relation_type FROM dbo.document_relations
       WHERE from_document = ${documentId} AND to_document = ${id.doc1}
    `.execute(db);
    assert.equal(relation.rows[0].relation_type, 'reply_to');
  });

  test('a reply can only answer a live incoming letter', async () => {
    const cases = [
      [id.outLetter, 'an outgoing letter is not something to reply to'],
      [id.letter2, 'the annulled entry is struck from the book'],
      ['9999999', 'no such letter'],
    ];
    for (const [index, [replyToLetterId, why]] of cases.entries()) {
      const refused = await call('POST', '/api/correspondence/register', postman, {
        documentId: await upload(postman, 'intake', `sader-bad-${index}.txt`, `رد خاطئ ${index}`),
        direction: 'out',
        subject: 'رد غير مرتبط',
        replyToLetterId,
      });
      assert.equal(refused.statusCode, 400, why);
      assert.equal(refused.json().error, 'invalid_reply_to', why);
    }

    // An INCOMING letter does not reply to anything; the field belongs to صادر.
    const wrongWay = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'wared-bad.txt', 'وارد برد'),
      direction: 'in',
      subject: 'وارد لا يرد على شيء',
      replyToLetterId: id.letter1,
    });
    assert.equal(wrongWay.statusCode, 400);
    assert.equal(wrongWay.json().error, 'invalid_reply_to');
  });

  // ── What the trail refuses ──────────────────────────────────────────────

  test('a struck-out entry and a held document both refuse a new scan', async () => {
    const annulled = await addLetterVersion(
      postman,
      id.letter2,
      { action: 'rescan' },
      'annulled.txt',
      'بعد الإلغاء',
    );
    assert.equal(annulled.statusCode, 409);
    assert.equal(annulled.json().error, 'annulled');

    const annulledMove = await call(
      'POST',
      `/api/correspondence/letters/${id.letter2}/movements`,
      postman,
      { kind: 'out', personName: 'أحد' },
    );
    assert.equal(annulledMove.statusCode, 409);
    assert.equal(annulledMove.json().error, 'annulled');

    // A held document is frozen, additions included — the CORE refusal, with the
    // core's own status code.
    await sql`UPDATE dbo.documents SET legal_hold = 1 WHERE document_id = ${id.doc1}`.execute(db);
    const held = await addLetterVersion(
      postman,
      id.letter1,
      { action: 'rescan' },
      'held.txt',
      'تحت الحجز',
    );
    assert.equal(held.statusCode, 423);
    assert.equal(held.json().error, 'legal_hold');
    await sql`UPDATE dbo.documents SET legal_hold = 0 WHERE document_id = ${id.doc1}`.execute(db);

    const missing = await addLetterVersion(postman, '9999999', {}, 'ghost.txt', 'لا وجود له');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, 'not_found');
  });

  test('with the master switch off, the paper trail refuses like everything else', async () => {
    const off = await call('PUT', '/api/settings/correspondence.enabled', boss, { value: false });
    assert.equal(off.statusCode, 200, off.body);

    const version = await addLetterVersion(
      postman,
      id.letter1,
      { action: 'rescan' },
      'disabled.txt',
      'مُعطّل',
    );
    assert.equal(version.statusCode, 409);
    assert.equal(version.json().error, 'correspondence_disabled');

    const movement = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'out',
      personName: 'أحد',
    });
    assert.equal(movement.statusCode, 409);
    assert.equal(movement.json().error, 'correspondence_disabled');

    const listed = await call('GET', '/api/correspondence/letters?location=out', postman);
    assert.equal(listed.statusCode, 409);
    assert.equal(listed.json().error, 'correspondence_disabled');

    await call('PUT', '/api/settings/correspondence.enabled', boss, { value: true });
  });

  // ── What the design review found ────────────────────────────────────────
  //
  // Each of these is a wound that only shows up where two features meet: the
  // trail and the purge sweep, the trail and the core version history, the
  // register and the generic relations table.

  test('purging a binned letter succeeds and keeps its trail as a tombstone', async () => {
    const documentId = await upload(postman, 'intake', 'wared-purge.txt', 'كتاب سيُنظَّف');
    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
      subject: 'كتاب مصيره سلة المحذوفات',
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const letterId = registered.json().letterId;

    // Registration wrote «كما ورد» against version 1 — the row that used to
    // hold a foreign key into dbo.document_versions.
    const before = await sql`
      SELECT COUNT(*) AS n FROM dbo.correspondence_version_actions
       WHERE correspondence_id = ${letterId}
    `.execute(db);
    assert.equal(Number(before.rows[0].n), 1);

    const version = await sql`
      SELECT storage_path FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    const storagePath = version.rows[0].storage_path;

    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = DATEADD(day, -60, SYSUTCDATETIME())
       WHERE document_id = ${documentId}
    `.execute(db);

    const { purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js');
    const result = await purgeDeletedDocuments({ graceDays: 30 });

    // The whole point: the only thing in the system that reclaims bytes must
    // not be jammed by a register table it has never heard of.
    assert.equal(result.failed, 0, 'the paper trail must not block the purge sweep');
    assert.ok(result.purged >= 1);
    assert.equal(await storage.exists(storagePath), false, 'the bytes are gone');

    const versions = await sql`
      SELECT COUNT(*) AS n FROM dbo.document_versions WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(versions.rows[0].n), 0, 'the version row went with them');

    // And the trail survives as history: «في هذا اليوم ورد هذا الكتاب» is worth
    // keeping after the scan itself has been destroyed.
    const after = await sql`
      SELECT action FROM dbo.correspondence_version_actions WHERE correspondence_id = ${letterId}
    `.execute(db);
    assert.equal(after.rows.length, 1, 'the trail outlives the bytes it describes');
    assert.equal(after.rows[0].action, 'received');
  });

  test('a paper-trail version is a document version in the core trail too', async () => {
    const documentId = await upload(postman, 'intake', 'wared-watched.txt', 'كتاب مُراقَب');
    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
      subject: 'كتاب يراقبه غير القلم',
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const letterId = registered.json().letterId;

    // fin2 watches the document and is not the one filing the scan, so the
    // notice is owed to them.
    const watching = await call('POST', '/api/watches', fin2, { documentId });
    assert.equal(watching.statusCode, 200, watching.body);

    const added = await addLetterVersion(
      postman,
      letterId,
      { action: 'rescan' },
      'wared-watched-v2.txt',
      'إعادة مسح',
    );
    assert.equal(added.statusCode, 201, added.body);

    // The core row every other version path writes: against the DOCUMENT and
    // its folder, so neither the document's own history nor the folder-scoped
    // audit view skips a scan that arrived through the register.
    const core = await sql`
      SELECT folder_id, detail FROM dbo.audit_log
       WHERE action = 'document.version_added'
         AND target_type = 'document' AND target_id = ${String(documentId)}
    `.execute(db);
    assert.equal(core.rows.length, 1, 'the document history must not skip a paper-trail version');
    assert.equal(String(core.rows[0].folder_id), String(id.intake), 'and it carries the folder');

    // The register's own row stays beside it — two questions, two answers.
    const register = await sql`
      SELECT COUNT(*) AS n FROM dbo.audit_log
       WHERE action = 'mail.paper_version'
         AND target_type = 'correspondence' AND target_id = ${String(letterId)}
    `.execute(db);
    assert.equal(Number(register.rows[0].n), 1);

    const inbox = await call('GET', '/api/notifications?unread=true', fin2);
    assert.ok(
      inbox.json().notifications.some((n) => n.documentId === String(documentId)),
      'a watcher hears about the version a returned paper created',
    );
  });

  test('«مُجاب» is the register\'s own link, not the relations table\'s', async () => {
    const incomingDoc = await upload(postman, 'intake', 'wared-awaiting.txt', 'كتاب يُنتظر رده');
    const incoming = await call('POST', '/api/correspondence/register', postman, {
      documentId: incomingDoc,
      direction: 'in',
      subject: 'طلب يُنتظر رده',
    });
    assert.equal(incoming.statusCode, 200, incoming.body);
    const letterId = incoming.json().letterId;

    const detail = async () =>
      (await call('GET', `/api/correspondence/letters/${letterId}`, postman)).json();

    assert.equal((await detail()).letter.answered, false);

    const firstReply = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'sader-reply-1.txt', 'رد أول'),
      direction: 'out',
      subject: 'رد أول',
      replyToLetterId: letterId,
    });
    assert.equal(firstReply.statusCode, 200, firstReply.body);

    let seen = await detail();
    assert.equal(seen.letter.answered, true);
    assert.deepEqual(seen.answeredBy.map((r) => r.status), ['registered']);

    // Struck out: the letter is open again, and the entry stays in the history
    // carrying the reason it no longer counts.
    const annulled = await call(
      'POST',
      `/api/correspondence/letters/${firstReply.json().letterId}/annul`,
      postman,
      { reason: 'أُلغي الرد قبل إرساله' },
    );
    assert.equal(annulled.statusCode, 200, annulled.body);

    seen = await detail();
    assert.equal(seen.letter.answered, false, 'a struck-out صادر answered nothing');
    assert.equal(seen.answeredBy.length, 1, 'but the history keeps it');
    assert.equal(seen.answeredBy[0].status, 'annulled');

    const secondDoc = await upload(postman, 'intake', 'sader-reply-2.txt', 'رد ثانٍ');
    const secondReply = await call('POST', '/api/correspondence/register', postman, {
      documentId: secondDoc,
      direction: 'out',
      subject: 'رد ثانٍ',
      replyToLetterId: letterId,
    });
    assert.equal(secondReply.statusCode, 200, secondReply.body);
    assert.equal((await detail()).letter.answered, true, 'a live reply answers it again');

    /*
     * The core relation is still written, for the document page's «مرتبطة»
     * list, and anybody who can see the document may remove it from there.
     * The BOOK is not theirs to change: «مُجاب» reads reply_to_id and nothing
     * else, so the register says exactly the same thing afterwards.
     */
    const relations = (await call('GET', `/api/documents/${secondDoc}/relations`, postman)).json();
    const link = relations.relations.find((r) => r.relationType === 'reply_to');
    assert.ok(link, 'the display relation is written at registration');
    assert.equal((await call('DELETE', `/api/relations/${link.relationId}`, postman)).statusCode, 200);

    seen = await detail();
    assert.equal(seen.letter.answered, true, 'deleting the display copy changes nothing');
    assert.equal(seen.answeredBy.length, 2);

    const reply = (
      await call('GET', `/api/correspondence/letters/${secondReply.json().letterId}`, postman)
    ).json();
    assert.equal(reply.replyTo.letterId, letterId);
    assert.equal(reply.replyTo.status, 'registered', 'the target\'s status travels with the link');
  });

  test('the register finds a letter by its book reference, exactly', async () => {
    const arabicDigits = (text) =>
      String(text).replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));

    // Forty and four hundred: the pair that proves the match is equality and
    // not a LIKE, which is what made «بحث برقم الكتاب» useless.
    for (const number of [40, 400]) {
      const counter = await call('PUT', '/api/admin/correspondence/counters', boss, {
        direction: 'in',
        year: YEAR,
        nextNumber: number,
      });
      assert.equal(counter.statusCode, 200, counter.body);

      const registered = await call('POST', '/api/correspondence/register', postman, {
        documentId: await upload(postman, 'intake', `wared-${number}.txt`, `كتاب ${number}`),
        direction: 'in',
        subject: `كتاب برقم ${number}`,
      });
      assert.equal(registered.json().bookNumber, number, registered.body);
      id[`letter:${number}`] = registered.json().letterId;
    }

    const found = async (q) =>
      (await call('GET', `/api/correspondence/letters?q=${encodeURIComponent(q)}`, postman))
        .json()
        .letters.map((letter) => letter.letterId);

    assert.deepEqual(await found(`40/${YEAR}`), [id['letter:40']], 'the reference on the paper');
    assert.deepEqual(
      await found(arabicDigits(`40/${YEAR}`)),
      [id['letter:40']],
      'typed on the Arabic keypad, which is the only one on her desk',
    );
    assert.deepEqual(
      await found('40'),
      [id['letter:40']],
      'the bare number is entry forty, never four hundred',
    );
    assert.deepEqual(await found(`40/${YEAR - 1}`), [], 'last year is a different book');
    // Prose still searches prose.
    assert.deepEqual(await found('كتاب برقم 400'), [id['letter:400']]);
  });

  test('«الأوراق الخارجة» never offers a struck-out letter', async () => {
    const documentId = await upload(postman, 'intake', 'wared-out-annulled.txt', 'خرج ثم أُلغي');
    const registered = await call('POST', '/api/correspondence/register', postman, {
      documentId,
      direction: 'in',
      subject: 'كتاب خرج ثم أُلغي قيده',
    });
    assert.equal(registered.statusCode, 200, registered.body);
    const letterId = registered.json().letterId;

    const out = await call('POST', `/api/correspondence/letters/${letterId}/movements`, postman, {
      kind: 'out',
      personName: 'الساعي',
    });
    assert.equal(out.statusCode, 201, out.body);

    const papersOut = async () =>
      (await call('GET', '/api/correspondence/letters?location=out', postman))
        .json()
        .letters.map((letter) => letter.letterId);
    assert.ok((await papersOut()).includes(letterId), 'it is out, so it is on the list');

    const annulled = await call('POST', `/api/correspondence/letters/${letterId}/annul`, postman, {
      reason: 'سُجّل في الدفتر الخطأ',
    });
    assert.equal(annulled.statusCode, 200, annulled.body);

    assert.ok(
      !(await papersOut()).includes(letterId),
      'a struck-out letter can never accept a returned copy, so the picker must not offer it',
    );
  });

  test('a reply target out of reach refuses by its own name', async () => {
    // A folder with no entry at all: only a super admin reaches into it.
    await makeFolder('sealed');
    const sealed = await call('POST', '/api/correspondence/register', boss, {
      documentId: await upload(boss, 'sealed', 'wared-sealed.txt', 'كتاب محجوب'),
      direction: 'in',
      subject: 'كتاب لا يراه القلم',
    });
    assert.equal(sealed.statusCode, 200, sealed.body);

    const forbidden = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'sader-sealed.txt', 'رد على محجوب'),
      direction: 'out',
      subject: 'رد على كتاب محجوب',
      replyToLetterId: sealed.json().letterId,
    });
    assert.equal(forbidden.statusCode, 403, forbidden.body);
    assert.equal(
      forbidden.json().error,
      'reply_to_forbidden',
      'a letter she cannot reach is not a letter she picked wrongly',
    );

    // And a target that nothing could ever reply to still refuses by the other
    // name, so the screen can tell the two apart.
    const invalid = await call('POST', '/api/correspondence/register', postman, {
      documentId: await upload(postman, 'intake', 'sader-sealed-2.txt', 'رد خاطئ'),
      direction: 'out',
      subject: 'رد على صادر',
      replyToLetterId: id.outLetter,
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'invalid_reply_to');
  });

  test('a department that names nobody gets nobody named', async () => {
    // The custody log says the paper is with الموارد البشرية — the unit next
    // door, named by finance when it handed the sheet on.
    const letter = await call('GET', `/api/correspondence/letters/${id.letterPaper}`, postman);
    assert.equal(letter.json().location.state, 'out');
    assert.equal(letter.json().location.personName, 'الموارد البشرية');

    const byDepartment = await addLetterVersion(
      fin1,
      id.letterPaper,
      { action: 'endorsement' },
      'fin-unnamed.txt',
      'مسح من المالية بلا اسم',
    );
    assert.equal(byDepartment.statusCode, 201, byDepartment.body);
    assert.equal(
      byDepartment.json().personName,
      null,
      'finance must not sign another unit\'s name to work done in its own hands',
    );

    // For the mail room the blank IS the log: they are the ones who wrote it.
    const byMailRoom = await addLetterVersion(
      postman,
      id.letterPaper,
      { action: 'instruction' },
      'post-unnamed.txt',
      'مسح من القلم بلا اسم',
    );
    assert.equal(byMailRoom.statusCode, 201, byMailRoom.body);
    assert.equal(byMailRoom.json().personName, 'الموارد البشرية');
  });

  test('a hand-over note keeps its whole thousand characters', async () => {
    const note = 'ملاحظة '.repeat(200).slice(0, 1000);
    const moved = await call('POST', `/api/correspondence/letters/${id.letter1}/movements`, postman, {
      kind: 'out',
      personName: 'مدير الإدارة',
      note,
    });
    assert.equal(moved.statusCode, 201, moved.body);
    assert.equal(moved.json().movement.note.length, 1000, 'not cut in half by a 500-wide column');
  });
});
