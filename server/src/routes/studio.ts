/**
 * Studio API(Part 1 §22-§29、§68、§120)。
 *
 *   GET  /api/studio/settings                 AI 服务配置状态(永不含密钥值)
 *   GET  /api/studio/topics                   选题工作室话题选择器(§23)
 *   GET  /api/studio/topics/:id               证据包 + 确定性摘要 + 历史(§14/§24)
 *   GET  /api/studio/topics/:id/marks         人工状态
 *   POST /api/studio/topics/:id/generate      生成/重新生成(引擎锁,§72)
 *   POST /api/studio/runs/:id/mark            保存 / 收藏 / 废弃 / 备注(§21)
 *
 * 无 AI 凭据时上面全部可读 —— 只有 generate 返回 409,并在 message 里说清缺哪个环境变量。
 */
import express from "express";
import { z } from "zod";
import type { DB } from "../db/client";
import { withEngineLock } from "../services/engineLock";
import { clientOrServerError, badRequest } from "./errors";
import { studioSettings } from "../studio/studioSettings";
import type { StudioProvider } from "../studio/provider";
import {
  generateStudioPlan,
  getStudioView,
  listStudioMarks,
  listStudioTopics,
  saveStudioMark,
} from "../studio/service";

function idParam(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function createStudioRouter(
  db: DB,
  deps: { makeProvider?: () => StudioProvider } = {},
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/settings", (_req, res) => {
    res.json(studioSettings());
  });

  router.get("/topics", async (req, res) => {
    try {
      const q = z
        .object({
          sort: z.enum(["opportunity", "trend", "recent"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          search: z.string().trim().max(80).optional(),
        })
        .parse(req.query);
      res.json({ topics: await listStudioTopics(db, q) });
    } catch (e) {
      clientOrServerError(res, "studio-topics", e);
    }
  });

  router.get("/topics/:id", async (req, res) => {
    const topicId = idParam(req.params.id);
    if (topicId === null) return badRequest(res, "话题 id 必须是正整数");
    try {
      res.json(await getStudioView(db, topicId));
    } catch (e) {
      clientOrServerError(res, "studio-view", e);
    }
  });

  router.get("/topics/:id/marks", async (req, res) => {
    const topicId = idParam(req.params.id);
    if (topicId === null) return badRequest(res, "话题 id 必须是正整数");
    try {
      res.json({ marks: await listStudioMarks(db, topicId) });
    } catch (e) {
      clientOrServerError(res, "studio-marks", e);
    }
  });

  router.post("/topics/:id/generate", async (req, res) => {
    const topicId = idParam(req.params.id);
    if (topicId === null) return badRequest(res, "话题 id 必须是正整数");
    try {
      const body = z
        .object({ regenerate: z.boolean().optional() })
        .strict()
        .parse(req.body ?? {});
      await withEngineLock(res, ["studio"], "studio-generate", true, async () => {
        const r = await generateStudioPlan(db, topicId, {
          reuse: body.regenerate === true ? false : undefined,
          makeProvider: deps.makeProvider,
        });
        return {
          runId: r.runId,
          status: r.status,
          reused: r.reused,
          output: r.output,
          unsupportedClaims: r.unsupportedClaims,
          error: r.error,
          provider: r.provider,
          model: r.model,
          durationMs: r.durationMs,
          evidenceHash: r.evidence.evidenceHash,
          evidenceTruncated: r.evidence.evidenceTruncated,
          demoData: r.evidence.demoData,
          staleEvidence: r.evidence.dataFreshness.stale,
        };
      });
    } catch (e) {
      clientOrServerError(res, "studio-generate", e);
    }
  });

  router.post("/runs/:id/mark", async (req, res) => {
    const runId = idParam(req.params.id);
    if (runId === null) return badRequest(res, "生成记录 id 必须是正整数");
    try {
      const body = z
        .object({
          angleIndex: z.number().int().min(0).max(999).nullable().optional(),
          state: z.enum(["saved", "favorite", "discarded", "none"]),
          note: z.string().trim().max(2000).nullable().optional(),
        })
        .strict()
        .parse(req.body ?? {});
      const mark = await saveStudioMark(db, {
        runId,
        angleIndex: body.angleIndex ?? null,
        state: body.state,
        note: body.note ?? null,
      });
      res.json({ mark });
    } catch (e) {
      clientOrServerError(res, "studio-mark", e);
    }
  });

  return router;
}
