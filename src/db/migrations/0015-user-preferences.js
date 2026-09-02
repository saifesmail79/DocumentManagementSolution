import { sql } from 'kysely';

/**
 * Per-user interface state.
 *
 * ─── Why a table and not the browser ────────────────────────────────────────
 *
 * The first thing this holds is the order someone has arranged their tile menu
 * into. `localStorage` would have been a smaller change and the wrong one: an
 * arrangement kept in the browser is lost the moment that person signs in from
 * the second machine they use, or from the shared workstation in the records
 * room, and lost silently — the tiles simply come back in the original order
 * with nothing to say why. A preference the user set deliberately belongs to the
 * user, not to a browser profile.
 *
 * ─── Why a key/value table and not a column per preference ──────────────────
 *
 * `dbo.settings` already established this shape for system settings and it has
 * held up: the schema does not change every time a screen learns to remember
 * something. The alternative is a migration per checkbox.
 *
 * The value is validated by the service that owns each key rather than by the
 * schema, because "an array of module names" is not a constraint SQL Server can
 * usefully express, and a CHECK constraint that half-expresses it would be worse
 * than none — it would look like a guarantee.
 *
 * ─── On deleting a user ─────────────────────────────────────────────────────
 *
 * The foreign key has no cascade, matching `dbo.favourites` and the rest of the
 * per-user tables: users are deactivated here, not deleted, and a cascade would
 * quietly discard rows if that ever changed. A deliberate cleanup is better than
 * an automatic one nobody remembers exists.
 */
export const m0015UserPreferences = {
  id: '0015',
  name: 'per-user interface preferences',

  async up(trx) {
    await sql`
      IF OBJECT_ID('dbo.user_preferences', 'U') IS NULL
      CREATE TABLE dbo.user_preferences (
        user_id     bigint        NOT NULL,
        -- varchar, not nvarchar: keys are ASCII identifiers chosen in code, and
        -- the allowlist in the service is what decides which of them exist.
        pref_key    varchar(60)   NOT NULL,
        -- NVARCHAR(MAX) holding JSON. Small today, and there is no gain in
        -- guessing a ceiling for something whose shape each key defines.
        value       nvarchar(max) NOT NULL,
        updated_at  datetime2(3)  NOT NULL
          CONSTRAINT DF_user_preferences_updated_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_user_preferences PRIMARY KEY (user_id, pref_key),
        CONSTRAINT FK_user_preferences_user FOREIGN KEY (user_id)
          REFERENCES dbo.users(user_id)
      );
    `.execute(trx);
  },
};
