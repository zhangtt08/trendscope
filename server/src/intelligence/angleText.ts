/**
 * AngleTextBuilder (Stage 8 §34-§35):角度表达 ≠ 完整语义文本。
 * 标题/钩子主导,弱化大段背景正文 —— "同一话题下换了个说法"才是角度变化。
 * ANGLE_TEXT_V1;绝不与 Content Embedding 混用同一空间(§35,由调用方单独成空间)。
 */
import { createHash } from "node:crypto";
import { ANGLE_TEXT_V1 } from "./profiles";

export interface AngleText {
  text: string;
  wasTruncated: boolean;
  hash: string;
  version: string;
}

const MAX_LEN = 120;

/** title 全保 + 首句摘要(≤60 字);hashtag 附加;URL/作者/指标绝不参与。 */
export function buildAngleText(input: { title: string | null; text: string | null; hashtags?: string[] | null }): AngleText {
  const title = (input.title ?? "").trim();
  const body = (input.text ?? "").trim();
  const firstSentence = body.split(/(?<=[。！？!?\n])/)[0]?.trim() ?? "";
  let core = title.length > 0 ? title : firstSentence;
  let wasTruncated = false;
  if ([...core].length > MAX_LEN) {
    core = [...core].slice(0, MAX_LEN).join("");
    wasTruncated = true;
  }
  const tags = (input.hashtags ?? []).slice(0, 3);
  const text = [core, tags.length > 0 ? tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ") : ""]
    .filter(Boolean)
    .join(" ");
  return {
    text,
    wasTruncated,
    hash: createHash("sha256").update(text).digest("hex"),
    version: ANGLE_TEXT_V1,
  };
}
