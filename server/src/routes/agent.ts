/**
 * Agent API 端点(personal-agent-hub《AGENT_API_STANDARD.md》v1)。
 *
 *   GET  /api/health          契约健康检查(同时保留界面在读的数据健康字段,见下)
 *   GET  /api/agent/manifest  项目身份 + 工具清单
 *   GET  /api/agent/tools     [{name,description,input_schema,risk}]
 *   POST /api/agent/tool      {tool,input} -> {ok:true,data,tool,ms}
 *
 * 为什么直接挂进现有 server 而不另起进程/端口:TrendScope 本来就有常驻 Express(5184),
 * 再起一个 agent 进程只会多出第二种启动方式、第二个端口和一份会漂移的 DB 连接。
 *
 * ⚠ 挂载顺序:`app.get("*")` 会把任何未匹配路径返回 SPA 的 HTML,而 `createApiRouter`
 *   末尾还有一条 404 兜底。所以这四个端点必须**先于**它们注册,否则 JSON 端点会被 HTML 吃掉。
 *
 * 入站边界(只接受本机回环 Host、Origin/Referer 必须落在回环、可选共享令牌)不在这里,
 * 也不在这里重复实现一遍 —— 那是 `server/src/app.ts` 第一个中间件(`server/src/local-guard.ts`)
 * 的职责,四个契约端点与界面、SPA 走的是同一道闸门。
 */
import express from "express";
import type { DB } from "../db/client";
import { isDemoMode } from "../db/client";
import { getDataHealth } from "../services/healthService";
import { appVersion } from "../version";
import type { StudioProvider } from "../studio/provider";
import {
  AGENT_API_VERSION,
  AGENT_PROJECT_ID,
  AGENT_TOOLS,
  executeAgentTool,
  listAgentTools,
  type AgentContext,
} from "../agent/tools";
import { agentHttpStatus, toAgentError, type AgentErrorCode } from "../agent/errors";

export interface AgentRouterOptions {
  /** 进程启动时刻(uptime_ms 的分母,与 /api/agent/manifest 共用)。 */
  bootedAt: number;
  makeStudioProvider?: () => StudioProvider;
}

/**
 * base_url 只是**对外 advertised 的地址**(给 Agent 看的清单里那句"你来打哪里"),
 * 优先用请求里的 Host 是为了用户换端口启动时清单不说错话,并把 localhost 归一成 127.0.0.1。
 *
 * ⚠ 这不是防御,也别当防御用:它不改写任何判定,更不校验任何头。
 * 本机边界(Host 逐字回环 + Origin/Referer + 可选令牌)在 `server/src/local-guard.ts`,
 * 由 `server/src/app.ts` 作为第一个中间件执行。把这里当闸门 = 闸门不存在。
 */
export function baseUrlOf(req: express.Request): string {
  const host = req.headers.host?.trim();
  if (!host) return "http://127.0.0.1:5184";
  const withoutLocalhost = host.replace(/^localhost/i, "127.0.0.1");
  return `http://${withoutLocalhost}`;
}

function fail(res: express.Response, code: AgentErrorCode, message: string, hint?: string, http?: number): void {
  const status = http ?? agentHttpStatus(code);
  res.status(status).json({
    ok: false,
    // 契约要求 unknown_tool 必须带机器可读的 available 清单（写在 message 里Agent 解析不到）。
    error: {
      code,
      message,
      ...(code === "unknown_tool" ? { available: AGENT_TOOLS.map((t) => t.name) } : {}),
      ...(hint ? { hint } : {}),
    },
  });
}

export function createAgentRouter(db: DB, opts: AgentRouterOptions): express.Router {
  const router = express.Router();
  // 只有 POST /api/agent/tool 有 body,但 json() 对 GET 是无害的;
  // 1mb 足够装下一个工具调用参数,又不至于让任何人用大 body 打爆本机。
  router.use(express.json({ limit: "1mb" }));

  const ctxFor = (req: express.Request): AgentContext => ({
    db,
    bootedAt: opts.bootedAt,
    baseUrl: baseUrlOf(req),
    makeStudioProvider: opts.makeStudioProvider,
  });

  /**
   * GET /api/health —— 契约要求 {ok:true,data:{project,version,agent_api,uptime_ms}}。
   * 同时:数据总览页一直在读这一份**扁平**的数据健康字段(totalContent / latestBatches /
   * pendingDuplicateCandidates …),那是界面既有契约。这里两者都给 —— 顶层保持扁平不动界面,
   * 另加 ok/data 信封满足 Agent 标准。不新造端点,也不让界面改读法。
   */
  router.get("/health", async (_req, res) => {
    const t0 = Date.now();
    let health;
    try {
      health = await getDataHealth(db);
    } catch (e) {
      // 健康检查本身失败时也必须回 JSON,并说清下一步(这条路径在 1.3GB 的库上真发生过山崩)
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        ok: false,
        error: { code: "internal_error", message: `数据健康检查失败:${msg}` },
        data: {
          project: AGENT_PROJECT_ID,
          version: appVersion(),
          agent_api: AGENT_API_VERSION,
          uptime_ms: Date.now() - opts.bootedAt,
        },
      });
      return;
    }
    res.json({
      ok: true,
      data: {
        project: AGENT_PROJECT_ID,
        version: appVersion(),
        agent_api: AGENT_API_VERSION,
        uptime_ms: Date.now() - opts.bootedAt,
        demo_mode: isDemoMode(),
        tools: AGENT_TOOLS.length,
        health_checked_in_ms: Date.now() - t0,
      },
      ...health,
    });
  });

  router.get("/agent/manifest", (_req, res) => {
    res.json({
      ok: true,
      data: {
        project: AGENT_PROJECT_ID,
        version: appVersion(),
        base_url: baseUrlOf(_req),
        agent_api: AGENT_API_VERSION,
        tools: listAgentTools(),
      },
    });
  });

  router.get("/agent/tools", (_req, res) => {
    res.json({ ok: true, data: listAgentTools() });
  });

  router.post("/agent/tool", async (req, res) => {
    const t0 = Date.now();
    const body = (req.body ?? {}) as { tool?: unknown; input?: unknown };
    try {
      const r = await executeAgentTool(body.tool, body.input, ctxFor(req));
      res.json({ ok: true, data: r.data, tool: r.tool, risk: r.risk, ms: Date.now() - t0 });
    } catch (e) {
      const err = toAgentError(e);
      if (err.code === "internal_error") console.error("[agent]", err.message);
      fail(res, err.code, err.message, err.hint);
    }
  });

  // 方法与路径写错的出路:JSON + 可执行提示,绝不让这些路径落到 SPA 的 HTML。
  router.get("/agent/tool", (_req, res) =>
    fail(
      res,
      "bad_input",
      "调用工具请用 POST /api/agent/tool,body 形如 {tool:\"trendscope.overview\",input:{}}。",
      "工具清单在 GET /api/agent/tools。",
      405,
    ),
  );
  // Express 4 的通配写法是 /*;上面的三条具体路由先注册,所以只会兜住"拼错的 agent 路径"。
  router.all("/agent/*", (req, res) =>
    fail(
      res,
      "unknown_tool",
      `Agent 契约只有四个端点:GET /api/health、GET /api/agent/tools、GET /api/agent/manifest、POST /api/agent/tool(收到 ${req.method} ${req.originalUrl})。`,
      "见 personal-agent-hub/docs/AGENT_API_STANDARD.md。",
      404,
    ),
  );

  return router;
}
