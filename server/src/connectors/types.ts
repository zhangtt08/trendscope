/**
 * Connector interface (Stage 3 §4/5) + run context/logging (§29/30).
 *
 * 分工铁律（§3）：
 *   Connector  = “怎么从外部数据源拿 Raw Data”（网络/浏览器/文件）
 *   SourceAdapter = “Raw Data → 标准化 ContentItem”（Stage 1 已验证管线）
 * 两者永不混装：调度器只会调用 Connector，标准化只会调用 SourceAdapter。
 */
import type { z } from "zod";
import type {
  AdapterCapability,
  PageResult,
  RemotePageRequest,
  RateLimitConfig,
} from "../domain/collection";
import { ConnectorError as DomainConnectorError } from "../domain/collection";
import { zodIssueLines } from "../domain/zodMessage";

// single source of truth for connector errors lives in domain/collection
export { ConnectorError } from "../domain/collection";
void DomainConnectorError;

/**
 * Stage 4 §23 Secret architecture: config values under secret-ish keys must be
 * `secretref:<id>` references — never plaintext. Enforced at task create/update.
 *
 * Stage 5: reference grammar extended to `secretref:<source>:<name>` (e.g.
 * `secretref:env:ZHIHU_ACCESS_SECRET`) — still a reference, never a value.
 * Resolution is owned by SecretResolver (services/secrets), nowhere else.
 */
export const SECRET_REF_PATTERN = /^secretref:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;
export function isSecretRef(v: unknown): v is string {
  return typeof v === "string" && SECRET_REF_PATTERN.test(v);
}

export type ConnectorType = "api" | "browser" | "file" | "mock" | "other";

export interface ConnectorMetadata {
  id: string;
  name: string;
  platform: string;
  connectorType: ConnectorType;
  /** which SourceAdapter normalizes this connector's raw rows */
  sourceType: string;
  version: string;
  capabilities: AdapterCapability[];
  defaultTimezone: string;
  description?: string;
  isDemo?: boolean; // FixtureRemoteConnector 等 demo 连接器打标
}

/** Structured, secret-free run event types (Stage 4 §25). */
export const RUN_EVENT_TYPES = [
  "RUN_QUEUED",
  "RUN_STARTED",
  "PAGE_REQUESTED",
  "PAGE_FETCHED",
  "PAGE_FAILED",
  "RATE_LIMIT_WAIT",
  "RETRY",
  "CHECKPOINT_SAVED",
  "RECORD_IMPORTED",
  "SCHEMA_DRIFT",
  "RUN_PARTIAL",
  "RUN_COMPLETED",
  "RUN_CANCELLED",
  "RUN_FAILED",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/** @deprecated legacy alias from the pre-Stage-4 draft — use RECORD_IMPORTED */
export const RECORD_NORMALIZED: RunEventType = "RECORD_IMPORTED";
void RECORD_NORMALIZED;

/** Keys stripped from any event payload before persisting. */
const SECRET_KEY_RE = /(authorization|cookie|secret|token|password|api[_-]?key|credential)/i;

export function redactData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(redactData);
  if (typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redactData(v);
    }
    return out;
  }
  if (typeof data === "string" && isSecretRef(data)) return "[REDACTED]";
  return data;
}

export interface RunLogger {
  event(type: RunEventType, message?: string, data?: unknown): void;
  readonly runId: number;
}

/** Context handed to connector.collectPage — runtime-owned services only. */
export interface ConnectorRunContext {
  runId: number;
  taskId: number;
  signal: AbortSignal;
  logger: RunLogger;
}

/** Connector-facing policy the runtime derives from connector defaults + task overrides. */
export interface ConnectorPolicy {
  rateLimit: RateLimitConfig;
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  breaker: { failureThreshold: number; cooldownMs: number };
}

/**
 * The Connector contract. Platform fields (keyword/cursor/search_id) live in
 * the connector's own config schema — the scheduler never sees them (§7).
 */
export interface Connector {
  readonly metadata: ConnectorMetadata;
  /** connector-specific config schema (zod) — scheduler validates via this */
  readonly configSchema: z.ZodTypeAny;
  /** loose item-level schema for SCHEMA_DRIFT detection (§32) */
  readonly itemSchema: z.ZodTypeAny;
  /** declared default policy; user task config may only lower limits (§21) */
  readonly defaultPolicy: ConnectorPolicy;
  validateConfig(config: unknown): { ok: boolean; error?: string };
  healthCheck(ctx: { signal?: AbortSignal }): Promise<{ healthy: boolean; detail?: string }>;
  /** fetch ONE page of raw rows. Must honor signal; runtime handles rate/retry. */
  collectPage(req: RemotePageRequest, config: unknown, ctx: ConnectorRunContext): Promise<PageResult<unknown>>;
  /** optional hook: connector-side per-run state advance (fixture metrics growth) */
  notifyRunFinished?(taskId: number): void;
}

/**
 * §23 Secret architecture: config values under secret-ish keys must be
 * `secretref:<id>` references — never plaintext. Enforced at task create/update.
 */
const SECRETISH_KEY_RE = /(secret|token|password|passwd|credential|api[_-]?key|cookie|authorization)/i;

export function lintSecrets(config: unknown, path = "config"): string | null {
  if (config === null || config === undefined) return null;
  if (Array.isArray(config)) {
    for (let i = 0; i < config.length; i++) {
      const r = lintSecrets(config[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof config === "object") {
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      if (
        SECRETISH_KEY_RE.test(k) &&
        typeof v === "string" &&
        v.length > 0 &&
        !isSecretRef(v)
      ) {
        return `${path}.${k}: 必须使用 secretref:<id> 引用,禁止明文密钥`;
      }
      const r = lintSecrets(v, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

export function validateWithSchema(schema: z.ZodTypeAny, config: unknown): { ok: boolean; error?: string } {
  const r = schema.safeParse(config);
  if (r.success) return { ok: true };
  return {
    ok: false,
    error: zodIssueLines(r.error),
  };
}
