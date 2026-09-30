/**
 * FixtureRemoteConnector (Stage 3 §27/28) — the Stage 3 acceptance core.
 *
 * Simulates a REAL remote source: stateful pagination, latency, temporary &
 * permanent failures, 429s, resume, duplicate content, growing metrics,
 * schema drift. Runs scenarios A–H:
 *   A 3 pages all success
 *   B page2 first attempt 500 → retry succeeds
 *   C page3 permanent failure → run partial
 *   D 429 on page2 → backoff → recovery
 *   E resume from checkpoint (collects remaining pages)
 *   F second run re-collects same content with GROWN metrics
 *   G same-run duplicate rows (snapshot dedup verification)
 *   H schema drift page (missing required fields → SCHEMA_DRIFT)
 *
 * It is a DEMO connector (metadata.isDemo) — no real platform logic ever
 * enters the scheduler or the pipeline.
 */
import { z } from "zod";
import {
  ConnectorError,
  type PageResult,
  type RemotePageRequest,
} from "../domain/collection";
import type {
  Connector,
  ConnectorMetadata,
  ConnectorPolicy,
  ConnectorRunContext,
} from "./types";
import { validateWithSchema } from "./types";

export const FixtureConfigSchema = z
  .object({
    platform: z.enum(["douyin", "xiaohongshu", "zhihu", "bilibili", "weibo", "other"]).default("weibo"),
    keyword: z.string().min(1).max(200).default("fixture"),
    /** total items the "remote" source can offer */
    totalItems: z.number().int().min(1).max(5000).default(9),
    pageSize: z.number().int().min(1).max(250).default(3),
    /** hard page cap per run */
    pageLimit: z.number().int().min(1).max(100).default(10),
    scenario: z.enum(["A", "B", "C", "D", "E", "F", "G", "H"]).default("A"),
    /** latency per page (ms) — keeps tests fast, simulates a remote */
    latencyMs: z.number().int().min(0).max(5_000).default(15),
    /** canonical→source key mapping used by JSONAdapter downstream */
    mapping: z.record(z.string()).default({
      platformContentId: "remote_id",
      title: "标题",
      text: "正文",
      authorName: "作者昵称",
      publishedAt: "发布时间",
      views: "播放量",
      likes: "点赞数",
      comments: "评论数",
      shares: "分享数",
      favorites: "收藏数",
    }),
    sourceTimezone: z.string().default("Asia/Shanghai"),
    /** G: insert an exact duplicate of the first row on each page */
    duplicateEveryPage: z.boolean().default(false),
  })
  .strict();

type FixtureConfig = z.infer<typeof FixtureConfigSchema>;

/** per-task runtime state (metrics growth across runs — scenario F) */
const runCounters = new Map<string, number>();

function buildRow(cfg: FixtureConfig, index: number, runNumber: number): Record<string, unknown> {
  // stable remote id: same content across runs (scenario F re-collects it)
  const remoteId = `fx_${cfg.platform}_${cfg.keyword}_${index}`;
  const base = 100 + index * 7;
  const growth = (runNumber - 1) * 50; // metrics grow every new run
  return {
    remote_id: remoteId,
    标题: `${cfg.keyword} 内容 ${index}`,
    正文: `第 ${runNumber} 次采集的第 ${index} 条内容 #采集 #fixture`,
    作者昵称: `fixture作者${index % 3}`,
    发布时间: `2026-09-${String((index % 28) + 1).padStart(2, "0")} 12:30:00`,
    播放量: String(base * 10 + growth * 10),
    点赞数: String(base + growth),
    评论数: String(Math.floor(base / 10) + growth),
    分享数: String(Math.floor(base / 20) + growth),
    收藏数: String(Math.floor(base / 5) + growth),
  };
}

export class FixtureRemoteConnector implements Connector {
  readonly metadata: ConnectorMetadata = {
    id: "fixture-remote",
    name: "示例远程源(演示)",
    platform: "other",
    connectorType: "mock",
    sourceType: "json",
    version: "1.0.0",
    capabilities: ["search", "content_detail", "metrics"],
    defaultTimezone: "Asia/Shanghai",
    description:
      "可配置场景的模拟远程数据源：分页/延迟/失败/429/resume/指标增长/重复/Schema 漂移",
    isDemo: true,
  };

  readonly configSchema = FixtureConfigSchema;
  readonly itemSchema = z.object({
    remote_id: z.string(),
    标题: z.string(),
    发布时间: z.string(),
    播放量: z.union([z.string(), z.number()]),
  });

  readonly defaultPolicy: ConnectorPolicy = {
    rateLimit: { rps: 5, concurrency: 1 }, // demo: 5 req/s upper bound, serial pages
    retry: { maxRetries: 2, baseDelayMs: 50, maxDelayMs: 500 },
    breaker: { failureThreshold: 3, cooldownMs: 1_000 },
  };

