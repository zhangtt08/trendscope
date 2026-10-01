/**
 * TrendScope Agent 能力注册表(HTTP 契约 `GET /api/agent/tools` 与
 * `POST /api/agent/tool` 的唯一实现处)。
 *
 * 三条硬规矩,改这里之前先读:
 *  1. 每个 handler 调的都是项目**已有的 service / repository 函数** —— 与网页按同一个
 *     按钮走的是同一条代码路径。绝不在这里重写 SQL、绝不返回写死的样例数据。
 *     Agent 拿到的数字与用户在界面上看到的数字必须同源,否则同一个事实会有两个答案。
 *  2. `input_schema` 就是那份公布出去的契约,schema.ts 的校验器直接读它(单一来源)。
 *  3. 大结果自己截断并回 `truncated` + 总数;评分口径一律带 scoreVersion 与 evidence,
 *     让"为什么是 87 分"在工具返回值里就能回答。
 *
 * 生命周期/机会分/爆发指数的算法说明见 docs/SCORING_MODEL.md 与 docs/OPPORTUNITY_MODEL.md;
 * 这里只透出引擎算出来的实际数值与权重,不复述公式(复述就会腐烂)。
 */
import type { DB } from "../db/client";
import { isDemoMode } from "../db/client";
import { desc } from "drizzle-orm";
import { importBatches } from "../db/schema";
import { PLATFORMS, CONTENT_TYPES, DATA_QUALITIES } from "../domain/constants";
import { CONFIDENCE_LABELS_ZH, lifecycleZh, platformZh } from "../domain/labels";
import type { StudioProvider } from "../studio/provider";
import { getAnalysisStatus } from "../analysis/status";
import { getPlatformCoverage } from "../services/statsService";
import { getCollectionStats } from "../services/collection/service";
import { SCORING_PROFILES, configSnapshotFor as scoringConfigSnapshotFor } from "../scoring/profiles";
import { LIFECYCLE_LABELS_ZH } from "../scoring/lifecycle";
import { OPPORTUNITY_PROFILES } from "../opportunity/profiles";
import { resolveActiveProfile } from "../opportunity/profileStore";
import {
  getContentDetail,
  parseContentQuery,
  queryContent,
  type ContentQuery,
} from "../services/queryService";
import { getItemTrendSeries } from "../services/trendService";
import { listCandidates } from "../services/duplicateService";
import {
  getContentScoreDetail,
  getTopicTrendDetail,
  listTopicTrends,
} from "../scoring/repository";
import { getTopicOpportunityDetail, listOpportunityTopics } from "../opportunity/repository";
import { listTopics, topicDetail } from "../topics/governance";
import { generateStudioPlan, getStudioView } from "../studio/service";
import { beginRun, conflictMessage, endRun } from "../services/engineLock";
import { CHANNELS, DEFAULT_HOT_CHANNEL_INTERVAL_MIN, REFUSED_CHANNELS } from "../routes/hot";
import { appVersion } from "../version";
import { AgentError, mapServiceError } from "./errors";
import { validateAgentInput, type JsonSchema } from "./schema";

export const AGENT_PROJECT_ID = "trendscope";
export const AGENT_API_VERSION = 1;

export interface AgentContext {
  db: DB;
  /** 服务进程启动时刻,用于 uptime_ms(与 /api/health 同一口径)。 */
  bootedAt: number;
  /** 本机基地址,用于把 app_path 拼成可点开的链接(只含 127.0.0.1)。 */
  baseUrl: string;
  /** 与 /api/studio 同一个注入点(契约测试注入 Replay Provider,生产不传)。 */
  makeStudioProvider?: () => StudioProvider;
}

export type AgentRisk = "read" | "write" | "exec";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  risk: AgentRisk;
  handler: (input: Record<string, unknown>, ctx: AgentContext) => Promise<unknown>;
}

/* ------------------------------------------------------------------ *
 * 共用小工具
 * ------------------------------------------------------------------ */

function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}
function bool(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key];
  return typeof v === "boolean" ? v : undefined;
}
function reqId(input: Record<string, unknown>, key: string): number {
  const v = input[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new AgentError("bad_input", `「${key}」必须是正整数(数据库主键 id),收到 ${JSON.stringify(v)}`);
  }
  return v;
}

/** 文本截断:带 truncated 标记,绝不悄悄砍掉一半让调用方以为是全文。 */
function clip(s: string | null | undefined, max: number): { text: string | null; truncated: boolean } {
  if (s === null || s === undefined) return { text: null, truncated: false };
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** JSON 列 → 对象;解析不出来就原样留着,不折成 null 冒充"没有数据"。 */
function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const asRows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];

/** 返回给 Agent 的每一条都带界面内可达路径,配合 baseUrl 就是可点开的链接。 */
function appPath(ctx: AgentContext, path: string): string {
  return `${ctx.baseUrl}${path}`;
}

function pageSchema(extra: Record<string, JsonSchema> = {}, extraRequired: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "integer", minimum: 1, maximum: 1000000, default: 1, description: "页码,从 1 开始" },
      pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "每页条数(上限 100)" },
      ...extra,
    },
    required: extraRequired,
  };
}

function paginationNote(pageSize: number, limitKey = "pageSize") {
  return `单次最多 ${pageSize} 条(${limitKey});总数与页码见返回值的 total/page/${limitKey}。要更多就翻页,不要一次要 1000 条。`;
}

/* ------------------------------------------------------------------ *
 * 1 · overview
 * ------------------------------------------------------------------ */

