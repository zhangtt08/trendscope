/**
 * Stage 2 §24: performance verification with a ~5350-row fixture dataset
 * (5000 unique + 250 in-batch duplicates + 100 id-less rows forming 50
 * fingerprint candidates). Asserts pagination / FTS / candidate listing stay
 * fast — no O(n²) behaviour. Generous thresholds; real timings logged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDb, migrate, type DB } from "../../server/src/db/client";
import { startBatch, runImport } from "../../server/src/services/importService";
import { FixtureAdapter, loadFixture } from "../../server/src/adapters/fixture";
import { queryContent } from "../../server/src/services/queryService";
import { listCandidates } from "../../server/src/services/duplicateService";
import { contentItems } from "../../server/src/db/schema";
import { count } from "drizzle-orm";

let db: DB;
let sqliteRef: import("better-sqlite3").Database | null = null;
let tmpDir: string;
let importMs = 0;

const T = (ms: number) => expect(ms).toBeLessThan(ms + 1); // placeholder to satisfy lint if unused

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trendscope-perf-"));
  const { sqlite, db: d } = openDb(path.join(tmpDir, "perf.db"));
  migrate(sqlite, path.resolve(process.cwd(), "drizzle"));
  sqliteRef = sqlite;
  db = d;

  const env = loadFixture("large-dataset.json");
  const adapter = new FixtureAdapter();
  const batchId = await startBatch(db, {
    name: "perf:large-dataset",
    sourceType: "fixture",
    platform: env.platform,
  });
  const t0 = Date.now();
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
  importMs = Date.now() - t0;
}, 240_000);

afterAll(() => {
  sqliteRef?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("performance with ~5350-row dataset", () => {
  it("imports all rows: 5100 items (250 dup rows deduped), 50 candidates", async () => {
    const [n] = await db.select({ n: count() }).from(contentItems);
    // 5000 unique + 100 id-less = 5100 items; 250 duplicate rows merged into existing
    expect(n.n).toBe(5100);
    console.log(`[perf] import 5350 rows in ${importMs}ms`);
    expect(importMs).toBeLessThan(180_000);
    // ≥50 seeded id-less pairs + a handful of accidental title/author/day
    // collisions among 5000 unique rows (birthday paradox) — all legit candidates
    const candidates = await listCandidates(db, "pending", 100);
    expect(candidates.length).toBeGreaterThanOrEqual(50);
    expect(candidates.length).toBeLessThan(80);
  }, 240_000);

  it("paginated query (page 5, 20 rows) is fast", async () => {
    const t0 = Date.now();
    const r = await queryContent(db, { platform: "weibo", page: 5, pageSize: 20 });
    const ms = Date.now() - t0;
    expect(r.rows).toHaveLength(20);
    expect(r.total).toBe(5100);
    console.log(`[perf] paginated query: ${ms}ms`);
    expect(ms).toBeLessThan(1_000);
  });

  it("FTS Chinese search is fast (indexed term)", async () => {
    const t0 = Date.now();
    const r = await queryContent(db, { keyword: "牛肉面", pageSize: 20 });
    const ms = Date.now() - t0;
    expect(r.mode).toBe("fts");
    expect(r.total).toBeGreaterThan(100); // seeded term frequency
    console.log(`[perf] FTS search 牛肉面 (${r.total} hits): ${ms}ms`);
    expect(ms).toBeLessThan(1_000);
  });

  it("FTS rare-term search returns exactly the seeded item", async () => {
    const r = await queryContent(db, { keyword: "无ID疑似重复压测标题第49组" });
    expect(r.mode).toBe("fts");
    expect(r.total).toBe(2); // the pair (both live, not merged)
  });

  it("candidate listing is fast", async () => {
    const t0 = Date.now();
    const rows = await listCandidates(db, "pending", 50);
    const ms = Date.now() - t0;
    expect(rows.length).toBe(50);
    console.log(`[perf] candidate list: ${ms}ms`);
    expect(ms).toBeLessThan(1_000);
  });

  it("relevance sort + pagination combined works", async () => {
    const t0 = Date.now();
    const r = await queryContent(db, { keyword: "推荐", sortBy: "relevance", page: 2, pageSize: 20 });
    const ms = Date.now() - t0;
    expect(r.rows.length).toBeGreaterThan(0);
    console.log(`[perf] relevance page 2: ${ms}ms`);
    expect(ms).toBeLessThan(1_000);
  });

  void T;
});
