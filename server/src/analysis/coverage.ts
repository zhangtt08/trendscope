/**
 * 各引擎覆盖度(§32/§40)。
 *
 * "有多少话题就算多少"是错的:未评分的话题必须显式体现为差额,
 * 否则首页会显示"分析已完成",而机会工作台里一半话题是空的。
 */
import { count, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  contentScoreCurrent,
  topicIntelligenceCurrent,
  topicOpportunityCurrent,
  topicScoreCurrent,
} from "../db/schema";

export interface Coverage {
  scored: number;
  total: number;
  lastCalculatedAt: string | null;
}

const num = (v: unknown): number => Number(v ?? 0);

export async function coverageView(db: DB): Promise<[Coverage, Coverage, Coverage, Coverage]> {
  const burst = (
    await db
      .select({
        scored: sql<number>`sum(case when ${contentScoreCurrent.overallScore} is not null then 1 else 0 end)`,
        total: count(),
        last: sql<string | null>`max(${contentScoreCurrent.calculatedAt})`,
      })
      .from(contentScoreCurrent)
      .where(sql`${contentScoreCurrent.scoreType} = 'content_burst'`)
  )[0];
  const trend = (
    await db
      .select({
        scored: sql<number>`sum(case when ${topicScoreCurrent.score} is not null then 1 else 0 end)`,
        total: count(),
        last: sql<string | null>`max(${topicScoreCurrent.calculatedAt})`,
      })
      .from(topicScoreCurrent)
  )[0];
  const intel = (
    await db
      .select({
        scored: sql<number>`sum(case when ${topicIntelligenceCurrent.saturationScore} is not null
          or ${topicIntelligenceCurrent.noveltyScore} is not null then 1 else 0 end)`,
        total: count(),
        last: sql<string | null>`max(${topicIntelligenceCurrent.calculatedAt})`,
      })
      .from(topicIntelligenceCurrent)
  )[0];
  const opp = (
    await db
      .select({
        scored: sql<number>`sum(case when ${topicOpportunityCurrent.score} is not null then 1 else 0 end)`,
        total: count(),
        last: sql<string | null>`max(${topicOpportunityCurrent.calculatedAt})`,
      })
      .from(topicOpportunityCurrent)
  )[0];

  const to = (r: { scored?: unknown; total?: unknown; last?: string | null } | undefined): Coverage => ({
    scored: num(r?.scored),
    total: num(r?.total),
    lastCalculatedAt: r?.last ?? null,
  });
  return [to(burst), to(trend), to(intel), to(opp)];
}
