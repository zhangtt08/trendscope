/** Data Health API (Stage 2 §21/22) — deterministic metrics only. */
import { desc, eq, isNull, and, sql, count } from "drizzle-orm";
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

export async function getDataHealth(db: DB): Promise<DataHealth> {
  const [totalRow] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(isNull(contentItems.mergedIntoContentItemId));

  const [missingPublishedAt] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(and(isNull(contentItems.publishedAt), isNull(contentItems.mergedIntoContentItemId)));

  const [missingAnyMetric] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(
      and(
        isNull(contentItems.views),
        isNull(contentItems.likes),
        isNull(contentItems.comments),
        isNull(contentItems.shares),
        isNull(contentItems.favorites),
        isNull(contentItems.upvotes),
        isNull(contentItems.mergedIntoContentItemId),
      ),
    );

  const [missingAuthor] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(
      and(
        isNull(contentItems.authorId),
        isNull(contentItems.authorName),
        isNull(contentItems.mergedIntoContentItemId),
      ),
    );

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
    totalContent: totalRow?.n ?? 0,
    missingPublishedAt: missingPublishedAt?.n ?? 0,
    missingAnyMetric: missingAnyMetric?.n ?? 0,
    missingAuthor: missingAuthor?.n ?? 0,
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
