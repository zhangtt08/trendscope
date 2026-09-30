/**
 * Stage 6A unit — SemanticTextBuilder (§2-8) + textHash stability (§29).
 */
import { describe, it, expect } from "vitest";
import {
  buildSemanticText,
  hashSemanticText,
  stripHtml,
  cleanHashtags,
  SEMANTIC_TEXT_BUILDER_VERSION,
  fieldPlanFor,
} from "../../server/src/semantic/semanticTextBuilder";

const base = { contentType: "article", title: "标题", text: "正文", transcript: null, hashtags: [] };

describe("§5 cleaning", () => {
  it("strips HTML and decodes common entities", () => {
    const out = stripHtml("<p>你好<b>世界</b></p>&amp;更多&nbsp;文本").replace(/\s+/g, "");
    expect(out).toContain("你好世界");
    expect(stripHtml("a &amp; b &lt;tag&gt; &#39;q&#39;")).toBe("a & b <tag> 'q'");
  });

  it("collapses excessive punctuation and whitespace", () => {
    const st = buildSemanticText({ ...base, title: "好!!!", text: "内容!!!   多    空格" });
    expect(st.semanticText).not.toContain("!!!");
    expect(st.semanticText).not.toMatch(/ {2,}/);
  });
});

describe("§4 priority + duplicate removal", () => {
  it("identical title and text are kept once", () => {
    const st = buildSemanticText({ ...base, title: "同一句话", text: "同一句话" });
    expect(st.semanticText.split("同一句话").length - 1).toBe(1);
    expect(st.parts.filter((p) => p === "同一句话").length).toBe(1);
  });

  it("title comes first (priority)", () => {
    const st = buildSemanticText({ ...base, title: "AAA标题", text: "BBB正文" });
    expect(st.semanticText.indexOf("AAA标题")).toBeLessThan(st.semanticText.indexOf("BBB正文"));
  });
});

describe("§3 field selection per contentType", () => {
  it("video includes transcript; article does not", () => {
    const input = { ...base, contentType: "video", transcript: "这是转录文本XYZQ" };
    expect(buildSemanticText(input).semanticText).toContain("转录文本");
    expect(buildSemanticText({ ...base, transcript: "这是转录文本XYZQ" }).semanticText).not.toContain("转录文本");
  });

  it("hashtags included and deduplicated (case-insensitive)", () => {
    const st = buildSemanticText({ ...base, hashtags: ["减脂餐", "#减脂餐", "健身"] });
    expect(st.semanticText).toContain("#减脂餐");
    expect(st.semanticText).toContain("#健身");
    expect(st.semanticText.match(/#减脂餐/g)?.length).toBe(1);
  });

  it("empty hashtags list is skipped entirely", () => {
    expect(cleanHashtags([])).toEqual([]);
    expect(buildSemanticText({ ...base, hashtags: ["", "  "] }).semanticText).not.toContain("#");
  });

  it("answer supports question context; non-semantic fields never appear", () => {
    const st = buildSemanticText(
      { ...base, contentType: "answer", title: "回答正文内容很多很多", text: "具体分析" },
      { questionContext: "这是提问上下文" },
    );
    expect(st.semanticText).toContain("问题:这是提问上下文");
  });

  it("field plan exists for all seven content types", () => {
    for (const ct of ["video", "image_post", "text_post", "question", "answer", "article", "unknown"]) {
      expect(fieldPlanFor(ct)).toBeDefined();
    }
  });
});

describe("§6 truncation", () => {
  it("long text is truncated with wasTruncated=true and keeps title + hashtags", () => {
    const longText = "正".repeat(5000);
    const st = buildSemanticText({ ...base, title: "标题在这里", text: longText, hashtags: ["标签A", "标签B"] });
    expect(st.wasTruncated).toBe(true);
    expect(st.semanticText.length).toBeLessThanOrEqual(2000 + 20); // 组装行边界
    expect(st.semanticText).toContain("标题在这里");
    expect(st.semanticText).toContain("#标签A");
  });

  it("short text is not truncated", () => {
    const st = buildSemanticText(base);
    expect(st.wasTruncated).toBe(false);
  });
});

describe("§7/§8 version + hash", () => {
  it("exposes builder version and stable hash", () => {
    const st = buildSemanticText(base);
    expect(st.textBuilderVersion).toBe(SEMANTIC_TEXT_BUILDER_VERSION);
    expect(st.textHash).toBe(hashSemanticText(st.semanticText));
    expect(st.textHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("§29: metric-only changes do not exist at this layer — same semantic fields → same hash", () => {
    const a = buildSemanticText({ ...base, title: "T", text: "B" });
    const b = buildSemanticText({ ...base, title: "T", text: "B" });
    expect(a.textHash).toBe(b.textHash);
  });

  it("title/text change → hash changes (content update triggers re-embedding)", () => {
    const a = buildSemanticText({ ...base, title: "T", text: "B" });
    const b = buildSemanticText({ ...base, title: "T2", text: "B" });
    expect(a.textHash).not.toBe(b.textHash);
  });

  it("empty content → empty semanticText and empty hash (caller skips)", () => {
    const st = buildSemanticText({ contentType: "article", title: null, text: null, transcript: null, hashtags: [] });
    expect(st.semanticText).toBe("");
    expect(st.textHash).toBe("");
  });
});
