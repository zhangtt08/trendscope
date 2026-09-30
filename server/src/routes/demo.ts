/**
 * 演示模式 API(§34/§35)。
 *
 *   GET  /api/demo/status   当前是否演示库、有多少演示内容
 *   POST /api/demo/load     向演示库补充载入内置示例数据
 *   POST /api/demo/reset    清空并重新载入演示数据 —— 仅演示库可用,正式库返回 409
 *
 * 两个写操作在正式模式下**永远**被拒绝,而不是"小心地删除某几种行":
 * 演示数据与真实数据的隔离靠两个库文件,不靠 WHERE 条件 —— 后者迟早会出错。
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { clientOrServerError } from "./errors";
import { getDemoStatus, loadDemoData, resetDemoData } from "../services/demoService";

export function createDemoRouter(db: DB, activeDbFile?: string): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/status", async (_req, res) => {
    try {
      res.json(await getDemoStatus(db, activeDbFile));
    } catch (e) {
      clientOrServerError(res, "demo-api", e);
    }
  });

  router.post("/load", async (req, res) => {
    try {
      const body = z.object({ confirm: z.literal("LOAD_DEMO").optional() }).strict().parse(req.body ?? {});
      if (body.confirm !== "LOAD_DEMO") {
        return res.status(400).json({ error: "装载演示数据需要显式确认(confirm=LOAD_DEMO)" });
      }
      const r = await loadDemoData(db);
      res.json({ loaded: r.loaded, batches: r.batches, demoMode: true });
    } catch (e) {
      clientOrServerError(res, "demo-api", e);
    }
  });

  router.post("/reset", async (req, res) => {
    try {
      const body = z.object({ confirm: z.literal("RESET_DEMO").optional() }).strict().parse(req.body ?? {});
      if (body.confirm !== "RESET_DEMO") {
        return res.status(400).json({ error: "重置演示数据需要显式确认(confirm=RESET_DEMO)" });
      }
      const r = await resetDemoData(db);
      res.json({ clearedTables: r.clearedTables.length, reloaded: r.reloaded });
    } catch (e) {
      clientOrServerError(res, "demo-api", e);
    }
  });

  return router;
}
