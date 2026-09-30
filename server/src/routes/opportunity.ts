/**
 * Opportunity API (Stage 9 §75/§76):
 *   POST /api/opportunity/run | GET /api/opportunity/topics | /topics/:id | /runs | /profile
 *   PATCH /api/opportunity/topics/:id/decision(人工决策,不影响分数 §37)
 *   POST /api/analysis/full-refresh(可选编排:Stage 7 → 8 → 9,复用现有 API 逻辑,§53/§54)
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { runOpportunity } from "../opportunity/service";
import {
  getTopicOpportunityDetail,
  listOpportunityRuns,
  listOpportunityTopics,
  upsertDecision,
} from "../opportunity/repository";
import {
  archiveProfile,
  activateProfile,
  createProfile,
  createVersion,
  defaultDraft,
  getProfileView,
  listProfiles,
  profileDraftSchema,
} from "../opportunity/profileStore";
import { clientOrServerError, badRequest } from "./errors";
import { withEngineLock } from "../services/engineLock";

function strOr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseJsonFields<T extends Record<string, unknown>>(row: T | null, fields: string[]): T | null {
  if (!row) return null;
  const out = { ...row };
  for (const f of fields) {
    if (typeof out[f] === "string") {
      try {
        (out as Record<string, unknown>)[f] = JSON.parse(out[f] as string);
      } catch {
        /* keep raw */
      }
    }
  }
  return out;
}

