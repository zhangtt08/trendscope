/**
 * Stage 4 unit tests — collection domain primitives (§12/§13/§22/§23/§24).
 * All deterministic, no I/O, no real sleeps longer than ~50ms.
 */
import { describe, it, expect } from "vitest";
import {
  CONNECTOR_ERROR_CODES,
  ConnectorError,
  ConnectorCircuitBreaker,
  RateLimiter,
  computeBackoff,
  DEFAULT_RATE_LIMIT,
} from "../../server/src/domain/collection";
import { redactData, lintSecrets, RUN_EVENT_TYPES } from "../../server/src/connectors/types";
import { FixtureConfigSchema } from "../../server/src/connectors/fixtureRemote";

describe("error taxonomy (§22)", () => {
  it("exposes all 13 canonical codes", () => {
    expect([...CONNECTOR_ERROR_CODES]).toEqual([
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
    ]);
  });

  it("retryable: network/timeout/429/5xx; NOT: auth/config/schema/cancel", () => {
    const retryable = ["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED", "REMOTE_5XX"] as const;
    const fatal = [
      "AUTH_ERROR",
      "PERMISSION_DENIED",
      "INVALID_CONFIG",
      "INVALID_RESPONSE",
      "SCHEMA_DRIFT",
      "NORMALIZATION_ERROR",
      "CANCELLED",
      "INTERRUPTED",
      "UNKNOWN",
    ] as const;
    for (const code of retryable) expect(new ConnectorError(code, "x").retryable).toBe(true);
    for (const code of fatal) expect(new ConnectorError(code, "x").retryable).toBe(false);
  });
});

describe("retry backoff (§12)", () => {
  it("exponential growth capped at maxDelay, always >= half of expected", () => {
    const policy = { maxRetries: 5, baseDelayMs: 200, maxDelayMs: 5000 };
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = computeBackoff(attempt, policy);
      const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
      expect(d).toBeGreaterThanOrEqual(cap / 2 - 1);
      expect(d).toBeLessThanOrEqual(cap);
    }
  });
});

describe("rate limiter (§11)", () => {
  it("computes effective interval from the most conservative constraint", () => {
    expect(DEFAULT_RATE_LIMIT.effectiveIntervalMs({ rps: 5, concurrency: 1 })).toBe(200);
    expect(
      DEFAULT_RATE_LIMIT.effectiveIntervalMs({ rps: 10, minIntervalMs: 500, concurrency: 1 }),
    ).toBe(500);
    expect(DEFAULT_RATE_LIMIT.effectiveIntervalMs({ rpm: 30, concurrency: 1 })).toBe(2000);
    // no constraints → safe 1 req/s default
    expect(DEFAULT_RATE_LIMIT.effectiveIntervalMs({ concurrency: 1 })).toBe(1000);
  });

  it("spacing: consecutive acquires are at least interval apart", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 30, concurrency: 1 });
    await limiter.acquire(); // first call: no wait, stamps lastAcquireAt
    limiter.release();
    const t0 = Date.now();
    await limiter.acquire(); // second call: waits for the 30ms spacing
    limiter.release();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it("abort while spacing does not deadlock or leak the concurrency slot", async () => {
    const limiter = new RateLimiter({ minIntervalMs: 150, concurrency: 1 });
    await limiter.acquire(); // stamps lastAcquireAt = now
    limiter.release();
    const ac = new AbortController();
    const p = limiter.acquire(ac.signal); // hangs in the 150ms spacing window
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/abort/);
    // abort must NOT have leaked the slot: next acquire waits out only the
    // REMAINING window (< a full 150ms) instead of deadlocking behind a stuck slot
    const t0 = Date.now();
    await limiter.acquire();
    limiter.release();
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe("circuit breaker (§13)", () => {
  it("closed → open after threshold consecutive failures", () => {
    const b = new ConnectorCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }, "t1");
    expect(b.canExecute()).toBe(true);
    b.recordFailure();
    b.recordFailure();
    expect(b.canExecute()).toBe(true);
    b.recordFailure();
    expect(b.snapshot().state).toBe("open");
    expect(b.canExecute()).toBe(false);
  });

  it("success resets the failure streak", () => {
    const b = new ConnectorCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 }, "t2");
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.snapshot().state).toBe("closed"); // never reached 3 consecutive
  });

  it("open → half_open after cooldown; one probe; success → closed", () => {
    const b = new ConnectorCircuitBreaker({ failureThreshold: 1, cooldownMs: 20 }, "t3");
    b.recordFailure();
    expect(b.canExecute()).toBe(false);
    // busy-wait past cooldown
    const until = Date.now() + 30;
    while (Date.now() < until) {
      /* spin */
    }
    expect(b.canExecute()).toBe(true); // half_open probe admitted
    expect(b.canExecute()).toBe(false); // second request while probe in flight → no
    b.recordFailure();
    expect(b.snapshot().state).toBe("open");
    const until2 = Date.now() + 30;
    while (Date.now() < until2) {
      /* spin */
    }
    expect(b.canExecute()).toBe(true);
    b.recordSuccess();
    expect(b.snapshot().state).toBe("closed");
  });

  it("resetProbe releases a wedged half_open probe", () => {
    const b = new ConnectorCircuitBreaker({ failureThreshold: 1, cooldownMs: 10 }, "t4");
    b.recordFailure();
    const until = Date.now() + 20;
    while (Date.now() < until) {
      /* spin */
    }
    expect(b.canExecute()).toBe(true); // probe taken, never resolved
    expect(b.canExecute()).toBe(false);
    b.resetProbe();
    expect(b.canExecute()).toBe(true);
  });
});

