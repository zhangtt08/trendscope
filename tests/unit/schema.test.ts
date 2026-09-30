import { describe, it, expect } from "vitest";
import { parseMetric, parseHashtags, parseContentType } from "../../server/src/domain/numbers";
import { parseDateToIso } from "../../server/src/domain/dates";
import {
  PlatformSchema,
  MetricsSchema,
  NULL_METRICS,
  NormalizedRecordSchema as _unused,
} from "../../server/src/domain/constants";
import { NormalizedRecordSchema } from "../../server/src/adapters/types";

void _unused;

describe("metric parsing: unknown → null, real 0 → 0", () => {
  it.each([
    ["", null],
    [null, null],
    [undefined, null],
    ["N/A", null],
    ["-", null],
    ["—", null],
    ["未知", null],
    ["无", null],
    ["null", null],
    ["abc", null],
    [-500, null],
    ["-500", null],
  ])("unknown token %j → null", (input, expected) => {
    expect(parseMetric(input)).toBe(expected);
  });

  it.each([
    ["0", 0],
    [0, 0],
    ["0.0", 0],
  ])("real zero %j → 0 (never null)", (input, expected) => {
    expect(parseMetric(input)).toBe(expected);
  });

  it.each([
    ["152.3万", 1_523_000],
    ["1.2万", 12_000],
    ["3.5亿", 350_000_000],
    ["1,234", 1234],
    [" 88 ", 88],
    ["45.6万", 456_000],
    ["1.2W", 12_000],
    [12345, 12345],
    ["2300次", 2300],
  ])("quantity %j → %j", (input, expected) => {
    expect(parseMetric(input)).toBe(expected);
  });
});

describe("hashtag parsing", () => {
  it("parses '#a #b' style", () => {
    expect(parseHashtags("#探店 #牛肉面 #深夜食堂")).toEqual(["探店", "牛肉面", "深夜食堂"]);
  });
  it("parses comma separated", () => {
    expect(parseHashtags("tag1, tag2；tag3")).toEqual(["tag1", "tag2；tag3"]);
  });
  it("dedupes case-insensitively", () => {
    expect(parseHashtags("#Food #food")).toEqual(["Food"]);
  });
  it("unknown → empty array", () => {
    expect(parseHashtags("")).toEqual([]);
    expect(parseHashtags(null)).toEqual([]);
  });
});

describe("content type aliases", () => {
  it("maps 中文别名", () => {
    expect(parseContentType("视频")).toBe("video");
    expect(parseContentType("回答")).toBe("answer");
    expect(parseContentType("文章")).toBe("article");
    expect(parseContentType("图文")).toBe("image_post");
  });
  it("unknown tokens → null", () => {
    expect(parseContentType("N/A")).toBeNull();
    expect(parseContentType("乱写的类型")).toBeNull();
  });
});

describe("date parsing", () => {
  it("ISO strings", () => {
    expect(parseDateToIso("2026-09-10T08:00:00Z")).toBe("2026-09-10T08:00:00.000Z");
  });
  it("common datetime '2026-09-01 21:34:00' → UTC ISO", () => {
    expect(parseDateToIso("2026-09-01 21:34:00")).toBe("2026-09-01T21:34:00.000Z");
  });
  it("epoch seconds and milliseconds", () => {
    expect(parseDateToIso(1757642400)).toBe("2025-09-12T02:00:00.000Z");
    expect(parseDateToIso("1757642400000")).toBe("2025-09-12T02:00:00.000Z");
  });
  it("slash format", () => {
    expect(parseDateToIso("2026/09/05")).toBe("2026-09-05T00:00:00.000Z");
  });
  it("invalid date → null (never guessed)", () => {
    expect(parseDateToIso("not-a-date")).toBeNull();
    expect(parseDateToIso("2026-13-40 99:99:99")).toBeNull();
    expect(parseDateToIso("2026-02-30")).toBeNull();
  });
  it("unknown tokens → null", () => {
    expect(parseDateToIso("")).toBeNull();
    expect(parseDateToIso("N/A")).toBeNull();
  });
});

describe("zod gates", () => {
  it("PlatformSchema rejects unknown values", () => {
    expect(PlatformSchema.safeParse("douyin").success).toBe(true);
    expect(PlatformSchema.safeParse("myspace").success).toBe(false);
  });
  it("MetricsSchema requires all six nullable ints", () => {
    expect(MetricsSchema.safeParse(NULL_METRICS).success).toBe(true);
    expect(MetricsSchema.safeParse({ ...NULL_METRICS, views: -1 }).success).toBe(false);
    expect(MetricsSchema.safeParse({ views: 5 }).success).toBe(false);
  });
  it("NormalizedRecordSchema rejects missing metrics block", () => {
    const bad = {
      platform: "douyin",
      platformContentId: "1",
      contentType: "video",
      url: null,
      canonicalUrl: null,
      authorId: null,
      authorName: null,
      title: "t",
      text: null,
      transcript: null,
      hashtags: [],
      publishedAt: null,
      authorMetrics: { followers: null },
    };
    expect(NormalizedRecordSchema.safeParse(bad).success).toBe(false);
  });
});
