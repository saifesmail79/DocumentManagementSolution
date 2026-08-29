# Document Management Solution

Arabic-first, on-premise document management system.

**Stack:** Node.js + Fastify · React · SQL Server Standard (Windows Server) · files on a configurable filesystem path.

---

## Architecture in one page

**Metadata lives in SQL Server. Document files live on the filesystem.** The database
holds a relative path; it never holds the bytes. This keeps the database small enough to
back up hourly and restore in minutes, however many terabytes of documents accumulate.

**Storage layout ("Option C"):**

```
{STORAGE_ROOT}\{yyyy}\{MM}\{documentId}_v{version}_{sanitized-title}{ext}
\nas\dms\2026\08\10432_v2_عقد_إيجار_مبنى_الإدارة.pdf
```

Two deliberate properties:

1. **The layout is keyed on upload date, not on the filing tree.** Moving a folder in the
   DMS is a pure database operation — no files move, so nothing can half-fail and leave
   the database disagreeing with the disk.
2. **The disk is self-describing.** Filenames carry the document id, the version and a
   readable title, so the documents stay identifiable without the database.

   > The per-month JSON manifest that would also record the folder path and metadata is
   > **designed but not built**. Until it exists, losing the database means losing the
   > filing structure and metadata — the files themselves remain readable.

**Search.** SQL Server full-text search indexes an *extracted text column*, not the files.
A background worker extracts text from PDFs and Office documents, normalizes it, and
stores it. Search is permission-filtered in the same query that matches text, so a user
can never see a hit — or a result count — for a document they may not browse.

> The extractor reads a document's **existing text layer**. A scan is a photograph of a
> page and has none, so scans are recorded as `unsupported` and are not content-searchable
> until OCR exists. Title and metadata search are unaffected.

**Arabic.** ~95% of content is Arabic. `normalizeArabic()` runs at both index time and
query time; skipping either silently halves recall. All text columns are `NVARCHAR` with
`Arabic_CI_AI` collation.

## Getting started

```bash
npm install
cp .env.example .env             # then fill it in — DB_SERVER and STORAGE_ROOT at minimum
npm run migrate                  # idempotent; safe to re-run
npm run create-admin -- --username admin --name "مدير النظام"

npm run install:client
npm run build:client             # then http://localhost:3040 serves API + UI from one process
npm run dev                      # or Ctrl+Shift+B in VS Code for API + Vite together
```

`create-admin` prints a generated password once. The account is flagged
`must_change_password`, so it works for a single login and nothing else until replaced.

### Tests

```bash
npm test                  # everything: offline plus integration
npm run test:db           # integration only
```

The integration suite **truncates the identity and filing-tree tables**, so it never runs
against `DB_NAME`. It redirects itself to `DB_NAME + "_test"` (override with
`TEST_DB_NAME`), creates that database on first run, and refuses to start if the two
resolve to the same name.

## Layout

```
src/
  config/      environment validation — nothing else reads process.env
  db/          Kysely + tedious connection, migration runner
    migrations/
  storage/     Option C path building and the filesystem driver
  lib/         arabic.js — the normalization pipeline
  modules/     auth, tree, documents, search, extraction, admin, metadata, audit
  cli/         create-admin
client/        React + Vite, RTL, Tailwind tokens from the UI standards
docs/
  UI_UX_AGENT_STANDARDS.md    RTL-first UI standards — followed strictly
  SCAN_BRIDGE_INTEGRATION.md  the desktop scanner helper's API
tests/
```

## Operational notes

- **`UV_THREADPOOL_SIZE=64`.** Node uses 4 file-I/O worker threads by default. One stalled
  SMB session fills them and blocks file I/O for every request, not just uploads.
- **Never use a mapped drive letter for `STORAGE_ROOT`.** A Windows service runs in its own
  logon session and cannot see mapped drives. Use a UNC path and a dedicated service account
  that exists with the same name and password on the NAS.
- **Scan Bridge origin allowlist.** The helper rejects unknown origins with HTTP 403 and does
  not accept `https://` or hostnames out of the box. The production URL must be added to
  `C:\ProgramData\ScanBridge\appsettings.json` on every workstation, or scanning returns 403.
- **Backups.** The database backup is not optional — it is what makes the files meaningful.
  Take the database backup first, then the storage snapshot.
- **Password reset delivery is not implemented.** There is no SMTP configuration; the
  `log` transport writes the reset link to the application log. Configure a real transport
  before telling users the feature exists.
- **Developer vs Standard edition.** The development box runs SQL Server Developer, which
  has the full Enterprise feature set. Production is Standard. Anything Enterprise-only
  (`ONLINE = ON` index rebuilds, most Intelligent Query Processing, Resource Governor on
  2019) works in development and fails in production, so none of it is relied on.
