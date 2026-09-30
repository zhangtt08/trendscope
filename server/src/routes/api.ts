/**
 * HTTP API — Stage 1 base + Stage 2 additions:
 *   /api/health, /api/import/batches/:id (failed rows), /api/duplicates*,
 *   enhanced previews (dry-run valid/invalid + timezone default).
 * All handlers return JSON; errors are structured, never a white screen.
 */
import express from "express";
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { isDemoMode } from "../db/client";
import { importBatches, rawRecords, duplicateCandidates, contentItems } from "../db/schema";
import { runImport, startBatch, type ImportSummary } from "../services/importService";
import { parseCsv, CSVAdapter } from "../adapters/csv";
import {
  parseJsonPayload,
  detectJsonMapping,
  JSONAdapter,
} from "../adapters/json";
import { ManualAdapter, ManualInputSchema } from "../adapters/manual";
import { FixtureAdapter, listFixtures, loadFixture } from "../adapters/fixture";
import type { NormalizeContext } from "../adapters/types";
import { queryContent, parseContentQuery, getContentDetail } from "../services/queryService";
import { getDashboardStats } from "../services/statsService";
import { getDataHealth } from "../services/healthService";
import {
  getTrendOverview,
  getMomentumList,
  getItemTrendSeries,
} from "../services/trendService";
import { listPicks, setPick, removePick, SetPickSchema } from "../services/topicService";
import {
  listCandidates,
  getCandidate,
  resolveCandidate,
  type ResolveAction,
} from "../services/duplicateService";
import { computeFingerprint } from "../domain/fingerprint";
import { canonicalizeUrl } from "../domain/url";
import { PLATFORM_TIMEZONES, isValidTimezone } from "../domain/timezone";
import { LIMITS } from "../domain/constants";
import { z } from "zod";
import { describeZod } from "./errors";
import { zodIssueLines } from "../domain/zodMessage";

const csvAdapter = new CSVAdapter();
const jsonAdapter = new JSONAdapter();
const manualAdapter = new ManualAdapter();
const fixtureAdapter = new FixtureAdapter();

/** Short-lived in-memory upload cache so preview → import doesn't re-upload. */
const uploadCache = new Map<
  string,
  { kind: "csv" | "json"; filename?: string; content: string; ts: number }
>();
const UPLOAD_TTL_MS = 15 * 60 * 1000;

