/**
 * Trend service (Stage 3): momentum scoring + overview buckets + per-item series.
 *
 * Semantics (aligned with the project's "unknown = null, never fake 0" rule):
 * - Window: last `windowDays` days of snapshots (capturedAt is UTC ISO).
 * - base  = earliest snapshot inside the window; last = latest one.
 * - If the window holds a single snapshot, fall back to the latest snapshot
 *   BEFORE the window as baseline (so a second import still yields a delta).
 * - delta(metric) = last.metric - base.metric; null on either side → null.
 *   A real 0 stays 0 — only genuinely unknown values are null.
 * - rawMomentumScore (Raw Momentum Score / 原始互动动量) =
 *   Δlikes + 2·Δcomments + 2·Δfavorites + 3·Δshares. Transparent and
 *   explainable: null components count as 0 BUT are reported in
 *   unknownComponents so the UI can flag partial evidence.
 *   名词即语义:这是"原始互动动量"启发式,不是也不得被称为
 *   Viral Score / Trend Score / Opportunity Score(Stage 4 §0 第二条)。
 * - engagement = (likes+comments+shares+favs)/views on the `last` snapshot;
 *   null unless every component is known.
 *
 * Performance: two indexed SQL pulls + in-process grouping — no per-item
 * queries, no O(n²). Validated with the 5350-row perf fixture (<1s budget).
 */
import { and, eq, gte, like, lte, or, sql, type SQL } from "drizzle-orm";
import type { DB } from "../db/client";
import { contentItems, contentMetricSnapshots, topicIntelligenceCurrent, topicMemberships, topicOpportunityCurrent, topicPicks, topics } from "../db/schema";

export const METRICS = ["likes", "comments", "shares", "favorites", "views"] as const;
export type MetricName = (typeof METRICS)[number];

/**
 * Stage 5 §24/25 — Raw Momentum Input Mapping(平台语义差异):
 * 知乎的赞同(upvotes)承接"互动主指标"语义,绝不等同 likes 字段写库;
 * 权重依旧透明:upvotes 1 / comments 2 / shares 3 / favorites 2(与默认表同构)。
 * 其余平台维持原有 likes/comments/shares/favorites 权重,零回归。
 * 仍然只叫 Raw Momentum —— 不引入任何 Viral/Trend/Opportunity Score。
 */
export type DeltaMetricName = MetricName | "upvotes";

const ZHIHU_DELTA_METRICS: readonly DeltaMetricName[] = [...METRICS, "upvotes"];
const DEFAULT_DELTA_METRICS: readonly MetricName[] = [...METRICS];

export function deltaMetricsFor(platform: string | null | undefined): readonly DeltaMetricName[] {
  return platform === "zhihu" ? ZHIHU_DELTA_METRICS : DEFAULT_DELTA_METRICS;
}

const ZHIHU_SCORE_WEIGHTS: Partial<Record<DeltaMetricName, number>> = {
  upvotes: 1,
  comments: 2,
  shares: 3,
  favorites: 2,
};

/** Score weights — public on purpose (explainable scoring, no black box). */
export const SCORE_WEIGHTS: Record<"likes" | "comments" | "shares" | "favorites", number> = {
  likes: 1,
  comments: 2,
  shares: 3,
  favorites: 2,
};