async function overviewHandler(_input: Record<string, unknown>, ctx: AgentContext) {
  const [status, coverage, collectionStats] = await Promise.all([
    getAnalysisStatus(ctx.db),
    getPlatformCoverage(ctx.db),
    getCollectionStats(ctx.db),
  ]);
  return {
    project: AGENT_PROJECT_ID,
    version: appVersion(),
    agent_api: AGENT_API_VERSION,
    uptime_ms: Date.now() - ctx.bootedAt,
    demo_mode: isDemoMode(),
    generated_at: status.generatedAt,
    // 库里有什么(未知一律 null,不折算成 0 —— 这是本项目的红线)
    counts: {
      content_items: status.data.contentTotal,
      topics_total: status.topics.total,
      topics_active: status.topics.active,
      unclustered_content: status.topics.unclustered,
      source_kinds: status.data.sourceKinds,
      demo_share_percent: status.data.demoShare,
      latest_collected_at: status.data.latestCollectedAt,
    },
    // 四个确定性引擎各自的覆盖度:分母是"该算的条数",不是"全部条数"
    engines: status.engines,
    semantic: status.semantic,
    studio: status.studio,
    quality_gaps: status.data.quality,
    collection: {
      total_tasks: collectionStats.totalTasks,
      active_tasks: collectionStats.activeTasks,
      runs_today: collectionStats.runsToday,
      records_collected_today: collectionStats.recordsCollectedToday,
      running_now: collectionStats.runningNow,
    },
    platforms: coverage.map((p) => ({
      platform: p.platform,
      platform_zh: platformZh(p.platform),
      items: p.items,
      /** 该平台最近一次入库时间(MAX collected_at)—— 回答"多久没更新了"就看这个 */
      last_sync_at: p.latestAt,
      clustered_into_topics: p.clustered,
      missing_published_at: p.missingTime,
      no_metrics_at_all: p.noMetric,
    })),
    // 一键抓热点的渠道可用性:只报"缺哪个变量名",绝不读取或回显任何密钥值
    hot_channels: CHANNELS.map((c) => ({
      key: c.key,
      label: c.label,
      note: c.note,
      requires_env: c.needsEnv ?? null,
      available: c.needsEnv ? Boolean(process.env[c.needsEnv]?.trim()) : true,
      interval_minutes: c.onDemandOnly ? null : c.intervalMinutes ?? DEFAULT_HOT_CHANNEL_INTERVAL_MIN,
      on_demand_only: Boolean(c.onDemandOnly),
    })),
    refused_channels: REFUSED_CHANNELS,
    batch_history_hint: "导入批次(名称/来源/成功失败条数)用 trendscope.export_panel,panel=\"batches\"。",
    // 产品自述的下一步(与服务端 guide 同一份判定,不在前端重算)
    next_steps: status.guide
      .filter((g) => g.state === "todo" || g.state === "blocked")
      .map((g) => ({
        key: g.key,
        state: g.state,
        label: g.label,
        detail: g.detail,
        app_path: g.route,
        page_url: appPath(ctx, g.route),
      })),
    auto_analysis: status.autoAnalysis,
    notes: [
      "内容条数与话题条数是两个口径:一条内容可以归入 0 个或多个话题。",
      "评分数字全部来自确定性引擎(SQLite + 配置快照),没有任何模型参与。",
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 2 · search_contents
 * ------------------------------------------------------------------ */

const CONTENT_SORTS = ["relevance", "collectedAt", "publishedAt", "views", "likes", "comments", "title", "authorName", "dataQuality", "id"] as const;

async function searchContentsHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const q: ContentQuery = parseContentQuery({
    keyword: str(input, "keyword"),
    platform: str(input, "platform"),
    contentType: str(input, "contentType"),
    quality: str(input, "quality"),
    author: str(input, "author"),
    publishedFrom: str(input, "publishedFrom"),
    publishedTo: str(input, "publishedTo"),
    sortBy: str(input, "sortBy") ?? "collectedAt",
    order: str(input, "order") ?? "desc",
    page: num(input, "page") ?? 1,
    pageSize: num(input, "pageSize") ?? 20,
  });
  const result = await queryContent(ctx.db, q);
  return {
    ...result,
    rows: result.rows.map((r) => {
      const body = clip(r.text, 240);
      return {
        id: r.id,
        platform: r.platform,
        platform_zh: platformZh(r.platform),
        content_type: r.contentType,
        title: r.title,
        excerpt: body.text,
        excerpt_truncated: body.truncated,
        author_name: r.authorName,
        url: r.url,
        published_at: r.publishedAt,
        collected_at: r.collectedAt,
        metrics: {
          views: r.views,
          likes: r.likes,
          comments: r.comments,
          shares: r.shares,
          favorites: r.favorites,
          upvotes: r.upvotes,
        },
        data_quality: r.dataQuality,
        source_type: r.sourceType,
        // FTS 命中高亮([ ] 包住)原样带出,方便 Agent 说明"为什么命中这条"
        highlight_title: r.hlTitle ?? null,
        highlight_body: r.hlBody ?? null,
        page_url: appPath(ctx, `/content/${r.id}`),
      };
    }),
    search_mode: result.mode,
    search_mode_zh:
      result.mode === "fts" ? "全文索引(BM25 相关度)" : result.mode === "like" ? "关键词回退(索引不可用或未命中)" : "无关键词,按筛选条件列出",
    filters_applied: q,
    pagination_note: paginationNote(result.pageSize),
  };
}

/* ------------------------------------------------------------------ *
 * 3 · content_detail
 * ------------------------------------------------------------------ */

async function contentDetailHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const id = reqId(input, "contentItemId");
  const detail = await getContentDetail(ctx.db, id);
  if (!detail) throw new AgentError("not_found", `内容 #${id} 不存在`, "先用 trendscope.search_contents 拿到真实 id");
  const item = detail.item;
  const body = clip(item.text, 4000);
  const score = await getContentScoreDetail(ctx.db, id);
  const series = await getItemTrendSeries(ctx.db, id);

  return {
    id: item.id,
    platform: item.platform,
    platform_zh: platformZh(item.platform),
    content_type: item.contentType,
    title: item.title,
    body: body.text,
    body_truncated: body.truncated,
    hashtags: parseJson(item.hashtags),
    author: { id: item.authorId, name: item.authorName, followers: item.authorFollowers },
    source: {
      url: item.url,
      canonical_url: item.canonicalUrl,
      platform_content_id: item.platformContentId,
      published_at: item.publishedAt,
      raw_published_at: item.rawPublishedAt,
      published_tz: item.publishedTz,
      timezone_assumption: item.publishedTzAssumption,
      collected_at: item.collectedAt,
      source_type: item.sourceType,
      data_quality: item.dataQuality,
      quality_reasons: parseJson(item.qualityReasons),
    },
    metrics: {
      views: item.views,
      likes: item.likes,
      comments: item.comments,
      shares: item.shares,
      favorites: item.favorites,
      upvotes: item.upvotes,
    },
    snapshots: detail.snapshots.map((s) => ({
      captured_at: s.capturedAt,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      shares: s.shares,
      favorites: s.favorites,
      upvotes: s.upvotes,
    })),
    // 内容爆发指数:0-100 是对"已观察数据"的异常度量化,不是未来爆款概率。
    burst_score: score.current
      ? {
          score_version: score.current.scoreVersion,
          overall: score.current.overallScore,
          scorable: score.current.scorable === 1,
          unscorable_reason: score.current.unscorableReason,
          confidence: score.current.confidence,
          breakdown: parseJson(score.current.breakdown),
          evidence: parseJson(score.current.evidence),
          history_runs: score.history.length,
        }
      : null,
    burst_score_hint: score.current
      ? null
      : "这条内容还没跑过内容评分(或不可评分)。可让调用方先看 trendscope.overview 的 engines.contentBurst。",
    trend_series: series,
    // 证据可追溯:这条数据从哪个批次、哪一行原始记录来,被并进了哪条,还有哪些重复嫌疑
    lineage: {
      batch: detail.batch
        ? {
            id: detail.batch.id,
            name: detail.batch.name,
            source_type: detail.batch.sourceType,
            status: detail.batch.status,
            started_at: detail.batch.startedAt,
            page_url: appPath(ctx, `/import/${detail.batch.id}`),
          }
        : null,
      raw_record: detail.raw
        ? {
            id: detail.raw.id,
            row_index: detail.raw.rowIndex,
            note: detail.raw.note,
            payload: clip(detail.raw.payload, 1200),
          }
        : null,
      merged_into: detail.mergedInto
        ? { id: detail.mergedInto.id, title: detail.mergedInto.title }
        : null,
      merged_sources: detail.mergedSources,
      duplicate_candidates: detail.candidates,
    },
    app_path: `/content/${item.id}`,
    page_url: appPath(ctx, `/content/${item.id}`),
  };
}

/* ------------------------------------------------------------------ *
 * 4 · list_topics
 * ------------------------------------------------------------------ */

async function listTopicsHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const sortByRaw = str(input, "sortBy") ?? "score";
  const allowedSort = ["score", "memberCount", "recentNew", "updatedAt", "saturation", "novelty", "opportunity"];
  if (!allowedSort.includes(sortByRaw)) {
    throw new AgentError("bad_input", `sortBy 取值必须是 ${allowedSort.join(" / ")},收到 ${JSON.stringify(sortByRaw)}`);
  }
  const sat = str(input, "saturation");
  if (sat && !["low", "medium", "high", "unknown"].includes(sat)) {
    throw new AgentError("bad_input", 'saturation 取值必须是 low / medium / high / unknown');
  }
  const result = await listTopicTrends(ctx.db, {
    search: str(input, "search"),
    lifecycle: str(input, "lifecycle"),
    confidence: str(input, "confidence"),
    platform: str(input, "platform"),
    watch: str(input, "watch"),
    minScore: num(input, "minScore"),
    saturation: sat,
    noveltyMin: num(input, "noveltyMin"),
    minOpportunity: num(input, "minOpportunity"),
    sortBy: sortByRaw as "score",
    order: str(input, "order") === "asc" ? "asc" : "desc",
    page: num(input, "page") ?? 1,
    pageSize: num(input, "pageSize") ?? 20,
  });
  return {
    ...result,
    rows: result.rows.map((r) => ({
      topic_id: r.topicId,
      name: r.name,
      status: r.status,
      member_count: r.memberCount,
      trend_score: r.score,
      trend_confidence: r.confidence,
      lifecycle: r.lifecycle,
      lifecycle_zh: lifecycleZh(r.lifecycle),
      saturation_score: r.saturationScore,
      novelty_score: r.noveltyScore,
      opportunity_score: r.opportunityScore,
      opportunity_level: r.opportunityLevel,
      recent_new_content: r.recentNewContent,
      active_creators: r.activeCreators,
      burst_density: r.burstDensity,
      watch_state: r.watchState,
      calculated_at: r.calculatedAt,
      page_url: appPath(ctx, `/topics/${r.topicId}`),
    })),
    note: "只列已运行话题趋势评分且状态为 active 的话题;分数为 null 表示该话题尚未评分或数据不足(不是 0 分)。",
    pagination_note: paginationNote(result.pageSize),
  };
}

