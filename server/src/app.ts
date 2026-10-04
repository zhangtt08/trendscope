/**
 * HTTP layer assembly, kept out of index.ts so tests can drive the real
 * routers without booting the server (index.ts runs main() on import).
 *
 * Why this matters: no test previously exercised HTTP, so a UI calling
 * POST /topics/:id/watch against a PUT-only route (404), or a filter param
 * producing a 500, passed under 365 green tests.
 *
 * 这里还挂着**本机边界闸门**(第一个中间件)与 `listenLocal()`(唯一的绑定地址入口):
 * 两者都放在能被测试直接驱动的地方,而不是埋在 index.ts 里 —— 埋在那里就没人测得到。
 */
import express from "express";
import path from "node:path";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { performance } from "node:perf_hooks";
import type { DB } from "./db/client";
import {
  LOCAL_BIND_HOST,
  TOKEN_HEADER_NAME,
  denialBody,
  evaluateRequestGuard,
  policyFromEnv,
} from "./local-guard";
import { createApiRouter } from "./routes/api";
import { createAgentRouter } from "./routes/agent";
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

export interface LocalGuardOptions {
  /**
   * 本服务监听的端口。缺省时逐条取**连接实际落到的本机端口**(`req.socket.localPort`),
   * 这样 `listen(0)` 的测试与临时端口的桌面壳都不用把端口告诉应用 —— 而它仍然不是请求头里的端口。
   */
  port?: number;
  /** 共享令牌;缺省时读 `TRENDSCOPE_LOCAL_TOKEN`(空 = 不启用这一道)。 */
  token?: string | null;
}

export interface AppOptions {
  makeStudioProvider?: () => StudioProvider;
  dbFile?: string;
  onImported?: (summary: ImportSummary) => void;
  /** 进程启动时刻(uptime_ms 的分母)。缺省取 Node 自己的 timeOrigin,不需要额外传参。 */
  bootedAt?: number;
  localGuard?: LocalGuardOptions;
}

/** 判定用的端口:配置值 > 连接实际落到的本机端口 > 进程环境里的 PORT。永远不看请求头。 */
function guardPortOf(req: express.Request, configured?: number): number {
  if (configured) return configured;
  const local = req.socket?.localPort;
  if (typeof local === "number" && local > 0) return local;
  return policyFromEnv().port;
}

export function createApp(
  db: DB,
  runtime: CollectionRuntime,
  opts: AppOptions = {},
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  const bootedAt = opts.bootedAt ?? Math.round(performance.timeOrigin);
  const guardPolicy: LocalGuardOptions = opts.localGuard ?? {};
  const guardToken = guardPolicy.token ?? policyFromEnv().token ?? null;

  // ---------- 本机边界闸门:必须是第一个中间件 ----------
  //
  // 排在**所有**路由与 `app.get("*")` 的 SPA 兜底之前,理由有两个:
  //   1. 拒绝必须回 JSON。落到 SPA 兜底就成了一整个 index.html + 200,
  //      界面与 Agent 都读不出"为什么不给力",而 200 还会被当成成功。
  //   2. 它得在任何 body 解析之前把超大/长度未知的请求体挡掉,不然"先读满 300 MB
  //      再决定拒不拒"本身就是攻击面。
  // 判定表在 `server/src/local-guard.ts`(纯函数,单测直接驱动),这里只是适配器。
  // 这份文件不写 `Access-Control-Allow-Origin`:一个 `*` 都不写 —— 跨域放行头一旦存在,
  // 上面的三条判定就全部作废。
  app.use((req, res, next) => {
    const denial = evaluateRequestGuard(
      {
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
        referer: req.headers.referer ?? null,
        method: req.method,
        contentLength: (req.headers["content-length"] as string | undefined) ?? null,
        transferEncoding: (req.headers["transfer-encoding"] as string | undefined) ?? null,
        token: (req.headers[TOKEN_HEADER_NAME] as string | undefined) ?? null,
      },
      { port: guardPortOf(req, guardPolicy.port), token: guardToken },
    );
    if (!denial) return next();
    res.status(denial.status).json(denialBody(denial));
  });

  // 轮询端点(分析进度 / 工作室证据)必须绕开 HTTP 缓存:同一个 URL 反复 GET 时,
  // 浏览器会给启发式缓存,进度就会看起来卡住。
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // collection router FIRST (the /api router ends with a 404 catch-all)
  //
  // Agent 契约四条(/api/health、/api/agent/{tools,manifest}、POST /api/agent/tool)排在最前:
  // 末尾那条 `app.get("*")` 会把任何未匹配路径当 SPA 路由返回 HTML,晚注册一步,
  // JSON 端点就会被 HTML 吃掉(curl 拿到 200 + text/html,Agent 直接看不懂)。
  app.use("/api", createAgentRouter(db, { bootedAt, makeStudioProvider: opts.makeStudioProvider }));
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
  //
  // ⚠ 顺序纪律:这一段永远在上面的闸门之后。闸门先注册,拒掉的请求不会落到 SPA 兜底,
  // 错误体才是 JSON 而不是一整个 index.html。
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
        const status = (err as { status?: number } | null)?.status;
        const clientError = typeof status === 'number' && status >= 400 && status < 500;
        res.status(clientError ? status : 500).json({
          error: clientError ? (status === 413 ? '请求内容过大，请减少本次导入的数据量' : '请求内容格式无效，请检查后重试') : `服务器内部错误: ${msg}`,
        });
      }
    },
  );

  return app;
}

/** 监听之后回读到的真实绑定信息(端口 0 也能拿到实际端口)。 */
export interface BoundAddress {
  address: string;
  port: number;
  family: string;
}

/**
 * 唯一的启动监听入口:**只绑本机回环**(`LOCAL_BIND_HOST`)。
 *
 * 为什么要一个函数而不是各处直接 `app.listen(PORT)`:不带 host 参数时 Node 的默认值是
 * **`0.0.0.0`** —— 实测(2026-10-05)这台机器上 5184 同时挂在 `0.0.0.0` 与 `[::]` 上,
 * 局域网里任何一台机器都能直连这些接口(而它们能写这个库)。绑定地址必须是代码里写死的
 * **一件事**,不是"调用方记得传"的约定:传错一次就静默把整个库暴露出去。
 *
 * 回读地址而不是把参数原样报回去:`listen(0)` 时真实端口只有内核知道,
 * 而闸门判定与体检报告都必须落在真实那一个上。
 */
export function listenLocal(
  app: express.Express,
  port: number,
  onListening?: (bound: BoundAddress) => void,
): Server {
  const server = app.listen(port, LOCAL_BIND_HOST, () => {
    if (!onListening) return;
    const addr = server.address();
    onListening(
      typeof addr === "object" && addr
        ? { address: (addr as AddressInfo).address, port: (addr as AddressInfo).port, family: (addr as AddressInfo).family }
        : { address: LOCAL_BIND_HOST, port, family: "IPv4" },
    );
  });
  return server;
}