export interface MomentumQuery {
  platform?: string;
  keyword?: string;
  publishedFrom?: string;
  publishedTo?: string;
  /** Waist-content filter by absolute likes (user preference: hundreds→thousands). */
  likesMin?: number;
  likesMax?: number;
  windowDays?: number;
  sortBy?: "momentum" | "dailyLikes" | "engagement" | "latestSnapshot" | "publishedAt";
  order?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export type MetricsSnapshot = Partial<Record<MetricName, number | null>> & {
  upvotes?: number | null;
};

export interface MomentumRow {
  itemId: number;
  platform: string;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  url: string | null;
  contentType: string;
  base: { capturedAt: string; metrics: Partial<Record<DeltaMetricName, number>> } | null;
  last: { capturedAt: string; metrics: Partial<Record<DeltaMetricName, number>> } | null;
  delta: Partial<Record<DeltaMetricName, number | null>>;
  daily: Partial<Record<DeltaMetricName, number | null>>;
  engagement: number | null;
  /** Raw Momentum Score(原始互动动量)—— 透明启发式,非任何"潜力评分" */
  rawMomentumScore: number;
  unknownComponents: string[];
  snapshotCount: number;
  pick: { status: string; note: string | null } | null;
  /** §44: 所属话题(primary membership),未归题为 null;Stage 8 附饱和/新颖,Stage 9 附机会 */
  topic: { id: number; name: string; memberCount: number; saturation: number | null; novelty: number | null; opportunity: number | null } | null;
}

export interface MomentumResult {
  rows: MomentumRow[];
  total: number;
  page: number;
  pageSize: number;
  windowDays: number;
  windowStart: string;
  baselineUsedCount: number;
}

const DAY_MS = 86_400_000;

function parseMomentumQuery(q: Record<string, unknown>): MomentumQuery {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const sortBy = str(q.sortBy);
  return {
    platform: str(q.platform),
    keyword: str(q.keyword),
    publishedFrom: str(q.publishedFrom),
    publishedTo: str(q.publishedTo),
    likesMin: q.likesMin === undefined || q.likesMin === "" ? undefined : num(q.likesMin, 0, 0, Number.MAX_SAFE_INTEGER),
    likesMax: q.likesMax === undefined || q.likesMax === "" ? undefined : num(q.likesMax, 0, 0, Number.MAX_SAFE_INTEGER),
    windowDays: num(q.windowDays, 7, 1, 365),
    sortBy:
      sortBy === "dailyLikes" || sortBy === "engagement" || sortBy === "latestSnapshot" || sortBy === "publishedAt"
        ? sortBy
        : "momentum",
    order: q.order === "asc" ? "asc" : "desc",
    page: num(q.page, 1, 1, 1_000_000),
    pageSize: num(q.pageSize, 20, 1, 100),
  };
}

/** Normalized snapshot point (camelCase, regardless of query source). */
interface SnapPoint {
  id: number;
  contentItemId: number;
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  upvotes: number | null;
}

/** Raw SQL row shape (snake_case, from the baseline correlated subquery). */
interface RawSnapRow {
  id: number;
  content_item_id: number;
  captured_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  favorites: number | null;
  upvotes: number | null;
}

function rawToPoint(r: RawSnapRow): SnapPoint {
  return {
    id: r.id,
    contentItemId: r.content_item_id,
    capturedAt: r.captured_at,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    favorites: r.favorites,
    upvotes: r.upvotes,
  };
}

function pointMetrics(p: SnapPoint, platform?: string): Partial<Record<DeltaMetricName, number>> {
  const m: Partial<Record<DeltaMetricName, number>> = {};
  for (const k of deltaMetricsFor(platform)) {
    const v = p[k];
    if (v !== null && v !== undefined) m[k] = v;
  }
  return m;
}

export function computeDelta(
  base: { capturedAt: string; metrics: Partial<Record<DeltaMetricName, number>> },
  last: { capturedAt: string; metrics: Partial<Record<DeltaMetricName, number>> },
  metricsList: readonly DeltaMetricName[] = METRICS,
): {
  delta: Partial<Record<DeltaMetricName, number | null>>;
  daily: Partial<Record<DeltaMetricName, number | null>>;
  unknownComponents: string[];
} {
  const spanMs = Date.parse(last.capturedAt) - Date.parse(base.capturedAt);
  const spanDays = spanMs > 0 ? spanMs / DAY_MS : null;
  const delta: Partial<Record<DeltaMetricName, number | null>> = {};
  const daily: Partial<Record<DeltaMetricName, number | null>> = {};
  const unknownComponents: string[] = [];
  for (const k of metricsList) {
    const b = base.metrics[k];
    const l = last.metrics[k];
    // null-or-undefined on either side = unknown (defensive: SQL NULL must
    // never leak into arithmetic, where JS would coerce null → 0)
    if (b === undefined || b === null || l === undefined || l === null) {
      delta[k] = null;
      daily[k] = null;
      unknownComponents.push(k);
      continue;
    }
    const d = l - b;
    delta[k] = d;
    daily[k] = spanDays !== null ? d / spanDays : null;
  }
  return { delta, daily, unknownComponents };
}

export function engagementOf(m: Partial<Record<MetricName, number>>): number | null {
  const { likes, comments, shares, favorites, views } = m;
  if (likes === undefined || comments === undefined || shares === undefined || favorites === undefined || views === undefined) {
    return null;
  }
  if (views <= 0) return null; // real 0 views → not computable, not "infinite"
  return (likes + comments + shares + favorites) / views;
}

/** scoreOf — 平台感知权重(§24):透明启发式,非任何"潜力评分" */
export function scoreOf(
  delta: Partial<Record<DeltaMetricName, number | null>>,
  platform?: string | null,
): number {
  const weights: Partial<Record<DeltaMetricName, number>> =
    platform === "zhihu" ? ZHIHU_SCORE_WEIGHTS : SCORE_WEIGHTS;
  let score = 0;
  for (const k of Object.keys(weights) as DeltaMetricName[]) {
    const w = weights[k];
    if (w === undefined) continue;
    const d = delta[k];
    if (typeof d === "number" && Number.isFinite(d)) score += d * w;
  }
  return Math.round(score);
}

export async function getMomentumList(db: DB, rawQuery: Record<string, unknown>): Promise<MomentumResult> {
  const q = parseMomentumQuery(rawQuery);
  const now = Date.now();
  const windowStartIso = new Date(now - q.windowDays! * DAY_MS).toISOString();

  // 1) item-level content filters (merged sources excluded, same as listings)
  const conds: SQL[] = [sql`${contentItems.mergedIntoContentItemId} IS NULL`];
  if (q.platform) conds.push(eq(contentItems.platform, q.platform));
  if (q.publishedFrom) conds.push(gte(contentItems.publishedAt, q.publishedFrom));
  if (q.publishedTo) conds.push(lte(contentItems.publishedAt, q.publishedTo));
  if (q.likesMin !== undefined) conds.push(gte(contentItems.likes, q.likesMin));
  if (q.likesMax !== undefined) conds.push(lte(contentItems.likes, q.likesMax));
  if (q.keyword) {
    const kw = `%${q.keyword}%`;
    conds.push(or(like(contentItems.title, kw), like(contentItems.text, kw))!);
  }

  const candidates = await db
    .select({
      id: contentItems.id,
      platform: contentItems.platform,
      title: contentItems.title,
      authorName: contentItems.authorName,
      publishedAt: contentItems.publishedAt,
      url: contentItems.url,
      contentType: contentItems.contentType,
    })
    .from(contentItems)
    .where(and(...conds));
  if (candidates.length === 0) {
    return {
      rows: [],
      total: 0,
      page: q.page!,
      pageSize: q.pageSize!,
      windowDays: q.windowDays!,
      windowStart: windowStartIso,
      baselineUsedCount: 0,
    };
  }
  const idSet = new Set(candidates.map((c) => c.id));

  // 2) window snapshots for those items (single indexed pull, grouped in-process)
  const windowRows: SnapPoint[] = await db
    .select({
      id: contentMetricSnapshots.id,
      contentItemId: contentMetricSnapshots.contentItemId,
      capturedAt: contentMetricSnapshots.capturedAt,
      views: contentMetricSnapshots.views,
      likes: contentMetricSnapshots.likes,
      comments: contentMetricSnapshots.comments,
      shares: contentMetricSnapshots.shares,
      favorites: contentMetricSnapshots.favorites,
      upvotes: contentMetricSnapshots.upvotes,
    })
    .from(contentMetricSnapshots)
    .where(gte(contentMetricSnapshots.capturedAt, windowStartIso))
    .orderBy(contentMetricSnapshots.contentItemId, contentMetricSnapshots.capturedAt);

  const byItem = new Map<number, SnapPoint[]>();
  const withWindow = new Set<number>();
  for (const p of windowRows) {
    if (!idSet.has(p.contentItemId)) continue;
    withWindow.add(p.contentItemId);
    if (!byItem.has(p.contentItemId)) byItem.set(p.contentItemId, []);
    byItem.get(p.contentItemId)!.push(p);
  }

  // 3) single-snapshot items: pull their latest pre-window baseline in one
  //    correlated-subquery query (indexed by (content_item_id, captured_at)).
  const needBaseline = [...withWindow].filter((iid) => (byItem.get(iid)?.length ?? 0) === 1);
  let baselineUsedCount = 0;
  if (needBaseline.length > 0) {
    const idList = needBaseline.join(",");
    const baseRows = await db.all<RawSnapRow>(
      sql`SELECT s.id, s.content_item_id, s.captured_at, s.views, s.likes, s.comments, s.shares, s.favorites, s.upvotes
          FROM content_metric_snapshots s
          WHERE s.captured_at < ${windowStartIso}
            AND s.content_item_id IN (${sql.raw(idList)})
            AND s.id = (
              SELECT s2.id FROM content_metric_snapshots s2
              WHERE s2.content_item_id = s.content_item_id AND s2.captured_at < ${windowStartIso}
              ORDER BY s2.captured_at DESC, s2.id DESC LIMIT 1
            )`,
    );
    for (const r of baseRows) {
      byItem.get(r.content_item_id)!.unshift(rawToPoint(r));
      baselineUsedCount += 1;
    }
  }

  // 4) pick decisions for the candidate set (single indexed pull)
  const pickRows = await db
    .select({
      contentItemId: topicPicks.contentItemId,
      status: topicPicks.status,
      note: topicPicks.note,
    })
    .from(topicPicks);
  const pickMap = new Map(pickRows.map((p) => [p.contentItemId, { status: p.status, note: p.note }]));

  // §44: topic context lookup (single query)
  const memRows = await db
    .select({
      contentItemId: topicMemberships.contentItemId,
      topicId: topics.id,
      topicName: topics.name,
      memberCount: topics.memberCount,
      saturation: topicIntelligenceCurrent.saturationScore,
      novelty: topicIntelligenceCurrent.noveltyScore,
      opportunity: topicOpportunityCurrent.score,
    })
    .from(topicMemberships)
    .innerJoin(topics, eq(topics.id, topicMemberships.topicId))
    .leftJoin(topicIntelligenceCurrent, eq(topicIntelligenceCurrent.topicId, topics.id))
    .leftJoin(topicOpportunityCurrent, eq(topicOpportunityCurrent.topicId, topics.id));
  const topicByItem = new Map(memRows.map((m) => [m.contentItemId, m]));

  // 5) assemble rows
  const rows: MomentumRow[] = [];
  for (const c of candidates) {
    const snaps = byItem.get(c.id);
    if (!snaps || snaps.length < 2) continue; // no trend evidence yet
    const base = { capturedAt: snaps[0].capturedAt, metrics: pointMetrics(snaps[0], c.platform) };
    const lastRow = snaps[snaps.length - 1];
    const last = { capturedAt: lastRow.capturedAt, metrics: pointMetrics(lastRow, c.platform) };
    const { delta, daily, unknownComponents } = computeDelta(base, last, deltaMetricsFor(c.platform));
    rows.push({
      itemId: c.id,
      platform: c.platform,
      title: c.title,
      authorName: c.authorName,
      publishedAt: c.publishedAt,
      url: c.url,
      contentType: c.contentType,
      base,
      last,
      delta,
      daily,
      engagement: engagementOf(last.metrics),
      rawMomentumScore: scoreOf(delta, c.platform),
      unknownComponents,
      snapshotCount: snaps.length,
      pick: pickMap.get(c.id) ?? null,
      topic: topicByItem.has(c.id)
        ? (() => {
            const t = topicByItem.get(c.id)!;
            return { id: t.topicId, name: t.topicName, memberCount: t.memberCount, saturation: t.saturation, novelty: t.novelty, opportunity: t.opportunity };
          })()
        : null,
    });
  }

  // 6) sort + paginate in-process (5350-row scale: ms-level; perf test guards this)
  const dir = q.order === "asc" ? 1 : -1;
  const numOr = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : -Infinity);
  rows.sort((a, b) => {
    let cmp = 0;
    switch (q.sortBy) {
      case "dailyLikes":
        cmp = numOr(a.daily.likes) - numOr(b.daily.likes);
        break;
      case "engagement":
        cmp = numOr(a.engagement) - numOr(b.engagement);
        break;
      case "latestSnapshot":
        cmp = Date.parse(a.last!.capturedAt) - Date.parse(b.last!.capturedAt);
        break;
      case "publishedAt":
        cmp = Date.parse(a.publishedAt ?? "0") - Date.parse(b.publishedAt ?? "0");
        break;
      default:
        cmp = a.rawMomentumScore - b.rawMomentumScore;
    }
    return cmp * dir;
  });

