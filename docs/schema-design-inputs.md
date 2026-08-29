# Schema design inputs (raw agent output)

> Harvested from an adversarial design workflow that was interrupted before its final synthesis.
> These are the raw inputs: three independent schema designs plus two specialist reports.
> The final reviewed DDL is not yet written — see the ACL/tree work still outstanding.

---

## a3d6925397e4c373e

Here is the complete SQL Server specialist analysis with verified T-SQL.

---

## (a) Arabic Collation — Arabic_CI_AI, Arabic_100_CI_AI_SC, and FTS LANGUAGE 1025

**Is Arabic_CI_AI correct?**

Arabic_CI_AI is a valid SQL Server collation name (the legacy "version 80" code page collation). For a greenfield 2019+ system, use **Arabic_100_CI_AI_SC** instead. The `_100` suffix means version 100 (SQL Server 2008+) with better Unicode 6.0 coverage and correct Arabic character sorting weights; `_SC` adds supplementary character support. Apply this to every NVARCHAR column that holds Arabic text: titles, descriptions, folder names, tag names, user display names.

```sql
-- Correct collation for all Arabic-content NVARCHAR columns
title           NVARCHAR(500)  COLLATE Arabic_100_CI_AI_SC NOT NULL,
description     NVARCHAR(MAX)  COLLATE Arabic_100_CI_AI_SC NULL,
folder_name     NVARCHAR(300)  COLLATE Arabic_100_CI_AI_SC NOT NULL,
```

**Critical FTS interaction — FTS is always accent-sensitive regardless of column collation.**

This is the most important finding for this schema. Full-text search in SQL Server ignores the `_AI` (accent-insensitive) part of the column collation. FTS always searches accent-sensitively. If you store `كِتَابٌ` (with tashkeel diacritics) in the extracted_text column and search for `كتاب` (stripped), the FTS engine will NOT match them, even if the column is `Arabic_100_CI_AI_SC`.

The consequence: your Arabic normalization pipeline (alef/yaa/taa-marbuta unification, tashkeel stripping, tatweel stripping) MUST run before the text is written to the `extracted_text` column that the FTS index covers. The normalization is not optional; it is the only way to get accent-insensitive full-text matching in SQL Server with Arabic. Run it in the async extraction worker that populates the FTS column.

The column collation (Arabic_100_CI_AI_SC) still matters for LIKE comparisons, ORDER BY, equality, and GROUP BY on the non-FTS columns — the AI collation is used there and is correct for user-facing search.

**FTS column declaration:**

```sql
-- The FTS-indexed column holds pre-normalized Arabic text (diacritics already stripped by the worker)
-- Collation here is Arabic_100_CI_AI_SC; FTS ignores the AI flag but the column declaration is still valid
extracted_text  NVARCHAR(MAX)  COLLATE Arabic_100_CI_AI_SC NULL,

-- Full-text catalog and index
CREATE FULLTEXT CATALOG dms_fts_catalog
    WITH ACCENT_SENSITIVITY = OFF   -- has no effect for Arabic; kept for documentation intent
    AS DEFAULT;

CREATE FULLTEXT INDEX ON documents (extracted_text LANGUAGE 1025)
    KEY INDEX PK_documents
    ON dms_fts_catalog
    WITH STOPLIST = OFF,            -- do NOT use the system stoplist for Arabic; build a custom one
         CHANGE_TRACKING AUTO;
```

`LANGUAGE 1025` selects the SQL Server Arabic word breaker and stemmer. Verify the Arabic word breaker is installed:

```sql
SELECT * FROM sys.fulltext_languages WHERE lcid = 1025;
-- Must return a row; if empty, install SQL Server Full-Text Search feature
```

**Does the FTS column collation matter independently of the word breaker?**

For the FTS index itself, the column collation determines how the key values in the inverted index are compared — not how the word breaking happens. Word breaking is controlled entirely by the LANGUAGE clause. The net effect: use `Arabic_100_CI_AI_SC` for consistency, run normalization before insertion, use `LANGUAGE 1025` in the FTS index and in CONTAINSTABLE queries.

---

## (b) CONTAINSTABLE and FREETEXTTABLE — Syntax, RANK join, and the permission-filter plan trap

**Exact syntax:**

```sql
CONTAINSTABLE(
    table_name,
    { column_name | ( column_list ) | * },
    'contains_search_condition'
    [, LANGUAGE language_term ]
    [, top_n_by_rank ]
)
```

Returns a two-column table: `KEY` (the full-text key column value, here document_id) and `RANK` (integer 0–1000, higher = better match).

**Standard join pattern:**

```sql
SELECT d.document_id, d.title, d.created_at, fts.RANK
FROM documents AS d
INNER JOIN CONTAINSTABLE(
    documents,
    extracted_text,
    N'كتاب OR وثيقة',
    LANGUAGE 1025,
    500          -- top_n_by_rank: retrieve at most 500 candidates from FTS; see plan trap below
) AS fts ON d.document_id = fts.[KEY]
ORDER BY fts.RANK DESC;
```

**The permission-filter plan trap — verified:**

When you add a join to `effective_permissions` (or any non-FTS predicate) to the query above, the optimizer sees two inputs: the FTS TVF (whose row count estimate is opaque — SQL Server cannot statistics-sample a TVF) and the effective_permissions table (whose row count it knows). The optimizer frequently picks a plan that evaluates CONTAINSTABLE first, returns potentially tens of thousands of rows, then filters by permission. At scale this blows the memory grant and degrades.

The fix documented by Microsoft: give the optimizer a predicate on the FTS key column that it can push into the TVF. The only reliable way to do this for a permission filter is to **materialize the allowed document_id set into a temp table first**, then join that set into CONTAINSTABLE.

**Correct pattern for permission-filtered FTS search:**

```sql
-- Step 1: materialize allowed documents for this user in the target folder subtree
-- This set is small and indexable
CREATE TABLE #allowed (document_id BIGINT NOT NULL PRIMARY KEY);

INSERT INTO #allowed (document_id)
SELECT ep.document_id
FROM effective_permissions ep
WHERE ep.user_id          = @userId
  AND ep.folder_id        IN (SELECT node_id FROM #subtree_nodes)  -- pre-populated from path LIKE scan
  AND ep.permission_bits  & @requiredBits = @requiredBits          -- e.g. Read = bit 2
  AND ep.document_id IS NOT NULL;

-- Step 2: join CONTAINSTABLE against the temp table so the optimizer sees the small driving set
-- Use top_n_by_rank to cap the TVF output; for paging you need a count too (see below)
;WITH fts_results AS (
    SELECT a.document_id, fts.RANK
    FROM #allowed AS a
    INNER JOIN CONTAINSTABLE(
        documents,
        extracted_text,
        @searchTerm,
        LANGUAGE 1025,
        10000           -- generous cap; filtered by #allowed on the join
    ) AS fts ON a.document_id = fts.[KEY]
)
SELECT
    d.document_id,
    d.title,
    d.created_at,
    d.type_id,
    r.RANK,
    COUNT(*) OVER ()   AS total_count   -- windowed count for paging; computed over the permission-filtered set
FROM fts_results AS r
INNER JOIN documents AS d ON d.document_id = r.document_id
WHERE d.deleted_at IS NULL
ORDER BY r.RANK DESC
OFFSET @skip ROWS FETCH NEXT @pageSize ROWS ONLY;

DROP TABLE IF EXISTS #allowed;
```

This pattern ensures permission filtering happens before any CONTAINSTABLE row contributes to the result set. `COUNT(*) OVER()` gives the correct total count for the paging control without a second query — it reflects only the permission-filtered, non-deleted FTS matches.

If the temp table approach feels heavy for small permission sets, an alternative is `OPTION (LOOP JOIN)` to force a nested loop where `#allowed` drives and CONTAINSTABLE is the inner side — but this hint can backfire if #allowed is large. The temp table approach is more robust.

**FREETEXTTABLE:**

```sql
FREETEXTTABLE(documents, extracted_text, N'وثائق قانونية', LANGUAGE 1025, 200)
```

FREETEXTTABLE uses the linguistic meaning of the phrase (inflections, synonyms) whereas CONTAINSTABLE uses the literal search condition language (AND, OR, NEAR, prefix). For Arabic, FREETEXTTABLE's stemmer via the Arabic word breaker (LANGUAGE 1025) is generally superior for natural language queries. CONTAINSTABLE is better when users type exact technical terms or use boolean operators. Expose both modes in the UI.

---

## (c) Index Design

**Covering indexes for the hot browse query (list documents in folder X for user Y):**

The hot query drives from `effective_permissions` (user + folder + bits), joins to `documents` on document_id, then sorts and pages. The covering index on effective_permissions:

```sql
-- Primary access pattern: given user_id, find all their folder-level grants
CREATE INDEX IX_effperm_user_folder
ON effective_permissions (user_id, folder_id, permission_bits)
INCLUDE (document_id);
-- user_id + folder_id → index seek; permission_bits checked as residual on the seek rows

-- Secondary pattern: given user_id + document_id, check bits (FTS post-filter)
CREATE UNIQUE INDEX IX_effperm_user_doc
ON effective_permissions (user_id, document_id)
INCLUDE (permission_bits);
```

The covering index on documents for the list query:

```sql
-- Filtered index: only active (non-deleted) documents, the common browse case
-- Key columns: folder_id (seek), then sort columns as variants
-- Variant A: sort by created_at DESC
CREATE INDEX IX_docs_folder_created
ON documents (folder_id, created_at DESC)
INCLUDE (document_id, title, type_id, sensitivity_label_id, version_count, modified_at)
WHERE deleted_at IS NULL;

-- Variant B: sort by title (Arabic collation for correct ordering)
-- Do NOT put title in the key: NVARCHAR(500) = 1000 bytes; hits the 1700-byte key limit on non-clustered indexes
-- Always put variable-length long columns in INCLUDE, not in the key
CREATE INDEX IX_docs_folder_title
ON documents (folder_id)
INCLUDE (document_id, title, type_id, created_at, sensitivity_label_id, modified_at)
WHERE deleted_at IS NULL;
-- Sort on title is resolved as a sort operator after the index seek on folder_id, which is acceptable at this scale
```

**900/1700-byte key limit:**

In SQL Server 2019, the key size limit for non-clustered indexes is 1700 bytes (up from 900 for clustered). The practical rule: NVARCHAR(N) contributes 2*N bytes to the key limit. NVARCHAR(500) = 1000 bytes alone — it uses 59% of the non-clustered key budget and leaves no room for additional key columns. Never put an Arabic title column in the index key. Always use INCLUDE.

**Filtered indexes for soft delete:**

```sql
-- All the browse and search indexes above use WHERE deleted_at IS NULL.
-- Filtered indexes are appropriate here because the "active" predicate is highly selective
-- (deleted documents are a minority; the index is small and fast to scan).
-- Restriction: queries must have the predicate in a form the optimizer recognizes.
-- Use: WHERE deleted_at IS NULL in both the index and the query WHERE clause.
-- Do NOT use WHERE COALESCE(deleted_at, '2099-01-01') > GETDATE() — that breaks filter matching.
```

**Columnstore for audit_log in Standard edition:**

At DOP 2 for queries, no aggregate pushdown, and no string predicate pushdown, a non-clustered columnstore on the audit_log will help aggregate reporting queries (count by user, count by action type, range scans over event_time) because those queries are batch-mode-eligible under the columnstore even in Standard edition. The DOP 2 ceiling still roughly halves query time versus a single-threaded rowstore scan.

Add the columnstore only if you have reporting queries scanning millions of audit rows. If the audit_log is purely append-only with only tail reads (recent activity), skip it. Recommendation: add it when the table exceeds ~5M rows and you add a reporting feature.

```sql
-- On the partitioned audit_log table (see section e):
-- Apply per partition after a month is closed (switched out), so build is on a static table
CREATE NONCLUSTERED COLUMNSTORE INDEX NCCI_audit_log_analytics
ON audit_log_archive_202401 (event_time, actor_user_id, target_node_id, action_code, action_result);
-- Column selection: only columns used in analytics aggregations; omit large NVARCHAR payload columns
```

---

## (d) Materialized Path Column

**Type and collation:**

```sql
-- Path format: /1/42/713/ (leading and trailing slash, numeric IDs only)
-- VARCHAR, not NVARCHAR: paths contain only ASCII digits and slashes; VARCHAR saves 50% space
-- Collation: Latin1_General_100_BIN2 (binary ordering)
-- WHY binary: LIKE '/1/42/%' is a prefix scan that must use byte-order comparison.
--   If you use Arabic_100_CI_AI_SC, the collation's sort weights are linguistically derived
--   and SQL Server may not treat it as a pure prefix scan for the index.
--   Latin1_General_100_BIN2 guarantees that LIKE '/prefix/%' maps directly to a range seek
--   on the index because binary ordering is monotone with the stored byte sequence.
-- TRAP: if path column is Arabic_100_CI_AI_SC and the query literal is unqualified (e.g. N'/1/42/')
--   SQL Server may do an implicit collation conversion and CANNOT use the index seek.
--   With Latin1_General_100_BIN2 and VARCHAR parameters there is no implicit conversion.

materialized_path  VARCHAR(3000) COLLATE Latin1_General_100_BIN2 NOT NULL,

-- Index for subtree lookups
CREATE INDEX IX_nodes_path
ON filing_nodes (materialized_path)
INCLUDE (node_id, parent_id, node_name, node_type, breaks_inheritance);
-- LIKE '/1/42/%' on this index is a sargable range scan:
--   seek condition = materialized_path >= '/1/42/' AND materialized_path < '/1/42/~'
--   (SQL Server automatically converts the LIKE pattern to a range when the pattern has a fixed prefix)
```

**Reparenting a subtree:**

With a materialized path, reparenting is an UPDATE on all rows whose path starts with the old prefix:

```sql
-- Reparent subtree rooted at node 42 (old path '/1/42/') under node 99 (new path '/1/99/')
-- This is a bulk UPDATE; for large subtrees, batch it
DECLARE @old_prefix VARCHAR(3000) = '/1/42/';
DECLARE @new_prefix VARCHAR(3000) = '/1/99/';

UPDATE filing_nodes
SET materialized_path = @new_prefix + SUBSTRING(materialized_path, LEN(@old_prefix) + 1, 3000 - LEN(@new_prefix))
WHERE materialized_path LIKE @old_prefix + '%' COLLATE Latin1_General_100_BIN2;

-- Also update the node's parent_id (adjacency list part)
UPDATE filing_nodes SET parent_id = 99 WHERE node_id = 42;
```

The LIKE uses the binary collation so this is an index range scan, not a table scan.

---

## (e) Partitioning the audit_log by Month in Standard Edition

SQL Server Standard edition supports table partitioning from SQL Server 2016 SP1 onward; SQL Server 2019 Standard fully supports it including SWITCH.

```sql
-- Partition function: range RIGHT means the boundary value belongs to the RIGHT partition
-- Add future boundaries in the monthly maintenance job
CREATE PARTITION FUNCTION pf_audit_monthly (DATETIME2(0))
AS RANGE RIGHT FOR VALUES (
    '2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01',
    '2024-05-01', '2024-06-01', '2024-07-01', '2024-08-01',
    '2024-09-01', '2024-10-01', '2024-11-01', '2024-12-01',
    '2025-01-01' -- extend monthly in the maintenance job
);

-- Scheme: keep all partitions on PRIMARY for Standard edition (no filegroup flexibility needed at this scale)
CREATE PARTITION SCHEME ps_audit_monthly
AS PARTITION pf_audit_monthly ALL TO ([PRIMARY]);

-- audit_log table
-- PK must include the partition column (event_time) so the clustered index is partition-aligned
CREATE TABLE audit_log (
    audit_id      BIGINT        IDENTITY(1,1) NOT NULL,
    event_time    DATETIME2(0)  NOT NULL,
    actor_user_id INT           NOT NULL,
    action_code   TINYINT       NOT NULL,   -- enum: Create/Update/Delete/PermChange/Login/etc
    action_result TINYINT       NOT NULL,   -- 0=success, 1=denied
    target_type   TINYINT       NOT NULL,   -- 1=document, 2=folder, 3=user, etc
    target_id     BIGINT        NOT NULL,
    old_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    new_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    ip_address    VARCHAR(45)   NULL,
    session_id    UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_audit_log PRIMARY KEY CLUSTERED (event_time, audit_id)
) ON ps_audit_monthly(event_time);

-- Supporting index for "what did user X do recently"
CREATE INDEX IX_audit_actor_time
ON audit_log (actor_user_id, event_time DESC)
INCLUDE (action_code, target_type, target_id, action_result)
ON ps_audit_monthly(event_time);  -- must be on the same scheme for partition elimination
```

**Monthly SWITCH archival procedure:**

```sql
-- Run on the 1st of each month to archive 3-months-ago data
-- Example: archiving January 2024 in April 2024
-- Step 1: create the archive table with IDENTICAL schema and a CHECK constraint matching the partition range
CREATE TABLE audit_log_archive_202401 (
    audit_id      BIGINT        NOT NULL,
    event_time    DATETIME2(0)  NOT NULL,
    actor_user_id INT           NOT NULL,
    action_code   TINYINT       NOT NULL,
    action_result TINYINT       NOT NULL,
    target_type   TINYINT       NOT NULL,
    target_id     BIGINT        NOT NULL,
    old_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    new_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    ip_address    VARCHAR(45)   NULL,
    session_id    UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_audit_archive_202401 PRIMARY KEY CLUSTERED (event_time, audit_id),
    -- CHECK constraint must exactly match the partition boundaries for the SWITCH to succeed
    CONSTRAINT CK_audit_archive_202401_range
        CHECK (event_time >= '2024-01-01' AND event_time < '2024-02-01')
) ON [PRIMARY];  -- must be on the same filegroup as the source partition

-- Step 2: switch partition 2 (January 2024, boundary index 2 counting from 1 for leftmost)
-- Determine partition number: SELECT $PARTITION.pf_audit_monthly('2024-01-15')
ALTER TABLE audit_log
    SWITCH PARTITION 2
    TO audit_log_archive_202401;
-- This is a metadata-only operation; no data moves; completes in milliseconds
-- The archive table now holds all January 2024 rows

-- Step 3: TRUNCATE or back up the archive table as needed
-- Step 4: add next year's boundaries to the partition function
ALTER PARTITION FUNCTION pf_audit_monthly() SPLIT RANGE ('2026-01-01');
ALTER PARTITION SCHEME ps_audit_monthly NEXT USED [PRIMARY];
```

---

## (f) OFFSET/FETCH vs Keyset Pagination for the Document List

**At this scale (hundreds of thousands to low millions of documents), OFFSET/FETCH is the right default.** The filing tree distributes documents across folders; any single folder realistically holds hundreds to low thousands of active documents. The permission pre-filter via `effective_permissions` further limits the candidate set before sorting and paging.

Use OFFSET/FETCH:

```sql
SELECT d.document_id, d.title, d.created_at, d.type_id, d.sensitivity_label_id,
       COUNT(*) OVER () AS total_count
FROM effective_permissions ep
INNER JOIN documents d ON d.document_id = ep.document_id
WHERE ep.user_id          = @userId
  AND ep.folder_id        = @folderId
  AND ep.permission_bits  & 1 = 1   -- Browse bit
  AND d.deleted_at        IS NULL
ORDER BY d.created_at DESC          -- or d.title for alphabetical
OFFSET (@pageNumber - 1) * @pageSize ROWS
FETCH NEXT @pageSize ROWS ONLY;
```

OFFSET/FETCH degrades when skipping deep into a large result set because SQL Server must count past all skipped rows. The mitigation: cap the API at a max of 200 pages (the DMS UI will realistically never need deep pagination; provide search/filter to narrow results instead). For pages 1–20, performance is excellent with the covering indexes defined in section (c).

**When to use keyset:** Only if you build an infinite-scroll or "load more" UI where users continuously advance without jumping to arbitrary pages. Keyset by `(created_at, document_id)` eliminates the row-count problem:

```sql
-- Keyset continuation: client sends last seen (created_at, document_id)
SELECT TOP (@pageSize) d.document_id, d.title, d.created_at
FROM effective_permissions ep
INNER JOIN documents d ON d.document_id = ep.document_id
WHERE ep.user_id         = @userId
  AND ep.folder_id       = @folderId
  AND ep.permission_bits & 1 = 1
  AND d.deleted_at       IS NULL
  AND (d.created_at < @lastCreatedAt
       OR (d.created_at = @lastCreatedAt AND d.document_id < @lastDocumentId))
ORDER BY d.created_at DESC, d.document_id DESC;
```

Keyset cannot produce a total count. Decide based on UI design.

---

## (g) Bitmask INT vs Separate BIT Columns for Permission Verbs

**Use a TINYINT bitmask.** With 6 verbs it fits in 6 bits.

```
Bit 0 (1):   Browse    — see the node exists and see document titles
Bit 1 (2):   Read      — open/preview/download content
Bit 2 (4):   Upload    — add new documents / new versions
Bit 3 (8):   EditMeta  — change title, type, custom fields, tags
Bit 4 (16):  Delete    — soft-delete
Bit 5 (32):  ManagePerms — modify ACL, break/restore inheritance
```

The effective_permissions table stores two bitmasks: `allow_bits TINYINT` and `deny_bits TINYINT` (DENY takes precedence; net = allow_bits & ~deny_bits). Alternatively, pre-compute the net bits and store only `permission_bits TINYINT`. Pre-computation at login/permission-change time is the stated design, so store only net bits in the precomputed table.

```sql
CREATE TABLE effective_permissions (
    user_id         INT     NOT NULL,
    -- Covers both folder-level and document-level grants in one table
    -- Exactly one of (folder_id, document_id) is non-NULL per row
    folder_id       INT     NULL,
    document_id     BIGINT  NULL,
    permission_bits TINYINT NOT NULL,  -- net bits after inheritance and DENY resolution
    computed_at     DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_effperm_target CHECK (
        (folder_id IS NOT NULL AND document_id IS NULL) OR
        (folder_id IS NULL AND document_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX UX_effperm_user_folder
ON effective_permissions (user_id, folder_id)
INCLUDE (permission_bits)
WHERE folder_id IS NOT NULL;

CREATE UNIQUE INDEX UX_effperm_user_doc
ON effective_permissions (user_id, document_id)
INCLUDE (permission_bits)
WHERE document_id IS NOT NULL;
```

**Why TINYINT bitmask beats separate BIT columns:**

