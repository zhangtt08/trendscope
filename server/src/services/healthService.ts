/** Data Health API (Stage 2 §21/22) — deterministic metrics only. */
import { desc, eq, isNull, sql, count } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems, importBatches, rawRecords, duplicateCandidates } from "../db/schema";

export interface DataHealth {
  totalContent: number;
  missingPublishedAt: number;
  missingAnyMetric: number;
  missingAuthor: number;
  byQuality: { quality: string; n: number }[];
  byPlatform: { platform: string; n: number }[];
  pendingDuplicateCandidates: number;
  resolvedDuplicateCandidates: { confirmed: number; notDuplicate: number; ignored: number };
  failedRawRows: number;
  latestBatches: {
    id: number;
    name: string;
    sourceType: string;
    status: string;
    startedAt: string;
    totalRecords: number;
    failedRecords: number;
    duplicateRecords: number;
  }[];
}

/**
 * 首屏聚合的读法:以前对 content_items 打 4 条独立的全库 count(*)
 * (total / 缺发布时间 / 无任何指标 / 缺作者),每条都逐页扫一遍。1.3 GB 的库上
 * 这就是 /api/health 冷启动 12~35 秒的主要来源;而 getDataHealth 同时被
 * /api/health、/api/analysis/status 与 overview 工具复用,等于每个首屏都扫四遍。
 *
 * 现在折成**一次扫描**:SQLite 里 `x IS NULL` 求值为 1/0,`a AND b` 同样 1/0,
 * 于是 `SUM(...)` 就是原来的 count(*)。四条查询的 WHERE 都以 `merged_into_content_item_id IS NULL`
 * 为公共前缀,合并后逐字段语义完全一致 —— 不是近似,是同一判据少扫三遍。
 * byQuality / byPlatform 是两种分组键,合并不了,各留一条(合计 6 条扫描 → 3 条)。
 */
export async function getDataHealth(db: DB): Promise<DataHealth> {
  const live = sql`${contentItems.mergedIntoContentItemId} IS NULL`;
  const scalars = db.get(
    sql`SELECT
           COUNT(*) AS total,
           SUM(${contentItems.publishedAt} IS NULL) AS missing_published_at,
           SUM(${contentItems.views} IS NULL
               AND ${contentItems.likes} IS NULL
               AND ${contentItems.comments} IS NULL
               AND ${contentItems.shares} IS NULL
               AND ${contentItems.favorites} IS NULL
               AND ${contentItems.upvotes} IS NULL) AS missing_any_metric,
           SUM(${contentItems.authorId} IS NULL
               AND ${contentItems.authorName} IS NULL) AS missing_author
         FROM ${contentItems}
         WHERE ${live}`,
  ) as
    | {
        total: number;
        missing_published_at: number | null;
        missing_any_metric: number | null;
        missing_author: number | null;
      }
    | undefined;

  const byQuality = await db
    .select({ quality: contentItems.dataQuality, n: count() })
    .from(contentItems)
    .where(isNull(contentItems.mergedIntoContentItemId))
    .groupBy(contentItems.dataQuality);

  const byPlatform = await db
    .select({ platform: contentItems.platform, n: count() })
    .from(contentItems)
    .where(isNull(contentItems.mergedIntoContentItemId))
    .groupBy(contentItems.platform);

  const [pending] = await db
    .select({ n: count() })
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.status, "pending"));

  const resolvedRows = await db
    .select({ status: duplicateCandidates.status, n: count() })
    .from(duplicateCandidates)
    .where(sql`${duplicateCandidates.status} != 'pending'`)
    .groupBy(duplicateCandidates.status);

  const resolvedDuplicateCandidates = { confirmed: 0, notDuplicate: 0, ignored: 0 };
  for (const r of resolvedRows) {
    if (r.status === "confirmed_duplicate") resolvedDuplicateCandidates.confirmed = r.n;
    if (r.status === "not_duplicate") resolvedDuplicateCandidates.notDuplicate = r.n;
    if (r.status === "ignored") resolvedDuplicateCandidates.ignored = r.n;
  }

  const [failedRaw] = await db
    .select({ n: count() })
    .from(rawRecords)
    .where(sql`${rawRecords.note} IS NOT NULL`);

  const latestBatches = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.startedAt))
    .limit(5);

  return {
    totalContent: scalars?.total ?? 0,
    // SUM 在空表上返回 NULL(而 COUNT(*) 返回 0);?? 0 把"没有行"如实折成 0,
    // 与合并前的四条 count(*) 语义一致 —— 空库不会凭空冒出一个 null。
    missingPublishedAt: scalars?.missing_published_at ?? 0,
    missingAnyMetric: scalars?.missing_any_metric ?? 0,
    missingAuthor: scalars?.missing_author ?? 0,
    byQuality,
    byPlatform,
    pendingDuplicateCandidates: pending?.n ?? 0,
    resolvedDuplicateCandidates,
    failedRawRows: failedRaw?.n ?? 0,
    latestBatches: latestBatches.map((b) => ({
      id: b.id,
      name: b.name,
      sourceType: b.sourceType,
      status: b.status,
      startedAt: b.startedAt,
      totalRecords: b.totalRecords,
      failedRecords: b.failedRecords,
      duplicateRecords: b.duplicateRecords,
    })),
  };
}
