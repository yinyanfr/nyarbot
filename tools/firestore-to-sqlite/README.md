# Firestore to SQLite migration

Independent, one-shot migration utility for creating a new unified Nyarbot SQLite database. It reads Firestore with a service account, imports the legacy wordcloud SQLite tables, validates the result, and emits a JSON report. It does not import or depend on production source modules.

## Safety

- The output, report, and unknown-collection archive paths must not already exist.
- There is intentionally no overwrite flag. Move old artifacts away before rerunning.
- SQLite is built at a staging path and moved to the requested output only after all checks pass.
- Malformed documents in formal collections fail the complete migration.
- Top-level collections ending in `_backup` are ignored.
- Other unknown top-level collections are archived as JSON, including safe tagged representations of Firestore timestamps, references, geopoints, bytes, bigints, and non-finite numbers.
- Service-account data is read only for authentication and is never written to the database or report.

The report path is `<output>.migration-report.json`. Unknown archives are written under `<output>.unknown-collections/`. A failure before argument parsing cannot know the report path and is printed to stderr only; failures after parsing write a failed report when its path is available.

The output sets SQLite `user_version` to `1`, matching this schema contract.

## Install and run

Requires Node.js 22 or newer.

```bash
cd tools/firestore-to-sqlite
npm ci
npm run migrate -- \
  --service-account ../../src/services/serviceAccountKey.json \
  --wordcloud-db ../../data/wordcloud.sqlite \
  --output ../../data/nyarbot.sqlite \
  --timezone Asia/Shanghai
```

All four arguments are required. Paths are resolved from the current working directory. The service account's project ID selects the Firestore project.

## Formal sources

The tool migrates `users`, `diary`, `diaryObservations`, exactly `runtime/group`, `events`, `turns`, and `compactions`. Firestore document IDs are primary keys in the corresponding SQLite tables, including Firestore auto IDs. Original canonical JSON is retained in each formal parent row as `source_json` for auditability and hash checks.

Legacy wordcloud tables `group_messages`, `wordcloud_runs`, and `wordcloud_publications` are copied into the same output. Older `group_messages` databases without `is_forwarded` are supported with the production default of `0`; other missing required tables or columns fail migration.

## Schema alignment

`schema.sql` is the standalone contract intended for later alignment with the production SQLite implementation. The migration package does not edit or import `src/services`. Schema changes should be reconciled by changing this file and the insert/check code together before running the one-shot migration.

## Verification

The migration performs:

- source/output row-count checks for every formal collection and wordcloud table;
- SHA-256 checks over preserved Firestore document IDs and canonical source JSON;
- `PRAGMA integrity_check`;
- `PRAGMA foreign_key_check`;
- semantic checks for IDs, JSON validity, date shape, timestamp/cursor ordering, and boolean domains.

Run tool-local checks with:

```bash
npm run typecheck
npm test
```
