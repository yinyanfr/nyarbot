# Database Migration & Backup Maintenance

Production uses one SQLite database, `data/nyarbot.sqlite` by default. `src/services/database.ts` owns the connection and schema; `src/services/persistence.ts` owns persistence operations. Production neither initializes `firebase-admin` nor mounts Firebase credentials.

## One-Shot Firestore Cutover

This procedure is for the completed Firestore-to-unified-SQLite cutover, not normal startup. The independent tool reads Firestore and the legacy wordcloud SQLite database, writes a staged database, validates it, and publishes the requested output only after every check passes.

### Prepare

1. Confirm the deployment is still using Firestore and `data/wordcloud.sqlite`, and take provider/native backups of both sources.
2. Place the maintenance-only Firebase service account at `src/services/serviceAccountKey.json`. Do not add it to the production image, Compose mounts, or version control.
3. Stop all bot instances before migration so neither Firestore nor the legacy wordcloud database receives writes during the final export.
4. Ensure these destinations do not exist: `data/nyarbot.sqlite`, `data/nyarbot.sqlite.migration-report.json`, and `data/nyarbot.sqlite.unknown-collections/`. The tool intentionally refuses to overwrite them.

### Run

From the repository root, run the exact migration command:

```bash
cd tools/firestore-to-sqlite
npm ci
npm run migrate -- \
  --service-account ../../src/services/serviceAccountKey.json \
  --wordcloud-db ../../data/wordcloud.sqlite \
  --output ../../data/nyarbot.sqlite \
  --timezone Asia/Shanghai
```

Paths are resolved from `tools/firestore-to-sqlite`. The service account's project ID selects the Firestore project. All four arguments are required.

### Validate and Stage

1. Require a zero exit status and `status: "success"` in `data/nyarbot.sqlite.migration-report.json`.
2. Review every report check. The tool verifies source/output counts, SHA-256 hashes over Firestore IDs and canonical JSON, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, schema version, IDs, JSON, dates, timestamps/cursors, and boolean domains.
3. Review `data/nyarbot.sqlite.unknown-collections/` when present. Collections ending in `_backup` are intentionally ignored; other unknown top-level collections are archived as JSON.
4. Keep production stopped and smoke-test the candidate in staging with `DATABASE_PATH` pointed at a copy of `data/nyarbot.sqlite`. Verify startup, `/status`, representative user memories, diary history, runtime context, and `/wordcloud` preview without allowing staging to poll the production bot token concurrently.
5. Set production `DATABASE_PATH=data/nyarbot.sqlite` and a unique `DATABASE_BACKUP_PASSPHRASE` of at least 20 characters, then deploy/start the SQLite build. Production requires no Firebase credential mount.
6. Verify startup logs, `/status`, normal message persistence, and the next scheduled backup. Retain the Firestore project, legacy database, migration report, and unknown-collection archive until the rollback window closes.

### Failure and Rollback

Before publication, a failed migration removes its random staging database and does not create `data/nyarbot.sqlite`; inspect the failed report, move the report/archive artifacts aside, correct the source or configuration, and rerun. Never point production at a failed or partially reviewed output.

If post-cutover checks fail, stop the SQLite deployment immediately, preserve the failed candidate and logs, and restart the unchanged pre-cutover release against Firestore and `data/wordcloud.sqlite`. Do not run both releases concurrently. Investigate and repeat the full stopped-writer migration into new destination paths before another cutover.

After acceptance, revoke/delete the migration service-account key and remove the local JSON. Firebase remains a historical source only; it is not a production dependency.

## Daily Encrypted Backups

The bot takes an online SQLite snapshot daily at `DATABASE_BACKUP_SCHEDULE=03:30` in `APP_TIMEZONE`, compresses and encrypts it with `DATABASE_BACKUP_PASSPHRASE`, stores it under `DATABASE_BACKUP_PATH=data/backups`, and sends it as a Telegram document to `TG_ADMIN_UID`. Archives are named `nyarbot-<UTC timestamp>.sqlite.gz.enc`; the newest seven local archives are retained. Keep the passphrase separately from both local and Telegram copies.

If snapshot, encryption, size validation, or Telegram delivery fails, the run is not marked complete, the admin receives a failure DM when possible, and the service retries after 15 minutes. Telegram delivery is limited to 50 MB.

## Restore

Stop every bot instance before replacing the database. Restore to a staging path first; the command decrypts the archive and verifies SQLite integrity, foreign keys, schema version, table definitions, and the required table:

```bash
npm run backup:restore -- \
  data/backups/nyarbot-YYYYMMDDTHHMMSSZ.sqlite.gz.enc \
  data/nyarbot.restore.sqlite \
  --require-table users
```

The command reads `DATABASE_BACKUP_PASSPHRASE` from `.env` and refuses to overwrite the output unless `--force` is explicitly supplied. After it reports success:

1. Preserve the current `data/nyarbot.sqlite` under a separate incident filename.
2. Move `data/nyarbot.restore.sqlite` to `data/nyarbot.sqlite` while the bot remains stopped.
3. Start the bot and verify startup, `/status`, representative records, and new writes.
4. If validation or smoke checks fail, stop the bot and put the preserved pre-restore database back in place.