  const total = rows.length;
  const start = (q.page! - 1) * q.pageSize!;
  return {
    rows: rows.slice(start, start + q.pageSize!),
    total,
    page: q.page!,
    pageSize: q.pageSize!,
    windowDays: q.windowDays!,
    windowStart: windowStartIso,
    baselineUsedCount,
  };
}

/* ------------------------------------------------------------------ */
/* Overview: day-bucketed snapshot activity for the trend hero chart   */
/* ------------------------------------------------------------------ */

export interface TrendOverview {
  windowDays: number;
  windowStart: string;
  platform?: string;
  buckets: { date: string; snapshots: number; distinctItems: number; likesDeltaSum: number | null }[];
  platformMix: { platform: string; items: number; snapshots: number }[];
  totalSnapshots: number;
  activeItems: number;
}

export async function getTrendOverview(
  db: DB,
  rawQuery: Record<string, unknown>,
): Promise<TrendOverview> {
  const q = parseMomentumQuery(rawQuery);
  const now = Date.now();
  const windowStartIso = new Date(now - q.windowDays! * DAY_MS).toISOString();

  // Day buckets on UTC date prefix of capturedAt (documented: UTC day grain).
  const bucketRows = await db
    .select({
      date: sql<string>`substr(${contentMetricSnapshots.capturedAt}, 1, 10)`,
      snapshots: sql<number>`count(*)`,
      distinctItems: sql<number>`count(distinct ${contentMetricSnapshots.contentItemId})`,
    })
    .from(contentMetricSnapshots)
    .where(gte(contentMetricSnapshots.capturedAt, windowStartIso))
    .groupBy(sql`substr(${contentMetricSnapshots.capturedAt}, 1, 10)`)
    .orderBy(sql`substr(${contentMetricSnapshots.capturedAt}, 1, 10)`);

  const platformMixRows = await db
    .select({
      platform: contentItems.platform,
      items: sql<number>`count(distinct ${contentMetricSnapshots.contentItemId})`,
      snapshots: sql<number>`count(*)`,
    })
    .from(contentMetricSnapshots)
    .innerJoin(contentItems, eq(contentItems.id, contentMetricSnapshots.contentItemId))
    .where(
      and(
        gte(contentMetricSnapshots.capturedAt, windowStartIso),
        q.platform ? eq(contentItems.platform, q.platform) : sql`1 = 1`,
        sql`${contentItems.mergedIntoContentItemId} IS NULL`,
      ),
    )
    .groupBy(contentItems.platform);

  const totalSnapshots = bucketRows.reduce((s, b) => s + Number(b.snapshots), 0);
  return {
    windowDays: q.windowDays!,
    windowStart: windowStartIso,
    platform: q.platform,
    buckets: bucketRows.map((b) => ({
      date: b.date,
      snapshots: Number(b.snapshots),
      distinctItems: Number(b.distinctItems),
      likesDeltaSum: null, // reserved: cross-item like deltas per day is window-dependent
    })),
    platformMix: platformMixRows.map((p) => ({
      platform: p.platform,
      items: Number(p.items),
      snapshots: Number(p.snapshots),
    })),
    totalSnapshots,
    activeItems: platformMixRows.reduce((s, p) => s + p.items, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Per-item series for the detail page chart                           */
/* ------------------------------------------------------------------ */

export interface ItemTrendSeries {
  itemId: number;
  series: {
    capturedAt: string;
    source: string;
    importBatchId: number | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    favorites: number | null;
    upvotes: number | null;
  }[];
  delta: Partial<Record<DeltaMetricName, number | null>>;
  unknownComponents: string[];
}

export async function getItemTrendSeries(db: DB, itemId: number): Promise<ItemTrendSeries | null> {
  const [item] = await db
    .select({ id: contentItems.id, platform: contentItems.platform })
    .from(contentItems)
    .where(eq(contentItems.id, itemId))
    .limit(1);
  if (!item) return null;

  const snaps = await db
    .select({
      capturedAt: contentMetricSnapshots.capturedAt,
      source: contentMetricSnapshots.source,
      importBatchId: contentMetricSnapshots.importBatchId,
      views: contentMetricSnapshots.views,
      likes: contentMetricSnapshots.likes,
      comments: contentMetricSnapshots.comments,
      shares: contentMetricSnapshots.shares,
      favorites: contentMetricSnapshots.favorites,
      upvotes: contentMetricSnapshots.upvotes,
    })
    .from(contentMetricSnapshots)
    .where(eq(contentMetricSnapshots.contentItemId, itemId))
    .orderBy(contentMetricSnapshots.capturedAt);

  let delta: Partial<Record<DeltaMetricName, number | null>> = {};
  let unknownComponents: string[] = [];
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const metricsList = deltaMetricsFor(item.platform);
    const computed = computeDelta(
      {
        capturedAt: first.capturedAt,
        metrics: Object.fromEntries(
          metricsList.map((k) => [k, first[k]]).filter(([, v]) => v !== null && v !== undefined),
        ) as Partial<Record<DeltaMetricName, number>>,
      },
      {
        capturedAt: last.capturedAt,
        metrics: Object.fromEntries(
          metricsList.map((k) => [k, last[k]]).filter(([, v]) => v !== null && v !== undefined),
        ) as Partial<Record<DeltaMetricName, number>>,
      },
      metricsList,
    );
    delta = computed.delta;
    unknownComponents = computed.unknownComponents;
  }

  return { itemId, series: snaps, delta, unknownComponents };
}
