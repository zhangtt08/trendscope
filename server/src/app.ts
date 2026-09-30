/**
 * HTTP layer assembly, kept out of index.ts so tests can drive the real
 * routers without booting the server (index.ts runs main() on import).
 *
 * Why this matters: no test previously exercised HTTP, so a UI calling
 * POST /topics/:id/watch against a PUT-only route (404), or a filter param
 * producing a 500, passed under 365 green tests.
 */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import type { DB } from "./db/client";
import { createApiRouter } from "./routes/api";
import { createCollectionRouter } from "./routes/collection";
import { createEmbeddingRouter, createContentSemanticRouter } from "./routes/embedding";
import { createTopicsRouter } from "./routes/topics";
import { createScoringRouter, createTrendQueryRouter } from "./routes/scoring";
import { createIntelligenceRouter, createTopicIntelligenceRouter } from "./routes/intelligence";
import { createOpportunityRouter } from "./routes/opportunity";
import { createAnalysisRouter } from "./routes/analysis";
import { createStudioRouter } from "./routes/studio";
import { createDemoRouter } from "./routes/demo";
import { createHotRouter } from "./routes/hot";
import { createReportsRouter } from "./routes/reports";
import type { StudioProvider } from "./studio/provider";
import type { CollectionRuntime } from "./services/collection/runtime";
import type { ImportSummary } from "./services/importService";

export function createApp(
  db: DB,
  runtime: CollectionRuntime,
  opts: {
    makeStudioProvider?: () => StudioProvider;
    dbFile?: string;
    onImported?: (summary: ImportSummary) => void;
  } = {},
): express.Express {
  const app = express();
  app.disable("x-powered-by");

  // 轮询端点(分析进度 / 工作室证据)必须绕开 HTTP 缓存:同一个 URL 反复 GET 时,
  // 浏览器会给启发式缓存,进度就会看起来卡住。
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // collection router FIRST (the /api router ends with a 404 catch-all)
  app.use("/api/collection", createCollectionRouter(db, runtime));
  app.use("/api/embedding", createEmbeddingRouter(db));
  app.use("/api/scoring", createScoringRouter(db));
  app.use("/api/intelligence", createIntelligenceRouter(db));
  app.use("/api/opportunity", createOpportunityRouter(db));
  app.use("/api/studio", createStudioRouter(db, { makeProvider: opts.makeStudioProvider }));
  app.use("/api/demo", createDemoRouter(db, opts.dbFile));
  app.use("/api/hot", createHotRouter(db, runtime)); // 一键抓多平台热点
  app.use("/api/reports", createReportsRouter(db)); // 确定性自动分析报告
  app.use("/api/analysis", createAnalysisRouter(db)); // /api/analysis/full-refresh
  app.use("/api", createTopicIntelligenceRouter(db)); // /topics/:id/patterns|saturation|novelty|angles
  app.use("/api", createTrendQueryRouter(db)); // /trends/topics|contents, /topics/:id/trend
  app.use("/api", createTopicsRouter(db)); // /topics* before the 404 catch-all
  app.use("/api/content", createContentSemanticRouter(db)); // similar + embedding-status
  app.use("/api", createApiRouter(db, opts.onImported));

  // serve built SPA in production
  const distDir = path.resolve(process.cwd(), "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  // last-resort error guard: structured JSON, never an HTML crash page
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[server]", msg);
      if (!res.headersSent) {
        res.status(500).json({ error: `服务器内部错误: ${msg}` });
      }
    },
  );

  return app;
}