/* ------------------------------------------------------------------ *
 * 5 · topic_detail(含证据与最近一次选题结论)
 * ------------------------------------------------------------------ */

async function topicDetailHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const topicId = reqId(input, "topicId");
  const topic = await topicDetail(ctx.db, topicId);
  if (!topic) throw new AgentError("not_found", `话题 #${topicId} 不存在`, "先用 trendscope.list_topics 或 search_contents 拿真实 id");

  const [trend, opportunity, studioView] = await Promise.all([
    getTopicTrendDetail(ctx.db, topicId),
    getTopicOpportunityDetail(ctx.db, topicId),
    getStudioView(ctx.db, topicId, { historyLimit: 1 }).catch(() => null),
  ]);

  const base = (topic ?? {}) as Record<string, unknown>;
  const members = asRows(base.members).slice(0, 20).map((m) => ({
    content_item_id: m.contentItemId,
    title: m.title,
    platform: m.platform,
    similarity_score: m.similarityScore,
    assignment_method: m.assignmentMethod,
    manual_lock: m.manualLock,
    page_url: appPath(ctx, `/content/${String(m.contentItemId)}`),
  }));

  const lastRun = studioView?.history[0] ?? null;
  // 选题结论的每条证据编号 → 内容 id,让"这句话凭什么"点得回原文
  const evidenceRefs = studioView
    ? [
        ...studioView.evidence.topBurstContents.map((c) => ({
          ref_id: c.refId,
          kind: "burst-content",
          content_item_id: c.contentItemId,
          title: c.title,
          burst_score: c.burstScore,
          page_url: appPath(ctx, `/content/${c.contentItemId}`),
        })),
        ...studioView.evidence.representativeContent.map((c) => ({
          ref_id: c.refId,
          kind: "representative",
          content_item_id: c.contentItemId,
          title: c.title,
          page_url: appPath(ctx, `/content/${c.contentItemId}`),
        })),
      ]
    : [];

  return {
    topic_id: base.id,
    name: base.name,
    description: base.description,
    status: base.status,
    member_count: base.memberCount,
    keywords: base.keywords,
    hashtags: base.hashtags,
    first_observed_at: base.firstObservedAt,
    watch_state: base.watchState,
    trend: trend.current
      ? {
          score_version: trend.current.scoreVersion,
          overall: trend.current.score,
          confidence: trend.current.confidence,
          scorable: trend.current.scorable === 1,
          unscorable_reason: trend.current.unscorableReason,
          lifecycle: trend.current.lifecycle,
          lifecycle_zh: lifecycleZh(trend.current.lifecycle),
          pending_lifecycle: trend.current.pendingLifecycle,
          components: parseJson(trend.current.componentsJson),
          effective_weights: parseJson(trend.current.effectiveWeightsJson),
          evidence: parseJson(trend.current.evidence),
          calculated_at: trend.current.calculatedAt,
          history_runs: trend.history.length,
          lifecycle_events: trend.lifecycleEvents,
        }
      : null,
    opportunity: opportunity.current
      ? (() => {
          const cur = opportunity.current;
          // 组件贡献与 whyChanged 活在本次 Run 的那条**快照**上(current 表只是缓存,
          // 与 GET /api/opportunity/topics/:id 同一取法,不让调用方去猜)
          const snap = opportunity.history.find((h) => h.runId === cur.runId) ?? opportunity.history[0] ?? null;
          return {
            score_version: cur.scoreVersion,
            profile_id: cur.profileId,
            profile_version: cur.profileVersion,
            overall: cur.score,
            level: cur.opportunityLevel,
            confidence: cur.confidence,
            delta_vs_previous_run: cur.deltaScore,
            unscorable_reason: cur.unscorableReason,
            evidence: parseJson(cur.evidence),
            calculated_at: cur.calculatedAt,
            run_id: cur.runId,
            contributions: snap
              ? {
                  trend: snap.trendContribution,
                  burst: snap.burstContribution,
                  novelty: snap.noveltyContribution,
                  whitespace: snap.whitespaceContribution,
                  pattern: snap.patternContribution,
                  lifecycle: snap.lifecycleContribution,
                }
              : null,
            effective_weights: snap ? parseJson(snap.effectiveWeights) : null,
            why_changed: snap ? parseJson(snap.whyChanged) : null,
            history_runs: opportunity.history.length,
          };
        })()
      : null,
    latest_plan: lastRun
      ? {
          run_id: lastRun.id,
          status: lastRun.status,
          kind: lastRun.kind,
          provider: lastRun.provider,
          model: lastRun.model,
          evidence_hash: lastRun.evidenceHash,
          output: lastRun.output,
          unsupported_claims: lastRun.unsupportedClaims,
          error: lastRun.error,
          demo_data: lastRun.demoData,
          stale_evidence: lastRun.staleEvidence,
          created_at: lastRun.createdAt,
          page_url: appPath(ctx, `/studio/${topicId}`),
        }
      : null,
    evidence_refs: evidenceRefs,
    members,
    members_note: `成员按相似度排序,这里只给前 ${members.length} 条(共 ${String(base.memberCount ?? 0)} 条)。`,
    scoring_note:
      "趋势分/生命周期/机会分都由确定性引擎算出,口径(权重与阈值)见 trendscope.scoring_profile 或 GET /api/scoring/profile。",
  };
}

