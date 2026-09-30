/**
 * Scoring API (Stage 7 §CR-§CU):
 *   /api/scoring/profile | /runs | /content/run | /content/:id | /trend/run
 *   /api/trends/topics | /api/trends/contents | /api/topics/:id/trend
 * 列表全部 SQL 分页(§CS);breakdown 由服务端返回结构化 JSON,前端不算公式(§CU)。
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { SCORING_PROFILES, configSnapshotFor } from "../scoring/profiles";
import {
  getContentScoreDetail,
  getTopicTrendDetail,
  listContentScores,
  listScoringRuns,
  listTopicTrends,
} from "../scoring/repository";
import { runAllScoring, runContentScoring, runTopicTrendScoring } from "../scoring/service";
import { clientOrServerError } from "./errors";
import { withEngineLock } from "../services/engineLock";

/** JSON 列 → 对象;解析失败或为空一律回 fallback(绝不返回半成品冒充数据)。 */
function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonFields<T extends Record<string, unknown>>(row: T | null, fields: string[]): T | null {
  if (!row) return null;
  const out = { ...row };
  for (const f of fields) {
    if (typeof out[f] === "string") {
      try {
        (out as Record<string, unknown>)[f] = JSON.parse(out[f] as string);
      } catch {
        /* keep raw string */
      }
    }
  }
  return out;
}

