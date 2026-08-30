/**
 * Migration 0010 — fn_expand_group_members.
 *
 * 0001 provides fn_expand_principals(@user_id): given a user, every principal
 * that user acts as — itself plus every group it belongs to, transitively. That
 * answers "does this grant apply to me".
 *
 * The approval workflow needs the opposite direction: given a principal that a
 * step is assigned to, which real users can act on it. A step assigned to a
 * group has to notify its members, and a require_all step has to know how many
 * members there are before it can tell whether everyone has approved.
 *
 * ─── Guarded against cycles ─────────────────────────────────────────────────
 *
 * Group membership is a graph, not a tree, and 0001's own tests include a cyclic
 * definition. The recursion carries a depth counter and stops at 16, matching
 * fn_expand_principals — without it a cycle makes this recurse until SQL Server
 * kills the statement, and the caller sees an error rather than a member list.
 *
 * Inactive principals are excluded: notifying a deactivated account, or waiting
 * for it to approve something, would stall a request indefinitely.
 */

import { sql } from 'kysely';

export const m0010ExpandGroupMembers = {
  id: '0010',
  name: 'fn_expand_group_members for workflow assignment',

  async up(trx) {
    // Kysely sends a template carrying a ${} parameter through sp_executesql,
    // which cannot create a function — so this is sql.raw with nothing
    // interpolated. Same reason as the functions in 0001.
    await sql
      .raw(
        `
      CREATE FUNCTION dbo.fn_expand_group_members (@principal_id bigint)
      RETURNS TABLE
      AS
      RETURN (
        WITH members AS (
          -- A principal is a member of itself: a step assigned directly to one
          -- person must resolve to that person.
          SELECT CAST(@principal_id AS bigint) AS principal_id, 0 AS lvl
          UNION ALL
          SELECT gm.member_principal_id, m.lvl + 1
            FROM members m
            JOIN dbo.group_members gm ON gm.group_id = m.principal_id
           WHERE m.lvl < 16
        )
        SELECT DISTINCT m.principal_id
          FROM members m
          JOIN dbo.principals p ON p.principal_id = m.principal_id
         WHERE p.is_active = 1
           AND p.principal_type = 'user'
      );
    `,
      )
      .execute(trx);
  },
};
