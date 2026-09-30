/**
 * Stage 2 §31: Stage 1 DB → migration → Stage 2, data preserved.
 * Builds a DB using ONLY the Stage 1 migration (0000), seeds Stage 1-shaped
 * rows, then runs the normal migrate() + boot-time FTS backfill.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { openDb, migrate } from "../../server/src/db/client";
import { ensureFtsBackfilled } from "../../server/src/services/searchIndexService";
import { queryContent } from "../../server/src/services/queryService";
import { contentItems } from "../../server/src/db/schema";
import { eq } from "drizzle-orm";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-mig-"));
let sqlite: Database.Database | null = null;
let opened: Database.Database | null = null;

afterAll(() => {
  sqlite?.close();
  opened?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration from Stage 1 database", () => {
  const dbPath = path.join(tmpDir, "upgrade.db");

  it("stage1 DB migrates to stage2 in place, data preserved, FTS backfilled", async () => {
    // 1. simulate a Stage 1 DB: apply only 0000 and record it as applied
    sqlite = new Database(dbPath);
    sqlite.pragma("foreign_keys = ON");
    const initSql = fs.readFileSync(
      path.resolve(process.cwd(), "drizzle", "0000_init.sql"),
      "utf-8",
    );
    sqlite.exec(initSql);
    sqlite
      .prepare(
        "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)",
      )
      .run();
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, applied_at) VALUES (?, ?)")
      .run("0000_init.sql", new Date().toISOString());

    // 2. seed Stage 1-shaped data (raw + item + snapshot + batch)
    sqlite.exec(`INSERT INTO import_batches (id, name, source_type, platform, started_at, status, total_records, successful_records, failed_records, duplicate_records)
                 VALUES (1, 'stage1.csv', 'csv', 'douyin', '2026-09-01T00:00:00Z', 'completed', 1, 1, 0, 0)`);
    sqlite.exec(`INSERT INTO raw_records (id, source_type, platform, adapter, import_batch_id, payload, created_at)
                 VALUES (1, 'csv', 'douyin', 'csv-adapter', 1, '{"id":"old001"}', '2026-09-01T00:00:00Z')`);
    sqlite.exec(`INSERT INTO content_items (id, platform, platform_content_id, content_type, title, collected_at, data_quality, source_type, raw_data_id, created_at, updated_at)
                 VALUES (1, 'douyin', 'old001', 'video', '迁移后独特词天安门城楼', '2026-09-01T00:00:00Z', 'partial', 'csv', 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`);
    sqlite.exec(`INSERT INTO content_metric_snapshots (id, content_item_id, captured_at, views, source)
                 VALUES (1, 1, '2026-09-01T00:00:00Z', 10, 'csv')`);

    // 3. run the normal migration path — applies 0001_stage2 + 0002_fts
    const { sqlite: openedDb, db } = openDb(dbPath);
    opened = openedDb;
    const applied = migrate(opened, path.resolve(process.cwd(), "drizzle"));
    expect(applied).toBeGreaterThanOrEqual(2);

    // 4. boot-time FTS backfill (idempotent — production does this on every boot)
    const fts = ensureFtsBackfilled(db);
    expect(fts.indexed).toBe(1);

    // 5. data preserved
    const [item] = await db.select().from(contentItems).where(eq(contentItems.id, 1));
    expect(item).toBeDefined();
    expect(item.platformContentId).toBe("old001");

    // 6. new columns exist and are NULL for legacy rows
    expect(item.qualityReasons).toBeNull();
    expect(item.mergedIntoContentItemId).toBeNull();
    expect(item.publishedTzAssumption).toBeNull();

    // 7. FTS search works over migrated data (Chinese, bigram path)
    const r = await queryContent(db, { keyword: "天安门城楼" });
    expect(r.mode).toBe("fts");
    expect(r.total).toBe(1);
    expect(r.rows[0].id).toBe(1);
  });
});
