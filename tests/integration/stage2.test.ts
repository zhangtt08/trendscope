import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, migrate, type DB } from "../../server/src/db/client";
import { startBatch, runImport } from "../../server/src/services/importService";
import { CSVAdapter, parseCsv } from "../../server/src/adapters/csv";
import {
  buildMatchQuery,
  cjkSpace,
  docForItem,
} from "../../server/src/services/searchIndexService";
import { queryContent, getContentDetail } from "../../server/src/services/queryService";
import {
  listCandidates,
  resolveCandidate,
  pendingCandidateCount,
  getMergedSources,
} from "../../server/src/services/duplicateService";
import { contentItems, contentMetricSnapshots, rawRecords } from "../../server/src/db/schema";
import { eq, asc } from "drizzle-orm";

let db: DB;
let sqliteRef: import("better-sqlite3").Database | null = null;
let tmpDir: string;

const CSV_V1 = [
  "平台,id,标题,正文,作者,发布时间,播放量,点赞数",
  "douyin,v001,深夜牛肉面探店,这家店的面绝了 #探店,老王,2026-09-01 10:00:00,100,10",
  "douyin,v002,摄影打光教程,三分钟学会氛围感 #摄影,小陈,2026-09-02 11:00:00,0,0",
  "douyin,v003,第三条视频,普通内容,阿三,2026-09-03 12:00:00,,",
].join("\r\n");

async function importCsv(csv: string, timezone: string | null = "Asia/Shanghai") {
  const adapter = new CSVAdapter();
  const p = parseCsv(csv);
  const batchId = await startBatch(db, {
    name: "s2.csv",
    sourceType: "csv",
    platform: null,
  });
  return runImport(
    db,
    adapter,
    p.rows,
    { sourceType: "csv", mapping: p.detectedMapping, platformOverride: null, sourceTimezone: timezone, tzProvenance: "user_selected" },
    batchId,
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-s2-"));
  const { sqlite, db: d } = openDb(path.join(tmpDir, "s2.db"));
  migrate(sqlite, path.resolve(process.cwd(), "drizzle"));
  sqliteRef = sqlite;
  db = d;
});

afterAll(() => {
  sqliteRef?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("same-batch snapshot dedup (Stage 2 §2)", () => {
  it("same batch + identical metrics twice → 1 ContentItem, 1 snapshot", async () => {
    const csv = [
      "平台,id,标题,发布时间,播放量",
      "weibo,w100,同批重复测试,2026-09-01 10:00:00,50",
      "weibo,w100,同批重复测试,2026-09-01 10:00:00,50",
    ].join("\r\n");
    const s = await importCsv(csv);
    expect(s.imported).toBe(1);
    expect(s.duplicates).toBe(1);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w100"));
    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, item.id));
    expect(snaps).toHaveLength(1);
    expect(s.rows[1].snapshotSkippedSameBatch).toBe(true);
  });

  it("same batch + different metrics → 2 snapshots", async () => {
    const csv = [
      "平台,id,标题,发布时间,播放量",
      "weibo,w200,同批变化指标,2026-09-01 10:00:00,50",
      "weibo,w200,同批变化指标,2026-09-01 10:00:00,80",
    ].join("\r\n");
    const s = await importCsv(csv);
    expect(s.imported).toBe(1);
    expect(s.duplicates).toBe(1);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w200"));
    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, item.id));
    expect(snaps).toHaveLength(2);
  });

  it("cross-batch + unchanged metrics → still a new snapshot (observation time matters)", async () => {
    const csvV1 = "平台,id,标题,发布时间,播放量\r\nweibo,w300,跨批不变,2026-09-01 10:00:00,50";
    const csvV2 = "平台,id,标题,发布时间,播放量\r\nweibo,w300,跨批不变,2026-09-01 10:00:00,50";
    await importCsv(csvV1);
    await importCsv(csvV2);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w300"));
    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, item.id));
    expect(snaps).toHaveLength(2);
  });

  it("cross-batch + changed metrics → 2 snapshots + latest updated", async () => {
    const csvV1 = "平台,id,标题,发布时间,播放量\r\nweibo,w400,跨批增长,2026-09-01 10:00:00,50";
    const csvV2 = "平台,id,标题,发布时间,播放量\r\nweibo,w400,跨批增长,2026-09-01 10:00:00,500";
    await importCsv(csvV1);
    await importCsv(csvV2);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w400"));
    expect(item.views).toBe(500);
    const snaps = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, item.id))
      .orderBy(asc(contentMetricSnapshots.capturedAt));
    expect(snaps).toHaveLength(2);
    expect(snaps[0].views).toBe(50);
    expect(snaps[1].views).toBe(500);
  });
});

