/**
 * Import pipeline (Stage 1 §11/12/15/17 + Stage 2 §2/4/11/12):
 *   raw row → adapter.validateRaw → adapter.normalize → canonicalize url
 *           → dedup (platform+id → canonicalUrl → fingerprint-flag)
 *           → new: RawRecord + ContentItem + Snapshot #1 (+ DuplicateCandidate?)
 *           → existing: RawRecord + Snapshot* + latest-metrics update
 *
 * Stage 2 rules:
 * - Same ImportBatch + same item + identical metric values → only ONE snapshot
 *   (redundancy fix). Different batch / different observation time → snapshot
 *   ALWAYS appended, even when metrics unchanged (time-series value).
 * - Timezone provenance persisted (rawPublishedAt / publishedTz / assumption).
 * - Fingerprint matches create DuplicateCandidates — never auto-merged.
 * - One bad row never fails the rest of the file.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  importBatches,
  rawRecords,
  contentItems,
  contentMetricSnapshots,
  duplicateCandidates,
} from "../db/schema";
import type { SourceAdapter, NormalizeContext, NormalizedRecord } from "../adapters/types";
import { canonicalizeUrl } from "../domain/url";
import { computeFingerprint } from "../domain/fingerprint";
import { computeDataQuality, type QualityInput } from "../domain/quality";
import { LIMITS } from "../domain/constants";
import { syncItemAfterWrite } from "./searchIndexService";

export interface ImportRowOutcome {
  index: number;
  status: "imported" | "duplicate" | "failed";
  contentItemId?: number;
  error?: string;
  possibleDuplicateOf?: number;
  snapshotSkippedSameBatch?: boolean;
  warnings?: string[];
}

export interface ImportSummary {
  batchId: number;
  total: number;
  imported: number;
  duplicates: number;
  failed: number;
  rows: ImportRowOutcome[];
}

export interface StartBatchInput {
  name: string;
  sourceType: string;
  platform?: string | null;
  options?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function startBatch(db: DB, input: StartBatchInput): Promise<number> {
  const [row] = await db
    .insert(importBatches)
    .values({
      name: input.name,
      sourceType: input.sourceType,
      platform: input.platform ?? null,
      startedAt: nowIso(),
      status: "processing",
      options: input.options ? JSON.stringify(input.options) : null,
    })
    .returning({ id: importBatches.id });
  return row.id;
}

export async function markBatchFailed(db: DB, batchId: number, message: string): Promise<void> {
  await db
    .update(importBatches)
    .set({ status: "failed", completedAt: nowIso(), message })
    .where(eq(importBatches.id, batchId));
}

export async function runImport(
  db: DB,
  adapter: SourceAdapter,
  rawRows: unknown[],
  ctx: NormalizeContext,
  batchId: number,
  prov?: CollectionProvenance,
): Promise<ImportSummary> {
  if (rawRows.length > LIMITS.maxRecordsPerImport) {
    await markBatchFailed(
      db,
      batchId,
      `too many records: ${rawRows.length} > limit ${LIMITS.maxRecordsPerImport}`,
    );
    throw new Error(
      `单次导入最多 ${LIMITS.maxRecordsPerImport} 条，当前 ${rawRows.length} 条`,
    );
  }

  const summary = await importRowsIntoBatch(db, adapter, rawRows, ctx, batchId, prov);

  const status =
    summary.failed === 0
      ? "completed"
      : summary.failed === summary.total
        ? "failed"
        : "partial";
  await db
    .update(importBatches)
    .set({
      totalRecords: summary.total,
      successfulRecords: summary.imported + summary.duplicates,
      failedRecords: summary.failed,
      duplicateRecords: summary.duplicates,
      status,
      completedAt: nowIso(),
    })
    .where(eq(importBatches.id, batchId));

  return summary;
}

/**
 * Stage 4: page-level ingestion for collection runs — same processRow pipeline
 * (the ONLY RawRecord → ContentItem path), but does NOT touch batch status so
 * a run can feed many pages into ONE ImportBatch incrementally. Caller is
 * responsible for startBatch / final batch status via runImport-style closure
 * (collectionService finalizes the batch when the run ends).
 */
