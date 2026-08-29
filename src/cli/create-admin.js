/**
 * Creates a super-admin account.
 *
 * A fresh installation has no users, and every route requires one — so without
 * this there is no way in. It is deliberately a CLI rather than a "first run"
 * HTTP endpoint: an unauthenticated endpoint that creates an administrator is a
 * back door if the guard that disables it ever fails, and this system is
 * installed by someone with a shell on the box anyway.
 *
 *   npm run create-admin -- --username admin --name "مدير النظام"
 *   npm run create-admin -- --username admin --password "..." --name "Admin"
 *
 * With no --password, one is generated and printed once.
 */

import { randomBytes } from 'node:crypto';

import { db, sql, closeDatabase } from '../db/index.js';
import { hashPassword, validatePassword } from '../modules/auth/passwords.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'create-admin' });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/**
 * A generated password that satisfies the policy without being awkward to read
 * aloud over a phone. base64url avoids the characters that are ambiguous in most
 * fonts once the operator is typing them into a login form.
 */
function generatePassword() {
  return randomBytes(18).toString('base64url');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = typeof args.username === 'string' ? args.username.trim() : '';
  const displayName = typeof args.name === 'string' ? args.name.trim() : username;

  if (!username) {
    console.error('Usage: npm run create-admin -- --username <name> [--password <pw>] [--name "<display>"]');
    process.exitCode = 1;
    return;
  }

  const generated = typeof args.password !== 'string';
  const password = generated ? generatePassword() : args.password;

  const policy = validatePassword(password, { username });
  if (!policy.ok) {
    console.error('Password rejected:');
    for (const problem of policy.problems) console.error(`  • ${problem}`);
    process.exitCode = 1;
    return;
  }

  const existing = await sql`SELECT user_id FROM dbo.users WHERE username = ${username}`.execute(db);
  if (existing.rows.length > 0) {
    console.error(`A user named "${username}" already exists. Choose another name.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);

  // principals and users are two halves of one identity — a principal row with no
  // users row is an account nobody can log into but ACLs can still target, so the
  // pair is written in a transaction or not at all.
  const userId = await db.transaction().execute(async (trx) => {
    const principal = await sql`
      INSERT INTO dbo.principals (principal_type, display_name)
      OUTPUT INSERTED.principal_id AS pid
      VALUES ('user', ${displayName})
    `.execute(trx);

    const pid = principal.rows[0].pid;

    await sql`
      INSERT INTO dbo.users (user_id, username, password_hash, is_super_admin, must_change_password, password_changed_at)
      VALUES (${pid}, ${username}, ${passwordHash}, 1, ${generated ? 1 : 0}, SYSUTCDATETIME())
    `.execute(trx);

    return pid;
  });

  log.info({ userId: String(userId), username }, 'super admin created');

  console.log('');
  console.log(`  Super admin created: ${username}  (user_id ${userId})`);
  if (generated) {
    console.log(`  Password: ${password}`);
    console.log('');
    console.log('  Shown once and not stored anywhere in readable form.');
    console.log('  The account is flagged must_change_password, so this password works');
    console.log('  for the first login only and must be replaced immediately.');
  }
  console.log('');
}

try {
  await main();
} catch (error) {
  log.error({ err: error }, 'could not create the admin account');
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => {});
}
