import { describe, it, expect } from "vitest";
import { canonicalizeUrl } from "../../server/src/domain/url";
import { computeFingerprint } from "../../server/src/domain/fingerprint";
import { computeDataQuality } from "../../server/src/domain/quality";
import { NULL_METRICS } from "../../server/src/domain/constants";

describe("canonical URL normalization (conservative)", () => {
  it("strips utm / share / tracking params", () => {
    expect(
      canonicalizeUrl(
        "https://www.douyin.com/video/7412001234567890123?utm_source=copy&share_app_id=1234&spm=web",
      ),
    ).toBe("https://www.douyin.com/video/7412001234567890123");
  });
  it("strips xiaohongshu xsec_token", () => {
    expect(
      canonicalizeUrl("https://www.xiaohongshu.com/explore/66f1a2b3?xsec_token=ABC&utm_source=weixin"),
    ).toBe("https://www.xiaohongshu.com/explore/66f1a2b3");
  });
  it("keeps content-identifying params (never over-merges)", () => {
    expect(
      canonicalizeUrl("https://example.com/watch?id=123&utm_medium=x"),
    ).toBe("https://example.com/watch?id=123");
  });
  it("lowercases host, strips default port, fragment, trailing slash", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com:443/path/#frag")).toBe("https://example.com/path");
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com");
  });
  it("scheme-less input is tolerated", () => {
    expect(canonicalizeUrl("www.example.com/a?utm_source=x")).toBe("https://www.example.com/a");
  });
  it("non-http protocols → null", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalizeUrl("ftp://example.com/x")).toBeNull();
  });
  it("garbage → null", () => {
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
  });
});

describe("fingerprint: fuzzy match can only flag, never merge", () => {
  const base = {
    platform: "douyin",
    authorId: "dy_1",
    authorName: "作者",
    title: "三分钟学会氛围感打光",
    publishedAt: "2026-09-12T02:00:00.000Z",
  };
  it("stable across title punctuation/case/whitespace", () => {
    const a = computeFingerprint(base);
    const b = computeFingerprint({ ...base, title: "三分钟 学会 氛围感打光!" });
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });
  it("differs by platform", () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, platform: "weibo" }));
  });
  it("differs by publish day", () => {
    expect(computeFingerprint(base)).not.toBe(
      computeFingerprint({ ...base, publishedAt: "2026-09-13T02:00:00.000Z" }),
    );
  });
  it("no title → null (too weak to be useful)", () => {
    expect(computeFingerprint({ ...base, title: null })).toBeNull();
  });
  it("no platform → null", () => {
    expect(computeFingerprint({ ...base, platform: null })).toBeNull();
  });
});

describe("data quality rules (deterministic)", () => {
  const full = {
    platform: "douyin",
    platformContentId: "7412",
    url: "https://douyin.com/video/7412",
    canonicalUrl: "https://douyin.com/video/7412",
    urlWasProvided: true,
    title: "标题",
    text: "正文",
    transcript: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    authorId: "a1",
    authorName: "作者",
    metrics: { ...NULL_METRICS, views: 100 },
  };

  it("complete: id + body + date + author + metric (no reasons)", () => {
    const r = computeDataQuality(full);
    expect(r.quality).toBe("complete");
    expect(r.reasons).toEqual([]);
  });
  it("invalid: no platform", () => {
    const r = computeDataQuality({ ...full, platform: null as unknown as string });
    expect(r.quality).toBe("invalid");
    expect(r.reasons).toContain("missing_platform_id");
  });
  it("invalid: no body (title/text/transcript all empty)", () => {
    const r = computeDataQuality({ ...full, title: null, text: null, transcript: null });
    expect(r.quality).toBe("invalid");
    expect(r.reasons).toContain("missing_body");
  });
  it("minimal: body only, nothing observable", () => {
    const r = computeDataQuality({
      ...full,
      platformContentId: null,
      url: null,
      canonicalUrl: null,
      urlWasProvided: false,
      publishedAt: null,
      authorId: null,
      authorName: null,
      metrics: NULL_METRICS,
    });
    expect(r.quality).toBe("minimal");
    expect(r.reasons).toContain("missing_platform_id");
    expect(r.reasons).toContain("missing_metrics");
    expect(r.reasons).toContain("missing_published_at");
  });
  it("partial: core + one observable extra", () => {
    expect(computeDataQuality({ ...full, publishedAt: null }).quality).toBe("partial");
    expect(computeDataQuality({ ...full, metrics: NULL_METRICS, url: null, canonicalUrl: null, urlWasProvided: false }).quality).toBe("partial");
  });
  it("reasons: invalid_url flagged when raw url exists but cannot canonicalize (annotation only, no demotion)", () => {
    const r = computeDataQuality({ ...full, canonicalUrl: null, url: "not a url" });
    expect(r.reasons).toContain("invalid_url");
    expect(r.quality).toBe("complete");
  });
  it("reasons: missing_text when only title present", () => {
    const r = computeDataQuality({ ...full, text: null, transcript: null });
    expect(r.reasons).toContain("missing_text");
  });
});