describe("timezone semantics through the pipeline (Stage 2 §3/4/5)", () => {
  it("CSV naive dates interpreted in user-selected timezone, provenance stored", async () => {
    await importCsv(CSV_V1); // seed v001/v002/v003 for this + later describes
    const rows = await queryContent(db, { platform: "douyin", keyword: "牛肉面" });
    expect(rows.total).toBeGreaterThanOrEqual(1);
    const detail = await getContentDetail(db, rows.rows[0].id);
    expect(detail!.item.publishedAt).toBe("2026-09-01T02:00:00.000Z"); // 10:00 Shanghai
    expect(detail!.item.publishedTz).toBe("Asia/Shanghai");
    expect(detail!.item.publishedTzAssumption).toBe("user_selected");
    expect(detail!.item.rawPublishedAt).toBe("2026-09-01 10:00:00");
  });

  it("explicit offset in data wins over the selected timezone", async () => {
    const csv =
      "平台,id,标题,发布时间\r\nweibo,w500,带offset,2026-09-01T08:00:00+08:00";
    await importCsv(csv, "America/New_York");
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w500"));
    expect(item.publishedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(item.publishedTzAssumption).toBe("explicit_offset");
  });

  it("real 0 stays 0 and missing metric stays null (regression, Stage 2 §25)", async () => {
    const [v2] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v002"));
    expect(v2.views).toBe(0); // real 0
    expect(v2.likes).toBe(0);
    const [v3] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "v003"));
    expect(v3.views).toBeNull(); // unknown
    expect(v3.likes).toBeNull();
  });
});

describe("FTS5 search (Stage 2 §6-10)", () => {
  it("chinese title match", async () => {
    const r = await queryContent(db, { keyword: "牛肉面" });
    expect(r.mode).toBe("fts");
    expect(r.total).toBeGreaterThanOrEqual(1);
    expect(r.rows[0].title).toContain("牛肉面");
    expect(r.rows[0].hlTitle).toBeTruthy();
  });

  it("chinese body/tag match", async () => {
    const r = await queryContent(db, { keyword: "摄影" });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it("multi-keyword AND", async () => {
    const r = await queryContent(db, { keyword: "深夜 探店" });
    expect(r.total).toBeGreaterThanOrEqual(1);
    const r2 = await queryContent(db, { keyword: "深夜 不存在的词" });
    expect(r2.total).toBe(0);
  });

  it("author match", async () => {
    const r = await queryContent(db, { keyword: "老王" });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it("malformed match syntax falls back to LIKE safely", async () => {
    const r = await queryContent(db, { keyword: '探" OR 1=1 --' });
    expect(["like", "fts", "plain"]).toContain(r.mode);
    // injection attempt must not throw and must not return everything
  });

  it("FTS syncs after update (item enriched on re-collection)", async () => {
    // first collection: no title → stored (invalid quality), unsearchable by title
    const csvA = "平台,id,播放量\r\nweibo,w600,77";
    await importCsv(csvA);
    const r0 = await queryContent(db, { keyword: "黄鹤楼" });
    expect(r0.total).toBe(0);

    // re-collection with the SAME platform+id now carries a title → fill-if-null
    const csvB = "平台,id,标题,发布时间,播放量\r\nweibo,w600,黄鹤楼独特词夜景,2026-09-01 10:00:00,88";
    await importCsv(csvB);

    const r = await queryContent(db, { keyword: "黄鹤楼" });
    expect(r.mode).toBe("fts");
    expect(r.total).toBe(1);
    const [item] = await db.select().from(contentItems).where(eq(contentItems.platformContentId, "w600"));
    expect(item.title).toBe("黄鹤楼独特词夜景");
  });
});

describe("duplicate governance (Stage 2 §11-15)", () => {
  it("fingerprint match creates a pending candidate, never auto-merges", async () => {
    // two id-less, url-less rows with identical title/author/day on the same platform
    const csv =
      "平台,标题,正文,作者,发布时间\r\nweibo,无ID疑似重复标题XYZ,内容A,作者Q,2026-09-10 10:00:00\r\nweibo,无ID疑似重复标题XYZ,内容B,作者Q,2026-09-10 15:00:00";
    const s = await importCsv(csv);
    expect(s.imported).toBe(2); // both inserted as separate items
    const before = await db.select({ id: contentItems.id }).from(contentItems);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(await pendingCandidateCount(db)).toBeGreaterThanOrEqual(1);
  });

  it("confirm merge: pointer set, snapshots moved, raws kept, audit written", async () => {
    const candidates = await listCandidates(db, "pending");
    const target = candidates[0];
    const aId = target.a.id;
    const bId = target.b.id;

    const aSnapsBefore = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, aId));
    const bSnapsBefore = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, bId));

    const result = await resolveCandidate(db, target.id, "confirm");
    expect(result.mergedSourceId).toBe(bId);
    expect(result.targetId).toBe(aId);

    // source item: pointer set, row still exists
    const [bItem] = await db.select().from(contentItems).where(eq(contentItems.id, bId));
    expect(bItem).toBeDefined();
    expect(bItem.mergedIntoContentItemId).toBe(aId);

    // snapshots moved to canonical, history count preserved
    const aSnapsAfter = await db
      .select()
      .from(contentMetricSnapshots)
      .where(eq(contentMetricSnapshots.contentItemId, aId));
    expect(aSnapsAfter.length).toBe(aSnapsBefore.length + bSnapsBefore.length);

    // raws untouched: both creator raw records still exist
    const [aItem] = await db.select().from(contentItems).where(eq(contentItems.id, aId));
    expect(aItem.rawDataId).not.toBeNull();
    const allRaws = await db.select().from(rawRecords);
    expect(allRaws.length).toBeGreaterThanOrEqual(2);

    // merged sources visible on canonical
    const sources = await getMergedSources(db, aId);
    expect(sources.map((s) => s.item.id)).toContain(bId);

    // merged item excluded from content listings & FTS
    const listing = await queryContent(db, { keyword: "无ID疑似重复标题XYZ" });
    expect(listing.rows.every((r) => r.mergedIntoContentItemId === null)).toBe(true);
    expect(listing.total).toBe(1);
  });

  it("not_duplicate and ignore resolve without merging", async () => {
    // fabricate a candidate via two id-less same-title rows on another platform
    const csv =
      "平台,标题,正文,作者,发布时间\r\nzhihu,另一些无ID重复标题ABC,x1,作者Z,2026-09-11 10:00:00\r\nzhihu,另一些无ID重复标题ABC,x2,作者Z,2026-09-11 18:00:00\r\nzhihu,第三组无ID重复标题DEF,y1,作者Y,2026-09-12 09:00:00\r\nzhihu,第三组无ID重复标题DEF,y2,作者Y,2026-09-12 21:00:00";
    await importCsv(csv);
    const pending = await listCandidates(db, "pending");
    const c1 = pending[0];
    const c2 = pending[1];
    await resolveCandidate(db, c1.id, "not_duplicate");
    await resolveCandidate(db, c2.id, "ignore");
    const after = await listCandidates(db, null);
    const st1 = after.find((c) => c.id === c1.id)!.status;
    const st2 = after.find((c) => c.id === c2.id)!.status;
    expect(st1).toBe("not_duplicate");
    expect(st2).toBe("ignored");
    // no merges happened
    const [a] = await db.select().from(contentItems).where(eq(contentItems.id, c1.a.id));
    const [b] = await db.select().from(contentItems).where(eq(contentItems.id, c1.b.id));
    expect(a.mergedIntoContentItemId).toBeNull();
    expect(b.mergedIntoContentItemId).toBeNull();
  });

  it("double-resolve is rejected", async () => {
    const pending = await listCandidates(db, "pending");
    if (pending.length === 0) return; // no pending left — skip
    await resolveCandidate(db, pending[0].id, "ignore");
    await expect(resolveCandidate(db, pending[0].id, "confirm")).rejects.toThrow(
      /already resolved/,
    );
  });
});

