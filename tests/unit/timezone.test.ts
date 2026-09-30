import { describe, it, expect } from "vitest";
import {
  normalizeDate,
  isValidTimezone,
  PLATFORM_TIMEZONES,
} from "../../server/src/domain/timezone";

/**
 * Time parsing tests (Stage 2 §5). All assertions are absolute UTC instants —
 * independent of the machine's local timezone.
 */
describe("DateNormalizationService", () => {
  it("explicit Z offset is respected as-is", () => {
    const r = normalizeDate("2026-09-24T10:00:00Z");
    expect(r.iso).toBe("2026-09-24T10:00:00.000Z");
    expect(r.assumption).toBe("explicit_offset");
    expect(r.appliedTimezone).toBeNull();
  });

  it("explicit +08:00 offset is respected (converted to UTC)", () => {
    const r = normalizeDate("2026-09-24T10:00:00+08:00");
    expect(r.iso).toBe("2026-09-24T02:00:00.000Z");
    expect(r.assumption).toBe("explicit_offset");
  });

  it("explicit -05:00 offset is respected", () => {
    expect(normalizeDate("2026-09-24T10:00:00-05:00").iso).toBe("2026-09-24T15:00:00.000Z");
  });

  it("naive datetime + sourceTimezone Asia/Shanghai → NOT unconditional UTC", () => {
    const r = normalizeDate("2026-09-24 10:00:00", "Asia/Shanghai");
    expect(r.iso).toBe("2026-09-24T02:00:00.000Z");
    expect(r.assumption).toBe("adapter_default");
    expect(r.appliedTimezone).toBe("Asia/Shanghai");
  });

  it("naive datetime + user_selected provenance", () => {
    const r = normalizeDate("2026-09-24 10:00:00", "Asia/Shanghai", "user_selected");
    expect(r.assumption).toBe("user_selected");
  });

  it("naive datetime without sourceTimezone → UTC with unknown assumption (documented fallback)", () => {
    const r = normalizeDate("2026-09-24 10:00:00", null);
    expect(r.iso).toBe("2026-09-24T10:00:00.000Z");
    expect(r.assumption).toBe("unknown");
  });

  it("naive datetime in another IANA zone (America/New_York, EST in winter)", () => {
    const r = normalizeDate("2026-01-15 10:00:00", "America/New_York");
    expect(r.iso).toBe("2026-01-15T15:00:00.000Z"); // EST = UTC-5
  });

  it("DST zone summer offset (America/New_York, EDT = UTC-4)", () => {
    const r = normalizeDate("2026-07-15 10:00:00", "America/New_York");
    expect(r.iso).toBe("2026-07-15T14:00:00.000Z");
  });

  it("date-only naive + timezone", () => {
    const r = normalizeDate("2026-09-24", "Asia/Shanghai");
    expect(r.iso).toBe("2026-09-23T16:00:00.000Z"); // midnight Shanghai
  });

  it("timestamp seconds → UTC (epoch is tz-free)", () => {
    expect(normalizeDate(1757642400).iso).toBe("2025-09-12T02:00:00.000Z");
    expect(normalizeDate(1757642400).assumption).toBe("explicit_offset");
  });

  it("timestamp milliseconds string", () => {
    expect(normalizeDate("1757642400000").iso).toBe("2025-09-12T02:00:00.000Z");
  });

  it("invalid date → null", () => {
    expect(normalizeDate("not-a-date").iso).toBeNull();
    expect(normalizeDate("2026-02-30", "Asia/Shanghai").iso).toBeNull();
    expect(normalizeDate("2026-13-40 99:99:99", "Asia/Shanghai").iso).toBeNull();
  });

  it("empty / unknown tokens → null", () => {
    expect(normalizeDate("").iso).toBeNull();
    expect(normalizeDate("N/A").iso).toBeNull();
    expect(normalizeDate(null).iso).toBeNull();
    expect(normalizeDate(undefined).iso).toBeNull();
  });

  it("invalid timezone string → UTC fallback with unknown assumption", () => {
    const r = normalizeDate("2026-09-24 10:00:00", "Mars/Olympus");
    expect(r.iso).toBe("2026-09-24T10:00:00.000Z");
    expect(r.assumption).toBe("unknown");
    expect(r.appliedTimezone).toBeNull();
  });

  it("timezone validation helper", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("不是时区")).toBe(false);
  });

  it("CN platform defaults are Asia/Shanghai", () => {
    expect(PLATFORM_TIMEZONES.douyin).toBe("Asia/Shanghai");
    expect(PLATFORM_TIMEZONES.xiaohongshu).toBe("Asia/Shanghai");
    expect(PLATFORM_TIMEZONES.zhihu).toBe("Asia/Shanghai");
    expect(PLATFORM_TIMEZONES.bilibili).toBe("Asia/Shanghai");
    expect(PLATFORM_TIMEZONES.weibo).toBe("Asia/Shanghai");
  });
});