/* ------------------------------------------------------------------ *
 * 6 · generate_plan(exec,需 confirm)
 * ------------------------------------------------------------------ */

async function generatePlanHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const topicId = reqId(input, "topicId");
  if (input.confirm !== true) {
    throw new AgentError(
      "confirm_required",
      `生成选题方案会调用已配置的 AI 服务(消耗额度)并向本机库写入一条生成记录,因此必须显式传 confirm:true。`,
      `确认要做再调一次:{tool:"trendscope.generate_plan",input:{topicId:${topicId},confirm:true}}。想先看不花钱的证据与确定性摘要,用 trendscope.topic_detail。`,
    );
  }
  const lock = beginRun(["studio"]);
  if (!lock.ok) {
    throw new AgentError("engine_busy", conflictMessage(lock.conflicts), "等当前那次生成结束后再试,或先读 topic_detail 里已存在的那条结论。");
  }
  try {
    const regenerate = bool(input, "regenerate") === true;
    const r = await generateStudioPlan(ctx.db, topicId, {
      reuse: regenerate ? false : undefined,
      makeProvider: ctx.makeStudioProvider,
    });
    return {
      run_id: r.runId,
      status: r.status,
      reused: r.reused,
      output: r.output,
      unsupported_claims: r.unsupportedClaims,
      provider: r.provider,
      model: r.model,
      duration_ms: r.durationMs,
      error: r.error,
      evidence_hash: r.evidence.evidenceHash,
      evidence_truncated: r.evidence.evidenceTruncated,
      demo_data: r.evidence.demoData,
      stale_evidence: r.evidence.dataFreshness.stale,
      evidence_brief: r.brief,
      app_path: `/studio/${topicId}`,
      page_url: appPath(ctx, `/studio/${topicId}`),
      note:
        r.unsupportedClaims.length > 0
          ? `护栏标记了 ${r.unsupportedClaims.length} 条证据支持不了的说法,原样列在 unsupported_claims 里,未擅自删除或改写。`
          : "未发现与证据不符的说法(仍由人判断要不要做)。",
    };
  } finally {
    endRun(["studio"]);
  }
}