export async function importRowsIntoBatch(
  db: DB,
  adapter: SourceAdapter,
  rawRows: unknown[],
  ctx: NormalizeContext,
  batchId: number,
  prov?: CollectionProvenance,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    batchId,
    total: rawRows.length,
    imported: 0,
    duplicates: 0,
    failed: 0,
    rows: [],
  };

  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    let outcome: ImportRowOutcome;
    try {
      outcome = await processRow(db, adapter, rawRow, ctx, batchId, i, prov);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcome = { index: i, status: "failed", error: `db error: ${msg}` };
    }
    summary.rows.push(outcome);
    if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.status === "duplicate") summary.duplicates += 1;
    else summary.imported += 1;
  }

  return summary;
}

function metricsEqual(a: NormalizedRecord["metrics"], b: NormalizedRecord["metrics"]): boolean {
  return (
    a.views === b.views &&
    a.likes === b.likes &&
    a.comments === b.comments &&
    a.shares === b.shares &&
    a.favorites === b.favorites &&
    a.upvotes === b.upvotes
  );
}

/** Stage 3 provenance attached to raw_records when a connector run ingests rows. */
export interface CollectionProvenance {
  collectionRunId: number;
  connectorId: string;
  connectorVersion: string;
}

async function processRow(
  db: DB,
  adapter: SourceAdapter,
  rawRow: unknown,
  ctx: NormalizeContext,
  batchId: number,
  index: number,
  prov?: CollectionProvenance,
): Promise<ImportRowOutcome> {
  const ts = nowIso();

  // 1. cheap structural validation
  const v = adapter.validateRaw(rawRow);
  if (!v.ok) {
    await saveRaw(db, adapter, rawRow, batchId, index, ts, v.error ?? "validation failed", prov);
    return { index, status: "failed", error: v.error };
  }

  // 2. normalization (mapping + coercion + timezone semantics + zod gate)
  let record: NormalizedRecord;
  try {
    record = adapter.normalize(rawRow, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await saveRaw(db, adapter, rawRow, batchId, index, ts, `normalization error: ${msg}`, prov);
    return { index, status: "failed", error: msg };
  }

  // 3. canonical URL (central, idempotent)
  record.canonicalUrl = canonicalizeUrl(record.url);

  const warnings: string[] = [];
  const fp = computeFingerprint({
    platform: record.platform,
    authorId: record.authorId,
    authorName: record.authorName,
    title: record.title,
    publishedAt: record.publishedAt,
  });

  // 4. dedup: platform+platformContentId → canonicalUrl → fingerprint(flag only)
  let existingId: number | undefined;
  let existingRow: typeof contentItems.$inferSelect | undefined;
  if (record.platformContentId) {
    const [hit] = await db
      .select()
      .from(contentItems)
      .where(
        and(
          eq(contentItems.platform, record.platform),
          eq(contentItems.platformContentId, record.platformContentId),
        ),
      )
      .limit(1);
    if (hit) {
      existingId = hit.id;
      existingRow = hit;
    }
  }
  if (!existingId && record.canonicalUrl) {
    const [hit] = await db
      .select()
      .from(contentItems)
      .where(eq(contentItems.canonicalUrl, record.canonicalUrl))
      .limit(1);
    if (hit) {
      existingId = hit.id;
      existingRow = hit;
    }
  }

  if (existingId !== undefined && existingRow) {
    // 5b. re-collection within the SAME batch with identical metrics → no new
    // snapshot (redundancy). Cross-batch / changed metrics → snapshot appended.
    const [lastBatchSnapshot] = await db
      .select()
      .from(contentMetricSnapshots)
      .where(
        and(
          eq(contentMetricSnapshots.contentItemId, existingId),
          eq(contentMetricSnapshots.importBatchId, batchId),
        ),
      )
      .limit(1);

    const sameBatchSameMetrics =
      lastBatchSnapshot !== undefined &&
      metricsEqual(
        {
          views: lastBatchSnapshot.views,
          likes: lastBatchSnapshot.likes,
          comments: lastBatchSnapshot.comments,
          shares: lastBatchSnapshot.shares,
          favorites: lastBatchSnapshot.favorites,
          upvotes: lastBatchSnapshot.upvotes,
        },
        record.metrics,
      );

    // merged view (JS-side, explicit values — enables quality recomputation)
    const merged: QualityInput = {
      platform: record.platform,
      platformContentId: existingRow.platformContentId ?? record.platformContentId,
      url: existingRow.url ?? record.url,
      canonicalUrl: existingRow.canonicalUrl ?? record.canonicalUrl,
      urlWasProvided: Boolean(existingRow.url ?? record.url),
      title: existingRow.title ?? record.title,
      text: existingRow.text ?? record.text,
      transcript: existingRow.transcript ?? record.transcript,
      publishedAt: existingRow.publishedAt ?? record.publishedAt,
      authorId: existingRow.authorId ?? record.authorId,
      authorName: existingRow.authorName ?? record.authorName,
      metrics: {
        views: record.metrics.views ?? existingRow.views,
        likes: record.metrics.likes ?? existingRow.likes,
        comments: record.metrics.comments ?? existingRow.comments,
        shares: record.metrics.shares ?? existingRow.shares,
        favorites: record.metrics.favorites ?? existingRow.favorites,
        upvotes: record.metrics.upvotes ?? existingRow.upvotes,
      },
    };
    const q = computeDataQuality(merged);

    await db.transaction((tx) => {
      tx.insert(rawRecords)
        .values({
          sourceType: adapter.getSourceType(),
          platform: record.platform,
          adapter: adapter.id,
          importBatchId: batchId,
          rowIndex: index + 1,
          payload: JSON.stringify(rawRow ?? null),
          fieldNames: JSON.stringify(Object.keys((rawRow as object) ?? {})),
          createdAt: ts,
          collectionRunId: prov?.collectionRunId ?? null,
          connectorId: prov?.connectorId ?? null,
          connectorVersion: prov?.connectorVersion ?? null,
        })
        .run();
      if (!sameBatchSameMetrics) {
        tx.insert(contentMetricSnapshots)
          .values({
            contentItemId: existingId,
            capturedAt: ts,
            views: record.metrics.views,
            likes: record.metrics.likes,
            comments: record.metrics.comments,
            shares: record.metrics.shares,
            favorites: record.metrics.favorites,
            upvotes: record.metrics.upvotes,
            source: adapter.getSourceType(),
            importBatchId: batchId,
          })
          .run();
      }
      tx.update(contentItems)
        .set({
          views: merged.metrics.views,
          likes: merged.metrics.likes,
          comments: merged.metrics.comments,
          shares: merged.metrics.shares,
          favorites: merged.metrics.favorites,
          upvotes: merged.metrics.upvotes,
          authorFollowers:
            record.authorMetrics.followers ?? existingRow.authorFollowers,
          publishedAt: merged.publishedAt,
          rawPublishedAt:
            existingRow.rawPublishedAt ?? (record.rawPublishedAt == null ? null : String(record.rawPublishedAt)),
          publishedTz: merged.publishedAt
            ? (existingRow.publishedTz ?? record.publishedTz ?? null)
            : null,
          publishedTzAssumption: merged.publishedAt
            ? (existingRow.publishedTzAssumption ?? record.publishedTzAssumption ?? null)
            : null,
          title: merged.title,
          text: merged.text,
          url: merged.url,
          canonicalUrl: merged.canonicalUrl,
          contentType:
            existingRow.contentType === "unknown" ? record.contentType : existingRow.contentType,
          dataQuality: q.quality,
          qualityReasons: JSON.stringify(q.reasons),
          collectedAt: ts,
          updatedAt: ts,
        })
        .where(eq(contentItems.id, existingId))
        .run();
    });

    await syncItemAfterWrite(db, existingId);

    return {
      index,
      status: "duplicate",
      contentItemId: existingId,
      snapshotSkippedSameBatch: sameBatchSameMetrics || undefined,
    };
  }

  // 5c. fingerprint → possible duplicate FLAG + candidate (never merges)
  let possibleDuplicateOf: number | undefined;
  if (fp) {
    const [fpMatch] = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(and(eq(contentItems.fingerprint, fp), eq(contentItems.platform, record.platform)))
      .limit(1);
    if (fpMatch) {
      possibleDuplicateOf = fpMatch.id;
      warnings.push("possible duplicate (fingerprint match) — 需人工确认");
    }
  }

  // 6. new content item: raw → item → first snapshot (+ candidate?)
  const quality = computeDataQuality({
    platform: record.platform,
    platformContentId: record.platformContentId,
    url: record.url,
    canonicalUrl: record.canonicalUrl,
    urlWasProvided: Boolean(record.url),
    title: record.title,
    text: record.text,
    transcript: record.transcript,
    publishedAt: record.publishedAt,
    authorId: record.authorId,
    authorName: record.authorName,
    metrics: record.metrics,
  });

  const contentItemId = db.transaction((tx) => {
    const raw = tx
      .insert(rawRecords)
      .values({
        sourceType: adapter.getSourceType(),
        platform: record.platform,
        adapter: adapter.id,
        importBatchId: batchId,
        rowIndex: index + 1,
        payload: JSON.stringify(rawRow ?? null),
        fieldNames: JSON.stringify(Object.keys((rawRow as object) ?? {})),
        createdAt: ts,
        collectionRunId: prov?.collectionRunId ?? null,
        connectorId: prov?.connectorId ?? null,
        connectorVersion: prov?.connectorVersion ?? null,
      })
      .returning({ id: rawRecords.id })
      .get();

    const item = tx
      .insert(contentItems)
      .values({
        platform: record.platform,
        platformContentId: record.platformContentId,
        contentType: record.contentType,
        url: record.url,
        canonicalUrl: record.canonicalUrl,
        authorId: record.authorId,
        authorName: record.authorName,
        title: record.title,
        text: record.text,
        transcript: record.transcript,
        hashtags: JSON.stringify(record.hashtags),
        publishedAt: record.publishedAt,
        rawPublishedAt:
          record.rawPublishedAt === null || record.rawPublishedAt === undefined
            ? null
            : String(record.rawPublishedAt),
        publishedTz: record.publishedTz,
        publishedTzAssumption: record.publishedTzAssumption,
        collectedAt: ts,
        views: record.metrics.views,
        likes: record.metrics.likes,
        comments: record.metrics.comments,
        shares: record.metrics.shares,
        favorites: record.metrics.favorites,
        upvotes: record.metrics.upvotes,
        authorFollowers: record.authorMetrics.followers,
        dataQuality: quality.quality,
        qualityReasons: JSON.stringify(quality.reasons),
        sourceType: adapter.getSourceType(),
        rawDataId: raw.id,
        fingerprint: fp,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning({ id: contentItems.id })
      .get();

    tx.insert(contentMetricSnapshots)
      .values({
        contentItemId: item.id,
        capturedAt: ts,
        views: record.metrics.views,
        likes: record.metrics.likes,
        comments: record.metrics.comments,
        shares: record.metrics.shares,
        favorites: record.metrics.favorites,
        upvotes: record.metrics.upvotes,
        source: adapter.getSourceType(),
        importBatchId: batchId,
      })
      .run();

    return item.id;
  });

  if (possibleDuplicateOf !== undefined) {
    const a = possibleDuplicateOf;
    const b = contentItemId;
    const [pair] = await db
      .select({ id: duplicateCandidates.id })
      .from(duplicateCandidates)
      .where(
        sql`(
          (content_item_a = ${a} AND content_item_b = ${b})
          OR (content_item_a = ${b} AND content_item_b = ${a})
        )`,
      )
      .limit(1);
    if (!pair) {
      await db.insert(duplicateCandidates).values({
        contentItemA: a,
        contentItemB: b,
        reason: "fingerprint",
        similarity: 10000, // exact hash equality = 100%
        status: "pending",
        createdAt: ts,
      });
    }
  }

  await syncItemAfterWrite(db, contentItemId);

  return {
    index,
    status: "imported",
    contentItemId,
    possibleDuplicateOf,
    warnings: warnings.length ? warnings : undefined,
  };
}

async function saveRaw(
  db: DB,
  adapter: SourceAdapter,
  rawRow: unknown,
  batchId: number,
  index: number,
  ts: string,
  note: string,
  prov?: CollectionProvenance,
): Promise<void> {
  try {
    await db.insert(rawRecords).values({
      sourceType: adapter.getSourceType(),
      platform: null,
      adapter: adapter.id,
      importBatchId: batchId,
      rowIndex: index + 1,
      payload: JSON.stringify(rawRow ?? null),
      fieldNames: JSON.stringify(
        rawRow && typeof rawRow === "object" ? Object.keys(rawRow as object) : [],
      ),
      note,
      collectionRunId: prov?.collectionRunId ?? null,
      connectorId: prov?.connectorId ?? null,
      connectorVersion: prov?.connectorVersion ?? null,
      createdAt: ts,
    });
  } catch {
    // raw preservation must never crash the pipeline (e.g. non-serializable payload)
  }
}
