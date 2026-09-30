/**
 * Intelligence API (Stage 8 §74-§75):
 *   POST /api/intelligence/run | GET /api/intelligence/runs
 *   GET /api/topics/:id/patterns|saturation|novelty|angles
 *   GET /api/intelligence/content/:id/features(特征调试,§75)
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import {
  getContentFeatureRecord,
  getTopicAngles,
  getTopicNoveltyDetail,
  getTopicPatterns,
  getTopicSaturationDetail,
  listIntelligenceRuns,
} from "../intelligence/repository";
import { runIntelligence } from "../intelligence/service";
import { clientOrServerError } from "./errors";
import { withEngineLock } from "../services/engineLock";

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

export function createIntelligenceRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.post("/run", async (req, res) => {
    try {
      const body = z.object({ wait: z.boolean().optional() }).parse(req.body ?? {});
      await withEngineLock(res, ["intelligence"], "intelligence-api", body.wait === true, () =>
        runIntelligence(db),
      );
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  router.get("/runs", async (_req, res) => {
    try {
      res.json({ rows: await listIntelligenceRuns(db) });
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  router.get("/content/:id/features", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const row = await getContentFeatureRecord(db, id);
      if (!row) return res.status(404).json({ error: "暂无内容情报结果", hint: "尚未运行内容情报分析" });
      res.json(parseJsonFields(row as unknown as Record<string, unknown>, ["features"]));
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  return router;
}

/** /api 下的话题情报查询(与 topics/scoring 路由无路径冲突)。 */
export function createTopicIntelligenceRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/topics/:id/patterns", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const rows = await getTopicPatterns(db, id);
      res.json({
        rows: rows.map((r) => parseJsonFields(r as unknown as Record<string, unknown>, ["viralValue", "controlValue", "notes"])),
      });
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  router.get("/topics/:id/saturation", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await getTopicSaturationDetail(db, id);
      if (!detail.current) return res.status(404).json({ error: "暂无内容情报结果", hint: "尚未运行内容情报分析" });
      res.json({
        current: parseJsonFields(detail.current as unknown as Record<string, unknown>, ["breakdown", "evidence"]),
        history: detail.history.map((hh) => parseJsonFields(hh as unknown as Record<string, unknown>, ["breakdown", "evidence"])),
      });
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  router.get("/topics/:id/novelty", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await getTopicNoveltyDetail(db, id);
      if (!detail.current) return res.status(404).json({ error: "暂无内容情报结果", hint: "尚未运行内容情报分析" });
      res.json({
        current: parseJsonFields(detail.current as unknown as Record<string, unknown>, ["evidence"]),
        history: detail.history.map((hh) => parseJsonFields(hh as unknown as Record<string, unknown>, ["evidence"])),
      });
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  router.get("/topics/:id/angles", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const rows = await getTopicAngles(db, id);
      res.json({
        rows: rows.map((r) => ({ ...r, representativeItemIds: JSON.parse(r.representativeItemIds) as number[] })),
      });
    } catch (e) {
      clientOrServerError(res, "intelligence-api", e);
    }
  });

  return router;
}