/* ------------------------------------------------------------------ *
 * 7 · export_panel
 * ------------------------------------------------------------------ */

const PANELS = ["contents", "trends", "topics", "opportunity", "duplicates", "batches"] as const;
type Panel = (typeof PANELS)[number];

/** 面板字段顺序 = CSV 列顺序;每个面板一份,与界面表格看到的列同口径。 */
const PANEL_COLUMNS: Record<Panel, string[]> = {
  contents: ["id", "platform", "title", "author_name", "url", "published_at", "collected_at", "views", "likes", "comments", "data_quality", "source_type"],
  trends: ["topic_id", "name", "member_count", "trend_score", "lifecycle", "saturation_score", "novelty_score", "opportunity_score", "recent_new_content", "calculated_at"],
  topics: ["id", "name", "status", "member_count", "cohesion", "first_observed_at", "watch_state"],
  opportunity: ["topicId", "name", "score", "opportunityLevel", "confidence", "deltaScore", "trendScore", "noveltyScore", "saturationScore", "lifecycle", "memberCount", "decision", "calculatedAt"],
  duplicates: ["id", "reason", "status", "similarity", "item_a", "item_b", "title_a", "title_b", "created_at"],
  batches: ["id", "name", "sourceType", "platform", "status", "startedAt", "totalRecords", "successfulRecords", "duplicateRecords", "failedRecords"],
};

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","));
  return [head, ...body].join("\n");
}

function pick(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c] ?? null;
  return out;
}