export function createOpportunityRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.post("/run", async (req, res) => {
    try {
      const body = z
        .object({
          wait: z.boolean().optional(),
          /** 任意已存在的 profile key(内置两份 + 用户自建) */
          profileId: z.string().trim().min(1).max(60).optional(),
        })
        .parse(req.body ?? {});
      await withEngineLock(res, ["opportunity"], "opportunity-api", body.wait === true, () =>
        runOpportunity(db, { profileId: body.profileId }),
      );
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.get("/topics", async (req, res) => {
    try {
      const q = z
        .object({
          minOpportunity: z.coerce.number().min(0).max(100).optional(),
          confidence: z.string().optional(),
          lifecycle: z.string().optional(),
          maxSaturation: z.coerce.number().min(0).max(100).optional(),
          minNovelty: z.coerce.number().min(0).max(100).optional(),
          decision: z.string().optional(),
          watchState: z.string().optional(),
          minMembers: z.coerce.number().int().min(0).optional(),
          updatedAfter: z.string().optional(),
          sortBy: z.string().optional(),
          order: z.string().optional(),
          page: z.coerce.number().int().min(1).optional(),
          pageSize: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(req.query ?? {});
      const sortBy = strOr(q.sortBy);
      const result = await listOpportunityTopics(db, {
        minOpportunity: q.minOpportunity,
        confidence: strOr(q.confidence),
        lifecycle: strOr(q.lifecycle),
        maxSaturation: q.maxSaturation,
        minNovelty: q.minNovelty,
        decision: strOr(q.decision),
        watchState: strOr(q.watchState),
        minMembers: q.minMembers,
        updatedAfter: strOr(q.updatedAfter),
        sortBy:
          sortBy === "delta" || sortBy === "trend" || sortBy === "novelty" || sortBy === "memberCount" || sortBy === "updatedAt"
            ? sortBy
            : "score",
        order: q.order === "asc" ? "asc" : "desc",
        page: q.page ?? 1,
        pageSize: q.pageSize ?? 20,
      });
      res.json(result);
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.get("/topics/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await getTopicOpportunityDetail(db, id);
      if (!detail.current) return res.status(404).json({ error: "暂无机会分析结果", hint: "尚未运行机会分析" });
      const parsedHistory = detail.history.map((hh) =>
        parseJsonFields(hh as unknown as Record<string, unknown>, ["evidence", "whyChanged", "effectiveWeights"]),
      );
      // §61:有效权重存在快照的 effective_weights 列里;current 表只是缓存,不带这一列,
      // 所以从本次 Run 的那条快照取,而不是让前端去猜。
      const sameRun = parsedHistory.find((h) => (h as { runId?: number }).runId === detail.current!.runId);
      const effectiveWeights =
        (sameRun as { effectiveWeights?: Record<string, number> } | null)?.effectiveWeights ??
        (parsedHistory[0] as { effectiveWeights?: Record<string, number> } | null)?.effectiveWeights ??
        null;
      res.json({
        current: parseJsonFields(detail.current as unknown as Record<string, unknown>, ["evidence"]),
        effectiveWeights,
        history: parsedHistory,
        decision: detail.decision,
      });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.patch("/topics/:id/decision", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const body = z
        .object({
          status: z.enum(["shortlisted", "reviewing", "dismissed", "none"]),
          note: z.string().max(300).optional(),
        })
        .parse(req.body ?? {});
      await upsertDecision(db, id, body.status, body.note ?? null, new Date().toISOString());
      res.json({ ok: true });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.get("/runs", async (_req, res) => {
    try {
      res.json({ rows: await listOpportunityRuns(db) });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  /* ---------------- Stage 9.5 · Profile 治理(§39-§42) ----------------
   * 只读历史版本 + 写新版本 + 激活/归档。没有任何"改旧版本"的入口:
   * PATCH 显式回 409,而不是让它悄悄落到 404(§40 要求有契约测试锁死)。
   */

  const draftBody = profileDraftSchema;

  router.get("/profiles", async (_req, res) => {
    try {
      const rows = await listProfiles(db);
      const active = rows.find((r) => r.isActive) ?? null;
      res.json({
        rows,
        activeId: active?.id ?? null,
        defaultDraft: defaultDraft(),
        note: "机会模型只是分析偏好与权重配置,不是更准确的算法;历史快照永远指向它计算时用的那个版本。",
      });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.get("/profiles/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return badRequest(res, "invalid id");
      const view = await getProfileView(db, id);
      if (!view) return res.status(404).json({ error: `机会模型不存在:#${id}` });
      res.json({ profile: view });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.post("/profiles", async (req, res) => {
    try {
      const body = draftBody
        .extend({ profileKey: z.string().trim().min(2).max(60) })
        .parse(req.body ?? {});
      const { row, created } = await createProfile(db, body);
      res.status(created ? 201 : 200).json({ profile: await getProfileView(db, row.id), created });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.post("/profiles/:id/versions", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return badRequest(res, "invalid id");
      const body = draftBody.parse(req.body ?? {});
      const { row, created } = await createVersion(db, id, body);
      const view = await getProfileView(db, row.id);
      if (String(req.query?.activate) === "true") {
        await activateProfile(db, row.id);
        return res.status(created ? 201 : 200).json({ profile: await getProfileView(db, row.id), created, activated: true });
      }
      res.status(created ? 201 : 200).json({ profile: view, created });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.post("/profiles/:id/activate", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return badRequest(res, "invalid id");
      const row = await activateProfile(db, id);
      res.json({ profile: await getProfileView(db, row.id) });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.post("/profiles/:id/archive", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return badRequest(res, "invalid id");
      const row = await archiveProfile(db, id);
      res.json({ profile: await getProfileView(db, row.id) });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  router.patch("/profiles/:id", (req, res) => {
    res.status(409).json({
      error: "历史机会模型版本不可原地修改,请另存为新版本(已被快照引用的版本必须保持可解释)",
      id: req.params.id,
    });
  });

  router.get("/profile", async (_req, res) => {
    try {
      const rows = await listProfiles(db);
      res.json({
        profiles: rows.map((p) => ({
          id: p.profileKey,
          label: p.name,
          version: p.version,
          weights: p.weights,
          levelBands: p.levelBands,
          lifecycleFit: p.lifecycleFit,
          freshness: p.freshness,
          minimumAvailableComponents: p.minimumEvidence.minimumAvailableComponents,
          isActive: p.isActive,
          status: p.status,
          usage: p.usage,
          configSnapshot: JSON.stringify({ profileId: p.profileKey, profileVersion: p.version, weights: p.weights }),
        })),
        note: "机会指数是对当前已观察数据的结构化量化,不是未来结果概率;Profile 只是分析偏好",
      });
    } catch (e) {
      clientOrServerError(res, "opportunity-api", e);
    }
  });

  return router;
}