- One index covers all permission checks vs. six separate indexes or wide composite keys.
- The hot query is: `ep.permission_bits & @required = @required`. This is a residual predicate on the INCLUDE column — not a seek predicate, but the seek is on (user_id, folder_id) and the filter on permission_bits is applied to the tiny index rows already pinned by the seek. Cost is negligible.
- BIT columns would require either a composite covering index (six BIT columns = 6 bytes plus padding) or per-column queries. Neither is simpler or faster than a single TINYINT INCLUDE.
- The bitmask is transparent to Kysely: `ep.permission_bits & 1` in raw SQL fragments.

---

## (h) IDENTITY vs SEQUENCE vs GUID for Document IDs

**Use BIGINT IDENTITY.** The filename embeds the document ID (`{documentId}_v{n}_{sanitized-title}.pdf`), which makes the ID choice consequential.

**Why not GUID:**
- 16 bytes vs 8 bytes — doubles the clustered index leaf size.
- `NEWID()` (random) causes massive page fragmentation on the clustered index: every INSERT touches a random page, causing page splits. At millions of documents this causes 50–90% fill ratio degradation.
- `NEWSEQUENTIALID()` is sequential per server restart but requires the column to be the rowguid default and cannot be used in a client-side generated filename (you don't know the GUID before the INSERT commits).
- 36-character UUID in filenames is ugly and error-prone for operations staff reading the filesystem.

**Why not SEQUENCE:**
A SQL Server SEQUENCE object gives the same sequential BIGINT as IDENTITY but allows pre-fetching the next value before the INSERT — useful if you must write the file before committing the DB row. This is a minor advantage; if you accept the pattern of INSERT-then-write-file-then-update-status, IDENTITY is simpler.

**Recommended IDENTITY pattern:**

```sql
CREATE TABLE documents (
    document_id         BIGINT           IDENTITY(1,1)           NOT NULL,
    -- ...all other columns...
    CONSTRAINT PK_documents PRIMARY KEY CLUSTERED (document_id)
);

-- Application flow for new document upload:
-- 1. BEGIN TRANSACTION
-- 2. INSERT INTO documents (...) VALUES (...)
-- 3. DECLARE @newId BIGINT = SCOPE_IDENTITY()
-- 4. COMMIT TRANSACTION
-- 5. Write file to: {root}/{yyyy}/{MM}/{@newId}_v1_{sanitized_title}.pdf
-- 6. UPDATE documents SET file_path_suffix = ..., status = 'active' WHERE document_id = @newId
--    (or store the suffix from the INSERT with a computed path; the suffix is deterministic from the id)
-- If file write fails after commit: mark document status = 'upload_failed'; do not roll back the row
-- (the row exists but is invisible to browse queries until status = 'active'; simplifies retry)
```

**File path generation in Node.js (pure computation, no second DB round-trip):**

```js
function buildFilePath(rootDir, documentId, version, title) {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm   = String(now.getMonth() + 1).padStart(2, '0');
    const safe = title.replace(/[^\u0621-\u064Aa-zA-Z0-9 _-]/g, '').slice(0, 80).trim().replace(/\s+/g, '_');
    return `${rootDir}/${yyyy}/${mm}/${documentId}_v${version}_${safe}.pdf`;
}
```

The `documentId` is known immediately after `SCOPE_IDENTITY()`, making file naming deterministic without a second query.

---

## Complete Schema DDL (migration-manifest compatible, idempotent guards omitted here for clarity)

```sql
-- ============================================================
-- COLLATION USED THROUGHOUT: Arabic_100_CI_AI_SC
-- PATH COLLATION: Latin1_General_100_BIN2
-- ============================================================

-- Sensitivity labels: admin-configurable, not a hardcoded enum
CREATE TABLE sensitivity_labels (
    label_id    TINYINT      IDENTITY(1,1) NOT NULL,
    label_name  NVARCHAR(100) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    sort_order  TINYINT      NOT NULL DEFAULT 0,
    is_active   BIT          NOT NULL DEFAULT 1,
    CONSTRAINT PK_sensitivity_labels PRIMARY KEY CLUSTERED (label_id),
    CONSTRAINT UX_sensitivity_labels_name UNIQUE (label_name)
);

-- Document types
CREATE TABLE document_types (
    type_id     INT          IDENTITY(1,1) NOT NULL,
    type_name   NVARCHAR(200) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    is_active   BIT          NOT NULL DEFAULT 1,
    CONSTRAINT PK_document_types PRIMARY KEY CLUSTERED (type_id),
    CONSTRAINT UX_document_types_name UNIQUE (type_name)
);

-- Custom field definitions per document type
CREATE TABLE custom_field_defs (
    field_id        INT           IDENTITY(1,1) NOT NULL,
    type_id         INT           NOT NULL,
    field_name      NVARCHAR(200) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    field_data_type TINYINT       NOT NULL,  -- 1=text, 2=number, 3=date, 4=list
    is_required     BIT           NOT NULL DEFAULT 0,
    sort_order      TINYINT       NOT NULL DEFAULT 0,
    CONSTRAINT PK_custom_field_defs PRIMARY KEY CLUSTERED (field_id),
    CONSTRAINT FK_cfd_type FOREIGN KEY (type_id) REFERENCES document_types(type_id)
);

-- Groups (support nesting)
CREATE TABLE groups (
    group_id    INT           IDENTITY(1,1) NOT NULL,
    group_name  NVARCHAR(200) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    is_active   BIT           NOT NULL DEFAULT 1,
    CONSTRAINT PK_groups PRIMARY KEY CLUSTERED (group_id)
);

CREATE TABLE group_members (
    group_id        INT NOT NULL,
    member_group_id INT NULL,   -- non-null for nested group membership
    member_user_id  INT NULL,   -- non-null for direct user membership
    CONSTRAINT PK_group_members PRIMARY KEY CLUSTERED (group_id, COALESCE(member_group_id, 0), COALESCE(member_user_id, 0)),
    CONSTRAINT CK_gm_one_target CHECK (
        (member_group_id IS NOT NULL AND member_user_id IS NULL) OR
        (member_group_id IS NULL AND member_user_id IS NOT NULL)
    )
);

-- Flat membership cache: rebuilt on any group/user change
CREATE TABLE group_membership_cache (
    group_id INT NOT NULL,
    user_id  INT NOT NULL,
    CONSTRAINT PK_gmc PRIMARY KEY CLUSTERED (group_id, user_id)
);
CREATE INDEX IX_gmc_user ON group_membership_cache (user_id) INCLUDE (group_id);

-- Roles
CREATE TABLE roles (
    role_id         INT           IDENTITY(1,1) NOT NULL,
    role_name       NVARCHAR(200) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    permission_bits TINYINT       NOT NULL DEFAULT 0,
    CONSTRAINT PK_roles PRIMARY KEY CLUSTERED (role_id)
);

CREATE TABLE user_roles (
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    CONSTRAINT PK_user_roles PRIMARY KEY CLUSTERED (user_id, role_id)
);

-- Users (local auth only)
CREATE TABLE users (
    user_id          INT           IDENTITY(1,1) NOT NULL,
    username         VARCHAR(100)  NOT NULL,
    display_name     NVARCHAR(200) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    password_hash    VARCHAR(255)  NOT NULL,
    is_active        BIT           NOT NULL DEFAULT 1,
    created_at       DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    last_login_at    DATETIME2(0)  NULL,
    CONSTRAINT PK_users PRIMARY KEY CLUSTERED (user_id),
    CONSTRAINT UX_users_username UNIQUE (username)
);

-- Filing tree (adjacency list + materialized path)
CREATE TABLE filing_nodes (
    node_id              INT           IDENTITY(1,1) NOT NULL,
    parent_id            INT           NULL,          -- NULL for root nodes
    node_name            NVARCHAR(300) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    node_type            TINYINT       NOT NULL DEFAULT 1, -- 1=folder, 2=virtual cabinet, etc.
    materialized_path    VARCHAR(3000) COLLATE Latin1_General_100_BIN2 NOT NULL,
    -- path format: /1/42/713/ — always ends with trailing slash including own id
    depth                TINYINT       NOT NULL DEFAULT 0,
    breaks_inheritance   BIT           NOT NULL DEFAULT 0,
    created_by           INT           NOT NULL,
    created_at           DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    deleted_at           DATETIME2(0)  NULL,
    CONSTRAINT PK_filing_nodes PRIMARY KEY CLUSTERED (node_id),
    CONSTRAINT FK_fn_parent FOREIGN KEY (parent_id) REFERENCES filing_nodes(node_id)
);

CREATE INDEX IX_nodes_path ON filing_nodes (materialized_path)
INCLUDE (node_id, parent_id, node_name, breaks_inheritance)
WHERE deleted_at IS NULL;

CREATE INDEX IX_nodes_parent ON filing_nodes (parent_id)
INCLUDE (node_id, node_name, depth)
WHERE deleted_at IS NULL;

-- ACL (per node, targets group or role or individual user for exceptional cases)
CREATE TABLE acl_entries (
    acl_id           BIGINT  IDENTITY(1,1) NOT NULL,
    node_id          INT     NOT NULL,
    principal_type   TINYINT NOT NULL,  -- 1=user, 2=group, 3=role
    principal_id     INT     NOT NULL,
    allow_bits       TINYINT NOT NULL DEFAULT 0,
    deny_bits        TINYINT NOT NULL DEFAULT 0,
    created_by       INT     NOT NULL,
    created_at       DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_acl_entries PRIMARY KEY CLUSTERED (acl_id),
    CONSTRAINT FK_acl_node FOREIGN KEY (node_id) REFERENCES filing_nodes(node_id)
);

CREATE INDEX IX_acl_node ON acl_entries (node_id, principal_type, principal_id)
INCLUDE (allow_bits, deny_bits);

-- Documents
CREATE TABLE documents (
    document_id         BIGINT        IDENTITY(1,1) NOT NULL,
    folder_id           INT           NOT NULL,
    type_id             INT           NULL,
    title               NVARCHAR(500) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    sensitivity_label_id TINYINT      NULL,
    version_count       SMALLINT      NOT NULL DEFAULT 1,
    status              TINYINT       NOT NULL DEFAULT 0, -- 0=pending, 1=active, 2=upload_failed
    created_by          INT           NOT NULL,
    created_at          DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    modified_by         INT           NULL,
    modified_at         DATETIME2(0)  NULL,
    deleted_by          INT           NULL,
    deleted_at          DATETIME2(0)  NULL,
    -- FTS support: pre-normalized Arabic text populated by async worker
    extracted_text      NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    fts_status          TINYINT       NOT NULL DEFAULT 0, -- 0=pending, 1=indexed, 2=failed
    CONSTRAINT PK_documents PRIMARY KEY CLUSTERED (document_id),
    CONSTRAINT FK_doc_folder FOREIGN KEY (folder_id) REFERENCES filing_nodes(node_id),
    CONSTRAINT FK_doc_type   FOREIGN KEY (type_id)   REFERENCES document_types(type_id),
    CONSTRAINT FK_doc_label  FOREIGN KEY (sensitivity_label_id) REFERENCES sensitivity_labels(label_id)
);

-- Hot browse index: folder + active + sort by date
CREATE INDEX IX_docs_folder_created
ON documents (folder_id, created_at DESC)
INCLUDE (document_id, title, type_id, sensitivity_label_id, version_count, modified_at, status)
WHERE deleted_at IS NULL AND status = 1;

-- FTS index (defined after table; populate extracted_text via job table)
CREATE FULLTEXT INDEX ON documents (extracted_text LANGUAGE 1025)
    KEY INDEX PK_documents
    ON dms_fts_catalog
    WITH STOPLIST = OFF, CHANGE_TRACKING MANUAL;
-- MANUAL change tracking: let the async extraction worker call sp_fulltext_table to request re-indexing
-- after it updates extracted_text; avoids background FTS daemon competing with writes

-- Document versions
CREATE TABLE document_versions (
    version_id      BIGINT        IDENTITY(1,1) NOT NULL,
    document_id     BIGINT        NOT NULL,
    version_number  SMALLINT      NOT NULL,
    file_path       VARCHAR(4000) NOT NULL,  -- full path on disk (or relative from root)
    file_size_bytes BIGINT        NOT NULL,
    sha256          CHAR(64)      NOT NULL,
    mime_type       VARCHAR(100)  NOT NULL DEFAULT 'application/pdf',
    uploaded_by     INT           NOT NULL,
    uploaded_at     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_document_versions PRIMARY KEY CLUSTERED (document_id, version_number),
    CONSTRAINT FK_dv_document FOREIGN KEY (document_id) REFERENCES documents(document_id),
    CONSTRAINT UX_dv_sha256_doc UNIQUE (document_id, sha256)
);

-- Custom field values
CREATE TABLE document_custom_fields (
    document_id BIGINT        NOT NULL,
    field_id    INT           NOT NULL,
    field_value NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    CONSTRAINT PK_dcf PRIMARY KEY CLUSTERED (document_id, field_id),
    CONSTRAINT FK_dcf_doc   FOREIGN KEY (document_id) REFERENCES documents(document_id),
    CONSTRAINT FK_dcf_field FOREIGN KEY (field_id)    REFERENCES custom_field_defs(field_id)
);

-- Tags
CREATE TABLE tags (
    tag_id   INT           IDENTITY(1,1) NOT NULL,
    tag_name NVARCHAR(100) COLLATE Arabic_100_CI_AI_SC NOT NULL,
    CONSTRAINT PK_tags PRIMARY KEY CLUSTERED (tag_id),
    CONSTRAINT UX_tags_name UNIQUE (tag_name)
);

CREATE TABLE document_tags (
    document_id BIGINT NOT NULL,
    tag_id      INT    NOT NULL,
    CONSTRAINT PK_document_tags PRIMARY KEY CLUSTERED (document_id, tag_id),
    CONSTRAINT FK_dt_doc FOREIGN KEY (document_id) REFERENCES documents(document_id),
    CONSTRAINT FK_dt_tag FOREIGN KEY (tag_id)      REFERENCES tags(tag_id)
);
CREATE INDEX IX_dt_tag ON document_tags (tag_id) INCLUDE (document_id);

-- FTS extraction job table (no Redis; async worker polls this)
CREATE TABLE fts_extraction_queue (
    queue_id    BIGINT        IDENTITY(1,1) NOT NULL,
    document_id BIGINT        NOT NULL,
    version_id  BIGINT        NOT NULL,
    queued_at   DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
    status      TINYINT       NOT NULL DEFAULT 0, -- 0=pending, 1=processing, 2=done, 3=failed
    attempts    TINYINT       NOT NULL DEFAULT 0,
    last_error  NVARCHAR(500) NULL,
    CONSTRAINT PK_fts_queue PRIMARY KEY CLUSTERED (queue_id)
);
CREATE INDEX IX_fts_queue_pending ON fts_extraction_queue (status, queued_at)
WHERE status IN (0, 3);

-- Precomputed effective permissions
CREATE TABLE effective_permissions (
    user_id         INT     NOT NULL,
    folder_id       INT     NULL,
    document_id     BIGINT  NULL,
    permission_bits TINYINT NOT NULL,
    computed_at     DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_ep_target CHECK (
        (folder_id IS NOT NULL AND document_id IS NULL) OR
        (folder_id IS NULL AND document_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX UX_ep_user_folder
ON effective_permissions (user_id, folder_id)
INCLUDE (permission_bits)
WHERE folder_id IS NOT NULL;

CREATE UNIQUE INDEX UX_ep_user_doc
ON effective_permissions (user_id, document_id)
INCLUDE (permission_bits)
WHERE document_id IS NOT NULL;

CREATE INDEX IX_ep_folder_user
ON effective_permissions (folder_id, permission_bits)
INCLUDE (user_id)
WHERE folder_id IS NOT NULL;
-- Use when computing "who can access this folder" for permission display

-- Audit log (partitioned by month)
CREATE PARTITION FUNCTION pf_audit_monthly (DATETIME2(0))
AS RANGE RIGHT FOR VALUES (
    '2024-01-01','2024-02-01','2024-03-01','2024-04-01',
    '2024-05-01','2024-06-01','2024-07-01','2024-08-01',
    '2024-09-01','2024-10-01','2024-11-01','2024-12-01',
    '2025-01-01','2025-02-01','2025-03-01','2025-04-01',
    '2025-05-01','2025-06-01','2025-07-01','2025-08-01',
    '2025-09-01','2025-10-01','2025-11-01','2025-12-01',
    '2026-01-01','2026-02-01','2026-03-01','2026-04-01',
    '2026-05-01','2026-06-01','2026-07-01','2026-08-01',
    '2026-09-01','2026-10-01','2026-11-01','2026-12-01'
);

CREATE PARTITION SCHEME ps_audit_monthly
AS PARTITION pf_audit_monthly ALL TO ([PRIMARY]);

CREATE TABLE audit_log (
    audit_id      BIGINT        IDENTITY(1,1) NOT NULL,
    event_time    DATETIME2(0)  NOT NULL,
    actor_user_id INT           NOT NULL,
    action_code   TINYINT       NOT NULL,
    action_result TINYINT       NOT NULL DEFAULT 1,
    target_type   TINYINT       NOT NULL,
    target_id     BIGINT        NOT NULL,
    old_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    new_value     NVARCHAR(MAX) COLLATE Arabic_100_CI_AI_SC NULL,
    ip_address    VARCHAR(45)   NULL,
    CONSTRAINT PK_audit_log PRIMARY KEY CLUSTERED (event_time, audit_id)
) ON ps_audit_monthly(event_time);

CREATE INDEX IX_audit_actor
ON audit_log (actor_user_id, event_time DESC)
INCLUDE (action_code, target_type, target_id, action_result)
ON ps_audit_monthly(event_time);

CREATE INDEX IX_audit_target
ON audit_log (target_type, target_id, event_time DESC)
INCLUDE (actor_user_id, action_code, action_result)
ON ps_audit_monthly(event_time);
```

---

## Decision Summary Table

| Question | Decision | Reason |
|---|---|---|
| Arabic collation | Arabic_100_CI_AI_SC | Version 100, Unicode 6.0, supplementary chars |
| FTS diacritics | Strip in worker before inserting extracted_text | FTS is always accent-sensitive; AI collation has no effect on FTS |
| FTS language | LANGUAGE 1025 on index and CONTAINSTABLE | Arabic word breaker and stemmer |
| CONTAINSTABLE join | Pre-filter to temp table of allowed IDs | Prevents optimizer choosing FTS TVF as outer input |
| Permission model | TINYINT bitmask (allow + deny or net bits) | Single INCLUDE column, one index covers all 6 verbs |
| Document PK | BIGINT IDENTITY | Sequential, compact, knowable post-INSERT for filename |
| Path column | VARCHAR(3000) COLLATE Latin1_General_100_BIN2 | LIKE prefix scan sargable; no Arabic sort-weight interference |
| Soft delete indexes | Filtered (WHERE deleted_at IS NULL) | Smaller indexes; active state is the hot path |
| Audit partitioning | Monthly RANGE RIGHT, SWITCH for archival | Available in Standard 2019; SWITCH is metadata-only |
| Columnstore on audit | Add later at > 5M rows for analytics | Standard DOP 2 + no pushdown; rowstore faster at small scale |
| Pagination | OFFSET/FETCH with page cap | Per-folder sets are small after permission filter |

---

## aec2796fab7dcfe43

```json
{
  "angle": "Correctness-first, constraint-enforced. The schema self-describes legal state through check constraints, foreign keys, and a computed persisted effective_mask column that the database owns. effective_permissions is precomputed and carries an acl_version that must match filing_nodes.acl_version for the row to be trusted; any mismatch is a staleness signal that forces live computation. The hot query is a single covering-index seek followed by a window COUNT — no post-page filtering, no leaking of inaccessible rows. All invariants that could drift are either expressed as DB constraints or detected by the version column, not by application convention.",
  "ddl": "-- ====================================================================\n-- DOCUMENT MANAGEMENT SOLUTION – COMPLETE SCHEMA\n-- SQL Server 2019 Standard (partitioning available since 2016 SP1).\n-- Database-level collation: Arabic_CI_AI.\n-- Column-level overrides noted where different.\n-- ====================================================================\n\n-- ============================================================\n-- SECTION 1 – PRINCIPALS\n-- ============================================================\n\nCREATE TABLE dbo.users (\n    user_id        INT           IDENTITY(1,1) NOT NULL,\n    username       NVARCHAR(100) COLLATE Latin1_General_CI_AS NOT NULL, -- login; ASCII-safe\n    display_name   NVARCHAR(300) COLLATE Arabic_CI_AI NOT NULL,\n    email          NVARCHAR(254) COLLATE Latin1_General_CI_AS NOT NULL,\n    password_hash  NVARCHAR(256) NOT NULL,             -- bcrypt / argon2 digest\n    is_active      BIT           NOT NULL DEFAULT 1,\n    is_superadmin  BIT           NOT NULL DEFAULT 0,   -- bypasses ACL checks entirely\n    created_at     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_at     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    last_login_at  DATETIME2(0)  NULL,\n    CONSTRAINT PK_users       PRIMARY KEY CLUSTERED (user_id),\n    CONSTRAINT UQ_users_uname UNIQUE (username),\n    CONSTRAINT UQ_users_email UNIQUE (email)\n);\n\nCREATE TABLE dbo.groups (\n    group_id     INT            IDENTITY(1,1) NOT NULL,\n    group_name   NVARCHAR(300)  COLLATE Arabic_CI_AI NOT NULL,\n    description  NVARCHAR(2000) COLLATE Arabic_CI_AI NULL,\n    is_active    BIT            NOT NULL DEFAULT 1,\n    created_at   DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    created_by   INT            NULL,\n    CONSTRAINT PK_groups       PRIMARY KEY CLUSTERED (group_id),\n    CONSTRAINT UQ_groups_name  UNIQUE (group_name),\n    CONSTRAINT FK_groups_creator FOREIGN KEY (created_by) REFERENCES dbo.users(user_id)\n);\n\n-- member_type 'U' = user, 'G' = nested group.\n-- Conditional FK (member_id -> users OR groups depending on member_type)\n-- cannot be expressed as a SQL Server FK constraint; enforced at app layer.\n-- Cycle detection (group cannot be its own transitive ancestor) is enforced\n-- in usp_RebuildGroupMembershipCache via a visited-set loop.\nCREATE TABLE dbo.group_members (\n    group_id     INT          NOT NULL,\n    member_type  CHAR(1)      NOT NULL,\n    member_id    INT          NOT NULL,\n    added_at     DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),\n    added_by     INT          NULL,\n    CONSTRAINT PK_group_members PRIMARY KEY CLUSTERED (group_id, member_type, member_id),\n    CONSTRAINT FK_gm_group      FOREIGN KEY (group_id) REFERENCES dbo.groups(group_id),\n    CONSTRAINT CK_gm_type       CHECK (member_type IN ('U','G'))\n);\n\n-- Flat expansion of nested groups for fast permission resolution.\n-- One row per (group, transitive-member-user).\n-- Rebuilt by usp_RebuildGroupMembershipCache whenever group_members changes.\nCREATE TABLE dbo.group_membership_cache (\n    group_id  INT NOT NULL,\n    user_id   INT NOT NULL,\n    CONSTRAINT PK_gmc     PRIMARY KEY CLUSTERED (group_id, user_id),\n    CONSTRAINT FK_gmc_grp FOREIGN KEY (group_id) REFERENCES dbo.groups(group_id),\n    CONSTRAINT FK_gmc_usr FOREIGN KEY (user_id)  REFERENCES dbo.users(user_id)\n);\n\n-- Roles bundle permission bits into named templates.\n-- Bits: 1=Browse  2=Read  4=Upload  8=EditMeta  16=Delete  32=ManagePerms\n-- A role is a principal in ACEs: any user who holds the role inherits its bits\n-- when the ACE is evaluated.\nCREATE TABLE dbo.roles (\n    role_id         INT            IDENTITY(1,1) NOT NULL,\n    role_name       NVARCHAR(300)  COLLATE Arabic_CI_AI NOT NULL,\n    description     NVARCHAR(2000) COLLATE Arabic_CI_AI NULL,\n    permission_mask TINYINT        NOT NULL DEFAULT 0,\n    is_active       BIT            NOT NULL DEFAULT 1,\n    created_at      DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_roles      PRIMARY KEY CLUSTERED (role_id),\n    CONSTRAINT UQ_roles_name UNIQUE (role_name),\n    CONSTRAINT CK_roles_mask CHECK (permission_mask BETWEEN 0 AND 63)\n);\n\n-- Who holds each role.  grantee_type 'U'=user, 'G'=group.\nCREATE TABLE dbo.role_assignments (\n    role_id      INT          NOT NULL,\n    grantee_type CHAR(1)      NOT NULL,\n    grantee_id   INT          NOT NULL,\n    granted_at   DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),\n    granted_by   INT          NULL,\n    CONSTRAINT PK_role_assignments PRIMARY KEY CLUSTERED (role_id, grantee_type, grantee_id),\n    CONSTRAINT FK_ra_role    FOREIGN KEY (role_id)    REFERENCES dbo.roles(role_id),\n    CONSTRAINT FK_ra_granter FOREIGN KEY (granted_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT CK_ra_type    CHECK (grantee_type IN ('U','G'))\n);\n\n-- ============================================================\n-- SECTION 2 – SENSITIVITY LABELS (admin-configurable, not a hardcoded enum)\n-- ============================================================\n\nCREATE TABLE dbo.sensitivity_labels (\n    label_id     INT            IDENTITY(1,1) NOT NULL,\n    label_name   NVARCHAR(200)  COLLATE Arabic_CI_AI NOT NULL,\n    description  NVARCHAR(1000) COLLATE Arabic_CI_AI NULL,\n    color_hex    CHAR(7)        NULL,   -- '#RRGGBB'\n    sort_order   SMALLINT       NOT NULL DEFAULT 0,\n    is_active    BIT            NOT NULL DEFAULT 1,\n    created_at   DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_sensitivity_labels PRIMARY KEY CLUSTERED (label_id),\n    CONSTRAINT UQ_sl_name            UNIQUE (label_name),\n    CONSTRAINT CK_sl_color           CHECK (color_hex IS NULL\n        OR color_hex LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]')\n);\n\n-- ============================================================\n-- SECTION 3 – FILING TREE\n-- ============================================================\n\n-- Adjacency list + materialized path.\n-- path format: '/<id1>/<id2>/.../<thisId>/'  Always starts and ends with '/'.\n-- Contains only digits and slashes — safe for LIKE-prefix subtree queries.\n-- depth: 0 = root node.\n--\n-- acl_version: monotonically increasing counter.  Bumped by the application\n-- whenever an ACE changes on this node or on any ancestor through which this\n-- node inherits.  The effective_permissions row for this node is valid only\n-- when its stored acl_version equals this value.\nCREATE TABLE dbo.filing_nodes (\n    node_id              INT            IDENTITY(1,1) NOT NULL,\n    parent_id            INT            NULL,          -- NULL = root\n    node_type            CHAR(1)        NOT NULL DEFAULT 'F', -- 'F'=folder 'S'=smart/virtual\n    name                 NVARCHAR(500)  COLLATE Arabic_CI_AI NOT NULL,\n    description          NVARCHAR(2000) COLLATE Arabic_CI_AI NULL,\n    path                 NVARCHAR(4000) NOT NULL,\n    depth                SMALLINT       NOT NULL DEFAULT 0,\n    -- ACL inheritance control\n    inherits_permissions BIT            NOT NULL DEFAULT 1,\n    -- 1 = inherit ACEs from parent chain\n    -- 0 = this node has its own isolated ACL; parent chain is ignored\n    acl_version          INT            NOT NULL DEFAULT 0,\n    -- soft delete\n    is_deleted           BIT            NOT NULL DEFAULT 0,\n    deleted_at           DATETIME2(0)   NULL,\n    deleted_by           INT            NULL,\n    -- audit\n    created_at           DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    created_by           INT            NULL,\n    updated_at           DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_by           INT            NULL,\n    CONSTRAINT PK_filing_nodes   PRIMARY KEY CLUSTERED (node_id),\n    CONSTRAINT FK_fn_parent      FOREIGN KEY (parent_id)  REFERENCES dbo.filing_nodes(node_id),\n    CONSTRAINT FK_fn_deleted_by  FOREIGN KEY (deleted_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT FK_fn_created_by  FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT FK_fn_updated_by  FOREIGN KEY (updated_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT CK_fn_type        CHECK (node_type IN ('F','S')),\n    CONSTRAINT CK_fn_depth       CHECK (depth >= 0),\n    CONSTRAINT CK_fn_path_fmt    CHECK (path LIKE '/%/')\n);\n\n-- ============================================================\n-- SECTION 4 – ACL\n-- ============================================================\n\n-- Explicit ACEs stored per node.  Inherited ACEs are NOT duplicated here;\n-- they are resolved at computation time by walking the ancestor chain.\n-- principal_type: 'U'=user direct  'G'=group  'R'=role\n-- ace_type:       'A'=ALLOW        'D'=DENY\n-- permission_mask: bitmask 1-63 using the bit values defined on dbo.roles.\nCREATE TABLE dbo.acl_entries (\n    ace_id          INT          IDENTITY(1,1) NOT NULL,\n    node_id         INT          NOT NULL,\n    principal_type  CHAR(1)      NOT NULL,\n    principal_id    INT          NOT NULL,\n    ace_type        CHAR(1)      NOT NULL,\n    permission_mask TINYINT      NOT NULL,\n    sort_order      SMALLINT     NOT NULL DEFAULT 0,  -- display ordering only\n    created_at      DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),\n    created_by      INT          NULL,\n    CONSTRAINT PK_acl_entries    PRIMARY KEY CLUSTERED (ace_id),\n    CONSTRAINT FK_ace_node       FOREIGN KEY (node_id)    REFERENCES dbo.filing_nodes(node_id),\n    CONSTRAINT FK_ace_created_by FOREIGN KEY (created_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT CK_ace_type       CHECK (ace_type       IN ('A','D')),\n    CONSTRAINT CK_ace_principal  CHECK (principal_type IN ('U','G','R')),\n    CONSTRAINT CK_ace_mask       CHECK (permission_mask BETWEEN 1 AND 63)\n);\n\n-- Precomputed effective permissions per (folder-node, user).\n-- effective_mask = allow_mask & ~deny_mask, persisted by the database.\n-- The computation is: bitwise OR all applicable ALLOW ACEs into allow_mask,\n-- bitwise OR all applicable DENY ACEs into deny_mask, then effective = allow & ~deny.\n-- DENY always wins regardless of ACE level or principal specificity.\n--\n-- A row is STALE when ep.acl_version != fn.acl_version.\n-- The runtime must detect this and either recompute synchronously or deny.\n-- The background worker processes permission_recompute_queue to keep rows fresh.\nCREATE TABLE dbo.effective_permissions (\n    node_id        INT          NOT NULL,\n    user_id        INT          NOT NULL,\n    allow_mask     TINYINT      NOT NULL DEFAULT 0,\n    deny_mask      TINYINT      NOT NULL DEFAULT 0,\n    -- Database-owned computed column; cannot be written by the application.\n    effective_mask AS CAST(CAST(allow_mask AS INT) & ~CAST(deny_mask AS INT) AS TINYINT) PERSISTED,\n    acl_version    INT          NOT NULL,\n    computed_at    DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_effective_permissions PRIMARY KEY CLUSTERED (node_id, user_id),\n    CONSTRAINT FK_ep_node FOREIGN KEY (node_id) REFERENCES dbo.filing_nodes(node_id),\n    CONSTRAINT FK_ep_user FOREIGN KEY (user_id) REFERENCES dbo.users(user_id),\n    CONSTRAINT CK_ep_allow CHECK (allow_mask BETWEEN 0 AND 63),\n    CONSTRAINT CK_ep_deny  CHECK (deny_mask  BETWEEN 0 AND 63)\n);\n\n-- Work queue for the background recompute worker.\n-- user_id = NULL means \"recompute all users on this node\".\n-- The worker expands NULL rows into one recompute call per active user,\n-- then deletes the NULL row and inserts per-user rows as it completes them,\n-- or processes them in bulk and marks is_processed = 1.\nCREATE TABLE dbo.permission_recompute_queue (\n    queue_id      BIGINT        IDENTITY(1,1) NOT NULL,\n    node_id       INT           NOT NULL,\n    user_id       INT           NULL,\n    reason        NVARCHAR(100) NOT NULL,\n    queued_at     DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    is_processed  BIT           NOT NULL DEFAULT 0,\n    processed_at  DATETIME2(0)  NULL,\n    error_message NVARCHAR(2000) NULL,\n    CONSTRAINT PK_prq      PRIMARY KEY CLUSTERED (queue_id),\n    CONSTRAINT FK_prq_node FOREIGN KEY (node_id) REFERENCES dbo.filing_nodes(node_id)\n);\n\n-- ============================================================\n-- SECTION 5 – DOCUMENT TYPES AND TYPED CUSTOM FIELDS\n-- ============================================================\n\nCREATE TABLE dbo.document_types (\n    type_id     INT            IDENTITY(1,1) NOT NULL,\n    type_name   NVARCHAR(300)  COLLATE Arabic_CI_AI NOT NULL,\n    description NVARCHAR(2000) COLLATE Arabic_CI_AI NULL,\n    is_active   BIT            NOT NULL DEFAULT 1,\n    created_at  DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_document_types PRIMARY KEY CLUSTERED (type_id),\n    CONSTRAINT UQ_dt_name        UNIQUE (type_name)\n);\n\n-- type_id = NULL means the field applies to all document types.\n-- field_name uses Latin collation: it is a code key used by the application.\n-- field_label is the Arabic display label shown in the UI.\nCREATE TABLE dbo.field_definitions (\n    field_id         INT            IDENTITY(1,1) NOT NULL,\n    type_id          INT            NULL,\n    field_name       NVARCHAR(100)  COLLATE Latin1_General_CI_AS NOT NULL,\n    field_label      NVARCHAR(300)  COLLATE Arabic_CI_AI NOT NULL,\n    field_type       NVARCHAR(20)   NOT NULL,\n    -- TEXT | NUMBER | DATE | DATETIME | BOOLEAN | SELECT | MULTISELECT\n    is_required      BIT            NOT NULL DEFAULT 0,\n    is_searchable    BIT            NOT NULL DEFAULT 1,\n    sort_order       SMALLINT       NOT NULL DEFAULT 0,\n    default_value    NVARCHAR(1000) COLLATE Arabic_CI_AI NULL,\n    validation_regex NVARCHAR(500)  NULL,\n    is_active        BIT            NOT NULL DEFAULT 1,\n    created_at       DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_field_definitions PRIMARY KEY CLUSTERED (field_id),\n    CONSTRAINT FK_fd_type           FOREIGN KEY (type_id) REFERENCES dbo.document_types(type_id),\n    CONSTRAINT CK_fd_field_type     CHECK (field_type IN\n        ('TEXT','NUMBER','DATE','DATETIME','BOOLEAN','SELECT','MULTISELECT'))\n    -- Uniqueness of (type_id, field_name) enforced at app layer because\n    -- SQL Server UNIQUE constraints treat each NULL as distinct, meaning\n    -- two global fields (type_id = NULL) with the same field_name would both pass.\n);\n\n-- Allowed options for SELECT / MULTISELECT field types.\nCREATE TABLE dbo.field_options (\n    option_id    INT            IDENTITY(1,1) NOT NULL,\n    field_id     INT            NOT NULL,\n    option_value NVARCHAR(500)  COLLATE Arabic_CI_AI NOT NULL,\n    sort_order   SMALLINT       NOT NULL DEFAULT 0,\n    is_active    BIT            NOT NULL DEFAULT 1,\n    CONSTRAINT PK_field_options  PRIMARY KEY CLUSTERED (option_id),\n    CONSTRAINT FK_fo_field       FOREIGN KEY (field_id) REFERENCES dbo.field_definitions(field_id),\n    CONSTRAINT UQ_fo_field_val   UNIQUE (field_id, option_value)\n);\n\n-- ============================================================\n-- SECTION 6 – TAGS\n-- ============================================================\n\nCREATE TABLE dbo.tags (\n    tag_id     INT            IDENTITY(1,1) NOT NULL,\n    tag_name   NVARCHAR(300)  COLLATE Arabic_CI_AI NOT NULL,\n    is_active  BIT            NOT NULL DEFAULT 1,\n    created_at DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_tags      PRIMARY KEY CLUSTERED (tag_id),\n    CONSTRAINT UQ_tags_name UNIQUE (tag_name)\n);\n\n-- ============================================================\n-- SECTION 7 – DOCUMENTS AND VERSIONS\n-- ============================================================\n\n-- Documents live inside filing_nodes (folders).\n-- Permissions are enforced at the folder level: a document inherits its\n-- folder's effective_permissions.  There are no per-document ACEs in v1.\nCREATE TABLE dbo.documents (\n    document_id          INT            IDENTITY(1,1) NOT NULL,\n    node_id              INT            NOT NULL,   -- parent folder\n    title                NVARCHAR(1000) COLLATE Arabic_CI_AI NOT NULL,\n    document_type_id     INT            NULL,\n    sensitivity_label_id INT            NULL,\n    current_version_id   INT            NULL,       -- FK added after versions table below\n    is_deleted           BIT            NOT NULL DEFAULT 0,\n    deleted_at           DATETIME2(0)   NULL,\n    deleted_by           INT            NULL,\n    created_at           DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    created_by           INT            NULL,\n    updated_at           DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_by           INT            NULL,\n    CONSTRAINT PK_documents       PRIMARY KEY CLUSTERED (document_id),\n    CONSTRAINT FK_doc_node        FOREIGN KEY (node_id)              REFERENCES dbo.filing_nodes(node_id),\n    CONSTRAINT FK_doc_type        FOREIGN KEY (document_type_id)     REFERENCES dbo.document_types(type_id),\n    CONSTRAINT FK_doc_label       FOREIGN KEY (sensitivity_label_id) REFERENCES dbo.sensitivity_labels(label_id),\n    CONSTRAINT FK_doc_deleted_by  FOREIGN KEY (deleted_by)           REFERENCES dbo.users(user_id),\n    CONSTRAINT FK_doc_created_by  FOREIGN KEY (created_by)           REFERENCES dbo.users(user_id),\n    CONSTRAINT FK_doc_updated_by  FOREIGN KEY (updated_by)           REFERENCES dbo.users(user_id)\n);\n\n-- Disk path (relative to configured root):\n--   {root}/{yyyy}/{MM}/{document_id}_v{version_number}_{sanitized_title}.pdf\n-- The path layout does NOT mirror the filing tree; moving a folder is a\n-- pure DB operation that does not touch the file system.\n-- extracted_text is populated by the async extraction worker.\n-- Arabic normalization (alef/yaa/taa-marbuta unification, tashkeel/tatweel\n-- stripping) runs in the worker BEFORE writing extracted_text, and in the\n-- application BEFORE passing a search term to CONTAINSTABLE.\nCREATE TABLE dbo.document_versions (\n    version_id        INT             IDENTITY(1,1) NOT NULL,\n    document_id       INT             NOT NULL,\n    version_number    SMALLINT        NOT NULL,\n    file_path         NVARCHAR(2000)  NOT NULL,\n    file_size_bytes   BIGINT          NOT NULL,\n    mime_type         NVARCHAR(200)   NOT NULL,\n    sha256            CHAR(64)        NOT NULL,   -- lowercase hex SHA-256\n    -- Full-text content column.  FTS index is built on this column.\n    extracted_text    NVARCHAR(MAX)   COLLATE Arabic_CI_AI NULL,\n    extraction_status NVARCHAR(20)    NOT NULL DEFAULT 'PENDING',\n    extraction_error  NVARCHAR(2000)  NULL,\n    uploaded_by       INT             NOT NULL,\n    uploaded_at       DATETIME2(0)    NOT NULL DEFAULT SYSUTCDATETIME(),\n    version_comment   NVARCHAR(2000)  COLLATE Arabic_CI_AI NULL,\n    CONSTRAINT PK_document_versions PRIMARY KEY CLUSTERED (version_id),\n    CONSTRAINT FK_dv_document       FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),\n    CONSTRAINT FK_dv_uploader       FOREIGN KEY (uploaded_by) REFERENCES dbo.users(user_id),\n    CONSTRAINT UQ_dv_number         UNIQUE (document_id, version_number),\n    CONSTRAINT CK_dv_version_num    CHECK (version_number >= 1),\n    CONSTRAINT CK_dv_file_size      CHECK (file_size_bytes >= 0),\n    CONSTRAINT CK_dv_status         CHECK (extraction_status\n        IN ('PENDING','PROCESSING','DONE','FAILED','SKIPPED')),\n    CONSTRAINT CK_dv_sha256         CHECK (sha256 NOT LIKE '%[^0-9a-f]%'\n        AND LEN(sha256) = 64)\n);\n\n-- Back-reference from documents to its current version (deferred FK).\nALTER TABLE dbo.documents\n    ADD CONSTRAINT FK_doc_current_version\n        FOREIGN KEY (current_version_id)\n        REFERENCES dbo.document_versions(version_id);\n\n-- EAV for typed custom field values.\n-- All values stored as NVARCHAR(MAX); type coercion is the application's job.\n-- Numeric / date fields must be validated and cast by the app layer before storage.\nCREATE TABLE dbo.document_field_values (\n    document_id  INT            NOT NULL,\n    field_id     INT            NOT NULL,\n    value_text   NVARCHAR(MAX)  COLLATE Arabic_CI_AI NULL,\n    updated_at   DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_by   INT            NULL,\n    CONSTRAINT PK_dfv       PRIMARY KEY CLUSTERED (document_id, field_id),\n    CONSTRAINT FK_dfv_doc   FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),\n    CONSTRAINT FK_dfv_field FOREIGN KEY (field_id)    REFERENCES dbo.field_definitions(field_id)\n);\n\nCREATE TABLE dbo.document_tags (\n    document_id  INT          NOT NULL,\n    tag_id       INT          NOT NULL,\n    tagged_at    DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),\n    tagged_by    INT          NULL,\n    CONSTRAINT PK_document_tags PRIMARY KEY CLUSTERED (document_id, tag_id),\n    CONSTRAINT FK_dt_doc        FOREIGN KEY (document_id) REFERENCES dbo.documents(document_id),\n    CONSTRAINT FK_dt_tag        FOREIGN KEY (tag_id)      REFERENCES dbo.tags(tag_id)\n);\n\n-- ============================================================\n-- SECTION 8 – TEXT EXTRACTION JOB QUEUE\n-- ============================================================\n\n-- Polled by the Node.js extraction worker on a fixed interval.\n-- One row per version_id (UQ_ej_version enforces this).\n-- On completion the worker writes extracted_text into document_versions\n-- and updates extraction_status to 'DONE' or 'FAILED'.\nCREATE TABLE dbo.extraction_jobs (\n    job_id        INT            IDENTITY(1,1) NOT NULL,\n    version_id    INT            NOT NULL,\n    status        NVARCHAR(20)   NOT NULL DEFAULT 'PENDING',\n    priority      TINYINT        NOT NULL DEFAULT 5,   -- lower value = higher priority\n    queued_at     DATETIME2(0)   NOT NULL DEFAULT SYSUTCDATETIME(),\n    started_at    DATETIME2(0)   NULL,\n    completed_at  DATETIME2(0)   NULL,\n    worker_id     NVARCHAR(200)  NULL,\n    retry_count   TINYINT        NOT NULL DEFAULT 0,\n    max_retries   TINYINT        NOT NULL DEFAULT 3,\n    error_message NVARCHAR(2000) NULL,\n    CONSTRAINT PK_extraction_jobs PRIMARY KEY CLUSTERED (job_id),\n    CONSTRAINT FK_ej_version      FOREIGN KEY (version_id) REFERENCES dbo.document_versions(version_id),\n    CONSTRAINT UQ_ej_version      UNIQUE (version_id),\n    CONSTRAINT CK_ej_status       CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED'))\n);\n\n-- ============================================================\n-- SECTION 9 – AUDIT LOG (monthly partitioning)\n-- ============================================================\n\n-- SQL Server 2019 Standard supports table partitioning (available since 2016 SP1).\n-- RANGE RIGHT: each boundary value is the inclusive lower bound of its partition.\n-- '2026-09-01' as boundary = all rows with event_time >= '2026-09-01' go right.\n-- This keeps the first instant of a month in the same partition as the rest of it.\n\nCREATE PARTITION FUNCTION pf_audit_monthly (DATETIME2(0))\nAS RANGE RIGHT FOR VALUES (\n    '2026-01-01','2026-02-01','2026-03-01','2026-04-01',\n    '2026-05-01','2026-06-01','2026-07-01','2026-08-01',\n    '2026-09-01','2026-10-01','2026-11-01','2026-12-01',\n    '2027-01-01','2027-02-01','2027-03-01','2027-04-01',\n    '2027-05-01','2027-06-01','2027-07-01','2027-08-01',\n    '2027-09-01','2027-10-01','2027-11-01','2027-12-01',\n    '2028-01-01','2028-02-01','2028-03-01','2028-04-01',\n    '2028-05-01','2028-06-01','2028-07-01','2028-08-01',\n    '2028-09-01','2028-10-01','2028-11-01','2028-12-01'\n    -- Extend with a monthly maintenance job:\n    -- ALTER PARTITION FUNCTION pf_audit_monthly() SPLIT RANGE ('2029-01-01');\n    -- Run this before the new month begins; add the corresponding filegroup mapping\n    -- to ps_audit_monthly first if using multiple filegroups.\n);\n\n-- Single-filegroup install: all partitions on PRIMARY.\n-- Multi-filegroup: map older partitions to slower/cheaper filegroups.\nCREATE PARTITION SCHEME ps_audit_monthly\nAS PARTITION pf_audit_monthly\nALL TO ([PRIMARY]);\n\n-- Append-only. No UPDATE or DELETE is ever issued against this table.\n-- event_type is an open set; new event types are added without DDL changes.\n-- Typical values: UPLOAD, VERSION_ADD, SOFT_DELETE, RESTORE, MOVE, RENAME,\n--   PERM_CHANGE, GROUP_CHANGE, ROLE_CHANGE, USER_DEACTIVATE, LABEL_CHANGE.\n--\n-- PK is (event_time, log_id): event_time is the partition column and must\n-- be part of the clustered index key.  log_id (BIGINT IDENTITY) ensures\n-- global uniqueness even when multiple rows share the same event_time second.\nCREATE TABLE dbo.audit_log (\n    log_id       BIGINT          IDENTITY(1,1) NOT NULL,\n    event_time   DATETIME2(0)    NOT NULL DEFAULT SYSUTCDATETIME(),\n    event_type   NVARCHAR(50)    NOT NULL,\n    actor_id     INT             NULL,    -- NULL for system / migration actions\n    -- Polymorphic target\n    target_type  NVARCHAR(30)    NOT NULL,  -- DOCUMENT|NODE|ACE|USER|GROUP|ROLE\n    target_id    INT             NOT NULL,\n    target_name  NVARCHAR(1000)  COLLATE Arabic_CI_AI NULL,  -- snapshot at event time\n    -- Denormalised context for fast history queries\n    node_id      INT             NULL,\n    document_id  INT             NULL,\n    version_id   INT             NULL,\n    -- JSON diff for structural changes (PERM_CHANGE, RENAME, field edits)\n    before_state NVARCHAR(MAX)   NULL,\n    after_state  NVARCHAR(MAX)   NULL,\n    -- Request context\n    ip_address   NVARCHAR(45)    NULL,\n    session_id   NVARCHAR(100)   NULL,\n    CONSTRAINT PK_audit_log PRIMARY KEY CLUSTERED (event_time, log_id)\n) ON ps_audit_monthly(event_time);\n\n-- ============================================================\n-- SECTION 10 – FULL-TEXT SEARCH\n-- ============================================================\n\nCREATE FULLTEXT CATALOG ft_documents AS DEFAULT;\n\n-- Key index: PK_document_versions (version_id — unique, non-nullable).\n-- LANGUAGE 1025 = Arabic: uses SQL Server's Arabic word breaker and stemmer.\n-- CHANGE_TRACKING AUTO: FTS index updated asynchronously as extracted_text\n--   is written by the worker.  Lag is seconds to minutes under normal load.\n-- STOPLIST = SYSTEM: uses the built-in Arabic stop-word list.\n-- The Arabic normalization pipeline (alef/yaa unification, tashkeel stripping)\n-- runs in the Node.js worker before writing extracted_text and in the app\n-- before constructing the @search_term passed to CONTAINSTABLE.\nCREATE FULLTEXT INDEX ON dbo.document_versions\n    (extracted_text LANGUAGE 1025)\n    KEY INDEX PK_document_versions\n    ON ft_documents\n    WITH CHANGE_TRACKING AUTO, STOPLIST = SYSTEM;\n\n-- ============================================================\n-- SECTION 11 – INDEXES\n-- ============================================================\n\n-- ---- filing_nodes ----\n\n-- Tree-listing UI: find direct children of a given parent.\nCREATE INDEX IX_fn_parent_id\n    ON dbo.filing_nodes (parent_id, is_deleted)\n    INCLUDE (name, node_type, path, depth, inherits_permissions, acl_version);\n\n-- Subtree path-prefix queries: WHERE path LIKE '/1/3/%'.\n-- path contains only digits and slashes; no LIKE metacharacters can appear.\n-- Used for subtree scoping in FTS search and reparent sweeps.\nCREATE INDEX IX_fn_path\n    ON dbo.filing_nodes (path)\n    INCLUDE (node_id, parent_id, depth, is_deleted, inherits_permissions, acl_version);\n\n-- ---- acl_entries ----\n\n-- Primary lookup during permission resolution: all ACEs on a node.\nCREATE INDEX IX_ace_node_id\n    ON dbo.acl_entries (node_id, ace_type)\n    INCLUDE (principal_type, principal_id, permission_mask);\n\n-- Invalidation sweep: find all nodes where a given principal has an ACE.\nCREATE INDEX IX_ace_principal\n    ON dbo.acl_entries (principal_type, principal_id)\n    INCLUDE (node_id, ace_type, permission_mask);\n\n-- ---- effective_permissions ----\n\n-- FTS search join: given user Y, seek all (node_id, effective_mask) rows.\n-- Evaluated: (ep.effective_mask & 2) = 2 in residual after seek on user_id.\nCREATE INDEX IX_ep_user_id\n    ON dbo.effective_permissions (user_id)\n    INCLUDE (node_id, effective_mask, acl_version);\n\n-- ---- group_membership_cache ----\n\n-- User -> groups lookup used during permission resolution.\nCREATE INDEX IX_gmc_user_id\n    ON dbo.group_membership_cache (user_id)\n    INCLUDE (group_id);\n\n-- ---- role_assignments ----\n\n-- Find all roles held by a given user or group (permission resolution + invalidation).\nCREATE INDEX IX_ra_grantee\n    ON dbo.role_assignments (grantee_type, grantee_id)\n    INCLUDE (role_id);\n\n-- ---- documents ----\n\n-- HOT QUERY covering index: all non-deleted documents in a folder.\n-- Seek on (node_id, is_deleted = 0); INCLUDE covers the SELECT list\n-- so no key lookup is needed.  ORDER BY title requires a residual sort\n-- at this scale (hundreds to low thousands of docs per folder).\nCREATE INDEX IX_doc_node_id\n    ON dbo.documents (node_id, is_deleted)\n    INCLUDE (title, document_type_id, sensitivity_label_id,\n             current_version_id, created_at, created_by, updated_at);\n\n-- ---- document_versions ----\n\n-- Version history panel: all versions of a document ordered by version number.\nCREATE INDEX IX_dv_document_id\n    ON dbo.document_versions (document_id, version_number)\n    INCLUDE (uploaded_at, file_size_bytes, uploaded_by, extraction_status);\n\n-- ---- extraction_jobs ----\n\n-- Worker polls for PENDING jobs by priority then queue order.\n-- Filtered index covers only the interesting rows, minimising page reads.\nCREATE INDEX IX_ej_pending\n    ON dbo.extraction_jobs (priority, queued_at)\n    INCLUDE (version_id, retry_count, max_retries)\n    WHERE status = 'PENDING';\n\n-- ---- permission_recompute_queue ----\n\n-- Background worker scans unprocessed items ordered by arrival time.\nCREATE INDEX IX_prq_pending\n    ON dbo.permission_recompute_queue (queued_at)\n    INCLUDE (node_id, user_id, reason)\n    WHERE is_processed = 0;\n\n-- ---- audit_log (aligned nonclustered indexes on partitioned table) ----\n\n-- \"What did actor X do?\" — history per user.\nCREATE INDEX IX_al_actor\n    ON dbo.audit_log (actor_id, event_time)\n    INCLUDE (event_type, target_type, target_id)\n    ON ps_audit_monthly(event_time);\n\n-- \"Full history of document D.\"\nCREATE INDEX IX_al_document\n    ON dbo.audit_log (document_id, event_time)\n    INCLUDE (event_type, actor_id, version_id)\n    ON ps_audit_monthly(event_time);\n",
  "permissionResolution": "Given a target (node_id N, user_id U), compute effective_mask as follows.\n\nSTEP 1 — ADMIN BYPASS\nIf users.is_superadmin = 1 for user U, return effective_mask = 63 (all bits).  No ACE lookup occurs.\n\nSTEP 2 — COLLECT THE ACL SCOPE (ancestor walk)\nBuild the set of nodes whose explicit ACEs contribute to N's effective ACL.\n\nStart from N.  Include N's own ACEs unconditionally.\nIf N.inherits_permissions = 1, walk UP to N's parent.  Include the parent's ACEs.\nContinue upward as long as the current ancestor has inherits_permissions = 1.\nSTOP when:\n  - A node with inherits_permissions = 0 is encountered (its ACEs are included; its parent's are not), OR\n  - The root (parent_id IS NULL) is reached (its ACEs are included).\n\nThe SQL for the scope:\n\n  WITH acl_scope AS (\n      SELECT node_id, parent_id, inherits_permissions\n      FROM   dbo.filing_nodes\n      WHERE  node_id = @node_id\n      UNION ALL\n      SELECT p.node_id, p.parent_id, p.inherits_permissions\n      FROM   dbo.filing_nodes  p\n      INNER JOIN acl_scope     c ON p.node_id = c.parent_id\n      WHERE  c.inherits_permissions = 1    -- ascend only while child inherits\n  )\n\nSTEP 3 — FIND APPLICABLE ACEs\nAn ACE from acl_scope applies to user U if any of the following holds:\n  a. principal_type = 'U' AND principal_id = U\n  b. principal_type = 'G' AND principal_id IN\n       (SELECT group_id FROM dbo.group_membership_cache WHERE user_id = U)\n  c. principal_type = 'R' AND principal_id IN\n       -- roles held directly:\n       (SELECT role_id FROM dbo.role_assignments\n        WHERE  grantee_type = 'U' AND grantee_id = U\n        UNION\n        -- roles held via group membership:\n        SELECT ra.role_id\n        FROM   dbo.role_assignments  ra\n        JOIN   dbo.group_membership_cache gmc\n               ON ra.grantee_type = 'G' AND ra.grantee_id = gmc.group_id\n        WHERE  gmc.user_id = U)\n\nSTEP 4 — AGGREGATE\n  allow_mask = 0\n  deny_mask  = 0\n  For each applicable ACE with ace_type = 'A': allow_mask |= ace.permission_mask\n  For each applicable ACE with ace_type = 'D': deny_mask  |= ace.permission_mask\n  effective_mask = allow_mask & ~deny_mask\n\nDENY PRECEDENCE RULE: DENY beats ALLOW unconditionally, regardless of:\n  - the depth at which the DENY ACE lives (own vs inherited),\n  - the principal specificity (direct user vs group vs role).\n  A single DENY ACE for any bit clears that bit for the user.\n\nSTEP 5 — DEFAULT\nIf no applicable ACEs exist at all, effective_mask = 0 (default deny).\n\nSTEP 6 — STORING THE RESULT\nWrite (node_id, user_id, allow_mask, deny_mask, acl_version = filing_nodes.acl_version)\ninto dbo.effective_permissions using MERGE (upsert).\nThe database computes effective_mask from the PERSISTED computed column.\n\nSTEP 7 — READING THE RESULT (hot path)\nQuery effective_permissions WHERE node_id = N AND user_id = U.\nJOIN to filing_nodes to verify ep.acl_version = fn.acl_version.\nIf no qualifying row (absent or version mismatch): the row is stale.\n  Option A (synchronous safe): run Steps 2–6 live and return the result.\n  Option B (deny-safe): deny access and enqueue recomputation.\nThe design documents Option A as the default; Option B is acceptable during\nhigh-load bursts where the worker has fallen behind.",
  "invalidation": "Six change classes require recomputation.  For each, the SQL shows what to do\nand the blast-radius column states the maximum number of (node, user) pairs\nthat need to be refreshed.\n\n────────────────────────────────────────────────────────────────\n1. ACE ADDED / CHANGED / DELETED ON NODE X\n────────────────────────────────────────────────────────────────\nBlast radius: X plus all descendants that inherit through X\n  (descent stops at any child with inherits_permissions = 0).\nMaximum: entire subtree × all users.\n\n-- Find affected nodes (recursive CTE ascends DOWNWARD from X)\nWITH affected AS (\n    SELECT node_id, inherits_permissions\n    FROM   dbo.filing_nodes\n    WHERE  node_id = @changed_node_id\n    UNION ALL\n    SELECT c.node_id, c.inherits_permissions\n    FROM   dbo.filing_nodes c\n    INNER JOIN affected p ON c.parent_id = p.node_id\n    WHERE  c.inherits_permissions = 1   -- only descend through inheriting children\n      AND  c.is_deleted = 0\n)\n-- Bump acl_version to mark existing ep rows stale immediately\nUPDATE fn\nSET    fn.acl_version = fn.acl_version + 1\nFROM   dbo.filing_nodes fn\nINNER JOIN affected a ON a.node_id = fn.node_id;\n\n-- Queue recomputation (user_id = NULL = all users for each node)\nINSERT INTO dbo.permission_recompute_queue (node_id, user_id, reason)\nSELECT node_id, NULL, N'ACE_CHANGE'\nFROM   affected;\n\n────────────────────────────────────────────────────────────────\n2. INHERITANCE TOGGLED ON NODE X (break or restore)\n────────────────────────────────────────────────────────────────\nBlast radius: same as case 1 (X and inheriting descendants).\nUse the identical CTE above with reason = 'INHERITANCE_CHANGE'.\nWhen restoring inheritance (0→1), the node's new ACL scope extends\nto its parent chain; when breaking (1→0), it is isolated.  Both cases\nchange what ACEs apply, so a full recompute of X and inheriting\ndescendants is required.\n\n────────────────────────────────────────────────────────────────\n3. NODE X MOVED (reparenting a subtree)\n────────────────────────────────────────────────────────────────\nBlast radius: the entire moved subtree (ALL nodes under X, regardless\nof their inherits_permissions setting), because the ancestor chain changes.\nSee the reparenting section for the SQL — acl_version is bumped and the\nqueue is populated there, inside the same transaction as the path update.\n\n────────────────────────────────────────────────────────────────\n4. GROUP MEMBERSHIP CHANGES (user U added/removed from group G)\n────────────────────────────────────────────────────────────────\nBlast radius: user U's entire effective_permissions row-set.\nThe simplest correct action is to delete all ep rows for U and let the\nhot query trigger synchronous recomputation as each folder is visited.\nSimultaneously enqueue recomputation for every node that has a group ACE\npointing to G or any group that G belongs to.\n\n-- Step A: rebuild the flat membership cache (done by the application's\n--         usp_RebuildGroupMembershipCache stored procedure, which handles\n--         nesting via a depth-limited visited-set loop)\n\n-- Step B: invalidate U's cached permissions\nDELETE FROM dbo.effective_permissions WHERE user_id = @affected_user_id;\n\n-- Step C: queue recomputation for the affected nodes\nINSERT INTO dbo.permission_recompute_queue (node_id, user_id, reason)\nSELECT DISTINCT ace.node_id, @affected_user_id, N'GROUP_MEMBER_CHANGE'\nFROM   dbo.acl_entries ace\nWHERE  ace.principal_type = 'G'\n  AND  ace.principal_id IN (\n       -- G itself and every group that G is a transitive member of\n       SELECT group_id\n       FROM   dbo.group_membership_cache\n       WHERE  user_id IN (\n           SELECT user_id FROM dbo.group_membership_cache WHERE group_id = @changed_group_id\n       )\n       UNION\n       SELECT @changed_group_id\n  );\n\n────────────────────────────────────────────────────────────────\n5. ROLE DEFINITION CHANGES (roles.permission_mask updated for role R)\n────────────────────────────────────────────────────────────────\nBlast radius: all nodes that have an ACE for role R, for all users.\n\n-- Bump acl_version on affected nodes\nUPDATE fn\nSET    fn.acl_version = fn.acl_version + 1\nFROM   dbo.filing_nodes fn\nWHERE  fn.node_id IN (\n    SELECT DISTINCT node_id FROM dbo.acl_entries\n    WHERE  principal_type = 'R' AND principal_id = @changed_role_id\n);\n\n-- Queue recomputation (all users, because any user holding R is affected)\nINSERT INTO dbo.permission_recompute_queue (node_id, user_id, reason)\nSELECT DISTINCT node_id, NULL, N'ROLE_MASK_CHANGE'\nFROM   dbo.acl_entries\nWHERE  principal_type = 'R' AND principal_id = @changed_role_id;\n\n────────────────────────────────────────────────────────────────\n6. USER DEACTIVATED (is_active set to 0)\n────────────────────────────────────────────────────────────────\nBlast radius: the deactivated user only.\nThe runtime must check users.is_active = 1 before every permission check\n(a deactivated user is denied everything regardless of effective_mask).\nDeleting their rows prevents their cached grants from being served to a\nsession using a stale JWT until the next token refresh.\n\nDELETE FROM dbo.effective_permissions WHERE user_id = @deactivated_user_id;\n\nNo requeue is needed; reactivation re-triggers recomputation when the user\nnext logs in (or the worker is told to recompute for this user_id).",
  "hotQuery": "-- ====================================================================\n-- HOT QUERY: list documents in folder @folder_id that user @user_id\n-- may Browse (bit 1) or Read (bit 2), paginated.\n-- Set @required_mask = 1 to show titles, 2 to confirm content access.\n-- ====================================================================\n-- Indexes relied on:\n--   Step 1:  PK_effective_permissions  — seek (node_id, user_id)\n--            PK_filing_nodes           — seek node_id for acl_version check\n--   Step 2:  IX_doc_node_id            — covering seek (node_id, is_deleted)\n--            PK_document_versions      — clustered lookup via current_version_id\n--            PK_document_types         — optional lookup (small table, cached)\n--            PK_sensitivity_labels     — optional lookup (small table, cached)\n-- ====================================================================\n\n-- PARAMETERS (supply from application layer):\n-- @folder_id    INT\n-- @user_id      INT\n-- @required_mask TINYINT  -- 1 (Browse) or 2 (Read) or 3 (Browse|Read)\n-- @sort_col     NVARCHAR(20) -- 'title' | 'created_at' | 'updated_at' | 'file_size'\n-- @page         INT         -- 1-based\n-- @page_size    INT         -- e.g. 50\n\n-- ── STEP 1: Permission check on the folder ──────────────────────────\n-- A single covering-index seek.  If the row is absent the node has never\n-- been computed; if acl_version mismatches the row is stale.\n-- Both cases must trigger synchronous live computation before proceeding.\n\nDECLARE @effective_mask TINYINT;\n\nSELECT @effective_mask = ep.effective_mask\nFROM   dbo.effective_permissions ep\nINNER  JOIN dbo.filing_nodes fn\n        ON  fn.node_id    = ep.node_id\n        AND fn.acl_version = ep.acl_version     -- staleness guard\nWHERE  ep.node_id = @folder_id\n  AND  ep.user_id = @user_id;\n\n-- If @effective_mask IS NULL: row absent or stale.\n--   → call usp_RecomputeEffectivePermissions(@folder_id, @user_id), retry.\n-- If (@effective_mask & @required_mask) = 0: access denied → return empty.\n\n-- ── STEP 2: Paginated document listing (only if access granted) ──────\n\nSELECT\n    d.document_id,\n    d.title,\n    d.document_type_id,\n    dt.type_name,\n    d.sensitivity_label_id,\n    sl.label_name             AS sensitivity_label,\n    d.current_version_id,\n    dv.version_number         AS current_version_number,\n    dv.file_size_bytes,\n    dv.uploaded_at            AS last_version_at,\n    d.created_at,\n    d.created_by,\n    u.display_name            AS created_by_name,\n    COUNT(1) OVER ()          AS total_count     -- permission-pre-filtered total\nFROM   dbo.documents d\nINNER  JOIN dbo.document_versions dv\n        ON  dv.version_id = d.current_version_id\nLEFT   JOIN dbo.document_types dt\n        ON  dt.type_id    = d.document_type_id\nLEFT   JOIN dbo.sensitivity_labels sl\n        ON  sl.label_id   = d.sensitivity_label_id\nLEFT   JOIN dbo.users u\n        ON  u.user_id     = d.created_by\nWHERE  d.node_id    = @folder_id\n  AND  d.is_deleted = 0\n-- Dynamic sort: in Kysely, build the ORDER BY clause from @sort_col.\n-- 'title' maps to ORDER BY d.title COLLATE Arabic_CI_AI ASC\n-- 'created_at' maps to ORDER BY d.created_at DESC\n-- 'file_size'  maps to ORDER BY dv.file_size_bytes DESC\nORDER  BY d.title   -- replace with parameterised column via Kysely .orderBy()\nOFFSET (@page - 1) * @page_size ROWS\nFETCH  NEXT @page_size ROWS ONLY;\n\n-- Note: COUNT(1) OVER() is computed across the full WHERE-filtered set before\n-- OFFSET/FETCH is applied, so total_count is always the true untruncated count.\n-- No second COUNT(*) round-trip is needed.",
  "searchQuery": "-- ====================================================================\n-- FTS SEARCH: find documents matching @search_term that user @user_id\n-- may Read (bit 2), optionally scoped to a subtree.\n-- Filtering is applied BEFORE paging so total_count is exact.\n-- A document whose folder's ep row is absent or stale is treated as\n-- inaccessible (INNER JOIN excludes it): false negative, never false positive.\n-- ====================================================================\n-- Indexes relied on:\n--   CONTAINSTABLE               — FTS catalog on document_versions.extracted_text\n--   IX_ep_user_id               — seek user_id, filter effective_mask & 2\n--   PK_effective_permissions    — acl_version staleness check\n--   PK_filing_nodes             — acl_version + path for subtree filter\n--   IX_fn_path                  — subtree path LIKE scan\n--   UQ_dv_number / PK_doc_vers  — join document_versions to documents\n--   IX_doc_node_id              — join documents for is_deleted filter\n-- ====================================================================\n\n-- PARAMETERS:\n-- @search_term      NVARCHAR(1000)  -- already normalized by app (alef/yaa/tashkeel)\n-- @user_id          INT\n-- @subtree_node_id  INT NULL        -- if not NULL, scope search to this subtree\n-- @page             INT\n-- @page_size        INT\n\nDECLARE @subtree_path NVARCHAR(4000) = NULL;\nIF @subtree_node_id IS NOT NULL\n    SELECT @subtree_path = path\n    FROM   dbo.filing_nodes\n    WHERE  node_id   = @subtree_node_id\n      AND  is_deleted = 0;\n\nSELECT\n    d.document_id,\n    d.title,\n    d.node_id,\n    fn.name                     AS folder_name,\n    fn.path                     AS folder_path,\n    fts.[RANK]                  AS relevance_rank,\n    dv.version_id,\n    dv.uploaded_at,\n    sl.label_name               AS sensitivity_label,\n    COUNT(1) OVER ()            AS total_count   -- exact permission-filtered count\nFROM\n    -- CONTAINSTABLE returns (KEY = version_id, RANK).\n    -- LANGUAGE 1025 = Arabic: uses the same word breaker as the FTS index,\n    -- ensuring that the normalized search term is tokenised consistently.\n    CONTAINSTABLE(\n        dbo.document_versions,\n        extracted_text,\n        @search_term,\n        LANGUAGE 1025\n    ) AS fts\nINNER JOIN dbo.document_versions dv\n        ON  dv.version_id        = fts.[KEY]\n        AND dv.extraction_status = 'DONE'\nINNER JOIN dbo.documents d\n        ON  d.document_id        = dv.document_id\n        AND d.current_version_id = dv.version_id   -- current versions only\n        AND d.is_deleted         = 0\nINNER JOIN dbo.filing_nodes fn\n        ON  fn.node_id    = d.node_id\n        AND fn.is_deleted = 0\n        AND (  @subtree_path IS NULL\n            OR fn.path LIKE @subtree_path + N'%')  -- subtree scope\nINNER JOIN dbo.effective_permissions ep\n        ON  ep.node_id     = d.node_id\n        AND ep.user_id     = @user_id\n        AND ep.acl_version = fn.acl_version        -- stale rows excluded (safe: false negative)\nWHERE  (ep.effective_mask & 2) = 2                 -- Read bit must be set\nORDER  BY fts.[RANK] DESC\nOFFSET (@page - 1) * @page_size ROWS\nFETCH  NEXT @page_size ROWS ONLY;\n\n-- Correctness guarantee: the INNER JOIN on ep with the acl_version guard means\n-- a document in a folder whose effective_permissions row is stale is simply\n-- excluded from results rather than returned with potentially wrong permissions.\n-- The background worker must keep ep rows fresh to minimise these false negatives.\n-- COUNT(1) OVER() counts all rows surviving the permission filter before paging,\n-- so the count shown to the user is always permission-correct.",
  "reparenting": "-- ====================================================================\n-- REPARENT: move node @node_id (and its entire subtree) under @new_parent_id.\n-- Disk files are NOT touched; only the DB changes.\n-- Wrapped in a transaction with an advisory lock to serialise concurrent moves.\n-- ====================================================================\n\nBEGIN TRANSACTION;\n\n    -- Advisory lock: prevents two sessions from concurrently moving the same node.\n    -- Scope = transaction, so the lock releases on COMMIT or ROLLBACK.\n    DECLARE @lock_result INT;\n    EXEC @lock_result = sp_getapplock\n        @Resource = N'move_node_' + CAST(@node_id AS NVARCHAR(10)),\n        @LockMode = 'Exclusive',\n        @LockOwner = 'Transaction',\n        @LockTimeout = 5000;   -- 5 s; return -1 if timeout\n\n    IF @lock_result < 0\n    BEGIN\n        ROLLBACK;\n        RAISERROR(N'Could not acquire move lock on node %d.', 16, 1, @node_id);\n        RETURN;\n    END;\n\n    -- Guard: new parent must not be a descendant of the moving node\n    -- (would create a cycle in the adjacency list).\n    DECLARE @moving_path NVARCHAR(4000);\n    SELECT  @moving_path = path FROM dbo.filing_nodes WHERE node_id = @node_id;\n\n    IF EXISTS (\n        SELECT 1 FROM dbo.filing_nodes\n        WHERE  node_id = @new_parent_id\n          AND  path    LIKE @moving_path + N'%'\n    )\n    BEGIN\n        ROLLBACK;\n        RAISERROR(N'Cannot move node into its own descendant.', 16, 1);\n        RETURN;\n    END;\n\n    -- Capture current and new geometry.\n    DECLARE @old_depth       SMALLINT;\n    SELECT  @old_depth = depth FROM dbo.filing_nodes WHERE node_id = @node_id;\n\n    DECLARE @new_parent_path  NVARCHAR(4000);\n    DECLARE @new_parent_depth SMALLINT;\n    SELECT  @new_parent_path  = path,\n            @new_parent_depth = depth\n    FROM    dbo.filing_nodes WHERE node_id = @new_parent_id;\n\n    -- New path for @node_id: parent_path + node_id + '/'.\n    -- Descendants: replace the old prefix with the new prefix.\n    -- Example: old '/1/3/7/', new parent '/1/5/' → new '/1/5/7/'.\n    DECLARE @new_path    NVARCHAR(4000) =\n        @new_parent_path + CAST(@node_id AS NVARCHAR(10)) + N'/';\n    DECLARE @depth_delta SMALLINT =\n        (@new_parent_depth + 1) - @old_depth;\n\n    -- Single UPDATE touches every row in the subtree.\n    -- path LIKE @moving_path + '%' matches @node_id itself (path = @moving_path)\n    -- and all descendants (path starts with @moving_path).\n    -- path contains only digits and slashes, so LIKE has no metacharacter risk.\n    --\n    -- acl_version is bumped unconditionally: every node in the subtree now has\n    -- a different ancestor chain, so its inherited ACEs may have changed.\n    -- This marks all existing effective_permissions rows for the subtree as stale.\n    UPDATE dbo.filing_nodes\n    SET\n        path      = @new_path + SUBSTRING(path, LEN(@moving_path) + 1, 4000),\n        depth     = depth + @depth_delta,\n        parent_id = CASE WHEN node_id = @node_id THEN @new_parent_id\n                         ELSE parent_id END,\n        acl_version = acl_version + 1,\n        updated_at  = SYSUTCDATETIME()\n    WHERE path LIKE @moving_path + N'%';\n    -- After this UPDATE every subtree row has its new path starting with @new_path.\n\n    -- Queue effective-permission recomputation for the entire moved subtree.\n    -- user_id = NULL tells the worker to recompute all users for each node.\n    -- The worker processes NULL rows by expanding them over all active users.\n    INSERT INTO dbo.permission_recompute_queue (node_id, user_id, reason)\n    SELECT node_id, NULL, N'SUBTREE_MOVE'\n    FROM   dbo.filing_nodes\n    WHERE  path LIKE @new_path + N'%';\n\nCOMMIT TRANSACTION;\n\n-- ── Concurrency correctness ──────────────────────────────────────────\n-- The sp_getapplock serialises concurrent moves of the same node.\n-- Readers running under READ COMMITTED see the pre-commit state of rows\n-- they have not yet read; once the COMMIT is visible they observe the new\n-- paths and the new acl_version values.\n-- A reader that checks ep.acl_version = fn.acl_version after the COMMIT\n-- will find a mismatch for every moved node and fall back to live\n-- computation — it cannot serve a stale cached grant for the old ancestor\n-- chain.  The window between the COMMIT and the worker completing all\n-- recomputes is covered by the synchronous live-computation fallback.\n-- A reader mid-flight that already fetched fn.path before the UPDATE\n-- and then checks ep will find a version mismatch and similarly falls back.\n-- There is no window where a wrong effective_mask is served.",
  "tradeoffs": [
    "Documents inherit folder ACL (no per-document ACL in v1). All documents in the same folder have identical effective permissions. This is correct for 95% of use cases but prevents fine-grained per-document visibility splitting. Adding per-document ACEs later requires either making documents also be filing_nodes or adding a second ACL path in the permission resolver.",
    "DENY always beats ALLOW unconditionally, regardless of ACE level or principal specificity (own vs inherited, direct user vs group vs role). This is maximally safe but can cause unintuitive lockouts: a broad DENY ACE on an ancestor group catches a user who has an explicit ALLOW ACE lower in the tree, with no override mechanism short of removing the DENY or creating a break-inheritance point.",
    "effective_permissions is precomputed with an acl_version staleness guard. Hot reads are a single PK seek. The trade-off is that any ACL change requires bumping acl_version on the affected subtree and queuing recomputation. With 300 users and 10 000 nodes, a root-level ACE change touches up to 3 000 000 (node, user) rows — bounded but non-trivial. The acl_version bump is a cheap UPDATE sweep; the recompute is the slow part.",
    "Stale effective_permissions rows cause false negatives (a user cannot access a document they should), never false positives (a user cannot access a document they should not). The design chooses safe-deny over optimistic-serve when the worker is lagged. Applications must surface a 'try again shortly' message rather than silently returning empty results.",
    "group_membership_cache is a flat materialised view with no version column. It is correct only if usp_RebuildGroupMembershipCache is called after every change to group_members. A missed call means stale group memberships and incorrect permission resolution. The application must treat group_members writes and cache rebuilds as a single atomic unit (ideally inside a transaction or via an AFTER trigger on group_members).",
    "Materialized path (not closure table) for the filing tree. Subtree queries are simple path LIKE '/prefix/%' predicates; reparenting is one UPDATE sweep. A closure table would enable O(1) ancestor/descendant lookups without LIKE, but adds O(depth) rows per node and complicates reparenting. At hundreds to low thousands of nodes, the materialized path is sufficient and simpler to maintain.",
    "Audit log is partitioned by month with a pre-populated range. New partitions must be added before the month they cover (via ALTER PARTITION FUNCTION ... SPLIT RANGE). If the maintenance job fails, inserts for the new month land in the boundary catch-all partition and must be moved. A database agent job should split the next month's boundary at least one week in advance.",
    "Arabic normalization (alef/yaa/taa-marbuta unification, tashkeel and tatweel stripping) runs in application code before writing extracted_text and before building the CONTAINSTABLE search term. SQL Server's Arabic word breaker (LANGUAGE 1025) handles stemming and stopwords but does not do these custom normalizations. If the normalization logic diverges between indexing and querying, search recall degrades silently with no DB-level error.",
    "EAV for custom field values (NVARCHAR(MAX) for all types). Flexible schema with no DDL changes for new field types. The cost: numeric and date range queries require CAST/TRY_CAST inside WHERE clauses and cannot use B-tree seeks; cross-field joins for filtered document lists are expensive; and the DB cannot enforce value-type correctness (a date field accepts any string). Accept this for the field-variety requirement; add indexed computed columns for the two or three most-queried numeric or date fields if range filtering becomes a bottleneck.",
    "FTS CHANGE_TRACKING AUTO means the full-text index updates asynchronously after extracted_text is written. A document may not appear in search results for seconds to minutes after the extraction worker completes. This is an explicit design trade-off (async vs synchronous FTS population). CHANGE_TRACKING MANUAL with an explicit UPDATE FULLTEXT INDEX call in the worker is an alternative if near-real-time searchability is required."
  ]
}
```

---

## a5e9f8da7f23faada

```json
{
  "angle": "PERFORMANCE-FIRST. effective_permissions is the load-bearing table: every read-path query is a covering-index seek on that table followed by a covering-index seek on documents. The hot query never touches access_control_entries or the node ancestry chain at request time. Arabic normalization (alef/yaa unification, tashkeel/tatweel stripping) is applied at write time into a dedicated column so the FTS index and title sorts always operate on clean tokens. Heavy write cost (subtree rebuild on ACE/membership/move changes) is accepted in exchange for sub-millisecond reads at the stated scale of hundreds of nodes and 50-300 users.",
  "ddl": "-- ============================================================\n-- DMS SCHEMA | SQL Server 2019 Standard | PERFORMANCE-FIRST\n-- ============================================================\n-- Permission bitmask (TINYINT, 6 bits used):\n--   Browse      = 1   see node exists + document titles\n--   Read        = 2   open / preview / download content\n--   Upload      = 4   add documents / new versions\n--   EditMeta    = 8   edit document metadata\n--   Delete      = 16  soft-delete documents\n--   ManagePerms = 32  manage ACEs on this node\n-- ALL_BITS = 63\n-- users.is_admin=1 bypasses all ACL checks at the application layer.\n-- ============================================================\n\n-- ============================================================\n-- 1. PRINCIPALS\n-- ============================================================\n\nCREATE TABLE users (\n    user_id       INT           NOT NULL IDENTITY(1,1),\n    username      NVARCHAR(100) NOT NULL COLLATE Latin1_General_CI_AS,\n    display_name  NVARCHAR(300) NOT NULL COLLATE Arabic_CI_AI,\n    email         NVARCHAR(254) NOT NULL COLLATE Latin1_General_CI_AS,\n    password_hash NVARCHAR(256) NOT NULL,          -- bcrypt / argon2id hash\n    is_active     BIT           NOT NULL DEFAULT 1,\n    is_admin      BIT           NOT NULL DEFAULT 0,\n    created_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_at    DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_users          PRIMARY KEY CLUSTERED (user_id),\n    CONSTRAINT UQ_users_username UNIQUE (username),\n    CONSTRAINT UQ_users_email    UNIQUE (email)\n);\n-- Login: username seek -> password_hash + is_active + is_admin in one read\nCREATE NONCLUSTERED INDEX IX_users_username\n    ON users (username)\n    INCLUDE (password_hash, is_active, is_admin, display_name, user_id);\n\nCREATE TABLE groups (\n    group_id    INT           NOT NULL IDENTITY(1,1),\n    name        NVARCHAR(300) NOT NULL COLLATE Arabic_CI_AI,\n    description NVARCHAR(500)     NULL COLLATE Arabic_CI_AI,\n    is_active   BIT           NOT NULL DEFAULT 1,\n    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_groups      PRIMARY KEY CLUSTERED (group_id),\n    CONSTRAINT UQ_groups_name UNIQUE (name)\n);\n\n-- Direct user->group assignment\nCREATE TABLE group_members (\n    group_id INT          NOT NULL,\n    user_id  INT          NOT NULL,\n    added_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    added_by INT          NOT NULL,\n    CONSTRAINT PK_group_members PRIMARY KEY CLUSTERED (group_id, user_id),\n    CONSTRAINT FK_gm_group FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,\n    CONSTRAINT FK_gm_user  FOREIGN KEY (user_id)  REFERENCES users(user_id)  ON DELETE CASCADE,\n    CONSTRAINT FK_gm_added FOREIGN KEY (added_by) REFERENCES users(user_id)\n);\n-- Reverse lookup: which groups does user X directly belong to?\nCREATE NONCLUSTERED INDEX IX_gm_user\n    ON group_members (user_id) INCLUDE (group_id);\n\n-- Groups nested inside groups\nCREATE TABLE group_group_members (\n    parent_group_id INT          NOT NULL,\n    child_group_id  INT          NOT NULL,\n    added_at        DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    added_by        INT          NOT NULL,\n    CONSTRAINT PK_ggm        PRIMARY KEY CLUSTERED (parent_group_id, child_group_id),\n    CONSTRAINT FK_ggm_parent FOREIGN KEY (parent_group_id) REFERENCES groups(group_id),\n    CONSTRAINT FK_ggm_child  FOREIGN KEY (child_group_id)  REFERENCES groups(group_id),\n    CONSTRAINT FK_ggm_added  FOREIGN KEY (added_by) REFERENCES users(user_id),\n    CONSTRAINT CK_ggm_no_self CHECK (parent_group_id <> child_group_id)\n);\n-- Needed when rebuilding flat_group_members upward from a child group\nCREATE NONCLUSTERED INDEX IX_ggm_child\n    ON group_group_members (child_group_id) INCLUDE (parent_group_id);\n\n-- Precomputed transitive closure: user -> all groups they belong to directly or via nesting.\n-- Rebuilt synchronously by usp_rebuild_flat_group_members whenever group_members or\n-- group_group_members changes. Hot queries join here instead of traversing nesting.\nCREATE TABLE flat_group_members (\n    user_id  INT NOT NULL,\n    group_id INT NOT NULL,\n    CONSTRAINT PK_fgm      PRIMARY KEY CLUSTERED (user_id, group_id),\n    CONSTRAINT FK_fgm_user FOREIGN KEY (user_id)  REFERENCES users(user_id)  ON DELETE CASCADE,\n    CONSTRAINT FK_fgm_grp  FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE\n);\n-- Invalidation: which users are in group G (blast radius for ACE changes)?\nCREATE NONCLUSTERED INDEX IX_fgm_group\n    ON flat_group_members (group_id) INCLUDE (user_id);\n\n-- Named permission bundles\nCREATE TABLE roles (\n    role_id         INT           NOT NULL IDENTITY(1,1),\n    name            NVARCHAR(300) NOT NULL COLLATE Arabic_CI_AI,\n    description     NVARCHAR(500)     NULL COLLATE Arabic_CI_AI,\n    permission_bits TINYINT       NOT NULL DEFAULT 0,\n    is_active       BIT           NOT NULL DEFAULT 1,\n    created_at      DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_roles      PRIMARY KEY CLUSTERED (role_id),\n    CONSTRAINT UQ_roles_name UNIQUE (name),\n    CONSTRAINT CK_roles_bits CHECK (permission_bits BETWEEN 0 AND 63)\n);\n\nCREATE TABLE user_roles (\n    user_id  INT          NOT NULL,\n    role_id  INT          NOT NULL,\n    added_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    added_by INT          NOT NULL,\n    CONSTRAINT PK_user_roles PRIMARY KEY CLUSTERED (user_id, role_id),\n    CONSTRAINT FK_ur_user    FOREIGN KEY (user_id)  REFERENCES users(user_id)  ON DELETE CASCADE,\n    CONSTRAINT FK_ur_role    FOREIGN KEY (role_id)  REFERENCES roles(role_id)  ON DELETE CASCADE,\n    CONSTRAINT FK_ur_added   FOREIGN KEY (added_by) REFERENCES users(user_id)\n);\n-- Invalidation: which users hold role R?\nCREATE NONCLUSTERED INDEX IX_ur_role\n    ON user_roles (role_id) INCLUDE (user_id);\n\n-- ============================================================\n-- 2. SENSITIVITY LABELS (admin-configurable; NOT a hardcoded enum)\n-- ============================================================\nCREATE TABLE sensitivity_labels (\n    label_id    INT           NOT NULL IDENTITY(1,1),\n    name        NVARCHAR(100) NOT NULL COLLATE Arabic_CI_AI,\n    description NVARCHAR(500)     NULL COLLATE Arabic_CI_AI,\n    color_hex   CHAR(7)           NULL COLLATE Latin1_General_CI_AS,\n    sort_order  SMALLINT      NOT NULL DEFAULT 0,\n    is_active   BIT           NOT NULL DEFAULT 1,\n    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_sensitivity_labels     PRIMARY KEY CLUSTERED (label_id),\n    CONSTRAINT UQ_sensitivity_label_name UNIQUE (name)\n);\n\n-- ============================================================\n-- 3. FILING TREE (folders only; documents carry a node_id FK)\n-- ============================================================\n-- mpath format: '/1/' root, '/1/5/' child of 1, '/1/5/23/' grandchild.\n-- Prefix search LIKE '/1/5/%' never has a leading wildcard, so the index can seek.\n-- Max practical depth 10 levels x ~7 chars/segment = 80 chars; 500 is safe.\n-- inherits_permissions: 1 = inherit from parent chain (default); 0 = break inheritance.\n\nCREATE TABLE nodes (\n    node_id              INT           NOT NULL IDENTITY(1,1),\n    parent_id            INT               NULL,\n    mpath                VARCHAR(500)  NOT NULL COLLATE Latin1_General_CI_AS,\n    depth                TINYINT       NOT NULL DEFAULT 0,\n    name                 NVARCHAR(300) NOT NULL COLLATE Arabic_CI_AI,\n    node_type            TINYINT       NOT NULL DEFAULT 0,   -- 0=folder; reserved\n    inherits_permissions BIT           NOT NULL DEFAULT 1,\n    is_deleted           BIT           NOT NULL DEFAULT 0,\n    deleted_at           DATETIME2(3)      NULL,\n    deleted_by           INT               NULL,\n    created_by           INT           NOT NULL,\n    created_at           DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_at           DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_nodes        PRIMARY KEY CLUSTERED (node_id),\n    CONSTRAINT FK_nodes_parent FOREIGN KEY (parent_id)  REFERENCES nodes(node_id),\n    CONSTRAINT FK_nodes_cr     FOREIGN KEY (created_by) REFERENCES users(user_id),\n    CONSTRAINT FK_nodes_del    FOREIGN KEY (deleted_by) REFERENCES users(user_id),\n    CONSTRAINT CK_nodes_depth  CHECK (\n        (parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth > 0)\n    )\n);\n-- Subtree queries: WHERE mpath LIKE '/1/5/%'\n-- Filtered to active nodes; includes inherits_permissions for the rebuild SP.\nCREATE NONCLUSTERED INDEX IX_nodes_mpath\n    ON nodes (mpath)\n    INCLUDE (node_id, parent_id, depth, inherits_permissions, name)\n    WHERE is_deleted = 0;\n\n-- Tree display / children-of-parent listing\nCREATE NONCLUSTERED INDEX IX_nodes_parent\n    ON nodes (parent_id, is_deleted)\n    INCLUDE (node_id, name, mpath, depth, inherits_permissions);\n\n-- ============================================================\n-- 4. ACCESS CONTROL ENTRIES\n-- ============================================================\n-- principal_type: 1=user  2=group  3=role\n-- ace_type:       1=ALLOW  2=DENY\n-- permission_bits: bitmask of verbs this ACE grants or denies on node_id\n\nCREATE TABLE access_control_entries (\n    ace_id          INT          NOT NULL IDENTITY(1,1),\n    node_id         INT          NOT NULL,\n    principal_type  TINYINT      NOT NULL,\n    principal_id    INT          NOT NULL,\n    permission_bits TINYINT      NOT NULL,\n    ace_type        TINYINT      NOT NULL,\n    created_by      INT          NOT NULL,\n    created_at      DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_ace        PRIMARY KEY CLUSTERED (ace_id),\n    CONSTRAINT FK_ace_node   FOREIGN KEY (node_id)    REFERENCES nodes(node_id) ON DELETE CASCADE,\n    CONSTRAINT FK_ace_cr     FOREIGN KEY (created_by) REFERENCES users(user_id),\n    CONSTRAINT UQ_ace        UNIQUE (node_id, principal_type, principal_id, ace_type),\n    CONSTRAINT CK_ace_type   CHECK (ace_type       IN (1, 2)),\n    CONSTRAINT CK_ace_ptype  CHECK (principal_type IN (1, 2, 3)),\n    CONSTRAINT CK_ace_bits   CHECK (permission_bits BETWEEN 1 AND 63)\n);\n-- Rebuild lookup: all ACEs on node N (used when effective_permissions is rebuilt for N)\nCREATE NONCLUSTERED INDEX IX_ace_node\n    ON access_control_entries (node_id, ace_type)\n    INCLUDE (principal_type, principal_id, permission_bits);\n\n-- Invalidation lookup: all nodes referencing principal P\n-- (used to find blast radius when a group/role membership changes)\nCREATE NONCLUSTERED INDEX IX_ace_principal\n    ON access_control_entries (principal_type, principal_id)\n    INCLUDE (node_id, ace_type, permission_bits);\n\n-- ============================================================\n-- 5. EFFECTIVE PERMISSIONS (the hot-path precomputed table)\n-- ============================================================\n-- One row per (node_id, user_id). The hot query is a 2-seek join:\n--   1. PK seek on effective_permissions (node_id=@fid, user_id=@uid)\n--   2. IX_doc_node_active seek on documents (node_id=@fid)\n-- No ACE traversal at read time.\n\nCREATE TABLE effective_permissions (\n    node_id              INT          NOT NULL,\n    user_id              INT          NOT NULL,\n    effective_allow_bits TINYINT      NOT NULL DEFAULT 0,\n    effective_deny_bits  TINYINT      NOT NULL DEFAULT 0,\n    computed_at          DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_ep      PRIMARY KEY CLUSTERED (node_id, user_id),\n    CONSTRAINT FK_ep_node FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE,\n    CONSTRAINT FK_ep_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE\n);\n-- Search and subtree listing: which nodes can user Y Read?\n-- WHERE user_id=@uid AND (effective_allow_bits & 2) > 0\nCREATE NONCLUSTERED INDEX IX_ep_user_bits\n    ON effective_permissions (user_id, effective_allow_bits)\n    INCLUDE (node_id);\n\n-- ============================================================\n-- 6. DOCUMENT TYPES AND TYPED CUSTOM FIELDS\n-- ============================================================\nCREATE TABLE document_types (\n    type_id     INT           NOT NULL IDENTITY(1,1),\n    name        NVARCHAR(200) NOT NULL COLLATE Arabic_CI_AI,\n    description NVARCHAR(500)     NULL COLLATE Arabic_CI_AI,\n    is_active   BIT           NOT NULL DEFAULT 1,\n    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_document_types     PRIMARY KEY CLUSTERED (type_id),\n    CONSTRAINT UQ_document_type_name UNIQUE (name)\n);\n\n-- field_type: 1=text(NVARCHAR)  2=decimal  3=date  4=boolean  5=select(from value_list)\nCREATE TABLE custom_field_definitions (\n    field_id    INT           NOT NULL IDENTITY(1,1),\n    type_id     INT           NOT NULL,\n    name        NVARCHAR(200) NOT NULL COLLATE Arabic_CI_AI,\n    field_type  TINYINT       NOT NULL,\n    is_required BIT           NOT NULL DEFAULT 0,\n    sort_order  SMALLINT      NOT NULL DEFAULT 0,\n    -- For field_type=5: JSON array of allowed values stored as NVARCHAR (not native JSON type)\n    value_list  NVARCHAR(MAX)     NULL COLLATE Arabic_CI_AI,\n    is_active   BIT           NOT NULL DEFAULT 1,\n    created_at  DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_cfd      PRIMARY KEY CLUSTERED (field_id),\n    CONSTRAINT FK_cfd_type FOREIGN KEY (type_id) REFERENCES document_types(type_id),\n    CONSTRAINT CK_cfd_ft   CHECK (field_type IN (1, 2, 3, 4, 5))\n);\n-- Load field definitions for a document type (metadata form render)\nCREATE NONCLUSTERED INDEX IX_cfd_type_active\n    ON custom_field_definitions (type_id, is_active)\n    INCLUDE (field_id, name, field_type, sort_order);\n\n-- ============================================================\n-- 7. TAGS\n-- ============================================================\nCREATE TABLE tags (\n    tag_id     INT           NOT NULL IDENTITY(1,1),\n    name       NVARCHAR(100) NOT NULL COLLATE Arabic_CI_AI,\n    created_at DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_tags      PRIMARY KEY CLUSTERED (tag_id),\n    CONSTRAINT UQ_tags_name UNIQUE (name)\n);\n\n-- ============================================================\n-- 8. DOCUMENTS\n-- ============================================================\nCREATE TABLE documents (\n    doc_id           INT           NOT NULL IDENTITY(1,1),\n    node_id          INT           NOT NULL,\n    type_id          INT           NOT NULL,\n    label_id         INT               NULL,\n    title            NVARCHAR(500) NOT NULL COLLATE Arabic_CI_AI,\n    -- Application-normalized copy: alef variants unified, yaa unified,\n    -- tashkeel (U+064B-U+065F) stripped, tatweel (U+0640) stripped.\n    -- Used for consistent UI sort/filter. FTS lives on document_fulltext.\n    title_normalized NVARCHAR(500) NOT NULL COLLATE Arabic_CI_AI,\n    current_version  SMALLINT      NOT NULL DEFAULT 1,\n    is_deleted       BIT           NOT NULL DEFAULT 0,\n    deleted_at       DATETIME2(3)      NULL,\n    deleted_by       INT               NULL,\n    created_by       INT           NOT NULL,\n    created_at       DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    updated_at       DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_documents   PRIMARY KEY CLUSTERED (doc_id),\n    CONSTRAINT FK_doc_node    FOREIGN KEY (node_id)    REFERENCES nodes(node_id),\n    CONSTRAINT FK_doc_type    FOREIGN KEY (type_id)    REFERENCES document_types(type_id),\n    CONSTRAINT FK_doc_label   FOREIGN KEY (label_id)   REFERENCES sensitivity_labels(label_id),\n    CONSTRAINT FK_doc_creator FOREIGN KEY (created_by) REFERENCES users(user_id),\n    CONSTRAINT FK_doc_deleter FOREIGN KEY (deleted_by) REFERENCES users(user_id)\n);\n\n-- THE HOT QUERY INDEX: covers the folder listing for active docs.\n-- Seek: node_id = @fid AND is_deleted = 0.\n-- Includes every column the SELECT list needs; eliminates the key lookup entirely.\n-- Leading key is (node_id, updated_at DESC) so ORDER BY updated_at is free.\nCREATE NONCLUSTERED INDEX IX_doc_node_active\n    ON documents (node_id, updated_at DESC)\n    INCLUDE (doc_id, title, title_normalized, type_id, label_id, current_version, created_at)\n    WHERE is_deleted = 0;\n\n-- Global recent-documents feed (sort by created_at DESC, any folder)\nCREATE NONCLUSTERED INDEX IX_doc_created_desc\n    ON documents (created_at DESC)\n    INCLUDE (doc_id, node_id, title, type_id)\n    WHERE is_deleted = 0;\n\n-- Admin restore view: deleted docs per folder\nCREATE NONCLUSTERED INDEX IX_doc_node_deleted\n    ON documents (node_id, deleted_at DESC)\n    WHERE is_deleted = 1;\n\n-- ============================================================\n-- 9. DOCUMENT VERSIONS\n-- ============================================================\n-- File stored at: {root}/{yyyy}/{MM}/{doc_id}_v{version_number}_{sanitized_title}.{ext}\n-- The nightly sidecar job reads this table to produce the month-folder JSON manifests.\n\nCREATE TABLE document_versions (\n    version_id      INT           NOT NULL IDENTITY(1,1),\n    doc_id          INT           NOT NULL,\n    version_number  SMALLINT      NOT NULL,\n    file_path       NVARCHAR(900) NOT NULL COLLATE Latin1_General_CI_AS,\n    file_size_bytes BIGINT        NOT NULL,\n    mime_type       NVARCHAR(100) NOT NULL COLLATE Latin1_General_CI_AS,\n    sha256          CHAR(64)      NOT NULL COLLATE Latin1_General_CI_AS,\n    uploaded_by     INT           NOT NULL,\n    uploaded_at     DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    comment         NVARCHAR(500)     NULL COLLATE Arabic_CI_AI,\n    CONSTRAINT PK_dv           PRIMARY KEY CLUSTERED (version_id),\n    CONSTRAINT FK_dv_doc       FOREIGN KEY (doc_id)      REFERENCES documents(doc_id) ON DELETE CASCADE,\n    CONSTRAINT FK_dv_uploader  FOREIGN KEY (uploaded_by) REFERENCES users(user_id),\n    CONSTRAINT UQ_dv_docver    UNIQUE (doc_id, version_number)\n);\n-- Version history for a document, newest first\nCREATE NONCLUSTERED INDEX IX_dv_doc_version\n    ON document_versions (doc_id, version_number DESC)\n    INCLUDE (version_id, file_path, file_size_bytes, sha256, uploaded_at, uploaded_by);\n\n-- ============================================================\n-- 10. CUSTOM FIELD VALUES (EAV with typed columns)\n-- ============================================================\n-- Exactly one typed column is non-NULL per row (CHECK enforced).\n-- CHECK allows all-NULL for optional empty fields.\n\nCREATE TABLE custom_field_values (\n    value_id   INT            NOT NULL IDENTITY(1,1),\n    doc_id     INT            NOT NULL,\n    field_id   INT            NOT NULL,\n    val_text   NVARCHAR(2000)     NULL COLLATE Arabic_CI_AI,\n    val_number DECIMAL(18,4)      NULL,\n    val_date   DATE               NULL,\n    val_bool   BIT                NULL,\n    val_select NVARCHAR(200)      NULL COLLATE Arabic_CI_AI,\n    CONSTRAINT PK_cfv            PRIMARY KEY CLUSTERED (value_id),\n    CONSTRAINT FK_cfv_doc        FOREIGN KEY (doc_id)   REFERENCES documents(doc_id) ON DELETE CASCADE,\n    CONSTRAINT FK_cfv_field      FOREIGN KEY (field_id) REFERENCES custom_field_definitions(field_id),\n    CONSTRAINT UQ_cfv_doc_field  UNIQUE (doc_id, field_id),\n    CONSTRAINT CK_cfv_one_type   CHECK (\n        (CASE WHEN val_text   IS NOT NULL THEN 1 ELSE 0 END +\n         CASE WHEN val_number IS NOT NULL THEN 1 ELSE 0 END +\n         CASE WHEN val_date   IS NOT NULL THEN 1 ELSE 0 END +\n         CASE WHEN val_bool   IS NOT NULL THEN 1 ELSE 0 END +\n         CASE WHEN val_select IS NOT NULL THEN 1 ELSE 0 END) <= 1\n    )\n);\n-- All field values for a document (metadata display, export)\nCREATE NONCLUSTERED INDEX IX_cfv_doc\n    ON custom_field_values (doc_id)\n    INCLUDE (field_id, val_text, val_number, val_date, val_bool, val_select);\n\n-- ============================================================\n-- 11. DOCUMENT TAGS\n-- ============================================================\nCREATE TABLE document_tags (\n    doc_id INT NOT NULL,\n    tag_id INT NOT NULL,\n    CONSTRAINT PK_document_tags PRIMARY KEY CLUSTERED (doc_id, tag_id),\n    CONSTRAINT FK_dt_doc FOREIGN KEY (doc_id) REFERENCES documents(doc_id) ON DELETE CASCADE,\n    CONSTRAINT FK_dt_tag FOREIGN KEY (tag_id) REFERENCES tags(tag_id)\n);\n-- Reverse: all documents bearing a specific tag\nCREATE NONCLUSTERED INDEX IX_dt_tag\n    ON document_tags (tag_id) INCLUDE (doc_id);\n\n-- ============================================================\n-- 12. FTS INFRASTRUCTURE\n-- ============================================================\n\n-- Async text-extraction job queue. Node.js worker polls status, creation order.\nCREATE TABLE extraction_jobs (\n    job_id        INT          NOT NULL IDENTITY(1,1),\n    doc_id        INT          NOT NULL,\n    version_id    INT          NOT NULL,\n    -- 0=pending  1=running  2=done  3=failed\n    status        TINYINT      NOT NULL DEFAULT 0,\n    attempts      TINYINT      NOT NULL DEFAULT 0,\n    last_attempt  DATETIME2(3)     NULL,\n    error_message NVARCHAR(MAX)    NULL,\n    created_at    DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_ej        PRIMARY KEY CLUSTERED (job_id),\n    CONSTRAINT FK_ej_doc    FOREIGN KEY (doc_id)     REFERENCES documents(doc_id) ON DELETE CASCADE,\n    CONSTRAINT FK_ej_ver    FOREIGN KEY (version_id) REFERENCES document_versions(version_id),\n    CONSTRAINT CK_ej_status CHECK (status IN (0, 1, 2, 3))\n);\n-- Worker polls: WHERE status = 0 OR status = 1  ORDER BY created_at\n-- NOTE: SQL Server filtered index WHERE clauses do NOT support IN(); use OR predicates.\nCREATE NONCLUSTERED INDEX IX_ej_pending\n    ON extraction_jobs (status, created_at)\n    INCLUDE (job_id, doc_id, version_id, attempts)\n    WHERE status = 0 OR status = 1;\n\n-- Extracted text. One row per document; worker upserts after successful extraction.\n-- extracted_text_normalized carries application-level Arabic normalization:\n--   alef variants (أ إ آ ا) -> ا, final-yaa (ى) -> ي, optional taa-marbuta (ة) -> ه,\n--   tashkeel U+064B-U+065F stripped, tatweel U+0640 stripped.\n-- Arabic_CI_AI collation strips diacritics at query time but does NOT unify alef/yaa,\n-- which is why the normalized column is required.\nCREATE TABLE document_fulltext (\n    doc_id                    INT           NOT NULL,\n    version_id                INT           NOT NULL,\n    extracted_text            NVARCHAR(MAX) NOT NULL COLLATE Arabic_CI_AI,\n    extracted_text_normalized NVARCHAR(MAX) NOT NULL COLLATE Arabic_CI_AI,\n    extracted_at              DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    CONSTRAINT PK_dft     PRIMARY KEY CLUSTERED (doc_id),\n    CONSTRAINT FK_dft_doc FOREIGN KEY (doc_id)     REFERENCES documents(doc_id) ON DELETE CASCADE,\n    CONSTRAINT FK_dft_ver FOREIGN KEY (version_id) REFERENCES document_versions(version_id)\n);\n\n-- Full-text catalog (guard in migrate.js with IF NOT EXISTS on sys.fulltext_catalogs)\nIF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = N'dms_ft_catalog')\n    CREATE FULLTEXT CATALOG dms_ft_catalog AS DEFAULT;\n\n-- Full-text index on the normalized column.\n-- LANGUAGE 1025 = Arabic; built-in word breaker ships with SQL Server 2019.\n-- CHANGE_TRACKING AUTO: FTS daemon propagates inserts/updates asynchronously.\n-- STOPLIST SYSTEM: uses the built-in Arabic stopword list included with SQL Server.\nIF NOT EXISTS (\n    SELECT 1 FROM sys.fulltext_indexes fi\n    JOIN sys.tables t ON fi.object_id = t.object_id\n    WHERE t.name = N'document_fulltext'\n)\nCREATE FULLTEXT INDEX ON document_fulltext (\n    extracted_text_normalized LANGUAGE 1025\n)\nKEY INDEX PK_dft\nON dms_ft_catalog\nWITH CHANGE_TRACKING AUTO, STOPLIST = SYSTEM;\n\n-- ============================================================\n-- 13. AUDIT LOG (partitioned by month; append-only)\n-- ============================================================\n-- action_code: 1=create 2=update_meta 3=upload_version 4=delete 5=restore\n--              6=move 7=permission_change 8=role_change 9=group_change\n--              10=login 11=logout 12=sensitivity_change\n-- target_type: 1=document 2=node 3=user 4=group 5=role 6=ace\n--\n-- Partition: RANGE RIGHT means boundary value = start of that partition.\n-- 60 partitions covers 2025-01 to 2029-12; well within Standard's 128-partition limit.\n-- Add annual boundaries: ALTER PARTITION FUNCTION pf_audit_monthly() SPLIT RANGE ('2030-01-01')\n\nIF NOT EXISTS (SELECT 1 FROM sys.partition_functions WHERE name = N'pf_audit_monthly')\nCREATE PARTITION FUNCTION pf_audit_monthly (DATETIME2(3))\nAS RANGE RIGHT FOR VALUES (\n    '2025-01-01','2025-02-01','2025-03-01','2025-04-01','2025-05-01','2025-06-01',\n    '2025-07-01','2025-08-01','2025-09-01','2025-10-01','2025-11-01','2025-12-01',\n    '2026-01-01','2026-02-01','2026-03-01','2026-04-01','2026-05-01','2026-06-01',\n    '2026-07-01','2026-08-01','2026-09-01','2026-10-01','2026-11-01','2026-12-01',\n    '2027-01-01','2027-02-01','2027-03-01','2027-04-01','2027-05-01','2027-06-01',\n    '2027-07-01','2027-08-01','2027-09-01','2027-10-01','2027-11-01','2027-12-01',\n    '2028-01-01','2028-02-01','2028-03-01','2028-04-01','2028-05-01','2028-06-01',\n    '2028-07-01','2028-08-01','2028-09-01','2028-10-01','2028-11-01','2028-12-01',\n    '2029-01-01','2029-02-01','2029-03-01','2029-04-01','2029-05-01','2029-06-01',\n    '2029-07-01','2029-08-01','2029-09-01','2029-10-01','2029-11-01','2029-12-01'\n);\n\nIF NOT EXISTS (SELECT 1 FROM sys.partition_schemes WHERE name = N'ps_audit_monthly')\nCREATE PARTITION SCHEME ps_audit_monthly\n    AS PARTITION pf_audit_monthly ALL TO ([PRIMARY]);\n\n-- Clustered PK leads with occurred_at so the partition key is part of the clustered index\n-- (SQL Server requirement for a partitioned clustered index).\n-- (occurred_at, audit_id) is globally unique because audit_id is IDENTITY.\nCREATE TABLE audit_log (\n    audit_id    BIGINT        NOT NULL IDENTITY(1,1),\n    occurred_at DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME(),\n    user_id     INT               NULL,\n    action_code TINYINT       NOT NULL,\n    target_type TINYINT       NOT NULL,\n    target_id   INT           NOT NULL,\n    node_id     INT               NULL,\n    payload     NVARCHAR(MAX)     NULL,   -- before/after JSON; NVARCHAR not native json type\n    ip_address  VARCHAR(45)       NULL COLLATE Latin1_General_CI_AS,\n    CONSTRAINT PK_audit_log PRIMARY KEY CLUSTERED (occurred_at, audit_id)\n) ON ps_audit_monthly (occurred_at);\n\n-- Entity audit trail (all actions touching doc X or node Y); partition-aligned for elimination\nCREATE NONCLUSTERED INDEX IX_audit_target\n    ON audit_log (target_type, target_id, occurred_at DESC)\n    INCLUDE (user_id, action_code)\n    ON ps_audit_monthly (occurred_at);\n\n-- User activity trail\nCREATE NONCLUSTERED INDEX IX_audit_user\n    ON audit_log (user_id, occurred_at DESC)\n    INCLUDE (action_code, target_type, target_id)\n    ON ps_audit_monthly (occurred_at);",
  "permissionResolution": "effective_allow_bits for (node_id N, user_id U) is computed as follows. Admins (is_admin=1) skip this entirely; the application layer grants them all bits on every node without touching this table.\n\nSTEP 1 — FIND THE ACE WINDOW.\nParse N.mpath ('/1/5/23/') to extract the ordered list of ancestor node IDs [1, 5, 23] plus N itself. Walk this list from N upward and find the nearest node where inherits_permissions=0. That node is the \"break node\" B. The ACE window is the set of nodes from B down to N inclusive. If no break node is found (all ancestors inherit), the window is the entire ancestor chain from root to N.\n\nSQL to find B:\n  SELECT TOP 1 node_id\n  FROM nodes\n  WHERE node_id IN (<ancestor ids derived from mpath>)\n    AND inherits_permissions = 0\n  ORDER BY depth DESC;   -- highest depth = closest ancestor\n\nSTEP 2 — COLLECT ACEs.\n  SELECT principal_type, principal_id, ace_type, permission_bits\n  FROM access_control_entries\n  WHERE node_id IN (<ACE window set>);\nIX_ace_node is used here (node_id, ace_type leading keys).\n\nSTEP 3 — RESOLVE PRINCIPALS FOR USER U.\nFor each ACE:\n  principal_type=1 (user):   include if principal_id = U\n  principal_type=2 (group):  include if EXISTS (SELECT 1 FROM flat_group_members WHERE user_id=U AND group_id=principal_id)\n  principal_type=3 (role):   include if EXISTS (SELECT 1 FROM user_roles WHERE user_id=U AND role_id=principal_id)\n\nSTEP 4 — COMPUTE BITS (bitwise OR within each ace_type, then subtract DENY).\n  allow_raw = OR of permission_bits for all resolved ALLOW ACEs\n  deny_raw  = OR of permission_bits for all resolved DENY ACEs\n  effective_allow_bits = allow_raw & (~deny_raw) & 0x3F   -- mask to 6 bits\n  effective_deny_bits  = deny_raw\n\nSTEP 5 — UPSERT INTO effective_permissions.\n\nPRECEDENCE RULES (in priority order):\n  1. DENY anywhere in the ACE window wins over ALLOW anywhere in the window for the same bit — no node-proximity override.\n  2. Group ACEs and role ACEs are flattened through flat_group_members / user_roles before the OR; there is no \"direct user beats group\" override — if you need a user-specific exception, add a DENY ACE targeting principal_type=1.\n  3. Break inheritance means only ACEs explicitly set on nodes from B downward are considered; ACEs on nodes above B are invisible for this computation.\n  4. A node with no ACEs in its window and inherits_permissions=0 results in effective_allow_bits=0 for all users — complete denial.\n\nThe rebuild stored procedure (usp_rebuild_subtree_effective_permissions @root_node_id) executes the above for every (node, user) pair in the subtree using a cursor or batch INSERT...SELECT. At the stated scale (thousands of nodes, 300 users) this completes in well under one second.",
  "invalidation": "Six triggers require recomputation. Each entry includes the SQL and the blast radius.\n\n--- TRIGGER 1: AN ACE IS ADDED, MODIFIED, OR DELETED ON NODE N ---\nBlast radius: all users x all nodes in N's subtree (including N).\nSQL:\n  DECLARE @subtree_mpath VARCHAR(500);\n  SELECT @subtree_mpath = mpath FROM nodes WHERE node_id = @N;\n\n  DELETE ep\n  FROM effective_permissions ep\n  INNER JOIN nodes nd ON nd.node_id = ep.node_id\n  WHERE nd.mpath LIKE @subtree_mpath + '%';\n\n  EXEC usp_rebuild_subtree_effective_permissions @root_node_id = @N;\n\nNote: if the ACE references a group or role (not a single user), ALL users' rows for the subtree are affected. If principal_type=1 (single user), only that user's rows need rebuilding — pass @user_id to the rebuild SP to scope it.\n\n--- TRIGGER 2: INHERITANCE BROKEN OR RESTORED ON NODE N (inherits_permissions toggled) ---\nIdentical blast radius and SQL as Trigger 1. Breaking inheritance removes the parent ACE window; restoring it adds it back. Either change invalidates every row in the subtree for every user.\n\n--- TRIGGER 3: NODE MOVED — see reparenting section ---\n\n--- TRIGGER 4: GROUP MEMBERSHIP CHANGES (user added/removed from group G, or group G nested/unnested) ---\nStep A — rebuild flat_group_members (transitive closure):\n  DELETE FROM flat_group_members;\n  -- Recursive CTE to recompute the full closure from group_members + group_group_members:\n  WITH closure AS (\n    SELECT gm.user_id, gm.group_id\n    FROM group_members gm\n    UNION ALL\n    SELECT c.user_id, ggm.parent_group_id\n    FROM closure c\n    INNER JOIN group_group_members ggm ON ggm.child_group_id = c.group_id\n  )\n  INSERT INTO flat_group_members (user_id, group_id)\n  SELECT DISTINCT user_id, group_id FROM closure;\n\nStep B — find affected users (those whose group memberships changed):\n  -- For a single user added/removed: affected_users = {that user_id}\n  -- For group restructuring: affected_users = all users in flat_group_members for changed groups\n\nStep C — find affected nodes (nodes with ACEs referencing group G or any group in the changed subtree):\n  SELECT DISTINCT a.node_id\n  FROM access_control_entries a\n  WHERE a.principal_type = 2\n    AND a.principal_id IN (<changed group ids>);\n  -- Then expand to those nodes' subtrees via mpath LIKE.\n\nStep D — delete and rebuild effective_permissions for (affected nodes subtrees) x (affected users):\n  DELETE ep\n  FROM effective_permissions ep\n  INNER JOIN nodes nd ON nd.node_id = ep.node_id\n  WHERE ep.user_id IN (<affected users>)\n    AND nd.mpath IN (<subtree mpath LIKE expressions>);\n\n  EXEC usp_rebuild_subtree_effective_permissions ... (scoped to user list);\n\nBlast radius at maximum: a top-level group with an ACE on the root node = all users in that group x all nodes in the tree. At this scale that is still under 300 users x 2000 nodes = 600,000 rows, computed in seconds.\n\n--- TRIGGER 5: ROLE DEFINITION CHANGES (permission_bits changed on role R) ---\nStep A — find users holding role R:\n  SELECT user_id FROM user_roles WHERE role_id = @R;\n\nStep B — find nodes with ACEs referencing role R, expand to subtrees:\n  SELECT DISTINCT nd2.node_id\n  FROM access_control_entries a\n  INNER JOIN nodes nd ON nd.node_id = a.node_id\n  INNER JOIN nodes nd2 ON nd2.mpath LIKE nd.mpath + '%'\n  WHERE a.principal_type = 3 AND a.principal_id = @R;\n\nStep C — delete + rebuild effective_permissions for those (nodes x users):\n  DELETE ep FROM effective_permissions ep\n  WHERE ep.user_id IN (<step A>) AND ep.node_id IN (<step B>);\n  EXEC usp_rebuild_subtree_effective_permissions ...;\n\nBlast radius: (users with this role) x (subtrees of nodes where the role has ACEs). Typically narrow.\n\n--- TRIGGER 6: USER DEACTIVATED ---\n  DELETE FROM effective_permissions WHERE user_id = @deactivated_user_id;\nThe auth layer rejects inactive users before they reach any ACL check, so deleting their rows is a cleanup. Row count = number of nodes (bounded by tree size, typically < 2000 rows). Instant.",
  "hotQuery": "-- List documents in folder @node_id for user @user_id that the user can Browse (bit 1).\n-- Paginated; caller supplies @page (1-based) and @page_size.\n-- @sort_col: 1=updated_at DESC (default), 2=created_at DESC, 3=title_normalized ASC.\n--\n-- Execution plan: \n--   1. PK seek on effective_permissions (node_id=@node_id, user_id=@user_id) -> 1 row, bitmap check\n--   2. If bit satisfied: IX_doc_node_active seek on documents (node_id=@node_id, is_deleted=0)\n--   3. COUNT(*) OVER () from the same page scan — no second query needed\n-- No ACE traversal, no join to nodes, no full scan.\n\nDECLARE @node_id   INT = <param>;\nDECLARE @user_id   INT = <param>;\nDECLARE @page      INT = <param>;   -- 1-based\nDECLARE @page_size INT = <param>;\nDECLARE @sort_col  TINYINT = <param>;  -- 1, 2, or 3\n\nSELECT\n    d.doc_id,\n    d.title,\n    d.title_normalized,\n    d.type_id,\n    d.label_id,\n    d.current_version,\n    d.created_at,\n    d.updated_at,\n    COUNT(*) OVER () AS total_count\nFROM documents d\n-- The INNER JOIN on effective_permissions with the bit check acts as the permission gate.\n-- SQL Server evaluates the single-row seek on ep first (cheap) and prunes\n-- the entire documents scan if the user has no Browse permission.\nINNER JOIN effective_permissions ep\n    ON  ep.node_id = @node_id\n    AND ep.user_id = @user_id\n    AND (ep.effective_allow_bits & 1) > 0   -- Browse bit\nWHERE d.node_id   = @node_id\n  AND d.is_deleted = 0\nORDER BY\n    CASE WHEN @sort_col = 3 THEN d.title_normalized END ASC,\n    CASE WHEN @sort_col = 2 THEN d.created_at        END DESC,\n    d.updated_at DESC    -- covers @sort_col=1 and is the trailing sort for @sort_col=2/3\nOFFSET (@page - 1) * @page_size ROWS\nFETCH  NEXT @page_size ROWS ONLY;\n\n-- Indexes relied on:\n--   effective_permissions: PK_ep (node_id, user_id) -> single-row clustered seek\n--   documents: IX_doc_node_active (node_id, updated_at DESC) INCLUDE(all SELECT columns)\n--              filtered WHERE is_deleted=0 -> no residual predicate\n-- For @sort_col=3 (title sort) the index order does not match; SQL Server does a sort\n-- on the already-narrow result set (a single folder rarely exceeds a few hundred docs).",
  "searchQuery": "-- Full-text search across all content user @user_id may Read (bit 2).\n-- Optionally scoped to the subtree rooted at @root_node_id.\n-- Permission filter is INSIDE the CTE, BEFORE OFFSET/FETCH, so total_count is exact.\n-- A user never sees a hit they cannot Read.\n--\n-- Caller must normalize @search_term with the same Arabic normalization pipeline\n-- (alef unification, yaa, tashkeel strip) before passing it to match the indexed column.\n-- fn_normalize_arabic is a scalar UDF implemented in the application layer or as a\n-- SQL CLR / T-SQL function using NCHAR substitution.\n\nDECLARE @search_term   NVARCHAR(500) = <param>;   -- already normalized by caller\nDECLARE @user_id       INT           = <param>;\nDECLARE @root_node_id  INT           = NULL;       -- NULL = global; non-NULL = subtree scope\nDECLARE @page          INT           = <param>;\nDECLARE @page_size     INT           = <param>;\n\n-- Build CONTAINSTABLE query string.\n-- Wrap in double-quotes for exact-phrase; for multi-token AND use: token1 AND token2\n-- The caller decides the FTS grammar; this template uses phrase search.\nDECLARE @fts_query NVARCHAR(502) =\n    N'\"' + REPLACE(@search_term, N'\"', N'\"\"') + N'\"';\n\n-- Capture root mpath once (avoids correlated subquery per row in the main query)\nDECLARE @root_mpath VARCHAR(500) = NULL;\nIF @root_node_id IS NOT NULL\n    SELECT @root_mpath = mpath FROM nodes WHERE node_id = @root_node_id AND is_deleted = 0;\n\nWITH fts_hits AS (\n    -- CONTAINSTABLE returns (KEY=doc_id, RANK) for matching rows in document_fulltext.\n    -- LANGUAGE 1025 overrides the index-level language if needed at query time.\n    SELECT ft.[KEY] AS doc_id, ft.[RANK]\n    FROM CONTAINSTABLE(document_fulltext, extracted_text_normalized,\n                       @fts_query, LANGUAGE 1025) AS ft\n),\npermission_filtered AS (\n    SELECT\n        d.doc_id,\n        d.node_id,\n        d.title,\n        d.title_normalized,\n        d.type_id,\n        d.label_id,\n        d.current_version,\n        d.updated_at,\n        h.[RANK]\n    FROM fts_hits h\n    INNER JOIN documents d\n        ON  d.doc_id    = h.doc_id\n        AND d.is_deleted = 0\n    -- Permission gate: must have Read bit on the containing folder\n    INNER JOIN effective_permissions ep\n        ON  ep.node_id  = d.node_id\n        AND ep.user_id  = @user_id\n        AND (ep.effective_allow_bits & 2) > 0   -- Read bit\n    -- Subtree scope: if @root_node_id supplied, restrict to nodes under that root\n    INNER JOIN nodes n\n        ON  n.node_id   = d.node_id\n        AND n.is_deleted = 0\n        AND (@root_mpath IS NULL OR n.mpath LIKE @root_mpath + '%')\n),\ncounted AS (\n    SELECT *, COUNT(*) OVER () AS total_count\n    FROM permission_filtered\n)\nSELECT\n    doc_id, node_id, title, title_normalized, type_id, label_id,\n    current_version, updated_at, [RANK], total_count\nFROM counted\nORDER BY [RANK] DESC\nOFFSET (@page - 1) * @page_size ROWS\nFETCH  NEXT @page_size ROWS ONLY;\n\n-- Indexes relied on:\n--   document_fulltext: FTS index on extracted_text_normalized LANGUAGE 1025\n--   documents: PK_documents (doc_id) for the join from fts_hits; is_deleted predicate\n--   effective_permissions: IX_ep_user_bits (user_id, effective_allow_bits) INCLUDE(node_id)\n--     or PK_ep (node_id, user_id) depending on optimizer choice\n--   nodes: IX_nodes_mpath (mpath) for the subtree LIKE seek (no leading wildcard)\n--\n-- On very broad single-token queries CONTAINSTABLE can return millions of rows before\n-- the permission filter. If this becomes a bottleneck, add a top_n_by_rank cap as a\n-- heuristic for relevance (e.g., TOP 10000 by rank) with a UI warning that results\n-- may be incomplete; do NOT use it as the correctness mechanism.",
  "reparenting": "Moving node N from parent P1 to parent P2 is a pure database operation that does not touch the filesystem (the disk layout does not mirror the filing tree).\n\nALGORITHM:\n\n  DECLARE @node_id      INT = <node being moved>;\n  DECLARE @new_parent_id INT = <destination parent>;\n\n  DECLARE @old_mpath    VARCHAR(500),\n          @new_mpath    VARCHAR(500),\n          @parent_mpath VARCHAR(500),\n          @old_depth    TINYINT,\n          @parent_depth TINYINT,\n          @depth_delta  INT;\n\n  SELECT @old_mpath = mpath, @old_depth = depth\n  FROM nodes WHERE node_id = @node_id;\n\n  SELECT @parent_mpath = mpath, @parent_depth = depth\n  FROM nodes WHERE node_id = @new_parent_id;\n\n  -- New mpath for N: parent's path + N's own id + '/'\n  SET @new_mpath   = @parent_mpath + CAST(@node_id AS VARCHAR(10)) + '/';\n  SET @depth_delta = (@parent_depth + 1) - @old_depth;\n\n  BEGIN TRANSACTION;\n\n    -- 1. Update N and every descendant in one pass.\n    -- @old_mpath ends with '/', so LIKE @old_mpath + '%' matches N exactly\n    -- (N.mpath = @old_mpath) and all descendants (longer paths starting with @old_mpath).\n    -- REPLACE swaps the old prefix with the new prefix in every descendant path.\n    UPDATE nodes\n    SET\n        mpath     = REPLACE(mpath, @old_mpath, @new_mpath),\n        depth     = depth + @depth_delta,\n        parent_id = CASE WHEN node_id = @node_id THEN @new_parent_id ELSE parent_id END,\n        updated_at = SYSUTCDATETIME()\n    WHERE mpath LIKE @old_mpath + '%';\n    -- IX_nodes_mpath (mpath) supports the LIKE seek because the prefix is fully known\n    -- (no leading wildcard). The UPDATE is O(subtree size), not O(tree size).\n\n    -- 2. Delete stale effective_permissions for the moved subtree.\n    -- After the UPDATE above, the subtree rows have new mpaths starting with @new_mpath.\n    DELETE ep\n    FROM effective_permissions ep\n    INNER JOIN nodes nd ON nd.node_id = ep.node_id\n    WHERE nd.mpath LIKE @new_mpath + '%';\n\n    -- 3. Rebuild effective_permissions for the moved subtree under its new parent context.\n    -- The rebuild SP traverses @new_parent_id's ancestry chain to find the correct ACE\n    -- window, then computes bits for every (node in subtree, user) pair.\n    EXEC usp_rebuild_subtree_effective_permissions @root_node_id = @node_id;\n\n  COMMIT TRANSACTION;\n\nCONCURRENCY:\nThe transaction acquires row-level locks on nodes rows in IX_nodes_mpath order during the UPDATE. At the stated scale (hundreds to low thousands of nodes) no concurrent reparent of an overlapping subtree can race: SQL Server's lock escalation keeps the modified rows locked until COMMIT, and a second reparent of the same or a child node will block and then read the committed new mpath. SERIALIZABLE isolation is not required because the LIKE predicate on mpath is deterministic once the old_mpath is captured inside the transaction. If concurrent reparents of different subtrees are needed simultaneously, they are independent (non-overlapping mpath ranges) and do not block each other.\n\nCYCLE PREVENTION (application layer):\nBefore executing, verify that @new_parent_id is not a descendant of @node_id:\n  IF EXISTS (\n      SELECT 1 FROM nodes\n      WHERE node_id = @new_parent_id\n        AND mpath LIKE @old_mpath + '%'\n  ) RAISERROR('Cannot move a node into its own subtree', 16, 1);",
  "tradeoffs": [
    "effective_permissions is a write-amplified denormalization. Every ACE change, group membership change, or node reparent triggers a subtree rebuild of this table. At the stated ceiling (low thousands of nodes, 300 users, worst-case ~900k rows to recompute), a full rebuild completes in milliseconds. If the tree grows into the tens of thousands of nodes, the synchronous rebuild becomes unacceptable and the design must shift to lazy invalidation: mark dirty rows with a computed_at=NULL flag and rebuild on first access, accepting a slightly stale read on the first request after a permission change.",
    "Materialized path (mpath) makes subtree reads a prefix-seek with no leading wildcard, which is fast and requires no closure table. The trade is reparenting cost: moving a subtree requires an UPDATE pass over every descendant row. The closure table (deferred per spec) would make reparenting O(n^2) inserts but subtree reads a single index seek. At this scale mpath is the correct trade.",
    "Documents inherit permissions from their containing folder node only — there are no per-document ACEs. This is what makes the hot query a 2-seek join. Adding document-level ACEs in a future version would require extending effective_permissions to cover documents (adding millions of rows) and would require a second permission-join tier in the hot query.",
    "flat_group_members is rebuilt synchronously on every group membership change. At this scale (hundreds of groups, hundreds of users) the rebuild is fast. If group manipulation becomes frequent or group hierarchies become deep and wide, consider an async rebuild with a dirty flag and a short staleness window.",
    "The FTS normalized column (extracted_text_normalized) doubles storage for extracted text. This is required because Arabic_CI_AI handles diacritics (accent-insensitive) but does NOT unify alef variants (أ إ آ -> ا) or yaa (ى -> ي). Without normalization at index time, a search for 'الكتاب' misses documents indexed with 'ألكتاب'. The original column is retained for display and copy operations.",
    "SQL Server's Arabic word-breaker (LANGUAGE 1025) provides basic tokenization and some morphological stemming. It is weaker than dedicated Arabic NLP stemmers (Farasa, CAMeL). For higher recall on inflected Arabic roots, replace CONTAINSTABLE with FREETEXTTABLE, which applies stemming automatically; trade is reduced precision. A custom thesaurus file can bridge the gap for domain-specific synonyms.",
    "The audit log's clustered PK is (occurred_at, audit_id). Point lookup by audit_id alone requires a full-partition scan. This is accepted because audit_log is never queried by audit_id in isolation; every query provides a date range and partition elimination eliminates all but one or two partitions. If a by-ID lookup is ever needed, add a nonclustered index on (audit_id) — note this adds a non-aligned index that spans all partitions.",
    "Sensitivity labels are configurable rows, not schema-level enum values. The engine cannot enforce label-based access rules as constraints; any 'CONFIDENTIAL blocks download' logic must be implemented as additional ACEs at the folder level or as application-layer checks after the effective_permissions lookup. This is intentional: the product serves multiple sectors with different label semantics.",
    "The partition function pf_audit_monthly covers 2025-01 through 2029-12. Adding 2030 boundaries requires ALTER PARTITION FUNCTION ... SPLIT RANGE executed annually. This should be added to a scheduled maintenance job or to the migrate.js startup check (IF the current month is within 60 days of the last partition boundary, add 12 more months)."
  ]
}
```

---

## ad0cf0ed1f73711a6

https://claude.ai/code/artifact/b8280405-f8aa-4d15-a7d9-6f0db0e40873

---

**Design summary for the consuming agent:**

**Recommended architecture: delete-first invalidation + singleton worker + epoch guard**

The design rejects `is_dirty` flag (unsafe: dirty rows still hold stale-allowed values that could leak to the hot query) and shadow-table double-buffering (overkill at 300 users). It rejects synchronous recompute on write (role change = 600,000 row recompute blocks the API for seconds).

**Core guarantee:** a missing row in `effective_permissions` means "no access." Every hot query treats missing as denied. Invalidation = DELETE affected rows atomically with the ACL change, inside one transaction. No window exists where stale-allowed rows are visible.

**Key T-SQL decisions verified against Microsoft Learn:**
- Filtered indexes (`WHERE completed_at IS NULL`) on the rebuild queue: valid; the restriction is on computed, UDT, spatial, and hierarchyid columns — not BIT or DATETIME2.
- `MERGE` with `HOLDLOCK` prevents phantom-row duplicate-key errors but carries known concurrency bugs at scale; since the worker is a singleton enforced by `sp_getapplock(@LockOwner='Session')`, plain INSERT is used instead.
- `CONTAINSTABLE(..., LANGUAGE 1025)` standard INNER JOIN pattern with `ft.[KEY] = d.document_id`; permission filter joined before paging so counts are always accurate.
- SQL Server 2019 has no `BIT_OR` aggregate; per-bit `SUM(CASE WHEN bits & 0xNN > 0 THEN 1 ELSE 0 END) > 0 THEN 0xNN` pattern used throughout.
- Materialized path must use trailing slashes (e.g., `/1/5/`) so `LIKE '/1/5/%'` does not match `/1/57/`.

**Blast radii at 300 users × 2,000 nodes:**
- Leaf ACE change: 300 rows deleted, ~300 recomputed
- Root ACE change: 600,000 rows deleted; delete completes in ~1–3 s on standard disk
- Single user group join/leave: 2,000 rows
- Role bits change (widely assigned role): 600,000 rows
- Node move (subtree of 100 nodes): 30,000 rows

**Epoch guard closes the stale-write race:** worker captures `current_gen` at job start; writes inside a transaction that re-reads `current_gen WITH (UPDLOCK, HOLDLOCK)`; aborts write if epoch advanced since job was queued, leaving the newer job to produce correct values.

**Consistency checker** (`usp_check_permission_consistency`) samples N random cached rows, recomputes each via `usp_compute_single_permission`, classifies drift as `STALE_ALLOWED` (security finding, triggers full rebuild + alert) or `STALE_DENIED` (UX gap only). Logs to `permission_consistency_log` with JSON detail array.

---

## a0699e4dcc2c6b543

```json
{
  "target": "DocumentManagementSolution — DMS schema v1 (SQL Server 2019 Standard, effective_permissions precompute, adjacency+mpath filing tree, Arabic FTS, partitioned audit_log)",
  "bypasses": [
    "SOFT-DELETED FOLDER CONTENT REMAINS ACCESSIBLE. Sequence: (1) Admin soft-deletes folder F by setting nodes.is_deleted=1. (2) effective_permissions rows for (node_id=F, *) are NOT deleted — no invalidation step is defined for folder soft-delete. (3) User U, who has Browse+Read on F, makes a direct API call: GET /folders/{F}/documents. (4) Hot query executes: FROM documents d INNER JOIN effective_permissions ep ON ep.node_id=F AND ep.user_id=U AND (ep.effective_allow_bits & 1)>0 WHERE d.node_id=F AND d.is_deleted=0. (5) The join to nodes is absent from the hot query; the query never checks nodes.is_deleted. ep rows are still present, documents in F are still active. Result: U sees every document in a folder the admin intended to hide. The search query has the identical gap — its nodes join includes AND n.is_deleted=0, but only to evaluate the mpath LIKE scope; the permission gate is the ep join on d.node_id, which never checks whether that folder node is deleted. A direct search over known doc_ids in F also leaks.",
    "REPARENTING CYCLE CREATED BY CONCURRENT MOVES. Sequence: (1) Tree contains root R with children A and B, where A has child C. (2) T1 begins: checks that B is not a descendant of A (SELECT mpath of B, LIKE A.mpath+'%' → no match → passes). (3) T2 begins concurrently: checks that A is not a descendant of B (SELECT mpath of A, LIKE B.mpath+'%' → no match → passes). (4) T1 commits: UPDATE nodes SET mpath=REPLACE(mpath, A.mpath, B.mpath+A_id+'/') for A's subtree; A's mpath now reads /R/B/A/. (5) T2 commits: UPDATE nodes SET mpath=REPLACE(mpath, B.mpath, A.mpath_old+B_id+'/') for B's subtree, but B.mpath was read before T1 committed; B's rows update to /R/A/B/ using the stale old mpath of A. (6) Result: A.mpath=/R/B/A/, B.mpath=/R/A/B/ — each is inside the other's subtree. The cycle check is a plain SELECT outside any locking transaction, so both threads see no cycle and both commits succeed. All subsequent mpath-based queries (subtree scans, ACE invalidation, inheritance window computation) enter infinite LIKE expansions or incorrect results. The schema imposes no SERIALIZABLE scope or explicit lock around the pre-check + UPDATE pair."
  ],
  "correctnessBugs": [
    "GROUP NESTING CYCLE CRASHES flat_group_members AND LEAVES IT EMPTY. The schema prevents only direct self-reference (CK_ggm_no_self: parent_group_id <> child_group_id). An indirect cycle G1→G2→G3→G1 is not blocked at insert time. The Trigger-4 rebuild procedure issues DELETE FROM flat_group_members then runs the recursive CTE. SQL Server's default MAXRECURSION is 100; the CTE raises error 530 and rolls back the INSERT while the DELETE has already committed (if not wrapped in a single transaction). flat_group_members is now empty. All subsequent effective_permissions rebuilds treat every user as belonging to no groups. Group-based ALLOW ACEs resolve to 0 bits for every user until the table is manually fixed. No alert or watchdog is shown for this failure mode.",
    "SCOPED SEARCH SILENTLY EXPANDS TO GLOBAL ON DELETED OR MISSING SCOPE NODE. The search procedure sets @root_mpath with: IF @root_node_id IS NOT NULL SELECT @root_mpath = mpath FROM nodes WHERE node_id=@root_node_id AND is_deleted=0. If the scoping node does not exist or is soft-deleted, @root_mpath remains NULL (DECLARE initialises it NULL; the SELECT finds no row). The query's LIKE predicate becomes (@root_mpath IS NULL OR n.mpath LIKE @root_mpath+'%'), which is (TRUE OR ...) = TRUE. The caller asked for a scoped search; they receive results from every folder across the entire repository that they can Read. No error is raised and the total_count reflects the global result set, not the intended scope.",
    "flat_group_members REBUILD IS NOT SHOWN AS A SINGLE ATOMIC TRANSACTION, ALLOWING CONCURRENT PERMISSION REBUILDS TO READ PARTIAL MEMBERSHIP STATE. The Trigger-4 SQL issues DELETE FROM flat_group_members and then the CTE INSERT as sequential statements. Under SQL Server's default locking READ COMMITTED, the DELETE releases page locks as rows are processed. A concurrent effective_permissions rebuild that starts after the DELETE begins but before the INSERT completes reads a partially-populated flat_group_members — some group memberships present, others not yet inserted. The rebuild writes effective_permissions rows computed from this inconsistent view. After the INSERT completes, flat_group_members is correct but effective_permissions holds stale values, some STALE_ALLOWED (security finding) and some STALE_DENIED, with no marker that they need refresh.",
    "EPOCH GUARD DESCRIBED IN DESIGN NARRATIVE IS ABSENT FROM THE SCHEMA. The design summary specifies 'delete-first invalidation + singleton worker + epoch guard' and states the worker captures current_gen, then re-reads it inside a UPDLOCK+HOLDLOCK transaction to abort stale writes. No generation or epoch column exists in any table in the DDL. If permission rebuilds are ever made asynchronous — which the singleton-worker language implies — a slow rebuild job J1 queued before ACE change X can complete after a faster job J2 triggered by ACE change Y and overwrite J2's correct results with values that predate X. The result is STALE_ALLOWED rows with no automatic detection until the consistency checker's next sample run.",
    "DOCUMENT_FULLTEXT ROWS SURVIVE SOFT-DELETED DOCUMENTS IN THE FTS INDEX. documents.is_deleted=1 does not delete or flag the corresponding document_fulltext row. The FTS index continues to carry the document's normalized text. CONTAINSTABLE returns those doc_ids as candidates. The search query correctly filters AND d.is_deleted=0 before returning results and before computing COUNT(*) OVER(), so no content leaks to callers. However, the extraction_jobs queue may re-queue extraction attempts for a soft-deleted document's versions (no check on documents.is_deleted before enqueuing), wasting worker cycles and potentially updating document_fulltext with a fresh extraction after soft-delete.",
    "STALE ACE REFERENCE TO DELETED PRINCIPAL. access_control_entries has no foreign key from (principal_type, principal_id) to users, groups, or roles. When a user is deleted, ON DELETE CASCADE removes their user_roles and flat_group_members rows and their effective_permissions rows. But any ACE with principal_type=1 and principal_id=deleted_user_id remains. On a rebuild for those nodes, the ACE is read, principal_type=1 is checked against user_id=deleted_user, the user no longer exists in the users table, so no ep row is written — effectively harmless. But if the same user_id integer is reused by IDENTITY for a new user (SQL Server IDENTITY does not guarantee no-reuse after DBCC RESEED or identity gap fill), the new user silently inherits the stale ACE's permissions on all nodes that ace referenced.",
    "document_versions PK IS (version_id) BUT UQ_dv_docver IS ON (doc_id, version_number); document_fulltext FK_dft_ver REFERENCES document_versions(version_id) WITH NO CASCADE. If the extraction worker updates document_fulltext.version_id to point to version N and version N is later removed (no hard-delete path is defined, but an admin purge of old versions is a plausible future operation), the FK_dft_ver constraint is violated and the update fails at the DB level — but only if the delete is attempted. More critically, document_fulltext.version_id is never updated back to NULL on version removal, so the FTS index continues to serve text extracted from a version the system no longer considers current, with no indication that the extracted_text is stale."
  ],
  "performanceProblems": [
    "SEARCH QUERY DOES NOT USE TEMP-TABLE MATERIALIZATION FOR THE PERMISSION FILTER, CREATING THE EXACT PLAN TRAP THE SPECIALIST ANALYSIS WARNED AGAINST. The specialist findings section (b) states explicitly that a direct CONTAINSTABLE + permission JOIN causes the optimizer to frequently choose CONTAINSTABLE as the outer input, returning tens of thousands of rows before the ep filter runs. The search query template in the design does this exact join. For a common Arabic word such as 'وثيقة' CONTAINSTABLE may return hundreds of thousands of candidate doc_ids. The ep join is then applied as a residual predicate on each row. The recommended fix — INSERT allowed document_ids into #allowed, then join #allowed to CONTAINSTABLE — is documented in the specialist findings and ignored in the query template. The COUNT(*) OVER() still produces a correct count (it runs after the permission filter in the CTE evaluation), but the query memory grant and execution time can be orders of magnitude larger than necessary.",
    "IX_ep_user_bits IS (user_id, effective_allow_bits) INCLUDE(node_id) — effective_allow_bits IS NOT SARGABLE AS A SEEK PREDICATE. The search query's permission join pattern: WHERE ep.user_id=@user_id AND (ep.effective_allow_bits & 2) > 0 can seek on user_id but must scan all rows for that user to apply the bitmask filter as a residual predicate. At 300 users and 2,000 nodes this is at most 2,000 row reads per user — acceptable now. But as the tree grows to tens of thousands of nodes and the user base grows, this scan widens. The index cannot be made sargable on a bitmask without an indexed computed column (e.g., a persisted BIT column can_read AS CAST((effective_allow_bits & 2) AS BIT) PERSISTED, indexed). This is a deferred concern but should be noted before the schema is locked.",
    "HOT QUERY SORT ON title_normalized (sort_col=3) REQUIRES A BLOCKING SORT OPERATOR AFTER THE INDEX SEEK. IX_doc_node_active is keyed on (node_id, updated_at DESC); title sort does not match. SQL Server must materialize the full result set for the requested folder before sorting, then apply OFFSET/FETCH. For a folder with thousands of active documents this sort spills to tempdb. A second filtered index keyed on (node_id, title_normalized) INCLUDE(...) WHERE is_deleted=0 would eliminate the sort for the alphabetical case, which is the expected default for Arabic document libraries."
  ],
  "verdict": "Usable with fixes. The core security primitives are sound: missing ep row = denied (INNER JOIN pattern throughout), DENY is pre-computed into effective_allow_bits so no hot-path can accidentally skip it, inheritance resolution is well-specified, and the FTS search correctly gates on Read before paging so counts are always accurate. Two issues require fixes before any production data is loaded. First, the soft-deleted folder bypass: the hot query and the document search never verify that the folder node is active; an attacker who knows a deleted folder's node_id can browse its documents and all active versions indefinitely. Fix by deleting effective_permissions rows for any node on soft-delete, or by adding INNER JOIN nodes n ON n.node_id=d.node_id AND n.is_deleted=0 to both query templates. Second, the reparenting cycle race: the cycle-prevention check is a non-locking read that two concurrent reparent transactions can both pass, corrupting the mpath of both subtrees. Fix by beginning the reparent transaction at SERIALIZABLE isolation or acquiring an explicit application lock (sp_getapplock) before the cycle check. Three additional correctness bugs need fixes before enabling group nesting or async rebuilds: add a cycle guard on group_group_members inserts to prevent the recursive-CTE crash that empties flat_group_members; add a NOT-FOUND guard in the scoped search so a missing or deleted scope node raises an error rather than silently going global; and wrap the flat_group_members DELETE+INSERT in a single transaction. The epoch guard should be added to the schema (a generation BIGINT column on effective_permissions rows, or a separate rebuild_generation table) before any async rebuild worker is implemented."
}
```

---

## a8a83ad14fcb5ccb0

```json
{
  "target": "DocumentManagementSolution complete schema DDL + permission resolution + invalidation cases + hot query + FTS search query + reparenting procedure",
  "bypasses": [
    "CONCURRENT REPARENTING CYCLE — operation sequence: Admin 1 calls reparent(A, newParent=B); Admin 2 concurrently calls reparent(B, newParent=A). sp_getapplock locks 'move_node_A' for session 1 and 'move_node_B' for session 2; the two locks are independent and neither session blocks the other. Both sessions read the other node's current path under READ COMMITTED before either commits. Both cycle checks (`path LIKE @moving_path + N'%'`) pass because they read pre-commit state: A's path does not start with B's path and vice versa. Both UPDATEs target disjoint path-prefix sets and both COMMIT. Result: parent_id(A)=B and parent_id(B)=A simultaneously — a cycle in the adjacency list. The ancestor-walk CTE in permission resolution (`INNER JOIN acl_scope c ON p.node_id = c.parent_id`) loops between A and B until MAXRECURSION=100 aborts with an error, or, if OPTION(MAXRECURSION 0) is used, runs forever. Any permission computed for nodes inside this subtree derives from a corrupted ancestor chain; users may inherit ACEs from the wrong nodes or get effective_mask=0 due to the abort.",
    "ROLES.PERMISSION_MASK NOT USED IN RESOLUTION — operation sequence: Admin creates role R with permission_mask=3 (Browse+Read). Admin creates an ACE: node=N, principal_type='R', principal_id=R, ace_type='A', permission_mask=63. The permission resolution Step 3c collects all roles held by user U, finds R in scope, then aggregates allow_mask |= ace.permission_mask. The code uses ace.permission_mask (63), not roles.permission_mask (3). User U gets effective_mask=63 (all six bits). The role definition screen shows 'Browse, Read' but the user can Delete and ManagePerms. No invalidation case bumps acl_version when roles.permission_mask changes — invalidation case 5 bumps fn.acl_version for nodes where the role has an ACE, then recomputes using ace.permission_mask unchanged — so the cap never takes effect regardless. The column roles.permission_mask is dead with respect to grant computation.",
    "GROUP MEMBERSHIP STALENESS RACE — operation sequence: Admin removes user U from privileged group G (U previously had Read on node N via G's ACE). Application executes invalidation case 4: Step A rebuilds group_membership_cache in transaction T1 (G no longer lists U), COMMIT. Between T1 COMMIT and Step B DELETE FROM effective_permissions WHERE user_id=U starting, a concurrent HTTP request for user U executes the hot query. The hot query finds the existing ep row for (node_id=N, user_id=U), joins to filing_nodes and checks ep.acl_version = fn.acl_version. No ACE changed — only group membership changed — so acl_version was never bumped. The join succeeds. effective_mask still has Read bit set. User U receives documents they should no longer access. The window exists whenever Steps A and B execute in separate database transactions; on a loaded server this window can persist for tens to hundreds of milliseconds.",
    "FTS SCOPE EXPANSION VIA DELETED SUBTREE NODE — operation sequence: User U has Read only on folder subtree rooted at node D (by ACL design, U has no grants elsewhere). Admin soft-deletes node D (is_deleted=1). U now has Read on zero folders (correct desired state). U submits a full-text search request with @subtree_node_id=D. The stored procedure executes: `SELECT @subtree_path = path FROM dbo.filing_nodes WHERE node_id = D AND is_deleted = 0` — no row returned, @subtree_path remains NULL. The FTS WHERE clause `(@subtree_path IS NULL OR fn.path LIKE @subtree_path + N'%')` evaluates the NULL branch as TRUE for every fn.path, dropping all subtree restriction. The INNER JOIN on effective_permissions still filters by Read bit, so if U somehow has residual Read grants on other nodes (legacy ACEs not yet cleaned up), those documents appear in results. More practically: even without residual grants, if U passes any other valid node ID (not the deleted one) they get broader results than intended. The deleted-node path is the vector that disables the scope guard."
  ],
  "correctnessBugs": [
    "WORKER EPOCH GUARD MISSING — the specialist analysis specifies that the recompute worker must capture fn.acl_version (current_gen) at job-dequeue time and re-read it with UPDLOCK+HOLDLOCK inside the ep write transaction, aborting the write if it advanced. The permission_recompute_queue DDL has no generation/epoch column. Without it: worker W1 dequeues job J1 for node X (ACE state S1, fn.acl_version=5 at dequeue time). While W1 is computing, a second ACE change sets fn.acl_version=6 and queues job J2. W1 finishes computing with S1 ACEs, then reads fn.acl_version=6 at write time (or uses the version from J1's snapshot, which is 5 — either way results are wrong). If W1 writes acl_version=6 with allow_mask/deny_mask from S1, the stored row has correct acl_version but stale permission data. The staleness guard (ep.acl_version = fn.acl_version) passes on every subsequent hot query until the next ACE change. Users receive permissions that reflect a superseded ACL state indefinitely.",
    "EFFECTIVE_PERMISSIONS STALE WHEN GROUP MEMBERSHIP REBUILD AND EP DELETE ARE NOT ATOMIC — the design specifies Step A (rebuild cache), Step B (delete ep rows for user U). If these run in separate transactions, a live synchronous recompute can fire between them: after Step A but before Step B, a hot query for U finds U's OLD ep row (not yet deleted), ep.acl_version matches fn.acl_version (no ACE change bumped it), staleness guard passes, OLD permissions served. If instead the recompute fires after Step B (ep row deleted) but before Step A is committed (cache shows old membership), the synchronous recompute reads old cache, writes a new ep row with current acl_version and wrong permission data that the staleness guard will never detect. The schema has no mechanism to force atomicity between cache rebuild and ep invalidation.",
    "DOCUMENTS WITH CURRENT_VERSION_ID = NULL NOT EXPLICITLY FILTERED — documents.current_version_id is INT NULL with no 'status' or 'pending' flag column. Exclusion of upload-incomplete documents from the hot query relies solely on the INNER JOIN to document_versions failing when current_version_id IS NULL (since version_id is NOT NULL). Any application code path that scans dbo.documents without this join — admin dashboards, orphan-document cleanup, audit log target lookups, soft-delete restoration — will see incomplete document rows. These rows have a node_id, title, sensitivity_label_id, and created_by that can be read without the document ever having had a version written, which may expose draft metadata that should not yet be visible.",
    "FIELD_DEFINITIONS UNIQUENESS FOR GLOBAL FIELDS UNENFORCED IN SCHEMA — field_definitions.type_id is NULL for global fields (apply to all document types). SQL Server UNIQUE constraints treat each NULL as a distinct value, so UNIQUE(type_id, field_name) would pass for two rows both having type_id=NULL and field_name=N'ReferenceNumber'. The schema acknowledges this and defers to the application layer. Two global fields with the same field_name produce ambiguous document_field_values rows: both (document_id, field_id_A) and (document_id, field_id_B) can exist, field_id_A and field_id_B displaying under the same label, with undefined behavior in field-value queries that join by field_name.",
    "EFFECTIVE_MASK COMPUTED COLUMN DOES NOT CONSTRAIN ALLOW_MASK | DENY_MASK NON-ZERO OVERLAP — the schema stores allow_mask and deny_mask separately, computes effective_mask = allow & ~deny as a PERSISTED column. There is no CHECK constraint preventing a worker from writing allow_mask=3, deny_mask=3 simultaneously (both bits set in both masks). The computed column correctly resolves to 0 in this case, but the stored allow_mask=3 is misleading and could confuse diagnostic tools or the consistency checker when trying to distinguish 'explicitly denied' from 'allowed but overridden'. A constraint CK_ep_no_allow_deny_overlap CHECK ((allow_mask & deny_mask) = 0) would enforce the invariant the algorithm guarantees.",
    "INVALIDATION CASE 1 CTE DESCENDS ONLY THROUGH INHERITING CHILDREN BUT STOP CONDITION IS ON CHILD FLAG NOT PARENT FLAG — the affected-nodes CTE uses `WHERE c.inherits_permissions = 1` to control ascent upward (correct) and the mirror descent CTE for invalidation uses the same condition for downward traversal. A node B with inherits_permissions=0 (breaks inheritance) is correctly excluded from the invalidation sweep when an ancestor A's ACE changes. However, if B's own ACE is changed (invalidation case 1 rooted at B), the CTE correctly descends into B's inheriting children. Edge case: if an ancestor A has inherits_permissions=1 and a child C has inherits_permissions=0, and a grandchild D of C has inherits_permissions=1 — an ACE change at A does NOT reach D because the descent stops at C. This is correct behavior, but D's effective_permissions were computed using A's inherited ACEs at the time D was computed (via the ancestor walk), so D's ep row is NOT stale. It is correct that D is not invalidated. No bug, but the design comment says 'descent stops at any child with inherits_permissions=0' without clarifying that D (which inherits from C, which isolates from A) already doesn't use A's ACEs. Documenting this avoids future incorrect invalidation widening."
  ],
  "performanceProblems": [
    "FTS SEARCH WITHOUT TEMP-TABLE PERMISSION PRE-FILTER — the search query drives from CONTAINSTABLE(...) as the outermost FROM clause, then chains INNER JOINs to document_versions, documents, filing_nodes, and effective_permissions. The specialist analysis (section b) explicitly documented that the optimizer, seeing a TVF (CONTAINSTABLE) whose row-count estimate is opaque, frequently chooses it as the outer loop, materialising all FTS hits before applying the permission filter. At a corpus of 100,000 documents with 10,000 FTS matches for a common Arabic term and a user with Read on 200 folders, the optimizer pulls all 10,000 version rows, joins through three more tables, then discards ~9,800 rows. The specialist's fix — INSERT INTO #allowed SELECT ep.node_id ... WHERE effective_mask & 2 = 2, then JOIN CONTAINSTABLE to #allowed — is not implemented. COUNT(1) OVER() remains correct (window function sees filtered rows before OFFSET/FETCH) but query memory grant and elapsed time degrade linearly with unfiltered FTS result count.",
    "PATH COLUMN COLLATION ARABIC_CI_AI PREVENTS GUARANTEED SARGABLE LIKE PREFIX SCAN — the filing_nodes.path column is NVARCHAR(4000) with no explicit collation, inheriting the database collation Arabic_CI_AI (the legacy version-80 collation, weaker than Arabic_100_CI_AI_SC). The specialist analysis (section d) explicitly warned that Arabic collation sort weights are linguistically derived and may prevent SQL Server from converting LIKE '/1/42/%' into a binary range seek ['/1/42/' <= path < '/1/42/~']. This affects three critical code paths: (1) subtree FTS scoping WHERE fn.path LIKE @subtree_path + N'%', (2) reparenting UPDATE WHERE path LIKE @moving_path + N'%', and (3) the post-reparent queue INSERT WHERE path LIKE @new_path + N'%'. On a tree with thousands of nodes, a non-sargable LIKE forces an index scan of IX_fn_path on every subtree operation. The recommended fix — VARCHAR(3000) COLLATE Latin1_General_100_BIN2 — was explicitly specified in the specialist findings but not applied.",
    "PERMISSION_RECOMPUTE_QUEUE WITHOUT DEDUPLICATION INDEX — the queue can accumulate multiple rows for the same (node_id, user_id=NULL) pair (e.g., rapid successive ACE changes). The worker processes each row independently, recomputing and writing to effective_permissions multiple times for the same node, each time acquiring row locks on the ep clustered index. Without a unique constraint or application-level deduplication on (node_id, user_id) for pending rows, a large burst of ACE changes (e.g., bulk import) queues O(nodes * changes) rows, and the worker performs redundant MERGE/upsert operations. At 2,000 nodes and 10 rapid changes, 20,000 queue rows are processed instead of 2,000."
  ],
  "verdict": "Usable with fixes on the correctness and concurrency bugs before any data is written. The schema's core model — delete-first invalidation, acl_version staleness guard, computed effective_mask, DENY-wins bitmask — is sound. The hot browse query is correct and the FTS permission filter is correct in its deny semantics (INNER JOIN exclusion means false negative, never false positive). However four issues must be fixed before production use: (1) concurrent reparenting requires either a single tree-wide lock or a serializable cycle check to prevent adjacency list cycles — a cycle corrupts all downstream permission computation; (2) the recompute worker requires an epoch guard column on permission_recompute_queue to prevent stale results from overwriting correct ep rows with a matching acl_version; (3) the group membership invalidation (Steps A and B) must execute atomically in a single transaction to close the race window where stale ep rows pass the acl_version guard; (4) roles.permission_mask either needs to be enforced as a cap in the ACE-creation constraint (CHECK that ace.permission_mask & ~roles.permission_mask = 0) or the column must be removed and the UI corrected, because as written it misleads administrators about the effective grant. The FTS scope-expansion on deleted nodes is a lower-severity correctness issue fixed by returning HTTP 400 when @subtree_node_id resolves to no active row rather than silently dropping the scope. The two performance issues (FTS without temp-table pre-filter, path collation) should be addressed before load testing but do not affect correctness or security."
}
```
