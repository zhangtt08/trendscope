/**
 * 分析编排 API(Release 1.0 · WP2 §32/§37-§40)。
 *
 *   GET  /api/analysis/status               产品走到哪一步了(首页/引导/依赖提示共用)
 *   POST /api/analysis/full-refresh         一键按序刷新(§37;不生成任何 AI 方案)
 *   GET  /api/analysis/full-refresh/latest  最近一次刷新进度(刷新页面后仍能看到)
 *   GET  /api/analysis/runs/:id             指定一次刷新
 *
 * 错误语义与全站一致:非法参数 400、不存在 404、引擎占用 409、服务端异常 500。
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { withEngineLock } from "../services/engineLock";
import { badRequest, clientOrServerError } from "./errors";
import { getAnalysisStatus } from "../analysis/status";
import { REFRESH_ENGINES, runFullRefresh } from "../analysis/fullRefresh";
import { getRun, latestRun } from "../analysis/repository";

export function createAnalysisRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/status", async (_req, res) => {
    try {
      res.json(await getAnalysisStatus(db));
    } catch (e) {
      clientOrServerError(res, "analysis-status", e);
    }
  });

  router.post("/full-refresh", async (req, res) => {
    try {
      const body = z
        .object({ wait: z.boolean().optional(), trigger: z.enum(["manual", "first-run"]).optional() })
        .strict()
        .parse(req.body ?? {});
      await withEngineLock(res, REFRESH_ENGINES, "analysis-full-refresh", body.wait !== false, () =>
        runFullRefresh(db, { trigger: body.trigger ?? "manual", preAcquired: true }),
      );
    } catch (e) {
      clientOrServerError(res, "analysis-full-refresh", e);
    }
  });

  router.get("/full-refresh/latest", async (_req, res) => {
    try {
      res.json({ run: await latestRun(db) });
    } catch (e) {
      clientOrServerError(res, "analysis-run", e);
    }
  });

  router.get("/runs/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest(res, "运行 id 必须是正整数");
    try {
      const run = await getRun(db, id);
      if (!run) return res.status(404).json({ error: `分析运行不存在:#${id}` });
      res.json({ run });
    } catch (e) {
      clientOrServerError(res, "analysis-run", e);
    }
  });

  return router;
}
