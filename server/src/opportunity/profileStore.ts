/**
 * Opportunity Profile 治理层(Stage 9.5 §23-§30/§38/§41/§42/§75)。
 *
 * 不变量,按 spec 硬规则实现:
 *  - 已存版本不可原地修改:没有任何 UPDATE 权重/参数的路径,只有 createVersion(§24/§25)。
 *  - 当前模型唯一:uq_profile_single_active 部分唯一索引兜底,代码里先清零再置一(§29/§30)。
 *  - 归档而非删除:被历史 Snapshot 引用的版本永远可读(§42/§41)。
 *  - 权重保存时归一化,全 0 拒绝(§32/§33);校验全部在服务端 Zod(§38)。
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "../db/client";
import { opportunityProfiles, topicOpportunitySnapshots, opportunityRuns } from "../db/schema";
import {
  BALANCED_PROFILE,
  OPPORTUNITY_PROFILES,
  type OpportunityProfile,
} from "./profiles";

export type ProfileRow = typeof opportunityProfiles.$inferSelect;

export const WEIGHT_KEYS = ["trend", "burst", "novelty", "whitespace", "pattern", "lifecycle"] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

export const LIFECYCLE_KEYS = [
  "emerging",
  "rising",
  "peak",
  "saturated",
  "declining",
  "evergreen",
  "unknown",
] as const;

const nonNegative = z.number().finite().min(0);
/** 生命周期适配值是 0-100 的透明映射;null = 该阶段无映射(数据不足时组件转 unknown) */
const fitValue = z.number().finite().min(0).max(100).nullable();

export const profileDraftSchema = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").max(60),
    description: z.string().trim().max(200).nullish(),
    weights: z
      .object({
        trend: nonNegative,
        burst: nonNegative,
        novelty: nonNegative,
        whitespace: nonNegative,
        pattern: nonNegative,
        lifecycle: nonNegative,
      })
      .refine((w) => WEIGHT_KEYS.some((k) => w[k] > 0), {
        message: "权重不能全部为 0",
        path: ["weights"],
      }),
    minimumEvidence: z.object({ minimumAvailableComponents: z.number().int().min(1).max(6) }),
    lifecycleFit: z
      .object({
        emerging: fitValue,
        rising: fitValue,
        peak: fitValue,
        saturated: fitValue,
        declining: fitValue,
        evergreen: fitValue,
        unknown: fitValue,
      })
      .refine((v) => LIFECYCLE_KEYS.some((k) => v[k] !== null), {
        message: "生命周期适配至少保留一个阶段",
      }),
    freshness: z.object({
      /** §34:单位是小时,不让用户填毫秒 */
      trendMaxAgeHours: z.number().int().min(1).max(24 * 90),
      intelligenceMaxAgeHours: z.number().int().min(1).max(24 * 90),
      penaltyStale: z.number().finite().min(0).max(1),
    }),
  })
  .strict();

export type ProfileDraft = z.infer<typeof profileDraftSchema>;

/** §32:任意非负权重 → 保存时归一化;总和恒为 1(与引擎的 missing-aware 重归一同一约定)。 */
export function normalizeWeights(weights: Record<WeightKey, number>): Record<WeightKey, number> {
  const sum = WEIGHT_KEYS.reduce((a, k) => a + weights[k], 0);
  if (!(sum > 0)) return weights;
  const out = {} as Record<WeightKey, number>;
  for (const k of WEIGHT_KEYS) out[k] = Math.round((weights[k] / sum) * 1e6) / 1e6;
  // 归一化后的舍入误差补到最大的一项,保证总和恰好为 1
  const drift = 1 - WEIGHT_KEYS.reduce((a, k) => a + out[k], 0);
  if (Math.abs(drift) > 1e-9) {
    const biggest = WEIGHT_KEYS.reduce((a, k) => (out[k] > out[a] ? k : a), WEIGHT_KEYS[0]);
    out[biggest] = Math.round((out[biggest] + drift) * 1e6) / 1e6;
  }
  return out;
}

export function sameProfileShape(a: ProfileRow, draftWeights: Record<WeightKey, number>, draft: ProfileDraft): boolean {
  const fresh = buildRowFields(draftWeights, draft);
  return (
    a.weightsJson === fresh.weightsJson &&
    a.freshnessJson === fresh.freshnessJson &&
    a.minimumEvidenceJson === fresh.minimumEvidenceJson &&
    a.lifecycleFitJson === fresh.lifecycleFitJson &&
    a.name === draft.name.trim() &&
    (a.description ?? "") === (draft.description?.trim() ?? "")
  );
}