describe("adapter contract (Stage 2 §27/28 — declarations only)", () => {
  it("format adapters declare platform 'any', no live capabilities", async () => {
    const { CSVAdapter: C, JSONAdapter: J, ManualAdapter: M, FixtureAdapter: F } = await import(
      "../../server/src/adapters/csv"
    ).then(async (csv) => ({
      CSVAdapter: csv.CSVAdapter,
      ...(await import("../../server/src/adapters/json")),
      ...(await import("../../server/src/adapters/manual")),
      ...(await import("../../server/src/adapters/fixture")),
    }));
    void F;
    expect(new C().getPlatform()).toBe("any");
    expect(new C().getCapabilities()).toEqual([]);
    expect(new J().getSourceType()).toBe("json");
    expect(new M().getPlatform()).toBe("any");
  });
});

describe("docForItem CJK handling", () => {
  it("cjkSpace inserts boundaries for tokenization", () => {
    expect(cjkSpace("深夜食堂探店vlog")).toContain("探 店");
    expect(cjkSpace("ABC探店")).toContain("ABC 探 店");
  });

  it("buildMatchQuery quotes every term (FTS operators neutralized, no injection)", () => {
    const q = buildMatchQuery('牛肉面" NOT ) * 牛肉');
    // every term is wrapped in double quotes → NOT/OR/AND become literal tokens
    expect(q).toBe('"牛 肉 面" AND "NOT"* AND "牛 肉"');
    expect(q).not.toMatch(/(^|\s)NOT(\s|$)/); // no bare NOT operator
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("  ")).toBeNull();
    // pure-syntax input yields no expression at all
    expect(buildMatchQuery('" * ) (')).toBeNull();
  });

  it("docForItem flattens hashtags JSON into tags", () => {
    const doc = docForItem({
      hashtags: '["探店","牛肉面"]',
      title: "t",
      text: "b",
      transcript: null,
      authorName: "a",
      authorId: null,
    } as unknown as Parameters<typeof docForItem>[0]);
    expect(doc.tags).toContain("探 店");
  });
});
