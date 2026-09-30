/**
 * Embedding API (Stage 6A §34/§37/§39/§43): spaces / jobs / similar / status.
 *遵循项目现有 API 风格;Secret 只显示 Configured/Missing(§34),绝不出值。
 */
import express from "express";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../db/client";
import { embeddingJobs, embeddingSpaces, contentItems } from "../db/schema";
import { LexicalFallbackEmbeddingProvider } from "../semantic/lexicalProvider";
import {
  OpenAICompatibleEmbeddingProvider,
  EmbeddingProviderConfigSchema,
} from "../semantic/openaiProvider";
import {
  ensureSpaceProbed,
  activateSpace,
  listSpaces,
  getSpace,
  countEmbeddings,
} from "../semantic/vectorRepository";
import {
  createEmbeddingJob,
  requestJobCancel,
  runEmbeddingJob,
  findSimilarContent,
  getEmbeddingStatus,
} from "../semantic/embeddingService";
import { resolveSecretRef, describeSecretSource } from "../services/secrets/secretResolver";
import { lintSecrets } from "../connectors/types";
import { clientOrServerError } from "./errors";

/** 内存 job 执行器:同一 job 不会并发执行(§17 精神) */
const runningJobs = new Set<number>();

function providerFor(body: unknown): { provider: LexicalFallbackEmbeddingProvider | OpenAICompatibleEmbeddingProvider; config: unknown } {
  const parsed = z
    .object({
      provider: z.enum(["lexical", "openai-compatible"]),
      dimension: z.number().int().min(64).max(4096).optional(),
      config: z.record(z.unknown()).optional(),
    })
    .parse(body);
  if (parsed.provider === "lexical") {
    return { provider: new LexicalFallbackEmbeddingProvider(parsed.dimension ?? 512), config: { dimension: parsed.dimension ?? 512 } };
  }
  const cfg = EmbeddingProviderConfigSchema.parse(parsed.config ?? {});
  return { provider: new OpenAICompatibleEmbeddingProvider(cfg), config: cfg };
}