async function exportPanelHandler(input: Record<string, unknown>, ctx: AgentContext) {
  const panel = (str(input, "panel") ?? "contents") as Panel;
  const limit = num(input, "limit") ?? 100;
  const format = str(input, "format") ?? "json";
  const columns = PANEL_COLUMNS[panel];
  let rows: Record<string, unknown>[] = [];
  let totalHint: number | null = null;

  if (panel === "contents") {
    const r = await queryContent(ctx.db, parseContentQuery({
      keyword: str(input, "search"),
      platform: str(input, "platform"),
      quality: str(input, "quality"),
      publishedFrom: str(input, "publishedFrom"),
      publishedTo: str(input, "publishedTo"),
      sortBy: str(input, "sortBy") ?? "collectedAt",
      order: str(input, "order") ?? "desc",
      page: num(input, "page") ?? 1,
      pageSize: Math.min(limit, 100),
    }));
    totalHint = r.total;
    rows = r.rows.map((x) => ({
      id: x.id,
      platform: x.platform,
      title: x.title,
      author_name: x.authorName,
      url: x.url,
      published_at: x.publishedAt,
      collected_at: x.collectedAt,
      views: x.views,
      likes: x.likes,
      comments: x.comments,
      data_quality: x.dataQuality,
      source_type: x.sourceType,
    }));
  } else if (panel === "trends") {
    const r = await listTopicTrends(ctx.db, {
      search: str(input, "search"),
      lifecycle: str(input, "lifecycle"),
      platform: str(input, "platform"),
      minScore: num(input, "minScore"),
      sortBy: "score",
      order: str(input, "order") === "asc" ? "asc" : "desc",
      page: num(input, "page") ?? 1,
      pageSize: Math.min(limit, 100),
    });
    totalHint = r.total;
    rows = r.rows.map((x) => ({
      topic_id: x.topicId,
      name: x.name,
      member_count: x.memberCount,
      trend_score: x.score,
      lifecycle: x.lifecycle,
      saturation_score: x.saturationScore,
      novelty_score: x.noveltyScore,
      opportunity_score: x.opportunityScore,
      recent_new_content: x.recentNewContent,
      calculated_at: x.calculatedAt,
    }));
  } else if (panel === "topics") {
    const r = await listTopics(ctx.db, {
      search: str(input, "search"),
      platform: str(input, "platform"),
      status: str(input, "status"),
    });
    rows = asRows(r).slice(0, limit).map((x) => ({
      id: x.id,
      name: x.name,
      status: x.status,
      member_count: x.memberCount,
      cohesion: x.cohesion,
      first_observed_at: x.firstObservedAt,
      watch_state: x.watchState,
    }));
    totalHint = rows.length;
  } else if (panel === "opportunity") {
    const r = await listOpportunityTopics(ctx.db, {
      sortBy: "score",
      order: str(input, "order") === "asc" ? "asc" : "desc",
      page: num(input, "page") ?? 1,
      pageSize: Math.min(limit, 100),
      minOpportunity: num(input, "minOpportunity"),
      confidence: str(input, "confidence"),
      lifecycle: str(input, "lifecycle"),
      decision: str(input, "decision"),
    });
    totalHint = r.total;
    rows = r.rows.map((x) => ({ ...x }));
  } else if (panel === "duplicates") {
    const r = await listCandidates(ctx.db, str(input, "status") ?? null, Math.min(limit, 200));
    rows = r.map((x) => ({
      id: x.id,
      reason: x.reason,
      status: x.status,
      similarity: x.similarity,
      item_a: x.a.id,
      item_b: x.b.id,
      title_a: x.a.title,
      title_b: x.b.title,
      created_at: x.createdAt,
    }));
    totalHint = rows.length;
  } else {
    const r = await ctx.db.select().from(importBatches).orderBy(desc(importBatches.startedAt)).limit(Math.min(limit, 200));
    rows = r.map((x) => ({ ...x }));
    totalHint = rows.length;
  }

  const picked = rows.map((r) => pick(r, columns));
  return {
    panel,
    columns,
    rows: picked,
    count: picked.length,
    total_matching: totalHint,
    truncated: totalHint !== null ? picked.length < totalHint : false,
    format_note: `列顺序即面板口径,与界面表格一致;${format === "csv" ? "csv 字段是本机面板的纯文本导出" : "要 csv 就传 format:\"csv\""}`,
    csv: format === "csv" ? toCsv(Object.keys(picked[0] ?? {}), picked) : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * 8 · scoring_profile(评分口径:权重与阈值直接取自引擎配置)
 * ------------------------------------------------------------------ */

async function scoringProfileHandler(_input: Record<string, unknown>, ctx: AgentContext) {
  const activeOpportunity = await resolveActiveProfile(ctx.db).catch(() => null);
  return {
    red_line: [
      "内容爆发指数、话题趋势指数、选题机会指数都是对**已观察数据**的量化。",
      "它们不是未来爆款概率,不构成选题建议;分数为 null 表示数据不足,不是 0 分。",
    ],
    content_burst: {
      version: SCORING_PROFILES.burst.version,
      weights: SCORING_PROFILES.burst.weights,
      velocity_windows: SCORING_PROFILES.burst.velocityWindows,
      velocity_fallback: SCORING_PROFILES.burst.velocityFallback,
      min_snapshots_for_velocity: SCORING_PROFILES.burst.minSnapshotsForVelocity,
      age_buckets: SCORING_PROFILES.burst.ageBuckets,
      cohort: SCORING_PROFILES.burst.cohort,
      creator_min_history: SCORING_PROFILES.burst.creatorMinHistory,
      confidence: SCORING_PROFILES.burst.confidence,
      how: "各组件先在「同组(cohort)」内取百分位,再按权重加权求和;缺失组件不按 0 计,而是把剩余权重按原比例重归一并降低置信度。",
    },
    topic_trend: {
      version: SCORING_PROFILES.trend.version,
      weights: SCORING_PROFILES.trend.weights,
      window_hours: SCORING_PROFILES.trend.windowHours,
      burst_density_threshold: SCORING_PROFILES.trend.burstDensityThreshold,
      min_members: SCORING_PROFILES.trend.minMembers,
      confidence: SCORING_PROFILES.trend.confidence,
      how: "当前窗口(默认 168 小时)与等长基准窗口对比:内容增长/互动增长/创作者增长/爆发密度/加速度五组件加权;成员少于 min_members 则不可评分。",
    },
    lifecycle: {
      thresholds: SCORING_PROFILES.lifecycle,
      states: LIFECYCLE_LABELS_ZH,
      how: "按趋势分、成员规模、增长比、话题年龄与波动做规则判定,带滞回(需连续观察若干次或分数大幅跳变才改状态),所以生命周期不会随一次评分乱跳。",
    },
    opportunity: {
      builtin_versions: Object.values(OPPORTUNITY_PROFILES).map((p) => ({ id: p.id, label: p.label, version: p.version, weights: p.weights })),
      active: activeOpportunity
        ? {
            id: activeOpportunity.id,
            label: activeOpportunity.label,
            version: activeOpportunity.version,
            weights: activeOpportunity.weights,
            level_bands: activeOpportunity.levelBands,
            lifecycle_fit: activeOpportunity.lifecycleFit,
            minimum_available_components: activeOpportunity.minimumAvailableComponents,
            freshness: activeOpportunity.freshness,
          }
        : null,
      how: "机会指数不重算下层指标,只消费趋势/爆发/情报/共性的当前快照并按权重合成;组件缺失 → 权重重归一并降置信,核心证据全缺 → 不可评分。",
    },
    config_snapshot: scoringConfigSnapshotFor(SCORING_PROFILES),
    engine_note: "同一数据库 + 同一 configSnapshot + 同一时间 → 逐位相同的评分结果;全流程无模型参与。",
    page_urls: {
      scoring: appPath(ctx, "/trends"),
      opportunity: appPath(ctx, "/profile"),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

const CONFIDENCE_ENUM = Object.keys(CONFIDENCE_LABELS_ZH);
const LIFECYCLE_ENUM = [...Object.keys(LIFECYCLE_LABELS_ZH).filter((k) => k !== "unknown"), "unknown"];

/** 工具清单就是契约本体:`GET /api/agent/tools` 原样透出 name/description/input_schema/risk。 */
export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "trendscope.overview",
    description:
      "什么时候用:需要了解这台 TrendScope 现在的状态 —— 服务是否活着、库里有多少内容与话题、四个评分引擎各自覆盖到哪一步、各平台最近一次同步时间、抓热点渠道缺哪个环境变量、下一步该做什么。返回 JSON 概览;所有数字直接来自本机 SQLite,没有缓存也没有假数据。",
    risk: "read",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    handler: overviewHandler,
  },
  {
    name: "trendscope.search_contents",
    description:
      "什么时候用:按关键词/平台/内容类型/质量/作者/时间范围检索本机已入库的内容条目(全文索引优先,索引不可用时自动回退关键词匹配并在 search_mode 里如实标注)。返回分页结果 + 每条的原文 URL 与界面链接。想读某条的完整正文与证据链,拿返回的 id 再调 trendscope.content_detail。",
    risk: "read",
    input_schema: pageSchema(
      {
        keyword: { type: "string", maxLength: 200, description: "全文检索词(BM25 相关度);留空=只按其它筛选条件列出" },
        platform: { type: "string", enum: [...PLATFORMS], description: "按平台过滤;本列表取自项目 PLATFORMS 常量,没有的平台就是没支持" },
        contentType: { type: "string", enum: [...CONTENT_TYPES] },
        quality: { type: "string", enum: [...DATA_QUALITIES], description: "数据完整度:complete/partial/minimal/invalid" },
        author: { type: "string", maxLength: 120, description: "作者昵称或作者 ID 的子串" },
        publishedFrom: { type: "string", maxLength: 40, description: "发布时间下界(YYYY-MM-DD 或 ISO 串)" },
        publishedTo: { type: "string", maxLength: 40, description: "发布时间上界;只给日期时按当天 23:59:59 收尾" },
        sortBy: { type: "string", enum: [...CONTENT_SORTS], default: "collectedAt" },
        order: { type: "string", enum: ["asc", "desc"], default: "desc" },
      },
    ),
    handler: searchContentsHandler,
  },
  {
    name: "trendscope.content_detail",
    description:
      "什么时候用:已经有一条内容的 id,需要它的完整正文、指标时序(快照)、内容爆发指数(含分解与 evidence)、以及可追溯的来源(哪个导入批次/原始行/时区推定/被并入哪条/重复嫌疑)。返回结构化详情;正文超长会截断并置 body_truncated。contentItemId 必须真实存在,否则 404。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        contentItemId: { type: "integer", minimum: 1, description: "content_items.id(用 search_contents 拿,不要猜)" },
      },
      required: ["contentItemId"],
    },
    handler: contentDetailHandler,
  },
  {
    name: "trendscope.list_topics",
    description:
      "什么时候用:检索已评分的话题条目 —— 趋势指数、生命周期、饱和度、新颖度、机会指数,支持搜索/生命周期/置信度/平台/关注状态等过滤与分页排序。返回话题级数据(带 member_count 与页面链接)。要看某个话题的成员、评分分解与最近一次选题结论,再调 trendscope.topic_detail。",
    risk: "read",
    input_schema: pageSchema({
      search: { type: "string", maxLength: 120, description: "话题名称模糊匹配" },
      lifecycle: { type: "string", enum: LIFECYCLE_ENUM, description: "生命周期状态;unknown=数据不足(不是低分)" },
      confidence: { type: "string", enum: CONFIDENCE_ENUM },
      platform: { type: "string", enum: [...PLATFORMS], description: "只保留该平台有成员的话题" },
      watch: { type: "string", enum: ["watching", "review", "ignored", "none"] },
      minScore: { type: "number", minimum: 0, maximum: 100, description: "话题趋势指数下限" },
      minOpportunity: { type: "number", minimum: 0, maximum: 100, description: "选题机会指数下限" },
      noveltyMin: { type: "number", minimum: 0, maximum: 100 },
      saturation: { type: "string", enum: ["low", "medium", "high", "unknown"], description: "饱和度档位(阈值由情报引擎决定)" },
      sortBy: { type: "string", enum: ["score", "memberCount", "recentNew", "updatedAt", "saturation", "novelty", "opportunity"], default: "score" },
      order: { type: "string", enum: ["asc", "desc"], default: "desc" },
    }),
    handler: listTopicsHandler,
  },
  {
    name: "trendscope.topic_detail",
    description:
      "什么时候用:已经有话题 id,需要这个话题的全貌 —— 成员内容(带 id 与页面链接)、话题趋势指数与生命周期及其组件分解/有效权重/不可用原因、机会指数与 whyChanged、最近一次选题方案(含 evidenceHash 与被护栏标记的 unsupported_claims)、以及证据编号到内容 id 的映射。话题不存在则 404。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topicId: { type: "integer", minimum: 1, description: "topics.id(用 list_topics 拿,不要猜)" },
      },
      required: ["topicId"],
    },
    handler: topicDetailHandler,
  },
  {
    name: "trendscope.generate_plan",
    description:
      "什么时候用:为某个话题生成(或复用)一份选题方案。会调用已配置的 AI 服务、消耗额度,并向本机库写入一条生成记录,因此必须显式传 confirm:true。返回方案角度、证据哈希、provider/model、耗时,以及护栏发现的「证据支持不了的说法」。未配置 AI 服务时返回 409 并点名缺哪个环境变量 —— 不编造方案。想看免费确定的证据,用 topic_detail。",
    risk: "exec",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        topicId: { type: "integer", minimum: 1 },
        confirm: { type: "boolean", description: "必须为 true:确认花钱生成并写入本机库" },
        regenerate: { type: "boolean", default: false, description: "true=即使证据没变也重新调用模型;false 时命中同一 evidenceHash 会复用上次的成功结果" },
      },
      required: ["topicId", "confirm"],
    },
    handler: generatePlanHandler,
  },
  {
    name: "trendscope.export_panel",
    description:
      "什么时候用:把某个面板当前的数据整份取走(contents / trends / topics / opportunity / duplicates / batches,与界面表格同口径)。返回 columns + rows + count + truncated;format:'csv' 时另给 csv 文本。用于做二次分析或存档,不改变库里任何数据。",
    risk: "read",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        panel: { type: "string", enum: [...PANELS], default: "contents" },
        format: { type: "string", enum: ["json", "csv"], default: "json" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100, description: "取走多少行(超过 100 会按面板分页上限处理)" },
        page: { type: "integer", minimum: 1, maximum: 1000000, default: 1 },
        search: { type: "string", maxLength: 200 },
        platform: { type: "string", enum: [...PLATFORMS] },
        quality: { type: "string", enum: [...DATA_QUALITIES] },
        lifecycle: { type: "string", enum: LIFECYCLE_ENUM },
        confidence: { type: "string", enum: CONFIDENCE_ENUM },
        status: { type: "string", maxLength: 40, description: "topics 面板用 status;_duplicates 面板用治理状态(pending/confirmed_duplicate/not_duplicate/ignored)" },
        decision: { type: "string", enum: ["shortlisted", "reviewing", "dismissed", "none"] },
        minScore: { type: "number", minimum: 0, maximum: 100 },
        minOpportunity: { type: "number", minimum: 0, maximum: 100 },
        sortBy: { type: "string", enum: [...CONTENT_SORTS] },
        order: { type: "string", enum: ["asc", "desc"], default: "desc" },
        publishedFrom: { type: "string", maxLength: 40 },
        publishedTo: { type: "string", maxLength: 40 },
      },
      required: [],
    },
    handler: exportPanelHandler,
  },
  {
    name: "trendscope.scoring_profile",
    description:
      "什么时候用:需要向用户解释「这个分数是怎么算出来的」。返回引擎当下真正在用的权重、窗口、同组(cohort)阈值、生命周期判据、置信度扣分项、机会指数档位与当前激活的机会模型(含库里自定义模型),以及 configSnapshot 哈希。分数与口径同源,不在这里复述公式。",
    risk: "read",
    input_schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    handler: scoringProfileHandler,
  },
];

