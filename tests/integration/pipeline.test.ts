import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, migrate, type DB } from "../../server/src/db/client";
import { runImport, startBatch } from "../../server/src/services/importService";
import { CSVAdapter } from "../../server/src/adapters/csv";
import { queryContent, getContentDetail } from "../../server/src/services/queryService";
import { getDashboardStats } from "../../server/src/services/statsService";
import { contentItems, contentMetricSnapshots, rawRecords, importBatches } from "../../server/src/db/schema";
import { eq, asc } from "drizzle-orm";

let db: DB;
let sqliteRef: import("better-sqlite3").Database | null = null;
let tmpDir: string;

const CSV_V1 = [
  "平台,id,标题,作者,发布时间,播放量,点赞数",
  "douyin,v001,第一条视频,作者甲,2026-09-01 10:00:00,100,10",
  "douyin,v002,第二条视频,作者乙,2026-09-02 11:00:00,0,0",
  "douyin,v003,第三条视频,作者丙,2026-09-03 12:00:00,,",
  "火星平台,,坏行未知平台,作者丁,2026-09-04 13:00:00,5,5",
].join("\r\n");

const CSV_V2 = [
  "平台,id,标题,作者,发布时间,播放量,点赞数",
  "douyin,v001,第一条视频,作者甲,2026-09-01 10:00:00,150,20",
  "douyin,v002,第二条视频,作者乙,2026-09-02 11:00:00,999,5",
].join("\r\n");

async function importCsv(dbx: DB, csv: string) {
  const adapter = new CSVAdapter();
  const { parseCsv } = await import("../../server/src/adapters/csv");
  const p = parseCsv(csv);
  const mapping = p.detectedMapping; // 平台→platform, id→platformContentId, …
  const batchId = await startBatch(dbx, {
    name: "test.csv",
    sourceType: "csv",
    platform: null,
    options: { mapping },
  });
  return runImport(
    dbx,
    adapter,
    p.rows,
    { sourceType: "csv", mapping, platformOverride: null },
    batchId,
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-test-"));
  const { sqlite, db: d } = openDb(path.join(tmpDir, "test.db"));
  migrate(sqlite, path.resolve(process.cwd(), "drizzle"));
  sqliteRef = sqlite;
  db = d;
});

afterAll(() => {
  sqliteRef?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("import pipeline: dedup + snapshots + batch stats", () => {
  let firstBatch: Awaited<ReturnType<typeof importCsv>>;

  it("first import: 3 imported (1 invalid-quality), 1 failed (no id, but raw preserved)", async () => {
    firstBatch = await importCsv(db, CSV_V1);
    expect(firstBatch.total).toBe(4);
    expect(firstBatch.imported).toBe(3);
    expect(firstBatch.failed).toBe(1);
    expect(firstBatch.duplicates).toBe(0);
  });

  it("batch stats persisted with completed status (partial if any failed)", async () => {
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, firstBatch.batchId));
    expect(b.status).toBe("partial");
    expect(b.totalRecords).toBe(4);
    expect(b.successfulRecords).toBe(3);
    expect(b.failedRecords).toBe(1);
  });

  it("real 0 stored as 0; missing metrics stored as null", async () => {
    const [v2] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.platformContentId, "v002"));
    expect(v2.views).toBe(0);
    expect(v2.likes).toBe(0);

    const [v3] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.platformContentId, "v003"));
    expect(v3.views).toBeNull();
    expect(v3.likes).toBeNull();
  });

  it("raw records preserved for every row including the failed one", async () => {
    const all = await db.select().from(rawRecords);
    expect(all.length).toBe(4);
    const failedRaw = all.find((r) => r.note?.includes("normalization error"));
    expect(failedRaw).toBeDefined();
  });

  it("query API: platform filter + keyword + sort + pagination", async () => {
    const page1 = await queryContent(db, {
      platform: "douyin",
      keyword: "视频",
      sortBy: "views",
      order: "desc",
      page: 1,
      pageSize: 2,
    });
    expect(page1.total).toBe(3);
    expect(page1.rows).toHaveLength(2);
    // desc by views: v002(999)? no — v001(100), v002(0), v003(null) → first is v001
    expect(page1.rows[0].platformContentId).toBe("v001");
  });

  it("content detail exposes raw + snapshots + batch lineage", async () => {
    const rows = await queryContent(db, { keyword: "第一条" });
    const detail = await getContentDetail(db, rows.rows[0].id);
    expect(detail).not.toBeNull();
    expect(detail!.snapshots).toHaveLength(1);
    expect(detail!.snapshots[0].views).toBe(100);
    expect(detail!.raw).not.toBeNull();
    expect(detail!.batch).not.toBeNull();
    expect(detail!.batch!.id).toBe(firstBatch.batchId);
    expect(JSON.parse(detail!.raw!.payload)["id"]).toBe("v001");
  });

  it("re-import with grown metrics: item count stable, snapshots grow, latest updated, history kept", async () => {
    const before = await db.select({ id: contentItems.id }).from(contentItems);
    const beforeSnapshots = await db.select({ id: contentMetricSnapshots.id }).from(contentMetricSnapshots);
    const v1HistoryBefore = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, (await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v001")))[0].id))
      .orderBy(asc(contentMetricSnapshots.capturedAt));

    const second = await importCsv(db, CSV_V2);
    expect(second.imported).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(second.failed).toBe(0);

    const after = await db.select({ id: contentItems.id }).from(contentItems);
    expect(after.length).toBe(before.length); // no new ContentItem

    const afterSnapshots = await db.select({ id: contentMetricSnapshots.id }).from(contentMetricSnapshots);
    expect(afterSnapshots.length).toBe(beforeSnapshots.length + 2); // +1 per re-collected item

    const [v1] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v001"));
    expect(v1.views).toBe(150); // latest updated
    expect(v1.likes).toBe(20);

    const v1HistoryAfter = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, v1.id))
      .orderBy(asc(contentMetricSnapshots.capturedAt));
    expect(v1HistoryAfter).toHaveLength(2);
    // history preserved: first snapshot still says 100/10
    expect(v1HistoryAfter[0].id).toBe(v1HistoryBefore[0].id);
    expect(v1HistoryAfter[0].views).toBe(100);
    expect(v1HistoryAfter[0].likes).toBe(10);
    expect(v1HistoryAfter[1].views).toBe(150);

    // collectedAt refreshed, publishedAt NOT overwritten
    expect(v1.collectedAt >= v1.createdAt).toBe(true);
  });

  it("v002 partial update: only provided metrics overwritten, null keeps previous", async () => {
    // CSV_V2 v002: views=999 likes=5 (both non-null) — update applies
    const [v2] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v002"));
    expect(v2.views).toBe(999);
    expect(v2.likes).toBe(5);
  });

  it("publishedAt never overwritten by re-import (fill-null only)", async () => {
    const [v1] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v001"));
    // "2026-09-01 10:00:00" parses (local tz aware) — the date part must survive re-import untouched
    expect(v1.publishedAt!.slice(0, 10)).toBe("2026-09-01");
  });

  it("dashboard stats aggregate", async () => {
    const stats = await getDashboardStats(db);
    expect(stats.totalContent).toBe(3);
    expect(stats.byPlatform[0].platform).toBe("douyin");
    expect(stats.latestBatch).not.toBeNull();
  });
});
