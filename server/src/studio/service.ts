/**
 * Studio 编排(§17-§21、§29):取证据 → 判模式 → 生成/复用 → 落库 → 幻觉护栏。
 *
 * 关键设计:
 *  - 无凭据时**不假装是 AI**:直接返回确定性证据摘要,并明确 kind/configured。
 *  - 每次生成都记录 provider/model/prompt/schema/evidence 版本与 evidenceHash。
 *  - 失败也落库(status=failed + error),历史不覆盖。
 */
import { desc, eq, isNull, like, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { topicOpportunityCurrent, topicScoreCurrent, topics, topicStudioRuns } from "../db/schema";
import { buildEvidencePackage, type StudioEvidencePackage } from "./evidencePackage";
import { buildEvidenceBrief, type EvidenceBrief } from "./evidenceBrief";
import { defaultStudioConfig, STUDIO_PROMPT_VERSION, STUDIO_SCHEMA_VERSION, type StudioConfig } from "./config";
import { buildStudioMessages } from "./prompt";
import { OpenAICompatibleStudioProvider, type StudioProvider } from "./provider";
import { LocalCliStudioProvider, localCliCommand } from "./localCli";
import { findUnknownEvidenceRefs, findUnsupportedClaims, type StudioOutput } from "./schema";
import { findReusableRun, finishRun, insertRun, listMarks, listRuns, upsertMark, deleteMark, type StudioRunRow } from "./repository";
import { studioSettings } from "./studioSettings";

export interface StudioGenerateResponse {
  runId: number;
  status: "completed" | "failed";
  reused: boolean;
  /** AI 生成时为方案;无凭据/失败时为 null,由 UI 走证据摘要 */
  output: StudioOutput | null;
  brief: EvidenceBrief;
  evidence: StudioEvidencePackage;
  unsupportedClaims: string[];
  error: string | null;
  provider: string | null;
  model: string | null;
  durationMs: number;
}

export interface StudioView {
  brief: EvidenceBrief;
  evidence: StudioEvidencePackage;
  settings: ReturnType<typeof studioSettings>;
  versions: { promptVersion: string; schemaVersion: string; evidenceVersion: string };
  history: StudioRunView[];
}
export interface StudioRunView {
  id: number;
  topicId: number;
  status: string;
  kind: string;
  provider: string | null;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  evidenceVersion: string;
  evidenceHash: string;
  output: StudioOutput | null;
  unsupportedClaims: string[];
  error: string | null;
  demoData: boolean;
  staleEvidence: boolean;
  evidenceTruncated: Record<string, boolean> | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  durationMs: number | null;
  marks: { angleIndex: number | null; state: string; note: string | null }[];
}

function parseMaybe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toRunView(row: StudioRunRow, marks: { angleIndex: number | null; state: string; note: string | null }[] = []): StudioRunView {
  return {
    id: row.id,
    topicId: row.topicId,
    status: row.status,
    kind: row.kind,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
    evidenceVersion: row.evidenceVersion,
    evidenceHash: row.evidenceHash,
    output: parseMaybe<StudioOutput | null>(row.output, null),
    unsupportedClaims: parseMaybe<string[]>(row.unsupportedClaims, []),
    error: row.error,
    demoData: row.demoData === 1,
    staleEvidence: row.staleEvidence === 1,
    evidenceTruncated: parseMaybe<Record<string, boolean> | null>(row.evidenceTruncated, null),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    durationMs: row.durationMs === null || row.durationMs === undefined ? null : Number(row.durationMs),
    marks,
  };
}

export class StudioUserError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function requireTopic(db: DB, topicId: number) {
  const [t] = await db.select({ id: topics.id }).from(topics).where(eq(topics.id, topicId));
  if (!t) throw new StudioUserError(404, `话题不存在:#${topicId}`);
  return t;
}

/** 证据 + 确定性摘要 —— **无 AI 凭据也能完整使用**(§14/§15)。 */
export async function getStudioView(
  db: DB,
  topicId: number,
  opts: { now?: number; historyLimit?: number } = {},
): Promise<StudioView> {
  await requireTopic(db, topicId);
  const evidence = await buildEvidencePackage(db, topicId, { now: opts.now });
  if (!evidence) throw new StudioUserError(404, "话题不存在");
  const runs = await listRuns(db, topicId, opts.historyLimit ?? 10);
  const marks = await listMarks(db, topicId);
  return {
    brief: buildEvidenceBrief(evidence, opts.now),
    evidence,
    settings: studioSettings(),
    versions: {
      promptVersion: STUDIO_PROMPT_VERSION,
      schemaVersion: STUDIO_SCHEMA_VERSION,
      evidenceVersion: evidence.evidenceVersion,
    },
    history: runs.map((r) => toRunView(r, marks.filter((m) => m.runId === r.id).map((m) => ({ angleIndex: m.angleIndex, state: m.state, note: m.note })))),
  };
}

function makeProvider(overrides: Partial<StudioConfig> | undefined, configured: StudioConfig): StudioProvider {
  const cfg = { ...configured, ...(overrides ?? {}) };
  try {
    const http = new OpenAICompatibleStudioProvider(cfg);
    // 没有 Key 但设了本机 CLI:用登录态出方案。来源在工作室界面与设置页都会如实写明,
    // 不会把"本机 Claude"显示成某个外部 API 模型。
    if (!http.validateConfig().ok && localCliCommand()) return new LocalCliStudioProvider();
    return http;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 配置不合法是运维问题,不是调用方的请求问题 —— 不能伪装成 400
    throw new StudioUserError(500, `AI 服务配置不合法,请检查 STUDIO_BASE_URL / STUDIO_MODEL 等设置：${msg}`);
  }
}

export async function generateStudioPlan(
  db: DB,
  topicId: number,
  opts: {
    now?: number;
    reuse?: boolean;
    config?: Partial<StudioConfig>;
    provider?: StudioProvider;
    /** 注入点:HTTP 契约测试用 Replay Transport,生产不传。 */
    makeProvider?: () => StudioProvider;
  } = {},
): Promise<StudioGenerateResponse> {
  const started = Date.now();
  await requireTopic(db, topicId);
  const settings = studioSettings();
  const evidence = await buildEvidencePackage(db, topicId, { now: opts.now });
  if (!evidence) throw new StudioUserError(404, "话题不存在");
  const brief = buildEvidenceBrief(evidence, opts.now);

  // §16:没有凭据就不出"AI 方案"。确定性证据摘要照常返回。
  if (!settings.configured) {
    throw new StudioUserError(
      409,
      `尚未配置 AI 生成服务（缺少环境变量 ${settings.missingEnvNames.join(" / ")}）。证据摘要可正常查看,选题方案生成需要先在设置里配置。`,
    );
  }

  // §19:相同证据可复用上次成功结果;默认开启,regenerate 显式关闭。
  if (opts.reuse !== false) {
    const prior = await findReusableRun(db, topicId, evidence.evidenceHash);
    if (prior && prior.output) {
      const output = parseMaybe<StudioOutput | null>(prior.output, null);
      if (output) {
        return {
          runId: prior.id,
          status: "completed",
          reused: true,
          output,
          brief,
          evidence,
          unsupportedClaims: parseMaybe<string[]>(prior.unsupportedClaims, []),
          error: null,
          provider: prior.provider,
          model: prior.model,
          durationMs: Date.now() - started,
        };
      }
    }
  }

  const provider =
    opts.provider ?? opts.makeProvider?.() ?? makeProvider(opts.config, defaultStudioConfig());

  const run = await insertRun(db, {
    topicId,
    kind: "ai",
    provider: provider.metadata.providerId,
    model: provider.metadata.model,
    promptVersion: provider.metadata.promptVersion,
    schemaVersion: provider.metadata.schemaVersion,
    evidenceVersion: evidence.evidenceVersion,
    evidenceHash: evidence.evidenceHash,
    inputSnapshot: JSON.stringify(evidence),
    demoData: evidence.demoData,
    staleEvidence: evidence.dataFreshness.stale,
    evidenceTruncated: JSON.stringify(evidence.evidenceTruncated),
    startedAt: new Date(started).toISOString(),
    createdAt: new Date(started).toISOString(),
  });

  try {
    const result = await provider.generate(buildStudioMessages(evidence));
    const claims = [
      ...findUnsupportedClaims(result.output, JSON.stringify(evidence)),
      ...findUnknownEvidenceRefs(result.output, new Set(evidence.evidenceIndex.map((e) => e.id))).map(
        (r) => `引用了证据包中不存在的编号「${r}」`,
      ),
    ];
    const finished = await finishRun(db, run.id, {
      status: "completed",
      output: JSON.stringify(result.output),
      unsupportedClaims: JSON.stringify(claims),
      usage: JSON.stringify(result.usage ?? {}),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
    void finished;
    return {
      runId: run.id,
      status: "completed",
      reused: false,
      output: result.output,
      brief,
      evidence,
      unsupportedClaims: claims,
      error: null,
      provider: provider.metadata.providerId,
      model: provider.metadata.model,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Secret 绝不入库/入日志:ConnectorError 的 details 只带 schema 摘要,不含头部
    await finishRun(db, run.id, {
      status: "failed",
      error: msg.slice(0, 500),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
    throw new StudioUserError(502, `AI 生成失败：${msg}`);
  }
}

export interface StudioTopicRow {
  topicId: number;
  name: string;
  status: string;
  namingSource: string;
  memberCount: number;
  updatedAt: string;
  opportunityScore: number | null;
  opportunityLevel: string | null;
  opportunityConfidence: string | null;
  trendScore: number | null;
  lifecycle: string | null;
  lastRunAt: string | null;
  runCount: number;
}

/** §23 话题选择器:机会 / 趋势 / 最近更新三种排序,不做"推荐话题"。 */
export async function listStudioTopics(
  db: DB,
  opts: { sort?: "opportunity" | "trend" | "recent"; limit?: number; search?: string; now?: number } = {},
): Promise<StudioTopicRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.search?.trim()
    ? or(like(topics.name, `%${opts.search.trim()}%`), like(topics.description, `%${opts.search.trim()}%`))
    : undefined;
  const order =
    opts.sort === "trend"
      ? [isNull(topicScoreCurrent.score), desc(topicScoreCurrent.score), desc(topics.updatedAt)]
      : opts.sort === "recent"
        ? [desc(topics.updatedAt)]
        : [isNull(topicOpportunityCurrent.score), desc(topicOpportunityCurrent.score), desc(topics.updatedAt)];
  const rows = await db
    .select({
      topicId: topics.id,
      name: topics.name,
      status: topics.status,
      namingSource: topics.namingSource,
      memberCount: topics.memberCount,
      updatedAt: topics.updatedAt,
      opportunityScore: topicOpportunityCurrent.score,
      opportunityLevel: topicOpportunityCurrent.opportunityLevel,
      opportunityConfidence: topicOpportunityCurrent.confidence,
      trendScore: topicScoreCurrent.score,
      lifecycle: topicScoreCurrent.lifecycle,
    })
    .from(topics)
    .leftJoin(topicOpportunityCurrent, eq(topicOpportunityCurrent.topicId, topics.id))
    .leftJoin(topicScoreCurrent, eq(topicScoreCurrent.topicId, topics.id))
    .where(where)
    .orderBy(...order)
    .limit(limit);

  const runAgg = await db
    .select({
      topicId: topicStudioRuns.topicId,
      lastRunAt: sql<string | null>`max(${topicStudioRuns.startedAt})`,
      runCount: sql<number>`count(*)`,
    })
    .from(topicStudioRuns)
    .groupBy(topicStudioRuns.topicId);
  const byTopic = new Map(runAgg.map((r) => [Number(r.topicId), r]));

  return rows.map((r) => {
    const agg = byTopic.get(r.topicId);
    return {
      ...r,
      opportunityScore: r.opportunityScore === null || r.opportunityScore === undefined ? null : Number(r.opportunityScore),
      trendScore: r.trendScore === null || r.trendScore === undefined ? null : Number(r.trendScore),
      memberCount: Number(r.memberCount ?? 0),
      lastRunAt: agg?.lastRunAt ?? null,
      runCount: Number(agg?.runCount ?? 0),
    };
  });
}

/** §21 人工状态:与生成结果分离存放,不改写历史。 */
export async function saveStudioMark(
  db: DB,
  input: { runId: number; angleIndex: number | null; state: string; note: string | null },
): Promise<{ id: number; runId: number; topicId: number; angleIndex: number | null; state: string; note: string | null }> {
  const [run] = await db
    .select({ id: topicStudioRuns.id, topicId: topicStudioRuns.topicId, output: topicStudioRuns.output })
    .from(topicStudioRuns)
    .where(eq(topicStudioRuns.id, input.runId));
  if (!run) throw new StudioUserError(404, `生成记录不存在:#${input.runId}`);
  if (input.angleIndex !== null) {
    const out = parseMaybe<StudioOutput | null>(run.output, null);
    const n = out?.recommendedAngles.length ?? 0;
    if (input.angleIndex < 0 || input.angleIndex >= n) {
      throw new StudioUserError(400, `角度序号越界:${input.angleIndex}(本次方案共 ${n} 个角度)`);
    }
  }
  if (input.state === "none") {
    await deleteMark(db, { runId: input.runId, angleIndex: input.angleIndex });
    return { id: 0, runId: input.runId, topicId: run.topicId, angleIndex: input.angleIndex, state: "none", note: null };
  }
  const row = await upsertMark(db, {
    runId: input.runId,
    topicId: run.topicId,
    angleIndex: input.angleIndex,
    state: input.state,
    note: input.note,
    now: new Date().toISOString(),
  });
  return {
    id: row.id,
    runId: row.runId,
    topicId: row.topicId,
    angleIndex: row.angleIndex,
    state: row.state,
    note: row.note,
  };
}

export async function listStudioMarks(db: DB, topicId: number) {
  const rows = await listMarks(db, topicId);
  return rows.map((m) => ({
    id: m.id,
    runId: m.runId,
    topicId: m.topicId,
    angleIndex: m.angleIndex,
    state: m.state,
    note: m.note,
    updatedAt: m.updatedAt,
  }));
}

