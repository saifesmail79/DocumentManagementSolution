/**
 * Integration tests for the Tier 3 features.
 *
 * Check-in/check-out, lifecycle states, expiry reminders, expiring share links,
 * parallel all-must-approve, SLA escalation, QR stamping, legal hold, and the
 * admin reporting dashboard.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { resolveTestDatabase, ensureTestDatabase, resetDatabase } from './helpers/test-database.js';

loadEnv();

const target = resolveTestDatabase();
const CONFIGURED = target.configured;

const STORAGE_ROOT = await mkdtemp(path.join(tmpdir(), 'dms-tier3-test-'));
process.env.STORAGE_ROOT = STORAGE_ROOT;
process.env.RENDITIONS_ENABLED = 'false';

let db;
let sql;
let app;
let PERM;
let storage;

const PASSWORD = 'correct-horse-battery-staple';
const id = {};

/** A one-page PDF, so the QR stamp has something real to work on. */
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj',
  'trailer<</Root 1 0 R/Size 4>>',
  '%%EOF',
].join('\n');

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

async function upload(cookie, folderName, filename, content, contentType = 'text/plain') {
  const boundary = '----dmstier3';
  const response = await app.inject({
    method: 'POST',
    url: `/api/folders/${id[folderName]}/documents`,
    headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      ),
      Buffer.from(content, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]),
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().documentId;
}

