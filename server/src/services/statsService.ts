/** Dashboard stats (spec §29): totals, platform & quality distribution, latest import. */
import { count, desc, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems, importBatches } from "../db/schema";

/**
 * 平台覆盖:每个平台采到多少、最近一次是什么时候、多少已归入话题、缺哪些字段。
 * 数据总览与「分析报告」共用这一份口径 —— 两处数字不一致是最容易被发现的谎。
 */
export interface PlatformCoverageRow {
  platform: string;
  items: number;
  latestAt: string | null;
  missingTime: number;
  noMetric: number;
  clustered: number;
}

export async function getPlatformCoverage(db: DB): Promise<PlatformCoverageRow[]> {
  const rows = (await db.all(sql`
    SELECT c.platform AS platform,
           COUNT(*) AS items,
           MAX(c.collected_at) AS latestAt,
           SUM(CASE WHEN c.published_at IS NULL THEN 1 ELSE 0 END) AS missingTime,
           SUM(CASE WHEN c.views IS NULL AND c.likes IS NULL AND c.comments IS NULL
                     AND c.shares IS NULL AND c.favorites IS NULL AND c.upvotes IS NULL
                    THEN 1 ELSE 0 END) AS noMetric,
           SUM(CASE WHEN m.content_item_id IS NOT NULL THEN 1 ELSE 0 END) AS clustered
      FROM content_items c
      LEFT JOIN (SELECT DISTINCT content_item_id AS content_item_id FROM topic_memberships) m
             ON m.content_item_id = c.id
     GROUP BY c.platform
     ORDER BY items DESC`)) as Record<string, unknown>[];
  return rows.map((r) => ({
    platform: String(r.platform),
    items: Number(r.items ?? 0),
    latestAt: r.latestAt ? String(r.latestAt) : null,
    missingTime: Number(r.missingTime ?? 0),
    noMetric: Number(r.noMetric ?? 0),
    clustered: Number(r.clustered ?? 0),
  }));
}

export async function getDashboardStats(db: DB) {
  const [totalRow] = await db.select({ n: count() }).from(contentItems);

  const byPlatform = await db
    .select({ platform: contentItems.platform, n: count() })
    .from(contentItems)
    .groupBy(contentItems.platform);

  const byQuality = await db
    .select({ quality: contentItems.dataQuality, n: count() })
    .from(contentItems)
    .groupBy(contentItems.dataQuality);

  const byContentType = await db
    .select({ contentType: contentItems.contentType, n: count() })
    .from(contentItems)
    .groupBy(contentItems.contentType);

  const [latestBatch] = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.startedAt))
    .limit(1);

  const platformCoverage = await getPlatformCoverage(db);

  return {
    totalContent: totalRow?.n ?? 0,
    byPlatform,
    platformCoverage,
    byQuality,
    byContentType,
    latestBatch: latestBatch ?? null,
  };
}