function buildRowFields(weights: Record<WeightKey, number>, draft: ProfileDraft) {
  return {
    weightsJson: JSON.stringify(weights),
    freshnessJson: JSON.stringify(draft.freshness),
    minimumEvidenceJson: JSON.stringify(draft.minimumEvidence),
    lifecycleFitJson: JSON.stringify(draft.lifecycleFit),
  };
}

function nextVersion(profileKey: string, existing: ProfileRow[]): string {
  const prefix = `${profileKey.toUpperCase()}_V`;
  let max = 0;
  for (const r of existing) {
    if (r.version.startsWith(prefix)) {
      const n = Number(r.version.slice(prefix.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${max + 1}`;
}

export function rowToProfile(row: ProfileRow): OpportunityProfile {
  const base = BALANCED_PROFILE;
  const tuning = safeParse(row.tuningJson, {
    levelBands: base.levelBands,
    confidence: base.confidence,
    burstMix: base.burstMix,
    recentBurstWindowHours: base.recentBurstWindowHours,
  }) as {
    levelBands?: OpportunityProfile["levelBands"];
    confidence?: OpportunityProfile["confidence"];
    burstMix?: OpportunityProfile["burstMix"];
    recentBurstWindowHours?: number;
  };
  return {
    ...base,
    id: row.profileKey,
    label: row.name,
    version: row.version,
    weights: safeParse(row.weightsJson, base.weights),
    minimumAvailableComponents: safeParse(row.minimumEvidenceJson, { minimumAvailableComponents: 3 })
      .minimumAvailableComponents,
    levelBands: tuning.levelBands ?? base.levelBands,
    lifecycleFit: safeParse(row.lifecycleFitJson, base.lifecycleFit),
    freshness: safeParse(row.freshnessJson, base.freshness),
    confidence: tuning.confidence ?? base.confidence,
    burstMix: tuning.burstMix ?? base.burstMix,
    recentBurstWindowHours: tuning.recentBurstWindowHours ?? base.recentBurstWindowHours,
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    const v = JSON.parse(raw) as T;
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function listProfileRows(db: DB): Promise<ProfileRow[]> {
  return db.select().from(opportunityProfiles).orderBy(sql`${opportunityProfiles.profileKey}`, sql`${opportunityProfiles.id}`);
}

export async function getProfileRow(db: DB, id: number): Promise<ProfileRow | null> {
  const [row] = await db.select().from(opportunityProfiles).where(eq(opportunityProfiles.id, id));
  return row ?? null;
}

export class ProfileError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 当前模型 → 引擎参数。运行入口必须走这里,保证"Active Profile 决定之后的新 Run"(§29/§30)。 */
export async function resolveActiveProfile(db: DB): Promise<OpportunityProfile> {
  const [row] = await db
    .select()
    .from(opportunityProfiles)
    .where(and(eq(opportunityProfiles.isActive, 1), eq(opportunityProfiles.status, "active")));
  if (!row) {
    throw new ProfileError(500, "没有可用的当前机会模型(opportunity_profiles 缺 active 行)");
  }
  return rowToProfile(row);
}

export async function resolveProfileByKey(db: DB, key: string): Promise<OpportunityProfile> {
  const rows = await db
    .select()
    .from(opportunityProfiles)
    .where(and(eq(opportunityProfiles.profileKey, key), eq(opportunityProfiles.status, "active")))
    .orderBy(sql`${opportunityProfiles.id} DESC`)
    .limit(1);
  if (!rows[0]) {
    // 代码内置 profile 在迁移前就已存在,保留只读回退,避免历史 profileId 请求直接失败
    const builtin = OPPORTUNITY_PROFILES[key as keyof typeof OPPORTUNITY_PROFILES];
    if (builtin) return builtin;
    throw new ProfileError(404, `机会模型不存在:${key}`);
  }
  return rowToProfile(rows[0]);
}

/** §41:每个版本被多少 Run / Snapshot 使用 —— 这是"不可修改"的证据。 */
export async function profileUsage(db: DB, row: ProfileRow): Promise<{ runs: number; snapshots: number }> {
  const [r] = await db
    .select({ n: sql<number>`count(*)` })
    .from(opportunityRuns)
    .where(and(eq(opportunityRuns.profileId, row.profileKey), eq(opportunityRuns.profileVersion, row.version)));
  const [s] = await db
    .select({ n: sql<number>`count(*)` })
    .from(topicOpportunitySnapshots)
    .where(
      and(
        eq(topicOpportunitySnapshots.profileId, row.profileKey),
        eq(topicOpportunitySnapshots.profileVersion, row.version),
      ),
    );
  return { runs: Number(r?.n ?? 0), snapshots: Number(s?.n ?? 0) };
}

export interface ProfileView {
  id: number;
  profileKey: string;
  name: string;
  description: string | null;
  version: string;
  status: string;
  isActive: boolean;
  weights: Record<WeightKey, number>;
  freshness: OpportunityProfile["freshness"];
  minimumEvidence: { minimumAvailableComponents: number };
  lifecycleFit: Record<string, number | null>;
  levelBands: OpportunityProfile["levelBands"];
  createdAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
  createdFromProfileId: number | null;
  usage: { runs: number; snapshots: number };
  /** §46:与同 key 上一版本的差异(首个版本为 null) */
  diff: Record<string, { from: unknown; to: unknown }> | null;
}

function viewOf(row: ProfileRow, prev: ProfileRow | null, usage: { runs: number; snapshots: number }): ProfileView {
  return {
    id: row.id,
    profileKey: row.profileKey,
    name: row.name,
    description: row.description,
    version: row.version,
    status: row.status,
    isActive: row.isActive === 1,
    weights: safeParse(row.weightsJson, BALANCED_PROFILE.weights),
    freshness: safeParse(row.freshnessJson, BALANCED_PROFILE.freshness),
    minimumEvidence: safeParse(row.minimumEvidenceJson, { minimumAvailableComponents: 3 }),
    lifecycleFit: safeParse(row.lifecycleFitJson, BALANCED_PROFILE.lifecycleFit),
    levelBands: rowToProfile(row).levelBands,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    archivedAt: row.archivedAt,
    createdFromProfileId: row.createdFromProfileId,
    usage,
    diff: prev ? diffOf(prev, row) : null,
  };
}

export function diffOf(prev: ProfileRow, next: ProfileRow): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const pw = safeParse(prev.weightsJson, BALANCED_PROFILE.weights);
  const nw = safeParse(next.weightsJson, BALANCED_PROFILE.weights);
  for (const k of WEIGHT_KEYS) {
    if (pw[k] !== nw[k]) out[k] = { from: pw[k], to: nw[k] };
  }
  if (prev.freshnessJson !== next.freshnessJson) {
    out.freshness = {
      from: safeParse(prev.freshnessJson, BALANCED_PROFILE.freshness),
      to: safeParse(next.freshnessJson, BALANCED_PROFILE.freshness),
    };
  }
  if (prev.minimumEvidenceJson !== next.minimumEvidenceJson) {
    out.minimumEvidence = {
      from: safeParse(prev.minimumEvidenceJson, { minimumAvailableComponents: 3 }),
      to: safeParse(next.minimumEvidenceJson, { minimumAvailableComponents: 3 }),
    };
  }
  if (prev.lifecycleFitJson !== next.lifecycleFitJson) {
    out.lifecycleFit = {
      from: safeParse(prev.lifecycleFitJson, BALANCED_PROFILE.lifecycleFit),
      to: safeParse(next.lifecycleFitJson, BALANCED_PROFILE.lifecycleFit),
    };
  }
  return out;
}

export async function listProfiles(db: DB): Promise<ProfileView[]> {
  const rows = await listProfileRows(db);
  const out: ProfileView[] = [];
  for (const row of rows) {
    const prev = rows
      .filter((x) => x.profileKey === row.profileKey && x.id < row.id)
      .sort((a, b) => b.id - a.id)[0];
    out.push(viewOf(row, prev ?? null, await profileUsage(db, row)));
  }
  return out;
}

export async function getProfileView(db: DB, id: number): Promise<ProfileView | null> {
  const row = await getProfileRow(db, id);
  if (!row) return null;
  const all = await listProfileRows(db);
  const prev = all
    .filter((x) => x.profileKey === row.profileKey && x.id < row.id)
    .sort((a, b) => b.id - a.id)[0];
  return viewOf(row, prev ?? null, await profileUsage(db, row));
}

/** §24:改参数 = 新建版本,永不原地改。§75:与最新版本完全相同的草稿不再重复建版本。 */
export async function createVersion(db: DB, baseId: number, draft: ProfileDraft): Promise<{ row: ProfileRow; created: boolean }> {
  const base = await getProfileRow(db, baseId);
  if (!base) throw new ProfileError(404, `机会模型不存在:#${baseId}`);
  const rows = await listProfileRows(db);
  const sameKey = rows.filter((r) => r.profileKey === base.profileKey);
  const latest = sameKey.sort((a, b) => b.id - a.id)[0];

  const weights = normalizeWeights(draft.weights);
  if (latest && sameProfileShape(latest, weights, draft)) {
    return { row: latest, created: false }; // 幂等:同一份草稿快速重复提交不产生多个相同版本
  }
  const now = new Date().toISOString();
  const fields = buildRowFields(weights, draft);
  const [created] = await db
    .insert(opportunityProfiles)
    .values({
      profileKey: latest.profileKey,
      name: draft.name.trim(),
      description: draft.description?.trim() ?? null,
      version: nextVersion(latest.profileKey, sameKey),
      status: "active",
      isActive: 0,
      ...fields,
      tuningJson: latest.tuningJson,
      createdFromProfileId: latest.id,
      createdAt: now,
    })
    .returning();
  return { row: created, created: true };
}

/** §28:复制为新 profile(新 key),不预设一堆模板。 */
export async function createProfile(
  db: DB,
  draft: ProfileDraft & { profileKey: string },
): Promise<{ row: ProfileRow; created: boolean }> {
  const key = draft.profileKey.trim();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) {
    throw new ProfileError(400, "模型标识只能用小写字母、数字与下划线,且以字母开头");
  }
  const rows = await listProfileRows(db);
  const existing = rows.filter((r) => r.profileKey === key);
  const weights = normalizeWeights(draft.weights);
  if (existing.length > 0) {
    const latest = existing.sort((a, b) => b.id - a.id)[0];
    if (sameProfileShape(latest, weights, draft)) return { row: latest, created: false };
    const now = new Date().toISOString();
    const [row] = await db
      .insert(opportunityProfiles)
      .values({
        profileKey: key,
        name: draft.name.trim(),
        description: draft.description?.trim() ?? null,
        version: nextVersion(key, existing),
        status: "active",
        isActive: 0,
        ...buildRowFields(weights, draft),
        tuningJson: latest.tuningJson,
        createdFromProfileId: latest.id,
        createdAt: now,
      })
      .returning();
    return { row, created: true };
  }
  const source = rows.find((r) => r.isActive === 1) ?? rows[0];
  const now = new Date().toISOString();
  const [row] = await db
    .insert(opportunityProfiles)
    .values({
      profileKey: key,
      name: draft.name.trim(),
      description: draft.description?.trim() ?? null,
      version: nextVersion(key, []),
      status: "active",
      isActive: 0,
      ...buildRowFields(weights, draft),
      tuningJson: source?.tuningJson ?? JSON.stringify({}),
      createdFromProfileId: source?.id ?? null,
      createdAt: now,
    })
    .returning();
  return { row, created: true };
}

/** §29/§30:激活只影响之后的新 Run;旧 Snapshot 指向旧版本,保持不变。 */
export async function activateProfile(db: DB, id: number): Promise<ProfileRow> {
  const row = await getProfileRow(db, id);
  if (!row) throw new ProfileError(404, `机会模型不存在:#${id}`);
  if (row.status !== "active") throw new ProfileError(409, "已归档的模型不能设为当前模型");
  const now = new Date().toISOString();
  // 先清零再置一:部分唯一索引 uq_profile_single_active 保证任何时刻最多一个当前模型
  await db.update(opportunityProfiles).set({ isActive: 0 }).where(eq(opportunityProfiles.isActive, 1));
  const [updated] = await db
    .update(opportunityProfiles)
    .set({ isActive: 1, activatedAt: now })
    .where(eq(opportunityProfiles.id, id))
    .returning();
  return updated;
}

/** §42:归档,不物理删除。当前模型必须先切走。 */
export async function archiveProfile(db: DB, id: number): Promise<ProfileRow> {
  const row = await getProfileRow(db, id);
  if (!row) throw new ProfileError(404, `机会模型不存在:#${id}`);
  if (row.isActive === 1) throw new ProfileError(409, "请先切换到其它当前模型,再归档这一份");
  if (row.status === "archived") return row;
  const [updated] = await db
    .update(opportunityProfiles)
    .set({ status: "archived", isActive: 0, archivedAt: new Date().toISOString() })
    .where(eq(opportunityProfiles.id, id))
    .returning();
  return updated;
}

/** §27:恢复默认 = 把编辑中的草稿换回系统默认,不动任何已存版本。 */
export function defaultDraft(): ProfileDraft {
  return {
    name: BALANCED_PROFILE.label,
    description: "默认分析偏好:六组件加权量化当前可研究程度,不预测未来结果",
    weights: { ...BALANCED_PROFILE.weights },
    minimumEvidence: { minimumAvailableComponents: BALANCED_PROFILE.minimumAvailableComponents },
    // BALANCED_PROFILE.lifecycleFit 声明为 Record<string, …>,但七个阶段键都在
    lifecycleFit: { ...BALANCED_PROFILE.lifecycleFit } as ProfileDraft["lifecycleFit"],
    freshness: { ...BALANCED_PROFILE.freshness },
  };
}
