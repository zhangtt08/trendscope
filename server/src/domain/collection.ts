/**
 * Connector domain primitives (Stage 3).
 * 错误分类、重试策略、限速、分页抽象 —— 全部平台无关。
 * 核心调度器不理解 keyword/cursor/search_id 等平台字段。
 */
import { z } from "zod";

/* ---------------- error taxonomy (§31) ---------------- */

export const CONNECTOR_ERROR_CODES = [
  "NETWORK_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_ERROR",
  "PERMISSION_DENIED",
  "INVALID_CONFIG",
  "REMOTE_5XX",
  "INVALID_RESPONSE",
  "SCHEMA_DRIFT",
  "NORMALIZATION_ERROR",
  "CANCELLED",
  "INTERRUPTED",
  "UNKNOWN",
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ConnectorErrorCode> = new Set([
  "NETWORK_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "REMOTE_5XX",
]);

export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

/* ---------------- retry policy (§16) ---------------- */

export interface RetryPolicyInput {
  maxRetries?: number; // attempts AFTER the first
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export const DEFAULT_RETRY: Required<RetryPolicyInput> = {
  maxRetries: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
};

/** exponential backoff + full jitter. */
export function computeBackoff(attempt: number, policy: Required<RetryPolicyInput>): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, attempt));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/* ---------------- rate limiter (§14/15) ---------------- */

export const RateLimitConfigSchema = z
  .object({
    /** max requests per second (connector default; user may lower) */
    rps: z.number().min(0.1).max(50).optional(),
    /** max requests per minute */
    rpm: z.number().min(1).max(3000).optional(),
    /** minimum spacing between two requests */
    minIntervalMs: z.number().min(0).max(3_600_000).optional(),
    /** parallel in-flight pages — bounded, never infinite */
    concurrency: z.number().int().min(1).max(8).default(1),
  })
  .strict();

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

export const DEFAULT_RATE_LIMIT: Required<Pick<RateLimitConfig, "concurrency">> & {
  effectiveIntervalMs: (c: RateLimitConfig) => number;
} = {
  concurrency: 1,
  effectiveIntervalMs: (c) => {
    const candidates: number[] = [];
    if (c.minIntervalMs !== undefined) candidates.push(c.minIntervalMs);
    if (c.rps !== undefined) candidates.push(1000 / c.rps);
    if (c.rpm !== undefined) candidates.push(60_000 / c.rpm);
    return candidates.length ? Math.max(...candidates) : 1_000; // safe default: 1 req/s
  },
};

/**
 * Spacing-based limiter: each acquire() waits so that consecutive calls are at
 * least `effectiveIntervalMs` apart. Concurrency is a hard cap (no unlimited).
 */
export class RateLimiter {
  private lastAcquireAt = 0;
  private inFlight = 0;
  private readonly waitQueue: (() => void)[] = [];
  readonly intervalMs: number;
  readonly concurrency: number;
  /** ms spent waiting on the most recent acquire (0 = no wait) — for RATE_LIMIT_WAIT events */
  lastWaitMs = 0;

  constructor(config: RateLimitConfig) {
    this.intervalMs = DEFAULT_RATE_LIMIT.effectiveIntervalMs(config);
    this.concurrency = config.concurrency ?? 1;
  }

