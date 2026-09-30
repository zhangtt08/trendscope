/**
 * Stage 3 integration: 0004 migration, topic picks (upsert semantics),
 * momentum service end-to-end (delta / null semantics / baseline fallback /
 * waist filter), overview buckets, and momentum performance (<1s @ 5350 items).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, migrate, type DB } from "../../server/src/db/client";
import { startBatch, runImport } from "../../server/src/services/importService";
import { CSVAdapter, parseCsv } from "../../server/src/adapters/csv";
import { FixtureAdapter, loadFixture } from "../../server/src/adapters/fixture";
import { getMomentumList, getTrendOverview } from "../../server/src/services/trendService";
import { setPick, listPicks, removePick } from "../../server/src/services/topicService";
import { contentMetricSnapshots } from "../../server/src/db/schema";
import { sql, eq } from "drizzle-orm";

let db: DB;
let sqliteRef: import("better-sqlite3").Database | null = null;
let tmpDir: string;

async function importCsv(csv: string, name = "s3.csv") {
  const adapter = new CSVAdapter();
  const p = parseCsv(csv);
  const batchId = await startBatch(db, { name, sourceType: "csv", platform: null });
  return runImport(
    db,
    adapter,
    p.rows,
    { sourceType: "csv", mapping: p.detectedMapping, platformOverride: null, sourceTimezone: "Asia/Shanghai", tzProvenance: "user_selected" },
    batchId,
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-s3-"));
  const { sqlite, db: d } = openDb(path.join(tmpDir, "s3.db"));
  migrate(sqlite, path.resolve(process.cwd(), "drizzle"));
  sqliteRef = sqlite;
  db = d;
});

afterAll(() => {
  sqliteRef?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("0004 migration: topic_picks", () => {
  it("creates table with unique per-item index", () => {
    const tables = sqliteRef!
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_picks'")
      .all();
    expect(tables).toHaveLength(1);
    const idx = sqliteRef!
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_topic_pick_item'")
      .all();
    expect(idx).toHaveLength(1);
  });

  it("re-running migrate is idempotent", () => {
    const before = sqliteRef!.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
    const applied = migrate(sqliteRef!, path.resolve(process.cwd(), "drizzle"));
    expect(applied).toBe(0);
    const after = sqliteRef!.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("topic picks (upsert per item)", () => {
  it("create → update → back to candidate → remove", async () => {
    const csv = "平台,id,标题,发布时间,点赞数\r\nweibo,p100,选题决策目标,2026-09-01 10:00:00,800";
    await importCsv(csv);
    const [item] = (await db.all<{ id: number }>(
      sql`SELECT id FROM content_items WHERE platform_content_id = 'p100'`,
    )) as { id: number }[];

    const created = await setPick(db, { contentItemId: item.id, status: "candidate" });
    expect(created.status).toBe("candidate");
    expect(created.decidedAt).toBeNull();

    const adopted = await setPick(db, {
      contentItemId: item.id,
      status: "adopted",
      note: "动量健康",
      rawMomentumScore: 420,
      windowDays: 7,
    });
    expect(adopted.status).toBe("adopted");
    expect(adopted.decidedAt).not.toBeNull();
    expect(adopted.rawMomentumScore).toBe(420);

    // still exactly one row per item (upsert, no unique violation)
    const picks = await listPicks(db, {});
    expect(picks.rows.filter((r) => r.contentItemId === item.id)).toHaveLength(1);
    expect(picks.counts.adopted).toBe(1);

    const back = await setPick(db, { contentItemId: item.id, status: "candidate" });
    expect(back.decidedAt).toBeNull();
    expect(back.note).toBeNull(); // note cleared on status change

    expect(await removePick(db, item.id)).toBe(true);
    expect(await removePick(db, item.id)).toBe(false);
  });

  it("rejects invalid status via zod gate", async () => {
    await expect(setPick(db, { contentItemId: 1, status: "maybe" as never })).rejects.toThrow();
  });
});

describe("momentum service", () => {
  it("computes cross-batch delta and score; unknown likes → null component", async () => {
    const v1 = "平台,id,标题,发布时间,点赞数,评论数\r\nweibo,m1,动量条目A,2026-09-01 10:00:00,100,10";
    const v2 = "平台,id,标题,发布时间,点赞数,评论数\r\nweibo,m1,动量条目A,2026-09-01 10:00:00,300,14";
    const v3 = "平台,id,标题,发布时间,点赞数,评论数\r\nweibo,m1,动量条目A,2026-09-01 10:00:00,,20";
    await importCsv(v1);
    await importCsv(v2);
    const r = await getMomentumList(db, { windowDays: 7 });
    const row = r.rows.find((x) => x.title === "动量条目A");
    expect(row).toBeDefined();
    expect(row!.delta.likes).toBe(200);
    expect(row!.delta.comments).toBe(4);
    expect(row!.rawMomentumScore).toBe(200 + 4 * 2);
    expect(row!.unknownComponents).toContain("shares");

    // third import with empty likes: latest snapshot likes=null → delta null
    await importCsv(v3);
    const r3 = await getMomentumList(db, { windowDays: 7 });
    const row3 = r3.rows.find((x) => x.title === "动量条目A");
    expect(row3!.delta.likes).toBeNull();
    expect(row3!.unknownComponents).toContain("likes");
  });

  it("waist-content filter: likesMin/likesMax constrain the pool", async () => {
    const v = [
      "平台,id,标题,发布时间,点赞数",
      "weibo,m2,腰部条目,2026-09-02 10:00:00,800",
      "weibo,m3,爆款条目,2026-09-02 10:00:00,90000",
    ].join("\r\n");
    await importCsv(v);
    await importCsv(v.replace("腰部条目", "腰部条目").replace("90000", "91000"));

    const all = await getMomentumList(db, { windowDays: 7 });
    const titles = all.rows.map((x) => x.title);
    expect(titles).toContain("腰部条目");
    expect(titles).toContain("爆款条目");

    const waist = await getMomentumList(db, { windowDays: 7, likesMin: 300, likesMax: 5000 });
    expect(waist.rows.map((x) => x.title)).toContain("腰部条目");
    expect(waist.rows.map((x) => x.title)).not.toContain("爆款条目");
  });

  it("single window snapshot falls back to pre-window baseline (observation evidence kept)", async () => {
    const v = "平台,id,标题,发布时间,点赞数\r\nweibo,m4,基线回看条目,2026-09-03 10:00:00,50";
    await importCsv(v);
    const [item] = (await db.all<{ id: number }>(
      sql`SELECT id FROM content_items WHERE platform_content_id = 'm4'`,
    )) as { id: number }[];
    // an older observation 10 days ago
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await db.insert(contentMetricSnapshots).values({
      contentItemId: item.id,
      capturedAt: old,
      likes: 10,
      source: "csv",
      importBatchId: null,
    });

    const r = await getMomentumList(db, { windowDays: 7 });
    const row = r.rows.find((x) => x.itemId === item.id);
    expect(row).toBeDefined();
    expect(row!.snapshotCount).toBe(2);
    expect(row!.delta.likes).toBe(40); // 50 - 10
    expect(r.baselineUsedCount).toBeGreaterThanOrEqual(1);

    // zero window snapshots → excluded entirely
    const rShort = await getMomentumList(db, { windowDays: 1 });
    // m4's only in-window snapshot is ~now, so it still appears; but an item
    // with no in-window activity at all must not:
    const v2 = "平台,id,标题,发布时间,点赞数\r\nweibo,m5,纯历史条目,2026-09-04 10:00:00,70";
    await importCsv(v2);
    const [item5] = (await db.all<{ id: number }>(
      sql`SELECT id FROM content_items WHERE platform_content_id = 'm5'`,
    )) as { id: number }[];
    await db.delete(contentMetricSnapshots).where(eq(contentMetricSnapshots.contentItemId, item5.id));
    await db.insert(contentMetricSnapshots).values({
      contentItemId: item5.id,
      capturedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      likes: 70,
      source: "csv",
      importBatchId: null,
    });
    const r5 = await getMomentumList(db, { windowDays: 7 });
    expect(r5.rows.find((x) => x.itemId === item5.id)).toBeUndefined();
  });

  it("overview buckets by UTC day and mixes platforms", async () => {
    const ov = await getTrendOverview(db, { windowDays: 7 });
    expect(ov.windowDays).toBe(7);
    expect(ov.totalSnapshots).toBeGreaterThan(0);
    expect(ov.buckets.length).toBeGreaterThan(0);
    for (const b of ov.buckets) {
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(ov.platformMix.some((p) => p.platform === "weibo" && p.items > 0)).toBe(true);
  });
});

describe("momentum performance (5350-row fixture)", () => {
  it("momentum listing stays under 1s", async () => {
    const env = loadFixture("large-dataset.json");
    const adapter = new FixtureAdapter();
    const batchId = await startBatch(db, {
      name: "s3:perf",
      sourceType: "fixture",
      platform: env.platform,
    });
    await runImport(
      db,
      adapter,
      env.rows,
      {
        sourceType: "fixture",
        mapping: env.mapping ?? undefined,
        platformOverride: env.platform,
        sourceTimezone: "Asia/Shanghai",
        tzProvenance: "adapter_default",
      },
      batchId,
    );

    // second wave of snapshots via set-based SQL (fast; simulates a re-collect).
    // strftime keeps the JS-ISO timestamp format (T-separator + Z suffix) so
    // string ordering stays consistent with the first wave.
    const t0 = Date.now();
    await db.run(sql`
      INSERT INTO content_metric_snapshots
        (content_item_id, captured_at, views, likes, comments, shares, favorites, source, import_batch_id)
      SELECT content_item_id,
             strftime('%Y-%m-%dT%H:%M:%S', captured_at, '+1 day') || '.000Z',
             views + 100, likes + 10, comments + 2, shares + 1, favorites + 1,
             'fixture', NULL
      FROM content_metric_snapshots
      WHERE source = 'fixture'
    `);
    const insertMs = Date.now() - t0;
    expect(insertMs).toBeLessThan(10_000);

    const t1 = Date.now();
    const r = await getMomentumList(db, { windowDays: 7, pageSize: 50 });
    const ms = Date.now() - t1;
    console.log(`[perf-s3] momentum list (${r.total} candidates): ${ms}ms`);
    expect(ms).toBeLessThan(1000);
    expect(r.total).toBeGreaterThan(1000);
    expect(r.rows).toHaveLength(50);

    const t2 = Date.now();
    const ov = await getTrendOverview(db, { windowDays: 7 });
    const ovMs = Date.now() - t2;
    console.log(`[perf-s3] overview: ${ovMs}ms`);
    expect(ovMs).toBeLessThan(1000);
    expect(ov.totalSnapshots).toBeGreaterThan(5000);
  }, 240_000);
});