describe("secret architecture (§23) + redaction (§24)", () => {
  it("lintSecrets rejects plaintext under secret-ish keys", () => {
    expect(lintSecrets({ apiKey: "sk-plain" })).toMatch(/secretref/);
    expect(lintSecrets({ config: { password: "hunter2" } })).toMatch(/secretref/);
    expect(lintSecrets({ nested: [{ cookie: "session=abc" }] })).toMatch(/secretref/);
  });

  it("lintSecrets accepts secretref: values and innocent keys", () => {
    expect(lintSecrets({ apiKey: "secretref:abc-123" })).toBeNull();
    expect(lintSecrets({ keyword: "减脂餐", totalItems: 9 })).toBeNull();
    expect(lintSecrets(null)).toBeNull();
  });

  it("redactData strips secret-ish keys and secretref values", () => {
    const out = redactData({
      Authorization: "Bearer x",
      cookie: "a=b",
      apiKey: "k",
      password: "p",
      my_token: "secretref:xyz",
      nested: { api_key: "v", ok: 1 },
      arr: [{ accessToken: "t" }],
    }) as Record<string, unknown>;
    expect(out.Authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.my_token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).api_key).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect((out.arr as Record<string, unknown>[])[0].accessToken).toBe("[REDACTED]");
  });

  it("run event vocabulary covers the Stage 4 §25 contract", () => {
    for (const ev of [
      "RUN_QUEUED",
      "RUN_STARTED",
      "PAGE_REQUESTED",
      "PAGE_FETCHED",
      "RATE_LIMIT_WAIT",
      "RETRY",
      "CHECKPOINT_SAVED",
      "RECORD_IMPORTED",
      "SCHEMA_DRIFT",
      "RUN_PARTIAL",
      "RUN_FAILED",
      "RUN_COMPLETED",
      "RUN_CANCELLED",
    ]) {
      expect(RUN_EVENT_TYPES).toContain(ev);
    }
  });
});

describe("fixture config (§7/§35)", () => {
  it("provides a default canonical→source mapping for the JSON pipeline", () => {
    const parsed = FixtureConfigSchema.parse({});
    expect(parsed.mapping.platformContentId).toBe("remote_id");
    expect(parsed.mapping.likes).toBe("点赞数");
    expect(parsed.scenario).toBe("A");
  });

  it("accepts the 1000+ item perf configuration", () => {
    const parsed = FixtureConfigSchema.parse({ totalItems: 1000, pageSize: 250, pageLimit: 4 });
    expect(parsed.totalItems).toBe(1000);
    expect(parsed.pageSize).toBe(250);
  });
});