describe('Tier 3 features', { skip: CONFIGURED ? false : target.reason }, () => {
  let aliceCookie;
  let bobCookie;
  let bossCookie;

  before(async () => {
    await ensureTestDatabase(target.database);
    ({ db, sql } = await import('../src/db/index.js'));
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    await resetDatabase(db, sql);
    ({ PERM } = await import('../src/db/migrations/0001-identity-and-acl.js'));
    ({ storage } = await import('../src/storage/index.js'));
    await storage.init();

    const { buildApp } = await import('../src/app.js');
    app = await buildApp({ logger: false });

    await makeUser('alice');
    await makeUser('bob');
    await makeUser('boss', { superAdmin: true });
    await makeFolder('cabinet');

    const everything = PERM.BROWSE | PERM.READ | PERM.UPLOAD | PERM.EDIT_META | PERM.DELETE;
    for (const user of ['alice', 'bob']) {
      await sql`
        INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
        VALUES (${id.cabinet}, ${id[user]}, ${everything}, 0)
      `.execute(db);
    }

    aliceCookie = await signIn('alice');
    bobCookie = await signIn('bob');
    bossCookie = await signIn('boss');
  });

  after(async () => {
    if (app) await app.close();
    if (db) await db.destroy();
    await rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  // ── Check-in / check-out ───────────────────────────────────────────────

  test('a checked-out document cannot be claimed by someone else', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'locked.txt', 'محتوى');

    assert.equal((await call('POST', `/api/documents/${documentId}/checkout`, aliceCookie, {})).statusCode, 200);

    const contested = await call('POST', `/api/documents/${documentId}/checkout`, bobCookie, {});
    assert.equal(contested.statusCode, 409);
    assert.equal(contested.json().error, 'locked');
    // Naming the holder is the difference between a usable lock and a mystery.
    assert.equal(contested.json().lockedBy.name, 'alice');

    // Re-claiming your own lock is idempotent, not an error.
    assert.equal((await call('POST', `/api/documents/${documentId}/checkout`, aliceCookie, {})).statusCode, 200);
  });

  test('a lock blocks another person restoring a version', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'lock-restore.txt', 'الأول');

    const boundary = '----dmstier3';
    await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/versions`,
      headers: { cookie: aliceCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v2.txt"\r\n` +
            'Content-Type: text/plain\r\n\r\n',
          'utf8',
        ),
        Buffer.from('الثاني', 'utf8'),
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
      ]),
    });

    await call('POST', `/api/documents/${documentId}/checkout`, aliceCookie, {});

    const blocked = await call('POST', `/api/documents/${documentId}/versions/1/restore`, bobCookie, {});
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, 'locked');
  });

  test('an administrator can force a check-in, an ordinary user cannot', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'forced.txt', 'محتوى');
    await call('POST', `/api/documents/${documentId}/checkout`, aliceCookie, {});

    assert.equal((await call('POST', `/api/documents/${documentId}/checkin`, bobCookie, {})).statusCode, 403);

    // A lock nobody can break is a document nobody can edit once its holder leaves.
    const forced = await call('POST', `/api/documents/${documentId}/checkin`, bossCookie, {});
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().forced, true);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  test('lifecycle state moves through the defined values and rejects others', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'lifecycle.txt', 'محتوى');

    for (const state of ['draft', 'superseded', 'obsolete', 'active']) {
      assert.equal(
        (await call('POST', `/api/documents/${documentId}/lifecycle`, aliceCookie, { state })).statusCode,
        200,
        state,
      );
    }

    const invalid = await call('POST', `/api/documents/${documentId}/lifecycle`, aliceCookie, {
      state: 'archived',
    });
    assert.equal(invalid.statusCode, 400);

    const row = await sql`
      SELECT lifecycle_state FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(row.rows[0].lifecycle_state, 'active');
  });

  // ── Expiry ─────────────────────────────────────────────────────────────

  test('an expiring document notifies once, not on every sweep', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'expiring.txt', 'محتوى');

    const soon = new Date(Date.now() + 5 * 24 * 3_600_000).toISOString();
    assert.equal(
      (await call('POST', `/api/documents/${documentId}/expiry`, aliceCookie, { expiresAt: soon })).statusCode,
      200,
    );

    const { notifyExpiring } = await import('../src/modules/documents/state.js');

    const first = await notifyExpiring({ withinDays: 30 });
    assert.ok(first.notified >= 1);

    const inbox = (await call('GET', '/api/notifications', aliceCookie)).json();
    assert.ok(inbox.notifications.some((n) => n.kind === 'document.expiring'));

    // A reminder that arrives every night is one people filter out.
    const second = await notifyExpiring({ withinDays: 30 });
    assert.equal(second.notified, 0);
  });

  test('clearing an expiry date re-arms the reminder', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'rearm.txt', 'محتوى');
    const soon = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();

    await call('POST', `/api/documents/${documentId}/expiry`, aliceCookie, { expiresAt: soon });
    const { notifyExpiring } = await import('../src/modules/documents/state.js');
    await notifyExpiring({ withinDays: 30 });

    // Setting a new date clears expiry_notified_at, so it will announce again.
    await call('POST', `/api/documents/${documentId}/expiry`, aliceCookie, { expiresAt: soon });

    const row = await sql`
      SELECT expiry_notified_at FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(row.rows[0].expiry_notified_at, null);
  });

  // ── Legal hold ─────────────────────────────────────────────────────────

  test('legal hold blocks deletion, and only a super admin can set it', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'held.txt', 'محتوى');

    // Not something a document owner can place on their own work.
    assert.equal(
      (await call('POST', `/api/documents/${documentId}/legal-hold`, aliceCookie, { hold: true })).statusCode,
      403,
    );

    assert.equal(
      (await call('POST', `/api/documents/${documentId}/legal-hold`, bossCookie, {
        hold: true,
        reason: 'قضية رقم ١٢',
      })).statusCode,
      200,
    );

    const blocked = await call('POST', '/api/bulk/delete', aliceCookie, { documentIds: [documentId] });
    assert.equal(blocked.json().results[0].reason, 'legal_hold');

    /*
     * Every road, not just the batch one.
     *
     * This test used to check bulk delete alone, and passed for months while
     * the row's own delete button binned held documents without a word — the
     * rule lived in one path and the test only walked that path. A hold is a
     * promise about the document, so every way of deleting it must refuse:
     * the single delete, the permanent purge, and the sweep that actually
     * destroys bytes.
     */
    const single = await call('DELETE', `/api/documents/${documentId}`, aliceCookie);
    assert.equal(single.statusCode, 423, `the row delete must refuse a held document: ${single.body}`);
    assert.equal(single.json().error, 'legal_hold');

    /*
     * Frozen means frozen, not merely undeletable.
     *
     * Metadata has no history table — an overwritten title or field value is
     * destroyed as finally as an erased blob. And a new or restored version
     * moves current_version, which is what every download, preview and share
     * link serves: content the hold was meant to freeze would change while it
     * stands. So the hold refuses every mutation, and this test walks each one.
     */
    const retitled = await call('PATCH', `/api/documents/${documentId}/metadata`, aliceCookie, {
      title: 'عنوان جديد فوق الحجز',
    });
    assert.equal(retitled.statusCode, 423, `metadata must be frozen under hold: ${retitled.body}`);

    const bulkMeta = await call('POST', '/api/bulk/metadata', aliceCookie, {
      documentIds: [documentId],
      fields: {},
    });
    assert.equal(
      bulkMeta.json().results?.[0]?.reason,
      'legal_hold',
      `bulk metadata must refuse too: ${bulkMeta.body}`,
    );

    const relifed = await call('POST', `/api/documents/${documentId}/lifecycle`, aliceCookie, {
      state: 'obsolete',
    });
    assert.ok(
      [409, 423].includes(relifed.statusCode),
      `lifecycle must be frozen under hold: ${relifed.statusCode} ${relifed.body}`,
    );

    const stillActive = await sql`
      SELECT lifecycle_state FROM dbo.documents WHERE document_id = ${documentId}
    `.execute(db);
    assert.notEqual(stillActive.rows[0].lifecycle_state, 'obsolete', 'the state must not have moved');

    // Force it into the bin behind the API's back, standing in for any past or
    // future path that forgets the rule — the sweep must hold the line alone.
    await sql`
      UPDATE dbo.documents
         SET is_deleted = 1, deleted_at = DATEADD(year, -1, SYSUTCDATETIME()), deleted_by = ${id.alice}
       WHERE document_id = ${documentId}
    `.execute(db);

    const purgeBlocked = await call('POST', `/api/documents/${documentId}/purge`, aliceCookie);
    assert.equal(purgeBlocked.statusCode, 423, 'permanent purge must refuse a held document');

    const { purgeDeletedDocuments } = await import('../src/modules/storage-maintenance/purge.js');
    const sweep = await purgeDeletedDocuments({ dryRun: true });
    assert.equal(sweep.purged, 0, 'the sweep must skip held documents, however long they sit');

    // Back out of the bin so the release-and-delete half below starts clean.
    await sql`
      UPDATE dbo.documents SET is_deleted = 0, deleted_at = NULL, deleted_by = NULL
       WHERE document_id = ${documentId}
    `.execute(db);

    await call('POST', `/api/documents/${documentId}/legal-hold`, bossCookie, { hold: false });
    const allowed = await call('POST', '/api/bulk/delete', aliceCookie, { documentIds: [documentId] });
    assert.equal(allowed.json().succeeded, 1);

    // And once the hold is gone, the sweep may have it like anything else.
    await sql`
      UPDATE dbo.documents SET deleted_at = DATEADD(year, -1, SYSUTCDATETIME())
       WHERE document_id = ${documentId}
    `.execute(db);
    const collectable = await purgeDeletedDocuments({ dryRun: true });
    assert.ok(collectable.purged >= 1, 'a released document is ordinary again');
  });

  test('placing a hold is recorded with its reason', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'audited-hold.txt', 'محتوى');
    await call('POST', `/api/documents/${documentId}/legal-hold`, bossCookie, {
      hold: true,
      reason: 'تحقيق داخلي',
    });

    const entries = await sql`
      SELECT detail, actor_username FROM dbo.audit_log
       WHERE action = 'document.legal_hold_changed' AND target_id = ${documentId}
    `.execute(db);

    assert.equal(entries.rows.length, 1);
    assert.match(entries.rows[0].detail, /تحقيق داخلي/);
  });

  // ── Share links ────────────────────────────────────────────────────────

  test('a share link serves content without a session, within its bounds', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'shared.txt', 'محتوى مشارك');

    const created = await call('POST', `/api/documents/${documentId}/shares`, aliceCookie, {
      expiresInHours: 24,
    });
    assert.equal(created.statusCode, 201);

    const token = created.json().token;

    // No cookie at all — this is the one route that serves bytes unauthenticated.
    const fetched = await app.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.body, 'محتوى مشارك');
    // A proxy must not cache it and hand it to the next person asking.
    assert.match(fetched.headers['cache-control'], /no-store/);
  });

  test('a revoked or expired link stops working', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'revoke-me.txt', 'محتوى');
    const created = await call('POST', `/api/documents/${documentId}/shares`, aliceCookie, {});
    const token = created.json().token;

    assert.equal((await app.inject({ method: 'GET', url: `/api/share/${token}` })).statusCode, 200);

    const links = (await call('GET', `/api/documents/${documentId}/shares`, aliceCookie)).json();
    await call('DELETE', `/api/shares/${links.links[0].shareId}`, aliceCookie);

    assert.equal((await app.inject({ method: 'GET', url: `/api/share/${token}` })).statusCode, 404);
  });

  test('a password-protected link demands the password', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'protected.txt', 'محتوى محمي');
    const created = await call('POST', `/api/documents/${documentId}/shares`, aliceCookie, {
      password: 'open-sesame-please',
    });
    const token = created.json().token;

    const without = await app.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(without.statusCode, 401);
    assert.equal(without.json().error, 'password_required');

    const wrong = await app.inject({ method: 'GET', url: `/api/share/${token}?password=nope` });
    assert.equal(wrong.statusCode, 401);

    const right = await app.inject({
      method: 'GET',
      url: `/api/share/${token}?password=open-sesame-please`,
    });
    assert.equal(right.statusCode, 200);
  });

  test('a download cap is enforced', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'capped.txt', 'محتوى');
    const created = await call('POST', `/api/documents/${documentId}/shares`, aliceCookie, {
      maxDownloads: 2,
    });
    const token = created.json().token;

    assert.equal((await app.inject({ method: 'GET', url: `/api/share/${token}` })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/share/${token}` })).statusCode, 200);

    const third = await app.inject({ method: 'GET', url: `/api/share/${token}` });
    assert.equal(third.statusCode, 410);
    assert.equal(third.json().error, 'download_limit_reached');
  });

  test('sharing requires being able to read the document yourself', async () => {
    await makeUser('browser');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.browser}, ${PERM.BROWSE}, 0)
    `.execute(db);
    const browserCookie = await signIn('browser');

    const documentId = await upload(aliceCookie, 'cabinet', 'not-yours.txt', 'محتوى');
    const refused = await call('POST', `/api/documents/${documentId}/shares`, browserCookie, {});
    assert.equal(refused.statusCode, 404, 'browse alone must not hand out content');
  });

  // ── Parallel approval and SLA escalation ───────────────────────────────

  test('a require_all step waits for every member of the group', async () => {
    await makeGroup('اللجنة', [id.alice, id.bob]);

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'موافقة جماعية',
      steps: [{ approverId: String(id.اللجنة), requireAll: true }],
    });
    assert.equal(template.statusCode, 201);

    const documentId = await upload(aliceCookie, 'cabinet', 'committee.txt', 'محتوى');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });
    const requestId = requested.json().requestId;

    const first = await call('POST', `/api/approvals/${requestId}/decision`, aliceCookie, {
      decision: 'approved',
    });
    assert.equal(first.json().outcome, 'awaiting_others', 'one approval is not enough');

    const second = await call('POST', `/api/approvals/${requestId}/decision`, bobCookie, {
      decision: 'approved',
    });
    assert.equal(second.json().outcome, 'approved');
  });

  test('the same person cannot approve a step twice', async () => {
    const templates = (await call('GET', '/api/approval-templates', bossCookie)).json();
    const templateId = templates.templates.find((t) => t.name === 'موافقة جماعية').templateId;

    const documentId = await upload(aliceCookie, 'cabinet', 'double.txt', 'محتوى');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId });
    const requestId = requested.json().requestId;

    await call('POST', `/api/approvals/${requestId}/decision`, aliceCookie, { decision: 'approved' });
    const again = await call('POST', `/api/approvals/${requestId}/decision`, aliceCookie, {
      decision: 'approved',
    });

    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'already_decided');
  });

  test('an overdue step escalates to the requester and administrators', async () => {
    await makeGroup('بطيئون', [id.bob]);

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'بمهلة',
      steps: [{ approverId: String(id.بطيئون), slaHours: 4 }],
    });

    const documentId = await upload(aliceCookie, 'cabinet', 'overdue.txt', 'محتوى');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });

    // Backdate the request past its SLA.
    await sql`
      UPDATE dbo.approval_requests
         SET requested_at = DATEADD(hour, -10, SYSUTCDATETIME())
       WHERE request_id = ${requested.json().requestId}
    `.execute(db);

    const { escalateOverdue } = await import('../src/modules/workflow/service.js');
    const result = await escalateOverdue();
    assert.ok(result.escalated >= 1);

    const inbox = (await call('GET', '/api/notifications', aliceCookie)).json();
    assert.ok(inbox.notifications.some((n) => n.kind === 'approval.escalated'));

    // The pending list marks it, so a task list can show it as late.
    const queue = (await call('GET', '/api/approvals/pending', bobCookie)).json();
    const entry = queue.requests.find((r) => r.requestId === requested.json().requestId);
    assert.equal(entry.overdue, true);
  });

  // ── Approvers must be able to read what they decide on ─────────────────

  /*
   * Eligibility to approve comes from the template, the right to open the
   * document from the folder ACL, and nothing used to connect them: a step
   * could be assigned to people who could not see the document, and they
   * could approve it blind. The rule is now enforced at both ends — before
   * the request is saved, and again when a decision is recorded.
   */
  test('an approval is refused, and not saved, when an approver cannot read the document', async () => {
    await makeUser('blind');
    // One member who can read (bob) and one who cannot: any of them may be the
    // one who acts, so a single blind member is enough to refuse the request.
    await makeGroup('لجنة بلا اطلاع', [id.bob, id.blind]);

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'مسار بلا اطلاع',
      steps: [{ approverId: String(id.bob) }, { approverId: String(id['لجنة بلا اطلاع']) }],
    });
    assert.equal(template.statusCode, 201, template.body);
    const templateId = template.json().templateId;

    const documentId = await upload(aliceCookie, 'cabinet', 'unseen.txt', 'محتوى لا يراه المعتمد');
    const refused = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId });
    assert.equal(refused.statusCode, 409, refused.body);

    const body = refused.json();
    assert.equal(body.error, 'approver_cannot_read');
    // The message names the step, the approver and exactly who lacks access —
    // bob is on the same step and must not be listed.
    assert.equal(body.blocked.length, 1);
    assert.equal(body.blocked[0].step, 2);
    assert.equal(body.blocked[0].approver, 'لجنة بلا اطلاع');
    assert.equal(body.blocked[0].approverType, 'group');
    assert.deepEqual(body.blocked[0].members.map((m) => m.name), ['blind']);

    const saved = await sql`
      SELECT COUNT(*) AS n FROM dbo.approval_requests WHERE document_id = ${documentId}
    `.execute(db);
    assert.equal(Number(saved.rows[0].n), 0, 'a refused request must not be saved');

    // Granting the missing access is the fix the message asks for.
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.blind}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);
    const accepted = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, { templateId });
    assert.equal(accepted.statusCode, 201, accepted.body);
  });

  test('a decision is refused once the approver can no longer read the document', async () => {
    await makeUser('fleeting');
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id.fleeting}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);
    const fleetingCookie = await signIn('fleeting');

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'اعتماد يفقد صلاحيته',
      steps: [{ approverId: String(id.fleeting) }],
    });
    assert.equal(template.statusCode, 201, template.body);

    const documentId = await upload(aliceCookie, 'cabinet', 'revoked.txt', 'محتوى');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json().requestId;

    // The grant is withdrawn while the request waits.
    await sql`DELETE FROM dbo.access_control_entries WHERE principal_id = ${id.fleeting}`.execute(db);

    // The task list still shows the request, but says the buttons will not work.
    const queue = (await call('GET', '/api/approvals/pending', fleetingCookie)).json();
    const entry = queue.requests.find((r) => r.requestId === requestId);
    assert.ok(entry, 'the request still waits on this approver');
    assert.equal(entry.canRead, false);

    const refused = await call('POST', `/api/approvals/${requestId}/decision`, fleetingCookie, {
      decision: 'approved',
    });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal(refused.json().error, 'no_document_access');

    const decisions = await sql`
      SELECT COUNT(*) AS n FROM dbo.approval_decisions WHERE request_id = ${requestId}
    `.execute(db);
    assert.equal(Number(decisions.rows[0].n), 0, 'a refused decision must not be recorded');

    const still = await sql`
      SELECT status FROM dbo.approval_requests WHERE request_id = ${requestId}
    `.execute(db);
    assert.equal(still.rows[0].status, 'pending');
  });

  // ── QR ─────────────────────────────────────────────────────────────────

  test('a QR code is produced and requires Read', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'qr.txt', 'محتوى');

    const response = await call('GET', `/api/documents/${documentId}/qr`, aliceCookie);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    // PNG signature.
    assert.equal(response.rawPayload.subarray(1, 4).toString('latin1'), 'PNG');

    const browserCookie = await signIn('browser');
    assert.equal((await call('GET', `/api/documents/${documentId}/qr`, browserCookie)).statusCode, 404);
  });

  test('stamping a PDF returns a modified copy and leaves the stored file alone', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'stamped.pdf', MINIMAL_PDF, 'application/pdf');

    const row = await sql`
      SELECT storage_path, sha256, file_size_bytes FROM dbo.document_versions
       WHERE document_id = ${documentId}
    `.execute(db);

    const stamped = await call('GET', `/api/documents/${documentId}/content?stamp=qr`, aliceCookie);
    assert.equal(stamped.statusCode, 200);
    assert.equal(stamped.rawPayload.subarray(0, 4).toString('latin1'), '%PDF');
    assert.ok(
      stamped.rawPayload.length > Number(row.rows[0].file_size_bytes),
      'the stamped copy carries an embedded image, so it is larger',
    );

    // The stored bytes must still match the recorded hash, or every integrity
    // check the system makes becomes a lie.
    assert.ok(await storage.verify(row.rows[0].storage_path, row.rows[0].sha256));

    const plain = await call('GET', `/api/documents/${documentId}/content`, aliceCookie);
    assert.equal(plain.rawPayload.length, Number(row.rows[0].file_size_bytes));
  });

  // ── Reporting ──────────────────────────────────────────────────────────

  test('the dashboard reports totals an administrator would ask for', async () => {
    const response = await call('GET', '/api/reports/overview', bossCookie);
    assert.equal(response.statusCode, 200);

    const body = response.json();
    assert.ok(body.documents > 0);
    assert.equal(typeof body.bytes, 'number');
    assert.equal(typeof body.activeUsers, 'number');
    assert.equal(typeof body.pendingApprovals, 'number');
    assert.equal(typeof body.onLegalHold, 'number');
  });

  test('reporting is super-admin only', async () => {
    assert.equal((await call('GET', '/api/reports/overview', aliceCookie)).statusCode, 403);
    assert.equal((await call('GET', '/api/reports/storage', aliceCookie)).statusCode, 403);
  });

  test('the trend, storage and distribution reports return usable shapes', async () => {
    const trend = (await call('GET', '/api/reports/trend?days=7', bossCookie)).json();
    assert.ok(Array.isArray(trend.trend));

    const storageReport = (await call('GET', '/api/reports/storage', bossCookie)).json();
    assert.ok(storageReport.folders.some((f) => f.name === 'cabinet'));

    const distribution = (await call('GET', '/api/reports/distribution', bossCookie)).json();
    assert.ok(Array.isArray(distribution.byType));
    assert.ok(distribution.byState.some((s) => s.name === 'active'));

    const contributors = (await call('GET', '/api/reports/contributors', bossCookie)).json();
    assert.ok(contributors.contributors.some((c) => c.actor === 'alice'));
  });

  // ── API keys and webhooks ──────────────────────────────────────────────

  test('an API key authenticates as its user and can be revoked', async () => {
    const created = await call('POST', '/api/api-keys', bossCookie, {
      name: 'تكامل الماسح',
      userId: String(id.alice),
    });
    assert.equal(created.statusCode, 201);

    const key = created.json().key;
    assert.ok(key.startsWith('dms_'));

    /*
     * Over the wire, not through the function.
     *
     * This test used to call resolveApiKey() directly — and passed for as long
     * as the function existed, while no request path ever invoked it. The
     * administration screen issued keys that could authenticate nothing, and
     * the test named "authenticates" never noticed, because it tested the
     * resolver instead of the door. The same storage-versus-effect failure as
     * the settings that saved and did nothing.
     */
    const viaKey = (headers = {}) =>
      app.inject({
        method: 'GET',
        url: '/api/folders/tree',
        headers: { authorization: `Bearer ${key}`, ...headers },
      });

    const opened = await viaKey();
    assert.equal(opened.statusCode, 200, `the key must open the door itself: ${opened.body}`);

    // As alice, with alice's permissions — a key inherits its user's view of
    // the tree, it does not become a skeleton key.
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(me.json().user?.username, 'alice');

    const listed = (await call('GET', '/api/api-keys', bossCookie)).json();
    const entry = listed.keys.find((k) => k.name === 'تكامل الماسح');
    await call('DELETE', `/api/api-keys/${entry.keyId}`, bossCookie);

    const afterRevoke = await viaKey();
    assert.equal(afterRevoke.statusCode, 401, 'a revoked key must stop working at the door');

    // A bad key does not fall through to any cookie that happens to ride along:
    // revocation must be testable from the caller's side.
    const withCookieToo = await viaKey({ cookie: aliceCookie });
    assert.equal(withCookieToo.statusCode, 401, 'a presented key gets the key’s answer, including no');
  });

  /**
   * The lock's one promise, on the ordinary path.
   *
   * restoreVersion checked the lock; addVersion — the way every new version
   * actually arrives — did not, so the promise held on the rare path and broke
   * on the common one. Two people editing "their" copy and the second upload
   * silently winning is precisely the collision check-out exists to prevent.
   */
  test('a checked-out document refuses new versions from anyone else', async () => {
    const documentId = await upload(aliceCookie, 'cabinet', 'quarterly.txt', 'النسخة الأولى');

    assert.equal(
      (await call('POST', `/api/documents/${documentId}/checkout`, aliceCookie)).statusCode,
      200,
    );

    const boundary = '----dmslock';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v2.txt"\r\n`
          + 'Content-Type: text/plain\r\n\r\n',
        'utf8',
      ),
      Buffer.from('نسخة منافسة', 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const postVersion = (cookie) =>
      app.inject({
        method: 'POST',
        url: `/api/documents/${documentId}/versions`,
        headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });

    const blocked = await postVersion(bobCookie);
    assert.equal(blocked.statusCode, 423, `bob must be refused while alice holds the lock: ${blocked.body}`);
    assert.equal(blocked.json().error, 'locked');
    assert.ok(blocked.json().lockedBy?.name, 'the refusal names who holds it');

    // The holder is not locked out of their own checkout.
    const own = await postVersion(aliceCookie);
    assert.equal(own.statusCode, 201, own.body);

    await call('POST', `/api/documents/${documentId}/checkin`, aliceCookie);
    const released = await postVersion(bobCookie);
    assert.equal(released.statusCode, 201, 'check-in reopens the document');
  });

  /**
   * Deactivating someone reports the approvals that will now never complete.
   *
   * A step assigned to a person — not a group — has exactly one eligible
   * approver, and reassignment deliberately does not exist. Without this count
   * the first sign of trouble is a document stuck "بانتظار الاعتماد" weeks
   * later, with the cause long scrolled out of anyone's memory.
   */
  test('deactivating a personal approver reports the approvals it strands', async () => {
    await makeUser('lonely-approver');
    // An approver has to be able to read the document, or the request is
    // refused before it exists and there is nothing to strand.
    await sql`
      INSERT INTO dbo.access_control_entries (folder_id, principal_id, allow_bits, deny_bits)
      VALUES (${id.cabinet}, ${id['lonely-approver']}, ${PERM.BROWSE | PERM.READ}, 0)
    `.execute(db);

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'اعتماد فردي',
      steps: [{ approverId: String(id['lonely-approver']), requireAll: false }],
    });
    assert.equal(template.statusCode, 201, template.body);

    const documentId = await upload(aliceCookie, 'cabinet', 'stranded.txt', 'بانتظار موافقة');
    const request = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });
    assert.equal(request.statusCode, 201, request.body);

    const deactivated = await call('POST', `/api/admin/users/${id['lonely-approver']}/active`, bossCookie, {
      active: false,
    });
    assert.equal(deactivated.statusCode, 200, deactivated.body);
    assert.ok(
      Number(deactivated.json().blockedApprovals) >= 1,
      `the response must count the stranded approvals: ${deactivated.body}`,
    );
  });

  test('only the hash of an API key is stored', async () => {
    const created = await call('POST', '/api/api-keys', bossCookie, {
      name: 'مفتاح آخر',
      userId: String(id.bob),
    });
    const key = created.json().key;

    const rows = await sql`SELECT key_hash FROM dbo.api_keys`.execute(db);
    for (const row of rows.rows) {
      assert.notEqual(row.key_hash, key);
      assert.match(row.key_hash, /^[0-9a-f]{64}$/);
    }
  });

  test('a webhook subscribes to events and queues a delivery', async () => {
    const created = await call('POST', '/api/webhooks', bossCookie, {
      name: 'نظام خارجي',
      url: 'http://127.0.0.1:9/never-answers',
      events: ['document.created'],
    });
    assert.equal(created.statusCode, 201);
    assert.ok(created.json().secret, 'the signing secret is returned once');

    await upload(aliceCookie, 'cabinet', 'triggers-hook.txt', 'محتوى');

    const deliveries = await sql`
      SELECT event, status FROM dbo.webhook_deliveries ORDER BY delivery_id DESC
    `.execute(db);

    assert.ok(deliveries.rows.length >= 1);
    assert.equal(deliveries.rows[0].event, 'document.created');
    // Queued, not sent inline — a dead receiver must not slow the upload.
    assert.equal(Number(deliveries.rows[0].status), 0);
  });

  /*
   * The secret used to be stored only as a hash, so nothing could sign with
   * it and deliveries carried no signature while the screen promised one. A
   * real listener stands in for the receiver here, and the signature is
   * recomputed from the documented recipe rather than from the service's own
   * helper, so this fails if the recipe and the code ever part ways.
   */
  test('a delivery is signed with the secret, and the documented recipe verifies it', async () => {
    const received = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const created = await call('POST', '/api/webhooks', bossCookie, {
        name: 'مستقبِل يتحقق',
        url: `http://127.0.0.1:${port}/hook`,
        events: ['document.created'],
      });
      assert.equal(created.statusCode, 201, created.body);
      const { webhookId, secret } = created.json();

      const documentId = await upload(aliceCookie, 'cabinet', 'signed.txt', 'محتوى موقّع');

      const { deliverPending } = await import('../src/modules/integration/service.js');
      await deliverPending({ max: 100 });

      const delivery = await sql`
        SELECT delivery_id, status FROM dbo.webhook_deliveries WHERE webhook_id = ${webhookId}
      `.execute(db);
      assert.equal(Number(delivery.rows[0].status), 2, 'the delivery reached the listener');

      const hit = received.find((r) => r.headers['x-dms-event'] === 'document.created');
      assert.ok(hit, 'the listener saw the delivery');
      assert.equal(JSON.parse(hit.body).data.documentId, String(documentId));
      assert.equal(hit.headers['x-dms-delivery'], String(delivery.rows[0].delivery_id));

      // The recipe from docs/WEBHOOKS.md, computed independently of the service.
      const timestamp = hit.headers['x-dms-timestamp'];
      assert.match(timestamp, /^[0-9]+$/);
      assert.ok(Math.abs(Number(timestamp) - Date.now() / 1000) < 60, 'the timestamp is now');
      const expected = 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${hit.body}`).digest('hex');
      assert.equal(hit.headers['x-dms-signature'], expected);

      // Rotation returns a new secret once, and the list shows the hook as signed.
      const rotated = await call('POST', `/api/webhooks/${webhookId}/secret`, bossCookie, {});
      assert.equal(rotated.statusCode, 200, rotated.body);
      assert.ok(rotated.json().secret && rotated.json().secret !== secret);
      let listed = (await call('GET', '/api/webhooks', bossCookie)).json();
      assert.equal(listed.webhooks.find((w) => w.webhookId === webhookId).signed, true);

      // A hook from before 0017 has no secret: it is marked, and delivers unsigned.
      await sql`UPDATE dbo.webhooks SET secret = NULL WHERE webhook_id = ${webhookId}`.execute(db);
      listed = (await call('GET', '/api/webhooks', bossCookie)).json();
      assert.equal(listed.webhooks.find((w) => w.webhookId === webhookId).signed, false);

      received.length = 0;
      await upload(aliceCookie, 'cabinet', 'unsigned.txt', 'محتوى بلا توقيع');
      await deliverPending({ max: 100 });
      const unsigned = received.find((r) => r.headers['x-dms-event'] === 'document.created');
      assert.ok(unsigned, 'still delivered');
      assert.equal(unsigned.headers['x-dms-signature'], undefined);
      assert.equal(unsigned.headers['x-dms-timestamp'], undefined);

      await call('DELETE', `/api/webhooks/${webhookId}`, bossCookie);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('approval events reach subscribed webhooks with the request and the decision in the payload', async () => {
    const created = await call('POST', '/api/webhooks', bossCookie, {
      name: 'متابع الاعتماد',
      url: 'http://127.0.0.1:9/approvals',
      events: ['approval.requested', 'approval.decided'],
    });
    assert.equal(created.statusCode, 201, created.body);
    const webhookId = created.json().webhookId;

    const template = await call('POST', '/api/approval-templates', bossCookie, {
      name: 'مسار يُبلَّغ عنه',
      steps: [{ approverId: String(id.bob) }],
    });
    assert.equal(template.statusCode, 201, template.body);

    const documentId = await upload(aliceCookie, 'cabinet', 'hooked.txt', 'محتوى');
    const requested = await call('POST', `/api/documents/${documentId}/approvals`, aliceCookie, {
      templateId: template.json().templateId,
    });
    assert.equal(requested.statusCode, 201, requested.body);
    const requestId = requested.json().requestId;

    const decided = await call('POST', `/api/approvals/${requestId}/decision`, bobCookie, {
      decision: 'approved',
    });
    assert.equal(decided.statusCode, 200, decided.body);

    const rows = await sql`
      SELECT event, payload FROM dbo.webhook_deliveries
       WHERE webhook_id = ${webhookId} ORDER BY delivery_id
    `.execute(db);
    const events = rows.rows.map((row) => ({ event: row.event, data: JSON.parse(row.payload).data }));

    assert.deepEqual(events.map((e) => e.event), ['approval.requested', 'approval.decided']);
    assert.equal(events[0].data.requestId, requestId);
    assert.equal(events[0].data.documentId, String(documentId));
    assert.equal(events[0].data.actor, 'alice');
    assert.equal(events[0].data.step, 1);
    assert.equal(events[1].data.requestId, requestId);
    assert.equal(events[1].data.decision, 'approved');
    assert.equal(events[1].data.outcome, 'approved');
    assert.equal(events[1].data.actor, 'bob');

    // Paused so the deliveries above do not keep retrying under later tests.
    await call('POST', `/api/webhooks/${webhookId}/active`, bossCookie, { active: false });
  });

  test('an unknown webhook event is refused', async () => {
    const response = await call('POST', '/api/webhooks', bossCookie, {
      name: 'خاطئ',
      url: 'https://example.test/hook',
      events: ['not.a.real.event'],
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'no_events');
  });

  test('a paused webhook queues nothing while paused and resumes afterwards', async () => {
    const created = await call('POST', '/api/webhooks', bossCookie, {
      name: 'خطاف مؤقت',
      url: 'http://127.0.0.1:9/paused-hook',
      events: ['document.created'],
    });
    assert.equal(created.statusCode, 201);
    const hookId = created.json().webhookId;

    // Baseline delivery count for this hook before pausing.
    const before = await sql`
      SELECT COUNT(*) AS n FROM dbo.webhook_deliveries WHERE webhook_id = ${hookId}
    `.execute(db);
    const countBefore = Number(before.rows[0].n);

    // Pause the webhook.
    const paused = await call('POST', `/api/webhooks/${hookId}/active`, bossCookie, { active: false });
    assert.equal(paused.statusCode, 200);

    // Upload a document — this normally triggers document.created.
    await upload(aliceCookie, 'cabinet', 'while-paused.txt', 'لا يُسلَّم');

    const duringPause = await sql`
      SELECT COUNT(*) AS n FROM dbo.webhook_deliveries WHERE webhook_id = ${hookId}
    `.execute(db);
    assert.equal(Number(duringPause.rows[0].n), countBefore, 'no new delivery while paused');

    // GET /api/webhooks should reflect isActive false.
    const listed = (await call('GET', '/api/webhooks', bossCookie)).json();
    const entry = listed.webhooks.find((w) => w.webhookId === hookId);
    assert.equal(entry.isActive, false);

    // Resume and upload again — the delivery count must now grow.
    const resumed = await call('POST', `/api/webhooks/${hookId}/active`, bossCookie, { active: true });
    assert.equal(resumed.statusCode, 200);

    await upload(aliceCookie, 'cabinet', 'after-resume.txt', 'يُسلَّم');

    const afterResume = await sql`
      SELECT COUNT(*) AS n FROM dbo.webhook_deliveries WHERE webhook_id = ${hookId}
    `.execute(db);
    assert.equal(Number(afterResume.rows[0].n), countBefore + 1, 'exactly one new delivery after resume');
  });

  test('editing a webhook changes url and events; bad inputs are rejected; the secret is preserved', async () => {
    const created = await call('POST', '/api/webhooks', bossCookie, {
      name: 'خطاف قابل للتعديل',
      url: 'http://127.0.0.1:9/original',
      events: ['document.created'],
    });
    assert.equal(created.statusCode, 201);
    const hookId = created.json().webhookId;

    // Read the secret before the edit so we can confirm it is unchanged.
    const before = await sql`
      SELECT secret FROM dbo.webhooks WHERE webhook_id = ${hookId}
    `.execute(db);
    const secretBefore = before.rows[0].secret;
    assert.equal(secretBefore, created.json().secret, 'the secret is kept for signing, not hashed');

    // Valid edit: change url and add another event.
    const edited = await call('PATCH', `/api/webhooks/${hookId}`, bossCookie, {
      name: 'خطاف قابل للتعديل',
      url: 'https://example.test/updated',
      events: ['document.created', 'document.updated'],
    });
    assert.equal(edited.statusCode, 200);

    const listed = (await call('GET', '/api/webhooks', bossCookie)).json();
    const entry = listed.webhooks.find((w) => w.webhookId === hookId);
    assert.equal(entry.url, 'https://example.test/updated');
    assert.ok(entry.events.includes('document.updated'));

    // The secret must be unchanged — the receiver keeps verifying with the
    // secret it received at creation time.
    const after = await sql`
      SELECT secret FROM dbo.webhooks WHERE webhook_id = ${hookId}
    `.execute(db);
    assert.equal(after.rows[0].secret, secretBefore);

    // A bad url must be rejected.
    const badUrl = await call('PATCH', `/api/webhooks/${hookId}`, bossCookie, {
      name: 'خطاف قابل للتعديل',
      url: 'ftp://not-http',
      events: ['document.created'],
    });
    assert.equal(badUrl.statusCode, 400);
    assert.equal(badUrl.json().error, 'invalid_url');

    // An empty event list must be rejected.
    const noEvents = await call('PATCH', `/api/webhooks/${hookId}`, bossCookie, {
      name: 'خطاف قابل للتعديل',
      url: 'https://example.test/updated',
      events: [],
    });
    assert.equal(noEvents.statusCode, 400);
    assert.equal(noEvents.json().error, 'no_events');
  });

  test('the audit log records api_key.issued, api_key.revoked, and webhook.changed actions by boss', async () => {
    const apiKeyRows = await sql`
      SELECT actor_username, action FROM dbo.audit_log
       WHERE action = 'api_key.issued' AND actor_username = 'boss'
    `.execute(db);
    assert.ok(apiKeyRows.rows.length >= 1, 'at least one api_key.issued row by boss');

    // The key created in the first API-key test is revoked with DELETE in that same test.
    const revokedRows = await sql`
      SELECT actor_username, action FROM dbo.audit_log
       WHERE action = 'api_key.revoked' AND actor_username = 'boss'
    `.execute(db);
    assert.ok(revokedRows.rows.length >= 1, 'at least one api_key.revoked row by boss');

    const webhookRows = await sql`
      SELECT actor_username, action FROM dbo.audit_log
       WHERE action = 'webhook.changed' AND actor_username = 'boss'
    `.execute(db);
    assert.ok(webhookRows.rows.length >= 1, 'at least one webhook.changed row by boss');
  });

  // ── Resumable upload ───────────────────────────────────────────────────

  test('a chunked upload resumes from the server-recorded offset', async () => {
    const content = Buffer.from('محتوى يُرفع على أجزاء متعددة للاختبار', 'utf8');

    const session = await call('POST', '/api/uploads', aliceCookie, {
      folderId: String(id.cabinet),
      filename: 'chunked.txt',
      totalBytes: content.length,
      mimeType: 'text/plain',
    });
    assert.equal(session.statusCode, 201);
    const sessionId = session.json().sessionId;

    const half = Math.floor(content.length / 2);

    const first = await app.inject({
      method: 'PATCH',
      url: `/api/uploads/${sessionId}`,
      headers: { cookie: aliceCookie, 'x-upload-offset': '0', 'content-type': 'application/octet-stream' },
      payload: content.subarray(0, half),
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().offset, half);

    // A client that thinks it sent more than it did is corrected, not accepted
    // at the wrong position.
    const wrong = await app.inject({
      method: 'PATCH',
      url: `/api/uploads/${sessionId}`,
      headers: { cookie: aliceCookie, 'x-upload-offset': '9999', 'content-type': 'application/octet-stream' },
      payload: content.subarray(half),
    });
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().offset, half, 'the server states the real offset');

    const second = await app.inject({
      method: 'PATCH',
      url: `/api/uploads/${sessionId}`,
      headers: {
        cookie: aliceCookie,
        'x-upload-offset': String(half),
        'content-type': 'application/octet-stream',
      },
      payload: content.subarray(half),
    });
    assert.equal(second.json().complete, true);

    const completed = await call('POST', `/api/uploads/${sessionId}/complete`, aliceCookie, {});
    assert.equal(completed.statusCode, 200);

    const fetched = await call('GET', `/api/documents/${completed.json().documentId}/content`, aliceCookie);
    assert.equal(fetched.rawPayload.toString('utf8'), content.toString('utf8'));
  });

  test('completing an incomplete session is refused', async () => {
    const session = await call('POST', '/api/uploads', aliceCookie, {
      folderId: String(id.cabinet),
      filename: 'incomplete.txt',
      totalBytes: 1000,
    });

    const response = await call('POST', `/api/uploads/${session.json().sessionId}/complete`, aliceCookie, {});
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'incomplete');
  });

  test('a session belongs to the person who started it', async () => {
    const session = await call('POST', '/api/uploads', aliceCookie, {
      folderId: String(id.cabinet),
      filename: 'mine.txt',
      totalBytes: 10,
    });

    const response = await call('GET', `/api/uploads/${session.json().sessionId}`, bobCookie);
    assert.equal(response.statusCode, 404);
  });
});