export function createEmbeddingRouter(db: DB): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  // ---- spaces (§37) ----
  router.get("/spaces", async (_req, res) => {
    try {
      const spaces = await listSpaces(db);
      const rows = [];
      for (const sp of spaces) {
        const [latest] = await db
          .select()
          .from(embeddingJobs)
          .where(eq(embeddingJobs.embeddingSpaceId, sp.id))
          .orderBy(desc(embeddingJobs.id))
          .limit(1);
        rows.push({
          ...sp,
          contentCount: await countEmbeddings(db, sp.id),
          latestJob: latest
            ? {
                id: latest.id,
                status: latest.status,
                processed: latest.processed,
                total: latest.total,
                createdAt: latest.createdAt,
              }
            : null,
        });
      }
      res.json({ rows });
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  // create/configure space (§39): lexical 直接建;api 需先 validateConfig
  router.post("/spaces", async (req, res) => {
    try {
      const { provider } = providerFor(req.body);
      const cfgCheck = provider.validateConfig();
      if (!cfgCheck.ok) {
        return res.status(400).json({
          error: cfgCheck.error,
          // §34: secret 只显示 Configured/Missing,不回显任何值
          credential: /credential unavailable/.test(cfgCheck.error ?? "") ? "MISSING" : "CONFIGURED",
        });
      }
      const space = await ensureSpaceProbed(db, provider);
      res.status(201).json(space);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(/必须|不存在|无效|缺失/.test(msg) ? 400 : 500).json({ error: msg });
    }
  });

  // activate (§35: 选择当前分析默认空间)
  router.post("/spaces/:id/activate", async (req, res) => {
    try {
      const space = await getSpace(db, req.params.id);
      if (!space) return res.status(404).json({ error: "向量空间不存在" });
      await activateSpace(db, space.id);
      res.json({ ok: true });
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  // settings 视图 (§34): Provider/Base URL/Model/Secret Source(Configured|Missing)/Dimension/Batch Size
  router.get("/settings", async (_req, res) => {
    try {
      const spaces = await listSpaces(db);
      // 词法空间的 provider 是 "lexical-hash",按 provider 字符串过滤永远过滤不掉它,
      // 会让 UI 在只有词法基线时报告 provider=openai-compatible。用 mode 判定。
      const apiSpaces = spaces.filter((s) => s.mode !== "lexical");
      const active = spaces.find((s) => s.isActive === 1) ?? null;
      // api provider 配置存在环境变量引用时,展示来源与状态(不展示值)
      const secretSource = "环境变量 EMBEDDING_API_KEY";
      const cred = resolveSecretRef("secretref:env:EMBEDDING_API_KEY");
      res.json({
        activeSpaceId: active?.id ?? null,
        provider: apiSpaces.length > 0 ? "openai-compatible" : "lexical",
        lexical: { providerId: "lexical-hash", model: "zh-lexical-v1", mode: "lexical" },
        api: {
          secretSource,
          credential: cred.ok ? "CONFIGURED" : "MISSING",
          baseUrl: process.env.EMBEDDING_BASE_URL ?? null,
          model: process.env.EMBEDDING_MODEL ?? null,
        },
        spaces: spaces.map((s) => ({ id: s.id, mode: s.mode, dimension: s.dimension, isActive: s.isActive === 1 })),
      });
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  // ---- jobs (§25/§38) ----
  router.get("/jobs", async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
      const rows = await db
        .select()
        .from(embeddingJobs)
        .orderBy(desc(embeddingJobs.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      res.json({ rows, page, pageSize });
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  router.post("/jobs", async (req, res) => {
    try {
      const body = z
        .object({
          spaceId: z.string().optional(),
          provider: z.enum(["lexical", "openai-compatible"]).optional(),
          dimension: z.number().int().min(64).max(4096).optional(),
          config: z.record(z.unknown()).optional(),
          scope: z.enum(["missing", "all"]).default("missing"),
          wait: z.boolean().optional(), // 测试/小数据可同步等待完成
        })
        .parse(req.body ?? {});

      // 解析 provider:显式 provider > 空间推导 > active 空间 > 默认 lexical
      let provider;
      let spaceId = body.spaceId ?? null;
      if (body.provider === "openai-compatible") {
        provider = new OpenAICompatibleEmbeddingProvider(EmbeddingProviderConfigSchema.parse(body.config ?? {}));
      } else if (body.provider === "lexical") {
        provider = new LexicalFallbackEmbeddingProvider(body.dimension ?? 512);
      } else {
        const sid = spaceId ?? (await db.select().from(embeddingSpaces).where(eq(embeddingSpaces.isActive, 1)).limit(1))[0]?.id;
        const sp = sid ? await getSpace(db, sid) : undefined;
        if (sp && sp.provider === "openai-compatible") {
          // api 空间重跑需要原始 config;环境变量约定路径
          provider = new OpenAICompatibleEmbeddingProvider(
            EmbeddingProviderConfigSchema.parse({
              baseUrl: process.env.EMBEDDING_BASE_URL ?? "http://localhost:11434/v1",
              model: process.env.EMBEDDING_MODEL ?? "unknown",
              apiKeySecretRef: "secretref:env:EMBEDDING_API_KEY",
              dimension: sp.dimension,
            }),
          );
          spaceId = sp.id;
        } else {
          provider = new LexicalFallbackEmbeddingProvider(sp?.dimension ?? body.dimension ?? 512);
          spaceId = spaceId ?? null;
        }
      }

      const space = await ensureSpaceProbed(db, provider);
      spaceId = space.id;
      if (body.provider === "lexical" || !body.provider) await activateSpace(db, space.id);

      const jobId = await createEmbeddingJob(db, spaceId!, body.scope);
      if (body.wait) {
        const result = await runEmbeddingJob(db, jobId, provider);
        return res.status(202).json({ jobId, ...result });
      }
      // 异步执行(§25 不阻塞页面)
      if (runningJobs.has(jobId)) return res.status(409).json({ error: "该向量化任务已在运行" });
      runningJobs.add(jobId);
      void runEmbeddingJob(db, jobId, provider)
        .catch((e) => console.error("[embedding] 向量化任务异常终止:", e))
        .finally(() => runningJobs.delete(jobId));
      res.status(202).json({ jobId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(/必须|不存在|无效|未设置/.test(msg) ? 400 : 500).json({ error: msg });
    }
  });

  router.get("/jobs/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [job] = await db.select().from(embeddingJobs).where(eq(embeddingJobs.id, id)).limit(1);
      if (!job) return res.status(404).json({ error: "向量化任务不存在" });
      res.json(job);
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  router.post("/jobs/:id/cancel", async (req, res) => {
    try {
      const ok = await requestJobCancel(db, Number(req.params.id));
      res.json({ ok });
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  return router;
}

/** Content 级路由:similar + embedding-status(挂到 /api/content 下) */
export function createContentSemanticRouter(db: DB): express.Router {
  const router = express.Router();

  router.get("/:id/similar", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const q = z
        .object({
          topK: z.coerce.number().int().min(1).max(50).optional(),
          minSimilarity: z.coerce.number().min(0).max(1).optional(),
          platform: z.string().optional(),
          spaceId: z.string().optional(),
        })
        .parse(req.query ?? {});
      const [item] = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.id, id)).limit(1);
      if (!item) return res.status(404).json({ error: "内容不存在" });
      const result = await findSimilarContent(db, id, {
        topK: q.topK,
        minSimilarity: q.minSimilarity,
        platform: q.platform,
        embeddingSpaceId: q.spaceId,
      });
      res.json(result);
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  router.get("/:id/embedding-status", async (req, res) => {
    try {
      const id = Number(req.params.id);
      res.json(await getEmbeddingStatus(db, id, typeof req.query.spaceId === "string" ? req.query.spaceId : undefined));
    } catch (e) {
      clientOrServerError(res, "embedding-api", e);
    }
  });

  return router;
}

// lintSecrets 守卫(§33):embedding 配置里出现明文密钥类字段直接拒绝
export function assertNoPlaintextSecrets(body: unknown): void {
  const err = lintSecrets(body);
  if (err) throw new Error(err);
}
void describeSecretSource;
