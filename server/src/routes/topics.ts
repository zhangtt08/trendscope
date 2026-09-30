/**
 * Topic API (Stage 6B §68): analyze / runs / topics / merge / split / move /
 * rename / watch / unclustered. 遵循现有 API 风格。
 */
import express from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { topicAnalysisRuns } from "../db/schema";
import { getActiveSpace, getSpace } from "../semantic/vectorRepository";
import { LexicalFallbackEmbeddingProvider } from "../semantic/lexicalProvider";
import { OpenAICompatibleEmbeddingProvider, EmbeddingProviderConfigSchema } from "../semantic/openaiProvider";
import { runTopicAnalysis, createAnalysisRun } from "../topics/analysis";
import { defaultConfigFor, mergeConfig } from "../topics/config";
import { clientOrServerError } from "./errors";
import { KeywordFallbackNaming } from "../topics/keywords";
import { topicNameProviderIfConfigured } from "../topics/nameProvider";
import {
  listTopics,
  topicDetail,
  listUnclustered,
  renameTopic,
  mergeTopics,
  MergeSchema,
  moveContent,
  splitTopic,
  SplitSchema,
  setWatch,
  WatchSchema,
  requestCancel,
} from "../topics/governance";

const running = new Set<number>();

export function createTopicsRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  // ---- analyze (§46/§49/§50) ----
  router.post("/topics/analyze", async (req, res) => {
    try {
      const body = z
        .object({
          embeddingSpaceId: z.string().optional(),
          platform: z.string().optional(),
          timeRangeStart: z.string().optional(),
          timeRangeEnd: z.string().optional(),
          autoEmbedMissing: z.boolean().optional(),
          config: z.record(z.unknown()).optional(),
          wait: z.boolean().optional(),
        })
        .parse(req.body ?? {});

      const space = body.embeddingSpaceId ? await getSpace(db, body.embeddingSpaceId) : await getActiveSpace(db);
      if (!space) {
        return res.status(400).json({
          error: "没有激活的 Embedding Space — 先到语义中心运行向量化(§69 empty dataset)",
        });
      }
      // provider 推导(§50:不静默切换空间)
      let provider;
      if (space.provider === "openai-compatible") {
        provider = new OpenAICompatibleEmbeddingProvider(
          EmbeddingProviderConfigSchema.parse({
            baseUrl: process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
            model: process.env.EMBEDDING_MODEL ?? space.model,
            apiKeySecretRef: "secretref:env:STUDIO_API_KEY",
            dimension: space.dimension,
          }),
        );
      } else {
        provider = new LexicalFallbackEmbeddingProvider(space.dimension);
      }

      const cfg = mergeConfig(defaultConfigFor(space.mode), body.config as never);
      const runId = await createAnalysisRun(db, space, body, cfg);
      void provider; // config validation already performed above

      // AI naming(§20/§70)必须走**聊天**能力,不是向量能力;开关只有一份实现:
      // topicNameProviderIfConfigured()(Studio 与"一键全分析"共用同一条判定)。
      // 这里原来是一段独立的手写 fetch:检查 STUDIO_API_KEY 却用 EMBEDDING_API_KEY 取值,
      // 于是"手动聚类有名字、点刷新没名字"两套行为并存。没有聊天能力时回退关键词命名(§19)。
      const nameProvider = topicNameProviderIfConfigured() ?? new KeywordFallbackNaming();

      if (body.wait) {
        const result = await runTopicAnalysis(db, runId, { ...body, nameProvider });
        return res.status(202).json({ ...result });
      }
      if (running.has(runId)) return res.status(409).json({ error: "该话题分析任务已在运行" });
      running.add(runId);
      void runTopicAnalysis(db, runId, { ...body, nameProvider })
        .catch((e) => console.error("[topics] 话题分析后台任务异常终止:", e))
        .finally(() => running.delete(runId));
      res.status(202).json({ runId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(/必须|没有|不存在|禁止|缺失/.test(msg) ? 400 : 500).json({ error: msg });
    }
  });

  // Express 4 不会捕获 async handler 的 reject —— 没有 try/catch 就是请求永久挂住
  // (错误中间件也收不到),所以这几个端点原先任何 DB 异常都会让前端一直转圈。
  router.get("/topic-analysis-runs", async (_req, res) => {
    try {
      const rows = await db.select().from(topicAnalysisRuns).orderBy(desc(topicAnalysisRuns.id)).limit(20);
      res.json({ rows });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.get("/topic-analysis-runs/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const [run] = await db.select().from(topicAnalysisRuns).where(eq(topicAnalysisRuns.id, id)).limit(1);
      if (!run) return res.status(404).json({ error: "运行记录不存在" });
      res.json(run);
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.post("/topic-analysis-runs/:id/cancel", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const cancelled = await requestCancel(db, id);
      if (cancelled === false) return res.status(404).json({ error: "运行记录不存在" });
      res.json({ ok: true });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  // ---- topics (§38-42) ----
  router.get("/topics", async (req, res) => {
    try {
      const q = z
        .object({
          search: z.string().optional(),
          platform: z.string().optional(),
          status: z.string().optional(),
          watch: z.string().optional(),
          minMembers: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.query ?? {});
      res.json({ rows: await listTopics(db, q) });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.get("/topics/unclustered", async (req, res) => {
    try {
      const limit = Math.min(200, Number(req.query.limit ?? 100) || 100);
      res.json({ rows: await listUnclustered(db, limit) });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.get("/topics/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "ID 无效" });
      const detail = await topicDetail(db, id);
      if (!detail) return res.status(404).json({ error: "话题不存在" });
      res.json(detail);
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.patch("/topics/:id", async (req, res) => {
    try {
      const body = z
        .object({ name: z.string().min(1).max(64), description: z.string().max(300).optional() })
        .parse(req.body);
      await renameTopic(db, Number(req.params.id), body.name, body.description);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/topics/merge", async (req, res) => {
    try {
      const body = MergeSchema.parse(req.body);
      await mergeTopics(db, body.canonicalTopicId, body.mergedTopicId);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/topics/split", async (req, res) => {
    try {
      const body = SplitSchema.parse(req.body);
      const r = await splitTopic(db, body);
      res.status(201).json(r);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  router.post("/topics/:id/move-content", async (req, res) => {
    try {
      const body = z.object({ contentItemId: z.number().int().positive() }).parse(req.body);
      await moveContent(db, body.contentItemId, Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  router.delete("/topics/:id/move-content", async (req, res) => {
    try {
      const body = z.object({ contentItemId: z.number().int().positive() }).parse(req.body);
      await moveContent(db, body.contentItemId, null);
      res.json({ ok: true });
    } catch (e) {
      clientOrServerError(res, "topics-api", e);
    }
  });

  // ---- watch (§37/§45) ----
  router.put("/topics/:id/watch", async (req, res) => {
    try {
      const body = WatchSchema.parse(req.body);
      await setWatch(db, Number(req.params.id), body.state);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  return router;
}
