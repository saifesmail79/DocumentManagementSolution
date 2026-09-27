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
      ['المالية', readOnly],
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
    assert.equal((await call('GET', '/api/correspondence/status', fin1)).json().queueCount, 1);
    assert.equal((await call('GET', '/api/correspondence/status', outsider)).json().queueCount, 0);

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
});
