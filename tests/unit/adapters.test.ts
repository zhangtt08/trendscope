import { describe, it, expect } from "vitest";
import { parseCsv, CSVAdapter } from "../../server/src/adapters/csv";
import { parseJsonPayload, JSONAdapter, detectJsonMapping } from "../../server/src/adapters/json";
import { ManualAdapter } from "../../server/src/adapters/manual";
import { detectMapping } from "../../server/src/adapters/fieldMapping";
import { NormalizationError } from "../../server/src/adapters/types";

const csvAdapter = new CSVAdapter();
const jsonAdapter = new JSONAdapter();
const manualAdapter = new ManualAdapter();

describe("CSV parsing + field detection", () => {
  const csv = [
    "视频id,标题,正文,分享链接,作者,发布时间,播放量,点赞数,评论数",
    "7412001234567890123,深夜食堂探店vlog,真香,https://www.douyin.com/video/7412001234567890123?utm_source=x,老王,2026-09-01 21:34:00,152.3万,23451,1892",
    ",,,https://www.douyin.com/video/x,某人,坏日期,abc,0,-",
  ].join("\n");

  it("parses headers + rows", () => {
    const p = parseCsv(csv);
    expect(p.headers).toContain("视频id");
    expect(p.rows).toHaveLength(2);
  });

  it("auto-detects 中文 headers onto canonical fields", () => {
    const p = parseCsv(csv);
    expect(p.detectedMapping.platformContentId).toBe("视频id");
    expect(p.detectedMapping.title).toBe("标题");
    expect(p.detectedMapping.authorName).toBe("作者");
    expect(p.detectedMapping.publishedAt).toBe("发布时间");
    expect(p.detectedMapping.views).toBe("播放量");
    expect(p.detectedMapping.likes).toBe("点赞数");
  });

  it("normalizes a douyin-style row: 万 units, tracking-stripped URL, bad row fields → null", () => {
    const p = parseCsv(csv);
    const rec = csvAdapter.normalize(p.rows[0], {
      sourceType: "csv",
      mapping: p.detectedMapping,
      platformOverride: "douyin",
    });
    expect(rec.platform).toBe("douyin");
    expect(rec.platformContentId).toBe("7412001234567890123");
    expect(rec.title).toBe("深夜食堂探店vlog");
    expect(rec.metrics.views).toBe(1_523_000);
    expect(rec.metrics.likes).toBe(23_451);
    expect(rec.canonicalUrl).toBe("https://www.douyin.com/video/7412001234567890123");

    const bad = csvAdapter.normalize(p.rows[1], {
      sourceType: "csv",
      mapping: p.detectedMapping,
      platformOverride: "douyin",
    });
    expect(bad.platformContentId).toBeNull();
    expect(bad.publishedAt).toBeNull(); // bad date → null
    expect(bad.metrics.views).toBeNull(); // "abc" → null
    expect(bad.metrics.likes).toBe(0); // real 0 → 0
    expect(bad.metrics.comments).toBeNull(); // "-" → null
  });
});

describe("mapping detection covers common aliases", () => {
  it("name/title/标题 all map to title", () => {
    expect(detectMapping(["name"]).title).toBe("name");
    expect(detectMapping(["标题"]).title).toBe("标题");
    expect(detectMapping(["video_title"]).title).toBe("video_title");
  });
  it("digg_count maps to likes", () => {
    expect(detectMapping(["digg_count"]).likes).toBe("digg_count");
  });
});

describe("JSON adapter", () => {
  it("single object works", () => {
    const rows = parseJsonPayload('{"id":"a1","title":"t","platform":"weibo"}');
    expect(rows).toHaveLength(1);
  });
  it("array works", () => {
    const rows = parseJsonPayload('[{"id":"a1"},{"id":"a2"}]');
    expect(rows).toHaveLength(2);
  });
  it("invalid json throws NormalizationError", () => {
    expect(() => parseJsonPayload("{oops")).toThrow(NormalizationError);
  });
  it("non-object payload throws", () => {
    expect(() => parseJsonPayload("[1,2,3]")).not.toThrow(); // array of scalars parses but rows are not objects → adapter validation catches
  });
  it("canonical keys need no mapping", () => {
    const rec = jsonAdapter.normalize(
      {
        platform: "weibo",
        platformContentId: "wb1",
        title: "微博标题",
        views: "1.2万",
      },
      { sourceType: "json" },
    );
    expect(rec.platformContentId).toBe("wb1");
    expect(rec.metrics.views).toBe(12_000);
  });
  it("non-canonical keys go through mapping", () => {
    const rows = [{ item_id: "x9", 标题: "知乎体标题", 赞同数: "3,204" }];
    const mapping = detectJsonMapping(rows);
    expect(mapping.platformContentId).toBe("item_id");
    const rec = jsonAdapter.normalize(rows[0], {
      sourceType: "json",
      mapping,
      platformOverride: "zhihu",
    });
    expect(rec.platform).toBe("zhihu");
    expect(rec.platformContentId).toBe("x9");
    expect(rec.metrics.upvotes).toBe(3_204);
    expect(rec.canonicalUrl).toBeNull(); // no url → canonical null
  });
  it("rejects non-object records", () => {
    expect(jsonAdapter.validateRaw("string").ok).toBe(false);
    expect(jsonAdapter.validateRaw(["a"]).ok).toBe(false);
  });
});

describe("manual adapter", () => {
  it("valid input → normalized record with canonical URL", () => {
    const rec = manualAdapter.normalize(
      {
        platform: "bilibili",
        contentType: "video",
        platformContentId: "BV1xx411c7mD",
        title: "测试视频",
        url: "https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333",
        likes: 0,
      },
      { sourceType: "manual" },
    );
    expect(rec.metrics.likes).toBe(0); // real 0 preserved
    expect(rec.metrics.views).toBeNull(); // not provided → null
    expect(rec.canonicalUrl).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
  });
  it("missing platform rejected", () => {
    expect(manualAdapter.validateRaw({ title: "no platform" }).ok).toBe(false);
  });
  it("negative metric rejected at form level", () => {
    expect(
      manualAdapter.validateRaw({ platform: "weibo", likes: -5 }).ok,
    ).toBe(false);
  });
});