function strOr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function createScoringRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/profile", (_req, res) => {
    res.json({
      burst: SCORING_PROFILES.burst,
      trend: SCORING_PROFILES.trend,
      lifecycle: SCORING_PROFILES.lifecycle,
      configSnapshot: configSnapshotFor(SCORING_PROFILES),
      note: "内容爆发指数与话题趋势指数均为对已观察数据的量化,不是未来爆款概率",
    });
  });

  router.get("/runs", async (req, res) => {
    try {
      res.json({ rows: await listScoringRuns(db, strOr(req.query.profile)) });
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.post("/content/run", async (req, res) => {
    try {
      const body = z.object({ wait: z.boolean().optional() }).parse(req.body ?? {});
      await withEngineLock(res, ["content"], "scoring-api", body.wait === true, () => runContentScoring(db));
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.post("/trend/run", async (req, res) => {
    try {
      const body = z.object({ wait: z.boolean().optional(), includeContent: z.boolean().optional() }).parse(req.body ?? {});
      const work = () => (body.includeContent ? runAllScoring(db) : runTopicTrendScoring(db));
      await withEngineLock(
        res,
        body.includeContent ? ["trend", "content"] : ["trend"],
        "scoring-api",
        body.wait === true,
        work,
      );
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.get("/content/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await getContentScoreDetail(db, id);
      if (!detail.current) return res.status(404).json({ error: "暂无评分结果", hint: "尚未运行内容评分" });
      res.json({
        current: parseJsonFields(detail.current as unknown as Record<string, unknown>, ["breakdown", "evidence"]),
        history: detail.history.map((h) => parseJsonFields(h as unknown as Record<string, unknown>, ["breakdown", "evidence"])),
      });
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });
  return router;
}

/** /api 下挂的趋势查询与话题趋势(与 topics router 无路径冲突)。 */
export function createTrendQueryRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/trends/topics", async (req, res) => {
    try {
      const q = z
        .object({
          search: z.string().optional(),
          lifecycle: z.string().optional(),
          confidence: z.string().optional(),
          platform: z.string().optional(),
          watch: z.string().optional(),
          minScore: z.coerce.number().min(0).max(100).optional(),
          saturation: z.string().optional(),
          noveltyMin: z.coerce.number().min(0).max(100).optional(),
          minOpportunity: z.coerce.number().min(0).max(100).optional(),
          sortBy: z.string().optional(),
          order: z.string().optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const sortBy = strOr(q.sortBy);
      const result = await listTopicTrends(db, {
        search: strOr(q.search),
        lifecycle: strOr(q.lifecycle),
        confidence: strOr(q.confidence),
        platform: strOr(q.platform),
        watch: strOr(q.watch),
        minScore: q.minScore,
        saturation: strOr(q.saturation),
        noveltyMin: q.noveltyMin,
        minOpportunity: q.minOpportunity,
        sortBy:
          sortBy === "memberCount" || sortBy === "recentNew" || sortBy === "updatedAt" || sortBy === "saturation" || sortBy === "novelty" || sortBy === "opportunity"
            ? sortBy
            : "score",
        order: q.order === "asc" ? "asc" : "desc",
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      });
      res.json(result);
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.get("/trends/contents", async (req, res) => {
    try {
      const q = z
        .object({
          platform: z.string().optional(),
          topicId: z.coerce.number().int().positive().optional(),
          confidence: z.string().optional(),
          minScore: z.coerce.number().min(0).max(100).optional(),
          maxScore: z.coerce.number().min(0).max(100).optional(),
          publishedFrom: z.string().optional(),
          publishedTo: z.string().optional(),
          scorable: z.string().optional(),
          sortBy: z.string().optional(),
          order: z.string().optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const sortBy = strOr(q.sortBy);
      const scorable = strOr(q.scorable);
      const result = await listContentScores(db, {
        platform: strOr(q.platform),
        topicId: q.topicId,
        confidence: strOr(q.confidence),
        minScore: q.minScore,
        maxScore: q.maxScore,
        publishedFrom: strOr(q.publishedFrom),
        publishedTo: strOr(q.publishedTo),
        scorable: scorable === "yes" || scorable === "no" ? scorable : undefined,
        sortBy: sortBy === "publishedAt" ? "publishedAt" : "score",
        order: q.order === "asc" ? "asc" : "desc",
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      });
      res.json(result);
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.post("/topics/trend/run", async (req, res) => {
    try {
      const body = z.object({ wait: z.boolean().optional() }).parse(req.body ?? {});
      await withEngineLock(res, ["trend"], "scoring-api", body.wait === true, () => runTopicTrendScoring(db));
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  router.get("/topics/:id/trend", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await getTopicTrendDetail(db, id);
      if (!detail.current) return res.status(404).json({ error: "暂无话题趋势结果", hint: "尚未运行话题趋势评分" });
      const cur = detail.current;
      // §51-§55:分解、有效权重、不可用原因全部来自服务端。
      // 老 Run 没存 components_json → 这里是 null,UI 必须显示"未记录",不得用当前权重复算冒充。
      const components = cur.componentsJson
        ? safeParse<Record<string, unknown> | null>(cur.componentsJson, null)
        : null;

      const effectiveWeights = cur.effectiveWeightsJson
        ? safeParse<Record<string, number> | null>(cur.effectiveWeightsJson, null)
        : null;
      const unavailableReasons: Record<string, string> = {};
      if (components) {
        for (const [k, v] of Object.entries(components)) {
          const c = v as { available?: boolean; reason?: string | null };
          if (c?.available === false) unavailableReasons[k] = c.reason ?? "该组件当前不可用";
        }
      }
      res.json({
        current: parseJsonFields(cur as unknown as Record<string, unknown>, ["evidence"]),
        detail: {
          topicId: id,
          overallScore: cur.score,
          confidence: cur.confidence,
          scoreVersion: cur.scoreVersion,
          scorable: cur.scorable === 1,
          unscorableReason: cur.unscorableReason,
          lifecycle: cur.lifecycle,
          pendingLifecycle: cur.pendingLifecycle,
          pendingCount: cur.pendingCount,
          contentGrowth: cur.contentGrowth,
          engagementGrowth: cur.engagementGrowth,
          creatorGrowth: cur.creatorGrowth,
          burstDensity: cur.burstDensity,
          acceleration: cur.acceleration,
          components,
          effectiveWeights,
          unavailableReasons,
          breakdownRecorded: components !== null,
          evidence: parseJsonFields({ evidence: cur.evidence }, ["evidence"])?.evidence ?? null,
          memberCount: cur.memberCount,
          recentNewContent: cur.recentNewContent,
          activeCreators: cur.activeCreators,
          avgRawMomentum: cur.avgRawMomentum,
          calculatedAt: cur.calculatedAt,
        },
        history: detail.history.map((h) =>
          parseJsonFields(h as unknown as Record<string, unknown>, ["evidence"]),
        ),
        lifecycleEvents: detail.lifecycleEvents,
      });
    } catch (e) {
      clientOrServerError(res, "scoring-api", e);
    }
  });

  return router;
}