  validateConfig(config: unknown): { ok: boolean; error?: string } {
    return validateWithSchema(FixtureConfigSchema, config);
  }

  async healthCheck(_ctx: { signal?: AbortSignal }): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "演示连接器,不依赖外部服务" };
  }

  async collectPage(
    req: RemotePageRequest,
    rawConfig: unknown,
    ctx: ConnectorRunContext,
  ): Promise<PageResult<unknown>> {
    const parsed = FixtureConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new ConnectorError("INVALID_CONFIG", "fixture config invalid");
    }
    const cfg = parsed.data;

    // latency — simulated remote
    if (cfg.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, cfg.latencyMs);
        ctx.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new ConnectorError("CANCELLED", "aborted during latency"));
          },
          { once: true },
        );
      });
    }
    if (ctx.signal?.aborted) throw new ConnectorError("CANCELLED", "aborted before page");

    // cursor: opaque index of the NEXT page (1-based). null/absent → page 1.
    const page = req.cursor ? this.decodeCursor(req.cursor) : 1;
    if (page === null || page < 1 || page > cfg.pageLimit) {
      throw new ConnectorError("INVALID_RESPONSE", `bad cursor: ${String(req.cursor)}`);
    }

    // ---- scenario behaviors (stateless per attempt unless noted) ----
    if (cfg.scenario === "B" && page === 2 && !this.oncePerRun(ctx.runId, "B500")) {
      this.markOnce(ctx.runId, "B500");
      throw new ConnectorError("REMOTE_5XX", "演示数据源:第 2 页模拟 500(首次尝试)");
    }
    if (cfg.scenario === "C" && page === 3) {
      throw new ConnectorError("REMOTE_5XX", "演示数据源:第 3 页持续失败(场景 C)");
    }
    if (cfg.scenario === "D" && page === 2 && !this.oncePerRun(ctx.runId, "D429")) {
      this.markOnce(ctx.runId, "D429");
      throw new ConnectorError("RATE_LIMITED", "演示数据源:第 2 页模拟 429(首次尝试)");
    }
    if (cfg.scenario === "E" && page === 3) {
      // after resume (checkpoint cursor) the "crash" is gone — pages flow again
      // before resume the run is expected to be cancelled/failed at page 2/3 boundary
      // (the collector test drives the interruption; connector stays permissive)
    }

    const startIndex = (page - 1) * cfg.pageSize;
    const total = Math.min(cfg.totalItems, cfg.pageSize * cfg.pageLimit);
    const items: Record<string, unknown>[] = [];
    for (let i = startIndex; i < Math.min(startIndex + cfg.pageSize, total); i++) {
      items.push(buildRow(cfg, i, this.runNumber(ctx.taskId)));
      if (cfg.scenario === "G" && cfg.duplicateEveryPage && items.length === 1) {
        items.push({ ...items[0] }); // exact duplicate row within the same page
      }
    }
    if (cfg.scenario === "H" && page === 2) {
      // schema drift: rows missing 标题/发布时间 entirely
      for (let k = 0; k < items.length; k++) {
        const bad: Record<string, unknown> = { ...items[k] };
        delete bad["标题"];
        delete bad["发布时间"];
        items[k] = bad;
      }
    }

    const nextPage = page + 1;
    const hasMore = nextPage <= cfg.pageLimit && startIndex + cfg.pageSize < total;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? this.encodeCursor(nextPage) : null,
      rawPaginationState: { page, total, runNumber: this.runNumber(ctx.taskId) },
    };
  }

  // ---- run-scoped once-flags (simulated transient faults) ----
  private static onceFlags = new Set<string>();
  private oncePerRun(runId: number, tag: string): boolean {
    return FixtureRemoteConnector.onceFlags.has(`${runId}:${tag}`);
  }
  private markOnce(runId: number, tag: string): void {
    FixtureRemoteConnector.onceFlags.add(`${runId}:${tag}`);
  }

  // ---- cursor codec (opaque to the scheduler) ----
  private encodeCursor(page: number): string {
    return Buffer.from(JSON.stringify({ p: page, s: "fx" })).toString("base64url");
  }
  private decodeCursor(cursor: string): number | null {
    try {
      const obj = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
        p?: number;
        s?: string;
      };
      if (obj.s !== "fx" || typeof obj.p !== "number") return null;
      return obj.p;
    } catch {
      return null;
    }
  }

  // ---- metrics growth across runs (scenario F) ----
  private runNumber(taskId: number): number {
    return (runCounters.get(String(taskId)) ?? 0) + 1;
  }
  /** collector notifies the fixture that a run for this task completed */
  notifyRunFinished(taskId: number): void {
    const cur = runCounters.get(String(taskId)) ?? 0;
    runCounters.set(String(taskId), cur + 1);
  }
  resetState(): void {
    runCounters.clear();
    FixtureRemoteConnector.onceFlags.clear();
  }
}
