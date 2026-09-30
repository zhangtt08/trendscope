/**
 * 报告文案的标签口径测试。
 *
 * 报告是服务端生成的文本,前端 `format.ts` / `ScoringBadges` 的中文标签管不到它 ——
 * 所以服务端另有一份标签(`server/src/domain/labels.ts`)。这一份测试就是为了让两侧
 * 不许漂移:同一枚举在两边翻成不同中文,用户就会在报告里看到英文码或前后不一致的说法。
 */
import { describe, it, expect } from "vitest";
import {
  PLATFORM_LABELS_ZH,
  confidenceZh,
  formatDateTimeZh,
  levelZh,
  lifecycleZh,
  platformZh,
} from "../../server/src/domain/labels";
import { LIFECYCLE_ZH } from "../../src/components/ScoringBadges";
import { PLATFORM_LABELS, SOURCE_TYPE_LABELS } from "../../src/lib/format";
import { INGEST_KIND_LABELS } from "../../server/src/domain/labels";

describe("报告标签与前端标签一致", () => {
  it("生命周期:服务端与前端逐键同义", () => {
    for (const key of Object.keys(LIFECYCLE_ZH)) {
      expect(lifecycleZh(key)).toBe(LIFECYCLE_ZH[key as keyof typeof LIFECYCLE_ZH]);
    }
    expect(lifecycleZh(null)).toBe("数据不足");
    expect(lifecycleZh("never_heard_of_it")).toBe("数据不足");
  });

  it("平台名:服务端与前端逐键同义", () => {
    for (const [code, label] of Object.entries(PLATFORM_LABELS)) {
      expect(platformZh(code)).toBe(label);
    }
    for (const code of Object.keys(PLATFORM_LABELS_ZH)) {
      expect(PLATFORM_LABELS[code]).toBe(PLATFORM_LABELS_ZH[code]);
    }
  });

  it("入库方式:服务端与前端 SOURCE_TYPE_LABELS 逐键同义", () => {
    for (const [code, label] of Object.entries(SOURCE_TYPE_LABELS)) {
      expect(INGEST_KIND_LABELS[code]).toBe(label);
    }
    for (const code of Object.keys(INGEST_KIND_LABELS)) {
      expect(SOURCE_TYPE_LABELS[code]).toBe(INGEST_KIND_LABELS[code]);
    }
  });

  it("置信度与档位翻成中文", () => {
    expect(confidenceZh("high")).toBe("高");
    expect(confidenceZh("medium")).toBe("中");
    expect(levelZh("insufficient")).toBe("数据不足");
    expect(levelZh(null)).toBe("数据不足");
  });
});

describe("报告时间格式", () => {
  it("ISO 一律转成「年-月-日 时:分」(北京时间),不给用户看 ISO", () => {
    const out = formatDateTimeZh("2026-09-29T05:41:13.592Z");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    // 05:41Z → 13:41 北京时间
    expect(out).toBe("2026-09-29 13:41");
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
  });

  it("空值与坏值不崩", () => {
    expect(formatDateTimeZh(null)).toBe("尚无");
    expect(formatDateTimeZh(undefined)).toBe("尚无");
    expect(formatDateTimeZh("不是时间")).toBe("不是时间");
  });
});