  /** Wait until a slot is available. Rejects on abort. */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new ConnectorError("CANCELLED", "aborted before acquire");
    // concurrency slot
    let gotSlot = false;
    while (!gotSlot) {
      if (this.inFlight < this.concurrency) {
        this.inFlight += 1;
        gotSlot = true;
        break;
      }
      await new Promise<void>((resolve, reject) => {
        const wrapper = () => {
          // wakeup path — remove self from queue so release() never lands here again
          const idx = this.waitQueue.indexOf(wrapper);
          if (idx >= 0) this.waitQueue.splice(idx, 1);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const idx = this.waitQueue.indexOf(wrapper);
          if (idx >= 0) this.waitQueue.splice(idx, 1);
          reject(new ConnectorError("CANCELLED", "aborted while waiting for slot"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waitQueue.push(wrapper);
      });
    }
    // spacing (slot already held — released by caller via release()/run())
    this.lastWaitMs = 0;
    const now = Date.now();
    const wait = this.lastAcquireAt + this.intervalMs - now;
    if (wait > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new ConnectorError("CANCELLED", "aborted while rate-limit waiting"));
            },
            { once: true },
          );
        });
        this.lastWaitMs = wait;
      } catch (e) {
        // abort during spacing: give the slot back so the limiter stays balanced
        this.release();
        throw e;
      }
    }
    this.lastAcquireAt = Date.now();
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /** Run fn under limiter (acquire → fn → release). */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/* ---------------- pagination abstraction (§11) ---------------- */

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
  /** opaque, connector-defined cursor for the NEXT page */
  nextCursor?: string | null;
  /** connector-defined raw pagination state (persisted inside checkpoint) */
  rawPaginationState?: unknown;
  /**
   * Stage 5 §29/30: optional discovery metadata aligned with `items` by index —
   * records WHERE/WHEN a content was discovered (search rank, hotlist rank…)
   * as append-only observations. Absent for connectors that don't provide it.
   */
  discovery?: {
    type: "search" | "hotlist" | "recommendation";
    query?: string | null;
    /** rank per item (index-aligned); null where the source gives no rank */
    ranks: (number | null)[];
    metadata?: unknown;
  };
}

export interface RemotePageRequest {
  /** opaque cursor from the previous PageResult (or checkpoint on resume) */
  cursor?: string | null;
  pageSize: number;
  signal?: AbortSignal;
}

/* ---------------- capabilities (§5) ---------------- */

export const ADAPTER_CAPABILITIES = [
  "search",
  "hotlist",
  "content_detail",
  "comments",
  "author",
  "metrics",
] as const;
export type AdapterCapability = (typeof ADAPTER_CAPABILITIES)[number];

/* ---------------- circuit breaker (§17) ---------------- */

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerOptions {
  failureThreshold?: number; // consecutive failures → open
  cooldownMs?: number; // open → half_open after this
}

interface BreakerRuntime {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenProbeInFlight: boolean;
}

export class ConnectorCircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private rt: BreakerRuntime;

  constructor(opts: BreakerOptions = {}, public readonly id = "default") {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.rt = { state: "closed", consecutiveFailures: 0, openedAt: null, halfOpenProbeInFlight: false };
  }

  snapshot(): BreakerRuntime & { threshold: number; cooldownMs: number } {
    return { ...this.rt, threshold: this.threshold, cooldownMs: this.cooldownMs };
  }

  /** Can a request go through right now? half_open allows exactly one probe. */
  canExecute(): boolean {
    this.refresh();
    if (this.rt.state === "closed") return true;
    if (this.rt.state === "open") return false;
    // half_open: single probe
    if (this.rt.halfOpenProbeInFlight) return false;
    this.rt.halfOpenProbeInFlight = true;
    return true;
  }

  /**
   * Release a half_open probe that never produced a success/failure record
   * (e.g. the run was cancelled while queued). Without this a cancelled probe
   * would wedge the breaker shut forever.
   */
  resetProbe(): void {
    this.rt.halfOpenProbeInFlight = false;
  }

  recordSuccess(): void {
    this.rt = { state: "closed", consecutiveFailures: 0, openedAt: null, halfOpenProbeInFlight: false };
  }

  recordFailure(): void {
    this.rt.halfOpenProbeInFlight = false;
    this.rt.consecutiveFailures += 1;
    if (this.rt.state === "half_open" || this.rt.consecutiveFailures >= this.threshold) {
      this.rt.state = "open";
      this.rt.openedAt = Date.now();
    }
  }

  private refresh(): void {
    if (this.rt.state === "open" && this.rt.openedAt !== null) {
      if (Date.now() - this.rt.openedAt >= this.cooldownMs) {
        this.rt.state = "half_open";
        this.rt.halfOpenProbeInFlight = false;
      }
    }
  }
}
