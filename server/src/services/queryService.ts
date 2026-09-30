/**
 * Query API (Stage 1 §19/20 + Stage 2 §6/8/9/10):
 * - FTS5-first keyword search (BM25 relevance by default) with LIKE fallback
 * - filters + pagination + column-allowlist sorting
 * - detail with full lineage incl. time provenance & merge info (Stage 2 §20)
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  lte,
  like,
  or,
  count,
  sql,
  type SQL,
} from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems, contentMetricSnapshots, rawRecords, importBatches } from "../db/schema";
import { buildMatchQuery } from "./searchIndexService";
import { getMergedSources, getMergeRecordsFor, candidatesForItem } from "./duplicateService";

export interface ContentQuery {
  platform?: string;
  contentType?: string;
  quality?: string;
  author?: string;
  keyword?: string;
  publishedFrom?: string;
  publishedTo?: string;
  collectedFrom?: string;
  collectedTo?: string;
  sortBy?: string;
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export interface ContentQueryResult {
  rows: (typeof contentItems.$inferSelect & {
    hlTitle?: string | null;
    hlBody?: string | null;
  })[];
  total: number;
  page: number;
  pageSize: number;
  mode: "fts" | "like" | "plain";
  queryUsed?: string | null;
}

const SORTABLE = {
  publishedAt: contentItems.publishedAt,
  collectedAt: contentItems.collectedAt,
  views: contentItems.views,
  likes: contentItems.likes,
  comments: contentItems.comments,
  title: contentItems.title,
  // Explorer 的表头提供 Author 排序;之前 SORTABLE 没有这一项,
  // 点它会静默退回 collectedAt,而箭头图标仍显示"已按 Author 排序"。
  authorName: contentItems.authorName,
  dataQuality: contentItems.dataQuality,
  id: contentItems.id,
} as const;

export function parseContentQuery(q: Record<string, unknown>): ContentQuery {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  return {
    platform: typeof q.platform === "string" && q.platform ? q.platform : undefined,
    contentType: typeof q.contentType === "string" && q.contentType ? q.contentType : undefined,
    quality: typeof q.quality === "string" && q.quality ? q.quality : undefined,
    author: typeof q.author === "string" && q.author ? q.author : undefined,
    keyword: typeof q.keyword === "string" && q.keyword ? q.keyword : undefined,
    publishedFrom: typeof q.publishedFrom === "string" ? q.publishedFrom : undefined,
    publishedTo: typeof q.publishedTo === "string" ? q.publishedTo : undefined,
    collectedFrom: typeof q.collectedFrom === "string" ? q.collectedFrom : undefined,
    collectedTo: typeof q.collectedTo === "string" ? q.collectedTo : undefined,
    sortBy:
      typeof q.sortBy === "string"
        ? q.sortBy === "relevance"
          ? "relevance"
          : q.sortBy in SORTABLE
            ? q.sortBy
            : "collectedAt"
        : "collectedAt",
    order: q.order === "asc" ? "asc" : "desc",
    page: num(q.page, 1, 1, 1_000_000),
    pageSize: num(q.pageSize, 20, 1, 100),
  };
}

function buildFilters(q: ContentQuery): SQL[] {
  const conds: SQL[] = [];
  // merged sources are excluded from listings (they remain accessible via detail)
  conds.push(sql`${contentItems.mergedIntoContentItemId} IS NULL`);
  if (q.platform) conds.push(eq(contentItems.platform, q.platform));
  if (q.contentType) conds.push(eq(contentItems.contentType, q.contentType));
  if (q.quality) conds.push(eq(contentItems.dataQuality, q.quality));
  if (q.author) {
    conds.push(
      or(
        like(contentItems.authorName, `%${q.author}%`),
        like(contentItems.authorId, `%${q.author}%`),
      )!,
    );
  }
  // 日期控件给的是 "YYYY-MM-DD",而库里存的是完整 UTC ISO 串。
  // 直接 lte("...T08:34:37Z", "2024-05-01") 按字符串比较恒为 false,
  // 会把结束日当天全部排除 —— 补成当天末尾才对。
  const endOfDay = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
  if (q.publishedFrom) conds.push(gte(contentItems.publishedAt, q.publishedFrom));
  if (q.publishedTo) conds.push(lte(contentItems.publishedAt, endOfDay(q.publishedTo)));
  if (q.collectedFrom) conds.push(gte(contentItems.collectedAt, q.collectedFrom));
  if (q.collectedTo) conds.push(lte(contentItems.collectedAt, endOfDay(q.collectedTo)));
  return conds;
}

function likeKeywordCond(keyword: string): SQL {
  const kw = `%${keyword}%`;
  return or(
    like(contentItems.title, kw),
    like(contentItems.text, kw),
    like(contentItems.authorName, kw),
    like(contentItems.platformContentId, kw),
  )!;
}

export async function queryContent(db: DB, q: ContentQuery): Promise<ContentQueryResult> {
  const conds = buildFilters(q);
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  const keyword = q.keyword?.trim();

  // ---------- FTS path (Stage 2) ----------
  if (keyword) {
    const match = buildMatchQuery(keyword);
    if (match) {
      try {
        const ftsFilter = sql`fts_documents MATCH ${match}`;
        const totalRow = db
          .get(
            sql`SELECT count(*) AS n
                FROM fts_documents
                JOIN content_items ON content_items.id = fts_documents.rowid
                WHERE ${ftsFilter}
                  AND content_items.merged_into_content_item_id IS NULL
                  ${conds.length ? sql`AND ${sql.join(conds, sql` AND `)}` : sql``}`,
          ) as { n: number } | undefined;

        const useRelevance = q.sortBy === "relevance";
        // SQLite 的 bm25() 是"越小越相关",所以最佳结果在 ASC 端。
        // 原实现把 order=desc 映射成 bm25 DESC,一旦前端启用相关度排序就会
        // 把最不相关的结果排在最前。相关度本身没有"升序"语义,故忽略 order。
        const orderSql = useRelevance
          ? sql`ORDER BY bm25(fts_documents) ASC, content_items.id ASC`
          : q.order === "asc"
            ? sql`ORDER BY ${sql.raw(sortSqlColumn(q.sortBy))} ASC, content_items.id DESC`
            : sql`ORDER BY ${sql.raw(sortSqlColumn(q.sortBy))} DESC, content_items.id DESC`;

        const rows = db
          .all(
            sql`SELECT content_items.*,
                  snippet(fts_documents, 0, '[', ']', '…', 20) AS hl_title,
                  snippet(fts_documents, 1, '[', ']', '…', 30) AS hl_body,
                  bm25(fts_documents) AS fts_score
                FROM fts_documents
                JOIN content_items ON content_items.id = fts_documents.rowid
                WHERE ${ftsFilter}
                  AND content_items.merged_into_content_item_id IS NULL
                  ${conds.length ? sql`AND ${sql.join(conds, sql` AND `)}` : sql``}
                ${orderSql}
                LIMIT ${pageSize} OFFSET ${offset}`,
          ) as Record<string, unknown>[];

        return {
          rows: rows.map(mapRawRow),
          total: totalRow?.n ?? 0,
          page,
          pageSize,
          mode: "fts",
          queryUsed: match,
        };
      } catch (e) {
        // malformed MATCH or FTS failure → safe LIKE fallback (Stage 2 §8)
        console.error("[fts] falling back to LIKE:", e instanceof Error ? e.message : e);
      }
    }
  }

  // ---------- plain / LIKE fallback path ----------
  const where = (() => {
    const all = [...conds];
    if (keyword) all.push(likeKeywordCond(keyword));
    return all.length > 0 ? and(...all) : undefined;
  })();

  const sortCol =
    SORTABLE[(q.sortBy === "relevance" ? "collectedAt" : (q.sortBy ?? "collectedAt")) as keyof typeof SORTABLE] ??
    contentItems.collectedAt;
  const orderBy = q.order === "asc" ? asc(sortCol) : desc(sortCol);

  const [totalRow] = await db
    .select({ n: count() })
    .from(contentItems)
    .where(where);
  const rows = await db
    .select()
    .from(contentItems)
    .where(where)
    // 次级排序键:同一次导入的多行 collected_at 完全相同(同一 nowIso),
    // 没有 tie-breaker 时 SQLite 顺序不稳定,翻页会重复/漏掉条目。
    .orderBy(orderBy, desc(contentItems.id))
    .limit(pageSize)
    .offset(offset);

  return {
    rows,
    total: totalRow?.n ?? 0,
    page,
    pageSize,
    mode: keyword ? "like" : "plain",
  };
}

function sortSqlColumn(sortBy?: string): string {
  const map: Record<string, string> = {
    publishedAt: "content_items.published_at",
    collectedAt: "content_items.collected_at",
    views: "content_items.views",
    likes: "content_items.likes",
    comments: "content_items.comments",
    title: "content_items.title",
    platform: "content_items.platform",
    dataQuality: "content_items.data_quality",
    id: "content_items.id",
  };
  return map[sortBy ?? "collectedAt"] ?? "content_items.collected_at";
}

/** Convert raw SQL rows (snake_case keys) into the camelCase shape drizzle returns. */
function mapRawRow(r: Record<string, unknown>): (typeof contentItems.$inferSelect) & {
  hlTitle?: string | null;
  hlBody?: string | null;
} {
  return {
    id: r.id as number,
    platform: r.platform as string,
    platformContentId: (r.platform_content_id as string) ?? null,
    contentType: r.content_type as string,
    url: (r.url as string) ?? null,
    canonicalUrl: (r.canonical_url as string) ?? null,
    authorId: (r.author_id as string) ?? null,
    authorName: (r.author_name as string) ?? null,
    title: (r.title as string) ?? null,
    text: (r.text as string) ?? null,
    transcript: (r.transcript as string) ?? null,
    hashtags: (r.hashtags as string) ?? null,
    publishedAt: (r.published_at as string) ?? null,
    rawPublishedAt: (r.raw_published_at as string) ?? null,
    publishedTz: (r.published_tz as string) ?? null,
    publishedTzAssumption: (r.published_tz_assumption as string) ?? null,
    collectedAt: r.collected_at as string,
    views: (r.views as number) ?? null,
    likes: (r.likes as number) ?? null,
    comments: (r.comments as number) ?? null,
    shares: (r.shares as number) ?? null,
    favorites: (r.favorites as number) ?? null,
    upvotes: (r.upvotes as number) ?? null,
    authorFollowers: (r.author_followers as number) ?? null,
    dataQuality: r.data_quality as string,
    qualityReasons: (r.quality_reasons as string) ?? null,
    mergedIntoContentItemId: (r.merged_into_content_item_id as number) ?? null,
    sourceType: r.source_type as string,
    rawDataId: (r.raw_data_id as number) ?? null,
    fingerprint: (r.fingerprint as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    hlTitle: (r.hl_title as string) ?? null,
    hlBody: (r.hl_body as string) ?? null,
  };
}

export type ContentRow = ContentQueryResult["rows"][number];

/** Full detail: normalized + snapshots + raw + batch lineage (Stage 1 §20 + Stage 2 §20). */
export async function getContentDetail(db: DB, id: number) {
  const [item] = await db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
  if (!item) return null;

  const snapshots = await db
    .select()
    .from(contentMetricSnapshots)
    .where(eq(contentMetricSnapshots.contentItemId, id))
    .orderBy(desc(contentMetricSnapshots.capturedAt));

  let raw = null as null | typeof rawRecords.$inferSelect;
  if (item.rawDataId) {
    const [r] = await db
      .select()
      .from(rawRecords)
      .where(eq(rawRecords.id, item.rawDataId))
      .limit(1);
    raw = r ?? null;
  }

  let batch = null as null | typeof importBatches.$inferSelect;
  if (raw?.importBatchId) {
    const [b] = await db
      .select()
      .from(importBatches)
      .where(eq(importBatches.id, raw.importBatchId))
      .limit(1);
    batch = b ?? null;
  }

  // Stage 2 lineage: merge info + candidates involving this item
  const mergedSources = item.mergedIntoContentItemId
    ? []
    : await getMergedSources(db, id);
  const mergeRecords = await getMergeRecordsFor(db, id);
  const candidates = await candidatesForItem(db, id);

  return {
    item,
    snapshots,
    raw,
    batch,
    mergedInto: item.mergedIntoContentItemId
      ? (
          await db
            .select({ id: contentItems.id, title: contentItems.title })
            .from(contentItems)
            .where(eq(contentItems.id, item.mergedIntoContentItemId))
            .limit(1)
        )[0] ?? null
      : null,
    mergedSources,
    mergeRecords,
    candidates,
  };
}
