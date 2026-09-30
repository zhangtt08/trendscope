/**
 * Collection Center API (Stage 4 §28-31): connectors / tasks / runs.
 * All handlers return structured JSON; no route ever returns a raw crash.
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { CollectionRuntime } from "../services/collection/runtime";
import { getConnector } from "../connectors/registry";
import {
  connectorView,
  createTask,
  deleteTask,
  getCollectionStats,
  getRun,
  getTask,
  listConnectorViews,
  listRuns,
  listTasks,
  updateTask,
} from "../services/collection/service";

const IdParam = z.coerce.number().int().positive();

export function createCollectionRouter(db: DB, runtime: CollectionRuntime): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  // ---- connectors (§29) ----
  router.get("/connectors", async (_req, res) => {
    try {
      res.json({ rows: await listConnectorViews(db, runtime) });
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/connectors/:id", async (req, res) => {
    try {
      res.json(await connectorView(db, runtime, req.params.id));
    } catch (e) {
      res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Stage 5 §43 Test Connection — low-cost credential probe (quota endpoint),
  // NEVER a bulk data fetch. Classifies: healthy / credential missing /
  // invalid credential / permission denied / rate limited / other.
  router.post("/connectors/:id/test", async (req, res) => {
    try {
      const connector = getConnector(req.params.id);
      if (!connector) return res.status(404).json({ error: "连接器不存在" });
      type CredentialChecker = { checkCredential(config?: unknown): { state: string; source: string; detail: string } };
      const credCheck = (connector as unknown as CredentialChecker).checkCredential;
      if (typeof credCheck === "function") {
        const cred = credCheck.call(connector);
        if (cred.state !== "configured") {
          return res.json({
            result: cred.state === "missing" ? "CREDENTIAL_MISSING" : "INVALID_CREDENTIAL",
            detail: cred.detail,
            secretSource: cred.source,
          });
        }
      }
      const check = await connector.healthCheck({ signal: undefined });
      let result = "OTHER";
      const detail = check.detail ?? "";
      if (check.healthy) result = "HEALTHY";
      else if (/AUTH_ERROR|鉴权失败/.test(detail)) result = "INVALID_CREDENTIAL";
      else if (/PERMISSION_DENIED/.test(detail)) result = "PERMISSION_DENIED";
      else if (/RATE_LIMITED|频率/.test(detail)) result = "RATE_LIMITED";
      else if (/INVALID_CONFIG|credential unavailable/.test(detail)) result = "CREDENTIAL_MISSING";
      res.json({ result, detail, secretSource: typeof credCheck === "function" ? credCheck.call(connector).source : undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ result: "OTHER", detail: msg });
    }
  });

  // ---- tasks (§30) ----
  router.get("/tasks", async (_req, res) => {
    try {
      res.json({ rows: await listTasks(db, runtime) });
    } catch (e) {
      serverError(res, e);
    }
  });

  router.post("/tasks", async (req, res) => {
    try {
      const view = await createTask(db, runtime, req.body);
      res.status(201).json(view);
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  router.get("/tasks/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const view = await getTask(db, runtime, id);
      if (!view) return res.status(404).json({ error: "采集任务不存在" });
      res.json(view);
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  router.patch("/tasks/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      res.json(await updateTask(db, runtime, id, req.body));
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  router.delete("/tasks/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const task = await getTask(db, runtime, id);
      if (!task) return res.status(404).json({ error: "采集任务不存在" });
      if (task.isRunning) {
        return res.status(409).json({ error: "task 正在运行,先取消当前 Run 再删除" });
      }
      const removed = await deleteTask(db, id);
      if (!removed) return res.status(404).json({ error: "采集任务不存在" });
      res.json({ ok: true, note: "历史 Run 已保留" });
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  // Run Now (§17 防重入:already_running 原样返回给 UI)
  router.post("/tasks/:id/run", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const result = await runtime.runTask(id, "manual");
      if (result.ok) return res.status(202).json({ runId: result.runId });
      const code =
        result.reason === "already_running"
          ? 409
          : result.reason === "task_not_found" || result.reason === "connector_not_found"
            ? 404
            : 400;
      res.status(code).json({ error: result.reason, detail: result.detail, runId: result.runId });
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  // cancel the task's current active run (queued or running)
  router.post("/tasks/:id/cancel", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const task = await getTask(db, runtime, id);
      if (!task) return res.status(404).json({ error: "采集任务不存在" });
      const { rows } = await listRuns(db, { taskId: id, page: 1, pageSize: 5 });
      const active = rows.find((r) => r.status === "running" || r.status === "queued");
      if (!active) return res.status(409).json({ error: "没有可取消的活动 Run" });
      const result = await runtime.cancelRun(active.id);
      if (!result.ok) return res.status(409).json({ error: result.reason });
      res.json({ ok: true, runId: active.id, status: result.status });
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  // ---- runs (§31) ----
  router.get("/runs", async (req, res) => {
    try {
      const q = z
        .object({
          taskId: z.coerce.number().int().positive().optional(),
          status: z.string().optional(),
          page: z.coerce.number().int().positive().optional(),
          pageSize: z.coerce.number().int().positive().max(100).optional(),
        })
        .parse(req.query ?? {});
      res.json(await listRuns(db, q));
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  router.get("/runs/:id", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const detail = await getRun(db, id);
      if (!detail) return res.status(404).json({ error: "运行记录不存在" });
      res.json(detail);
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  router.post("/runs/:id/cancel", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const result = await runtime.cancelRun(id);
      if (!result.ok) return res.status(409).json({ error: result.reason });
      res.json({ ok: true, status: result.status });
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  // resume (§38): new run seeded from the last checkpoint
  router.post("/runs/:id/resume", async (req, res) => {
    try {
      const id = IdParam.parse(req.params.id);
      const detail = await getRun(db, id);
      if (!detail) return res.status(404).json({ error: "运行记录不存在" });
      if (!detail.run.checkpoint) {
        return res.status(400).json({ error: "该 Run 没有 checkpoint,无法恢复" });
      }
      const result = await runtime.runTask(detail.run.taskId, "resume");
      if (result.ok) return res.status(202).json({ runId: result.runId, resumedFrom: id });
      const code = result.reason === "already_running" ? 409 : 400;
      res.status(code).json({ error: result.reason, detail: result.detail });
    } catch (e) {
      clientOrServerError(res, e);
    }
  });

  // ---- dashboard stats (§32) ----
  router.get("/stats", async (_req, res) => {
    try {
      res.json(await getCollectionStats(db));
    } catch (e) {
      serverError(res, e);
    }
  });

  return router;
}

function serverError(res: express.Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[collection-api]", msg);
  res.status(500).json({ error: `服务器错误: ${msg}` });
}

function clientOrServerError(res: express.Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof z.ZodError || /无效|not found|不存在|必须|禁止/.test(msg)) {
    res.status(400).json({ error: msg });
  } else {
    serverError(res, e);
  }
}
