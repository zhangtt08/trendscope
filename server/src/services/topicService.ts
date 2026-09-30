/**
 * Candidate workbench service (Stage 3 → Stage 4 §0 renamed): selection
 * decisions on content items — "Candidate Workbench / 内容候选工作台".
 * Domain 层命名:ContentPick(数据库表名 topic_picks 暂保留,见 docs/DECISIONS.md)。
 * One row per item (uq_topic_pick_item) — setPick upserts.
 * decidedAt: set when a decision (adopted/rejected) is made, cleared when the
 * item returns to candidate. Raw Momentum Score / window are snapshotted at
 * decision time for auditability (DB 列 momentum_score 保留历史命名,语义 =
 * rawMomentumScore)。
 */
import { and, desc, eq, sql, count } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client";
import { contentItems, topicPicks } from "../db/schema";

export const PickStatusSchema = z.enum(["candidate", "adopted", "rejected"]);

export const SetPickSchema = z
  .object({
    contentItemId: z.number().int().positive(),
    status: PickStatusSchema,
    note: z.string().max(2000).nullish(),
    /** Raw Momentum Score at decision time. Legacy alias momentumScore accepted. */
    rawMomentumScore: z.number().int().nullish(),
    momentumScore: z.number().int().nullish(),
    windowDays: z.number().int().min(1).max(365).nullish(),
  })
  .transform((v) => ({ ...v, rawMomentumScore: v.rawMomentumScore ?? v.momentumScore ?? null }));

export type SetPickInput = z.infer<typeof SetPickSchema>;

/** Domain-layer name: one candidate decision (DB row of topic_picks). */
export interface ContentPick {
  id: number;
  contentItemId: number;
  status: string;
  note: string | null;
  /** decision-time Raw Momentum Score (DB column: momentum_score) */
  rawMomentumScore: number | null;
  windowDays: number | null;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
  // joined content fields for the workbench list
  platform: string;
  title: string | null;
  authorName: string | null;
  publishedAt: string | null;
  likes: number | null;
  url: string | null;
}

/** @deprecated legacy alias — use ContentPick */
export type PickRow = ContentPick;

export async function setPick(db: DB, input: SetPickInput): Promise<ContentPick> {
  const parsed = SetPickSchema.parse(input);
  const now = new Date().toISOString();
  const decided = parsed.status === "candidate" ? null : now;

  // upsert on uq_topic_pick_item
  await db
    .insert(topicPicks)
    .values({
      contentItemId: parsed.contentItemId,
      status: parsed.status,
      note: parsed.note ?? null,
      momentumScore: parsed.rawMomentumScore,
      windowDays: parsed.windowDays ?? null,
      createdAt: now,
      decidedAt: decided,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: topicPicks.contentItemId,
      set: {
        status: parsed.status,
        note: parsed.note ?? null,
        momentumScore: parsed.rawMomentumScore,
        windowDays: parsed.windowDays ?? null,
        decidedAt: decided,
        updatedAt: now,
      },
    });

  const row = await getPick(db, parsed.contentItemId);
  if (!row) throw new Error("标记写入未生效"); // unreachable unless FK missing
  return row;
}

export async function getPick(db: DB, contentItemId: number): Promise<ContentPick | null> {
  const rows = await db
    .select({
      id: topicPicks.id,
      contentItemId: topicPicks.contentItemId,
      status: topicPicks.status,
      note: topicPicks.note,
      rawMomentumScore: topicPicks.momentumScore,
      windowDays: topicPicks.windowDays,
      createdAt: topicPicks.createdAt,
      decidedAt: topicPicks.decidedAt,
      updatedAt: topicPicks.updatedAt,
      platform: contentItems.platform,
      title: contentItems.title,
      authorName: contentItems.authorName,
      publishedAt: contentItems.publishedAt,
      likes: contentItems.likes,
      url: contentItems.url,
    })
    .from(topicPicks)
    .innerJoin(contentItems, eq(contentItems.id, topicPicks.contentItemId))
    .where(eq(topicPicks.contentItemId, contentItemId))
    .limit(1);
  return rows[0] ?? null;
}

export interface PickListQuery {
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface PickListResult {
  rows: PickRow[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
}

export async function listPicks(db: DB, rawQuery: Record<string, unknown>): Promise<PickListResult> {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  };
  const status =
    typeof rawQuery.status === "string" && PickStatusSchema.safeParse(rawQuery.status).success
      ? rawQuery.status
      : undefined;
  const page = num(rawQuery.page, 1, 1, 1_000_000);
  const pageSize = num(rawQuery.pageSize, 50, 1, 200);

  const baseConds = [
    sql`${contentItems.mergedIntoContentItemId} IS NULL`,
    status ? eq(topicPicks.status, status) : sql`1 = 1`,
  ];

  const rows = await db
    .select({
      id: topicPicks.id,
      contentItemId: topicPicks.contentItemId,
      status: topicPicks.status,
      note: topicPicks.note,
      rawMomentumScore: topicPicks.momentumScore,
      windowDays: topicPicks.windowDays,
      createdAt: topicPicks.createdAt,
      decidedAt: topicPicks.decidedAt,
      updatedAt: topicPicks.updatedAt,
      platform: contentItems.platform,
      title: contentItems.title,
      authorName: contentItems.authorName,
      publishedAt: contentItems.publishedAt,
      likes: contentItems.likes,
      url: contentItems.url,
    })
    .from(topicPicks)
    .innerJoin(contentItems, eq(contentItems.id, topicPicks.contentItemId))
    .where(and(...baseConds))
    .orderBy(desc(topicPicks.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [totalRow] = await db
    .select({ n: count() })
    .from(topicPicks)
    .innerJoin(contentItems, eq(contentItems.id, topicPicks.contentItemId))
    .where(and(...baseConds));

  const countRows = await db
    .select({ status: topicPicks.status, n: count() })
    .from(topicPicks)
    .innerJoin(contentItems, eq(contentItems.id, topicPicks.contentItemId))
    .where(sql`${contentItems.mergedIntoContentItemId} IS NULL`)
    .groupBy(topicPicks.status);

  const counts: Record<string, number> = { candidate: 0, adopted: 0, rejected: 0 };
  for (const r of countRows) counts[r.status] = Number(r.n);

  return { rows, total: Number(totalRow?.n ?? 0), page, pageSize, counts };
}

export async function removePick(db: DB, contentItemId: number): Promise<boolean> {
  const res = await db.delete(topicPicks).where(eq(topicPicks.contentItemId, contentItemId));
  return (res.changes ?? 0) > 0;
}
