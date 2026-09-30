/**
 * Stage 3 unit tests: momentum math (pure functions).
 * Core invariants: unknown = null (never fake 0), real 0 stays 0,
 * transparent scoring formula, engagement null-safety.
 */
import { describe, it, expect } from "vitest";
import {
  computeDelta,
  engagementOf,
  scoreOf,
  SCORE_WEIGHTS,
  type MetricName,
} from "../../server/src/services/trendService";

type P = { capturedAt: string; metrics: Partial<Record<MetricName, number>> };

describe("computeDelta", () => {
  it("computes positive deltas and daily rates", () => {
    const r = computeDelta(
      { capturedAt: "2026-09-20T00:00:00.000Z", metrics: { likes: 100, comments: 10 } },
      { capturedAt: "2026-09-24T00:00:00.000Z", metrics: { likes: 200, comments: 14 } },
    );
    expect(r.delta.likes).toBe(100);
    expect(r.delta.comments).toBe(4);
    expect(r.daily.likes).toBe(25); // 100 over 4 days
    expect(r.daily.comments).toBe(1);
    expect(r.unknownComponents).toEqual(["shares", "favorites", "views"]);
  });

  it("missing component → null delta, recorded in unknownComponents (never 0)", () => {
    // SQL NULL columns are excluded from the metrics map by pointMetrics(),
    // so "unknown" arrives as a missing key; explicit null is also tolerated.
    const r = computeDelta(
      { capturedAt: "2026-09-20T00:00:00.000Z", metrics: { likes: 100, views: 0 } },
      { capturedAt: "2026-09-24T00:00:00.000Z", metrics: { likes: null as unknown as number, views: 0 } },
    );
    expect(r.delta.likes).toBeNull();
    expect(r.unknownComponents).toContain("likes");
    // real 0 stays a real 0, not unknown
    expect(r.delta.views).toBe(0);
    expect(r.unknownComponents).not.toContain("views");
  });

  it("same-instant snapshots → delta computable but daily rate null (no division by zero)", () => {
    const r = computeDelta(
      { capturedAt: "2026-09-24T00:00:00.000Z", metrics: { likes: 10 } },
      { capturedAt: "2026-09-24T00:00:00.000Z", metrics: { likes: 30 } },
    );
    expect(r.delta.likes).toBe(20);
    expect(r.daily.likes).toBeNull();
  });

  it("negative delta preserved (metric decrease is real data)", () => {
    const r = computeDelta(
      { capturedAt: "2026-09-20T00:00:00.000Z", metrics: { likes: 500 } },
      { capturedAt: "2026-09-24T00:00:00.000Z", metrics: { likes: 480 } },
    );
    expect(r.delta.likes).toBe(-20);
    expect(r.daily.likes).toBe(-5);
  });
});

describe("scoreOf (transparent formula)", () => {
  it("applies weights likes=1 comments=2 favorites=2 shares=3", () => {
    expect(SCORE_WEIGHTS).toEqual({ likes: 1, comments: 2, shares: 3, favorites: 2 });
    const score = scoreOf({ likes: 10, comments: 5, shares: 2, favorites: 1, views: 999 });
    expect(score).toBe(10 + 5 * 2 + 2 * 3 + 1 * 2);
  });

  it("null components count as 0 in the score (partial evidence still scores)", () => {
    const score = scoreOf({ likes: 10, comments: null, shares: null, favorites: 1 });
    expect(score).toBe(10 + 1 * 2);
  });

  it("rounds fractional daily-derived deltas to an integer", () => {
    expect(scoreOf({ likes: 3.6 })).toBe(4);
  });
});

describe("engagementOf", () => {
  it("computes (likes+comments+shares+favorites)/views when all known", () => {
    expect(engagementOf({ likes: 10, comments: 5, shares: 3, favorites: 2, views: 1000 })).toBeCloseTo(0.02);
  });

  it("null if any component is unknown", () => {
    expect(engagementOf({ likes: 10, comments: 5, shares: 3, views: 1000 })).toBeNull();
    expect(engagementOf({ likes: 10, comments: 5, shares: 3, favorites: 2 })).toBeNull();
  });

  it("null for views <= 0 (no fake infinity)", () => {
    expect(engagementOf({ likes: 10, comments: 5, shares: 3, favorites: 2, views: 0 })).toBeNull();
  });
});