export function listAgentTools(): { name: string; description: string; input_schema: JsonSchema; risk: AgentRisk }[] {
  return AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk }));
}

/** POST /api/agent/tool 的唯一执行入口:查名字 → 按公布的 schema 校验 → 调真实能力。 */
export async function executeAgentTool(
  toolName: unknown,
  input: unknown,
  ctx: AgentContext,
): Promise<{ tool: string; risk: AgentRisk; data: unknown }> {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new AgentError(
      "bad_input",
      "请求体必须形如 {tool:\"trendscope.xxx\", input:{…}};tool 字段缺失或不是字符串。",
      "先 GET /api/agent/tools 拿准确的工具名与 input_schema。",
    );
  }
  const tool = AGENT_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    throw new AgentError(
      "unknown_tool",
      `没有名为「${toolName}」的工具。本机可用:${AGENT_TOOLS.map((t) => t.name).join(", ")}`,
      "工具名带 trendscope. 前缀,清单来自 GET /api/agent/tools。",
    );
  }
  const parsed = validateAgentInput(tool.input_schema, input);
  // 服务层抛的业务错误(带 status)在这里折算成契约 code:话题不存在该是 not_found/404,
  // AI 未配置该是 not_configured/409,而不是全成一锅 internal_error/500。
  let data: unknown;
  try {
    data = await tool.handler(parsed, ctx);
  } catch (e) {
    throw mapServiceError(e);
  }
  return { tool: tool.name, risk: tool.risk, data };
}