export function createApiRouter(
  db: DB,
  /**
   * 用户把自己手里的数据喂进库(CSV / JSON / 手工录入)后的挂点。
   * 与采集运行结束用的同一个"采完即算"规则:不补一次分析,话题排名就是旧的,
   * 报告页会把过期的数字当真话讲。由 index.ts 装配;不装配则完全惰性(单测不受影响)。
   */
  onImported?: (summary: ImportSummary) => void,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "14mb" }));

  const respondImport = (res: express.Response, summary: ImportSummary) => {
    if (summary.imported > 0) onImported?.(summary);
    res.json(collapseSummary(summary));
  };

  // ---- dashboard ----
  router.get("/stats", async (_req, res) => {
    try {
      res.json(await getDashboardStats(db));
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- data health (Stage 2 §21/22) ----
  router.get("/health", async (_req, res) => {
    try {
      res.json(await getDataHealth(db));
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- content queries ----
  router.get("/content", async (req, res) => {
    try {
      const q = parseContentQuery(req.query as Record<string, unknown>);
      res.json(await queryContent(db, q));
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/content/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "ID 无效" });
      }
      const detail = await getContentDetail(db, id);
      if (!detail) return res.status(404).json({ error: "内容不存在" });
      res.json(detail);
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- import history ----
  router.get("/import/batches", async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(importBatches)
        .orderBy(desc(importBatches.startedAt))
        .limit(100);
      res.json({ rows });
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- import batch detail incl. failed rows (Stage 2 §19) ----
  router.get("/import/batches/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "ID 无效" });
      }
      const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, id));
      if (!batch) return res.status(404).json({ error: "导入批次不存在" });

      const failedRows = (
        await db
          .select()
          .from(rawRecords)
          .where(eq(rawRecords.importBatchId, id))
          .orderBy(rawRecords.id)
      )
        .filter((r) => r.note !== null)
        .map((r) => ({
          id: r.id,
          rowIndex: r.rowIndex,
          note: r.note,
          payloadPreview: previewPayload(r.payload),
        }));

      const candidates = await db
        .select({
          id: duplicateCandidates.id,
          a: duplicateCandidates.contentItemA,
          b: duplicateCandidates.contentItemB,
          status: duplicateCandidates.status,
        })
        .from(duplicateCandidates)
        .where(sql`${duplicateCandidates.createdAt} >= ${batch.startedAt}`);

      res.json({ batch, failedRows, candidatesCreated: candidates.length });
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- duplicate governance (Stage 2 §11-15) ----
  router.get("/duplicates", async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : null;
      res.json({ rows: await listCandidates(db, status) });
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/duplicates/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const candidate = await getCandidate(db, id);
      if (!candidate) return res.status(404).json({ error: "疑似重复候选不存在" });
      res.json(candidate);
    } catch (e) {
      serverError(res, e);
    }
  });

  router.post("/duplicates/:id/resolve", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = z
        .object({ action: z.enum(["confirm", "not_duplicate", "ignore"]) })
        .safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "action 取值必须是 confirm / not_duplicate / ignore" });
      const result = await resolveCandidate(db, id, body.data.action as ResolveAction);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- CSV: preview (upload → detected fields + dry-run estimates) ----
  router.post("/import/csv/preview", (req, res) => {
    try {
      const body = CsvUploadSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: describeZod(body.error) });
      }
      const { filename, content, sourceTimezone } = body.data;
      const sizeErr = checkSize(content, filename);
      if (sizeErr) return res.status(413).json({ error: sizeErr });
      const utf8Err = checkUtf8(content);
      if (utf8Err) return res.status(400).json({ error: utf8Err });
      if (content.trim().length === 0) {
        return res.status(400).json({ error: "文件为空" });
      }

      const parsed = parseCsv(content, true);
      if (parsed.headers.length === 0) {
        return res.status(400).json({ error: "无法解析 CSV 表头（文件可能不是有效的 CSV）" });
      }
      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      cacheUpload(uploadId, { kind: "csv", filename, content });

      const full = parseCsv(content);
      const ctx: NormalizeContext = {
        sourceType: "csv",
        mapping: parsed.detectedMapping,
        platformOverride: null,
        sourceTimezone: resolveTimezone(sourceTimezone, null),
        tzProvenance: sourceTimezone ? "user_selected" : "adapter_default",
      };
      res.json({
        uploadId,
        filename,
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, LIMITS.previewRows),
        detectedMapping: parsed.detectedMapping,
        parseWarnings: parsed.errors.slice(0, 10),
        ...dryRun(csvAdapter, full.rows, ctx),
      });
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- CSV: real import ----
  router.post("/import/csv", async (req, res) => {
    try {
      const parsed = CsvImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: describeZod(parsed.error) });
      }
      const { uploadId, content, filename, mapping, platformOverride, sourceTimezone } = parsed.data;
      const resolved =
        (uploadId && uploadCache.get(uploadId)) ||
        (content ? { kind: "csv" as const, content, filename: filename ?? "upload.csv" } : null);
      if (!resolved) return res.status(400).json({ error: "缺少文件内容或 uploadId 已过期，请重新上传" });

      const full = parseCsv(resolved.content);
      if (full.headers.length === 0) {
        return res.status(400).json({ error: "无法解析 CSV 表头" });
      }
      if (full.rows.length === 0) {
        return res.status(400).json({ error: "文件中没有数据行" });
      }
      const tz = resolveTimezone(sourceTimezone, platformOverride ?? null);
      const ctx: NormalizeContext = {
        sourceType: "csv",
        mapping: mapping ?? full.detectedMapping,
        platformOverride: platformOverride ?? null,
        sourceTimezone: tz,
        tzProvenance: sourceTimezone ? "user_selected" : "adapter_default",
      };
      const batchId = await startBatch(db, {
        name: resolved.filename ?? "upload.csv",
        sourceType: "csv",
        platform: platformOverride ?? null,
        options: { mapping: ctx.mapping, sourceTimezone: tz },
      });
      const summary = await runImport(db, csvAdapter, full.rows, ctx, batchId);
      respondImport(res, summary);
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- JSON: preview ----
  router.post("/import/json/preview", (req, res) => {
    try {
      const body = CsvUploadSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: describeZod(body.error) });
      }
      const { content, filename, sourceTimezone } = body.data;
      const sizeErr = checkSize(content, filename);
      if (sizeErr) return res.status(413).json({ error: sizeErr });
      if (content.trim().length === 0) return res.status(400).json({ error: "文件为空" });

      let rows: unknown[];
      try {
        rows = parseJsonPayload(content);
      } catch (e) {
        return res.status(400).json({
          error: e instanceof Error ? e.message : "JSON 解析失败",
        });
      }
      const detectedMapping = detectJsonMapping(rows);
      const uploadId = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      cacheUpload(uploadId, { kind: "json", filename, content });

      const objectRows = rows.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
      );
      const ctx: NormalizeContext = {
        sourceType: "json",
        mapping: detectedMapping,
        platformOverride: null,
        sourceTimezone: resolveTimezone(sourceTimezone, null),
        tzProvenance: sourceTimezone ? "user_selected" : "adapter_default",
      };
      res.json({
        uploadId,
        filename,
        // 与 CSV preview 同一份契约:前端 MappingEditor 依赖 headers,
        // 缺了它 JSON 导入的字段映射界面会直接抛 TypeError 白屏。
        headers: [...new Set(objectRows.flatMap((r) => Object.keys(r)))],
        totalRows: rows.length,
        sampleRows: objectRows.slice(0, LIMITS.previewRows),
        detectedMapping,
        ...dryRun(jsonAdapter, objectRows, ctx),
      });
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- JSON: import ----
  router.post("/import/json", async (req, res) => {
    try {
      const parsed = CsvImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: describeZod(parsed.error) });
      }
      const { uploadId, content, filename, mapping, platformOverride, sourceTimezone } = parsed.data;
      const resolved =
        (uploadId && uploadCache.get(uploadId)) ||
        (content ? { kind: "json" as const, content, filename: filename ?? "upload.json" } : null);
      if (!resolved) return res.status(400).json({ error: "缺少文件内容或 uploadId 已过期，请重新上传" });

      let rows: unknown[];
      try {
        rows = parseJsonPayload(resolved.content);
      } catch (e) {
        return res.status(400).json({ error: e instanceof Error ? e.message : "JSON 解析失败" });
      }
      const objectRows = rows.filter(
        (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
      );
      const tz = resolveTimezone(sourceTimezone, platformOverride ?? null);
      const ctx: NormalizeContext = {
        sourceType: "json",
        mapping: mapping ?? detectJsonMapping(rows),
        platformOverride: platformOverride ?? null,
        sourceTimezone: tz,
        tzProvenance: sourceTimezone ? "user_selected" : "adapter_default",
      };
      const batchId = await startBatch(db, {
        name: resolved.filename ?? "upload.json",
        sourceType: "json",
        platform: platformOverride ?? null,
        options: { mapping: ctx.mapping, sourceTimezone: tz },
      });
      const summary = await runImport(db, jsonAdapter, objectRows, ctx, batchId);
      respondImport(res, summary);
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- Manual add ----
  router.post("/import/manual", async (req, res) => {
    try {
      const body = ManualInputSchema.extend({
        sourceTimezone: z.string().nullish(),
      }).safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({
          error: `表单校验失败: ${zodIssueLines(body.error)}`,
        });
      }
      const { sourceTimezone, ...manualInput } = body.data;
      const tz = resolveTimezone(sourceTimezone, manualInput.platform);
      const batchId = await startBatch(db, {
        name: `manual-${new Date().toISOString().slice(0, 19)}`,
        sourceType: "manual",
        platform: manualInput.platform,
        options: { sourceTimezone: tz },
      });
      const summary = await runImport(
        db,
        manualAdapter,
        [manualInput],
        { sourceType: "manual", sourceTimezone: tz, tzProvenance: "user_selected" },
        batchId,
      );
      respondImport(res, summary);
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- Fixtures ----
  router.get("/fixtures", async (_req, res) => {
    try {
      res.json({ fixtures: listFixtures() });
    } catch (e) {
      serverError(res, e);
    }
  });

  router.post("/import/fixture", async (req, res) => {
    try {
      const body = z.object({ file: z.string().min(1) }).safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "缺少 fixture 文件名" });
      let env;
      try {
        env = loadFixture(body.data.file);
      } catch (e) {
        return res.status(400).json({
          error: `fixture 无法加载: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      const tz =
        env.sourceTimezone && isValidTimezone(env.sourceTimezone)
          ? env.sourceTimezone
          : (PLATFORM_TIMEZONES[env.platform] ?? "Asia/Shanghai");
      const ctx: NormalizeContext = {
        sourceType: "fixture",
        mapping: env.mapping ?? undefined,
        platformOverride: env.platform,
        sourceTimezone: tz,
        tzProvenance: "adapter_default",
      };
      // 守卫:示例数据只能进演示库,进正式库必须带显式确认。
      // 真实事故:/api/demo/load 有这条守卫,而这里没有 —— 结果一次示例导入把 5350 条
      // fixture 写进了使用者的正式库。两个入口的口径必须一致。
      if (!isDemoMode() && (req.body as { confirm?: unknown })?.confirm !== "LOAD_SAMPLE_INTO_CURRENT_DB") {
        return res.status(409).json({
          error:
            "当前不是演示库。要把示例数据写进这个库,请显式确认(confirm: LOAD_SAMPLE_INTO_CURRENT_DB)——"
            + "示例数据不能冒充真实热门内容,界面会把它标为演示来源。",
        });
      }
      const batchId = await startBatch(db, {
        name: `示例数据 · ${env.title ?? env.name}`,
        sourceType: "fixture",
        platform: env.platform,
        options: { mapping: env.mapping ?? null, sourceTimezone: tz },
      });
      const summary = await runImport(db, fixtureAdapter, env.rows, ctx, batchId);
      // 示例数据刻意不接 onImported:让演示样本去刷新话题排名,等于把假数据算成"当前热点"。
      res.json(collapseSummary(summary));
    } catch (e) {
      serverError(res, e);
    }
  });

  // ---- 404 for unknown api paths ----
  // ---- trends & topic workbench (Stage 3) ----
  router.get("/trends/overview", async (req, res) => {
    try {
      res.json(await getTrendOverview(db, req.query as Record<string, unknown>));
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/trends/momentum", async (req, res) => {
    try {
      res.json(await getMomentumList(db, req.query as Record<string, unknown>));
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/content/:id/trend", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "ID 无效" });
      }
      const series = await getItemTrendSeries(db, id);
      if (!series) return res.status(404).json({ error: "内容不存在" });
      res.json(series);
    } catch (e) {
      serverError(res, e);
    }
  });

  router.get("/picks", async (req, res) => {
    try {
      res.json(await listPicks(db, req.query as Record<string, unknown>));
    } catch (e) {
      serverError(res, e);
    }
  });

  router.post("/picks", async (req, res) => {
    try {
      const parsed = SetPickSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: describeZod(parsed.error) });
      }
      const [exists] = await db
        .select({ id: contentItems.id })
        .from(contentItems)
        .where(eq(contentItems.id, parsed.data.contentItemId))
        .limit(1);
      if (!exists) return res.status(404).json({ error: "内容不存在" });
      res.json(await setPick(db, parsed.data));
    } catch (e) {
      serverError(res, e);
    }
  });

  router.delete("/picks/:itemId", async (req, res) => {
    try {
      const id = Number(req.params.itemId);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "ID 无效" });
      }
      const removed = await removePick(db, id);
      if (!removed) return res.status(404).json({ error: "标记不存在" });
      res.json({ ok: true });
    } catch (e) {
      serverError(res, e);
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "请求的资源不存在" });
  });

  return router;
}

/** Respect explicit timezone choice; fall back to platform default / Asia/Shanghai. */
function resolveTimezone(selected: string | null | undefined, platform: string | null): string {
  if (selected && isValidTimezone(selected)) return selected;
  if (platform && PLATFORM_TIMEZONES[platform]) return PLATFORM_TIMEZONES[platform];
  return "Asia/Shanghai";
}

interface DryRunResult {
  expectedValid: number;
  expectedInvalid: number;
  expectedDuplicates: number;
  invalidSamples: { index: number; error: string }[];
  timeFields: Record<string, { formats: string[]; samples: string[] }>;
  defaultTimezone: string;
}

/** Stage 2 §18: import preview dry-run — no DB writes. */
function dryRun(
  adapter: { normalize: (row: unknown, ctx: NormalizeContext) => unknown; validateRaw: (r: unknown) => { ok: boolean; error?: string } },
  rows: Record<string, unknown>[],
  ctx: NormalizeContext,
): DryRunResult {
  let valid = 0;
  let invalid = 0;
  const invalidSamples: { index: number; error: string }[] = [];
  const fpCounts = new Map<string, number>();

  rows.forEach((row, i) => {
    try {
      const rec = adapter.normalize(row, ctx) as {
        publishedAt: string | null;
        canonicalUrl: string | null;
        url: string | null;
        title: string | null;
        authorId: string | null;
        authorName: string | null;
        platform: string;
      };
      const fp = computeFingerprint({
        platform: rec.platform,
        authorId: rec.authorId,
        authorName: rec.authorName,
        title: rec.title,
        publishedAt: rec.publishedAt,
      });
      if (fp) fpCounts.set(fp, (fpCounts.get(fp) ?? 0) + 1);
      canonicalizeUrl(rec.url);
      valid += 1;
    } catch (e) {
      invalid += 1;
      if (invalidSamples.length < 10) {
        invalidSamples.push({
          index: i + 1,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  // in-file fingerprint collisions → expected duplicates on import
  let expectedDuplicates = 0;
  for (const n of fpCounts.values()) {
    if (n > 1) expectedDuplicates += n - 1;
  }

  // time format detection on the mapped publishedAt column
  const timeFields: DryRunResult["timeFields"] = {};
  const pubKey = ctx.mapping?.publishedAt;
  if (pubKey) {
    const formats = new Set<string>();
    const samples: string[] = [];
    for (const row of rows.slice(0, 200)) {
      const v = row[pubKey];
      if (v === undefined || v === null || v === "") continue;
      const s = String(v);
      if (/^\d{9,17}$/.test(s)) formats.add("timestamp");
      else if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) formats.add("explicit_offset");
      else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(s)) formats.add("naive_datetime");
      else if (/\d{4}年/.test(s)) formats.add("中文日期");
      else formats.add("unrecognized");
      if (samples.length < 5) samples.push(s.slice(0, 40));
    }
    timeFields.publishedAt = { formats: [...formats], samples };
  }

  return {
    expectedValid: valid,
    expectedInvalid: invalid,
    expectedDuplicates,
    invalidSamples,
    timeFields,
    defaultTimezone: ctx.sourceTimezone ?? "Asia/Shanghai",
  };
}

function previewPayload(payload: string | null): string {
  if (!payload) return "—";
  try {
    const obj = JSON.parse(payload);
    return JSON.stringify(obj).slice(0, 300);
  } catch {
    return payload.slice(0, 300);
  }
}

function collapseSummary(s: {
  batchId: number;
  total: number;
  imported: number;
  duplicates: number;
  failed: number;
  rows: { status: string; error?: string; warnings?: string[] }[];
}) {
  const errors = s.rows
    .map((r, idx) => ({ r, idx }))
    .filter(({ r }) => r.status === "failed")
    .slice(0, 20)
    .map(({ r, idx }) => `行 ${idx + 1}: ${r.error}`);
  const possibleDuplicates = s.rows.filter((r) => (r.warnings?.length ?? 0) > 0).length;
  return {
    batchId: s.batchId,
    total: s.total,
    imported: s.imported,
    duplicates: s.duplicates,
    failed: s.failed,
    errors,
    possibleDuplicates,
  };
}

function checkSize(content: string, filename?: string): string | null {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LIMITS.maxFileBytes) {
    return `文件过大: ${(bytes / 1024 / 1024).toFixed(1)} MB（上限 ${
      LIMITS.maxFileBytes / 1024 / 1024
    } MB）${filename ? ` — ${filename}` : ""}`;
  }
  return null;
}

function checkUtf8(content: string): string | null {
  try {
    const bytes = Buffer.from(content, "utf8");
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null;
  } catch {
    return "文件包含无效的 UTF-8 编码";
  }
}

function cacheUpload(uploadId: string, entry: { kind: "csv" | "json"; filename?: string; content: string }) {
  const now = Date.now();
  for (const [k, v] of uploadCache) {
    if (now - v.ts > UPLOAD_TTL_MS) uploadCache.delete(k);
  }
  uploadCache.set(uploadId, { ...entry, ts: now });
}

const CsvUploadSchema = z.object({
  content: z.string().max(LIMITS.maxFileBytes + 1024),
  filename: z.string().max(500).optional(),
  sourceTimezone: z.string().max(64).nullish(),
});

const CsvImportSchema = z.object({
  uploadId: z.string().optional(),
  content: z.string().optional(),
  filename: z.string().optional(),
  mapping: z.record(z.string()).nullish(),
  platformOverride: z.string().nullish(),
  sourceTimezone: z.string().max(64).nullish(),
});

function serverError(res: express.Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("[api]", msg);
  res.status(500).json({ error: `服务器错误: ${msg}` });
}
