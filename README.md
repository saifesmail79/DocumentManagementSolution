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
   readable title, and a nightly per-month JSON manifest records the full folder path,
   metadata and hashes. If the database were ever lost, the documents remain identifiable
   and the structure is recoverable.

**Search.** SQL Server full-text search indexes an *extracted text column*, not the files.
A background worker extracts text from PDFs and Office documents, normalizes it, and
stores it. Search is permission-filtered in the same query that matches text, so a user
can never see a hit — or a result count — for a document they cannot read.

**Arabic.** ~95% of content is Arabic. `normalizeArabic()` runs at both index time and
query time; skipping either silently halves recall. All text columns are `NVARCHAR` with
`Arabic_CI_AI` collation.

## Getting started

```bash
npm install
cp .env.example .env      # then fill it in
npm run migrate
npm run dev
```

```bash
npm test                  # unit tests, no database required
```

## Layout

```
src/
  config/      environment validation — nothing else reads process.env
  db/          Kysely + tedious connection, migration runner
    migrations/
  storage/     Option C path building and the filesystem driver
  lib/         arabic.js — the normalization pipeline
  modules/     feature modules (tree, documents, permissions, search…)
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
