// @vitest-environment node
/**
 * 展示层口径回归(§76 数字 / §77 时间 / §78 中文标签)。
 *
 * 这一类缺陷的共性是"编译期看不出来":枚举加了新取值,界面就把英文 code 直接
 * 显示给用户;单位换了一套又一套(10000 / 1万 / 10,000 / 1k)。用断言把它们钉住。
 */
import { describe, it, expect } from "vitest";
import {
  fmtMetric,
  fmtAxisNumber,
  fmtDateTime,
  PLATFORM_LABELS,
  CONTENT_TYPE_LABELS,
  SOURCE_TYPE_LABELS,
  QUALITY_LABELS,
  CAPABILITY_LABELS,
  CONNECTOR_TYPE_LABELS,
  RUN_STATUS_LABELS,
  RUN_ERROR_ZH,
  RUN_EVENT_ZH,
  DUP_REASON_LABELS,
  DUP_STATUS_LABELS,
  TRIGGER_LABELS,
  BREAKER_STATE_LABELS,
  EM_DASH,
} from "../../src/lib/format";
import {
  PLATFORMS,
  CONTENT_TYPES,
  SOURCE_TYPES,
  ADAPTER_CAPABILITIES,
  DUPLICATE_STATUSES,
  DUPLICATE_REASONS,
} from "../../server/src/domain/constants";

describe("§76 数字口径", () => {
  it("互动量与坐标轴用同一套万/亿,不引入 k / M", () => {
    for (const v of [0, 1, 999, 1000, 3400, 9999, 12345, 1_234_567, 230_000_000]) {
      const metric = fmtMetric(v);
      const axis = fmtAxisNumber(v);
      expect(metric).not.toMatch(/[kKmM]\b/);
      expect(axis).not.toMatch(/[kKmM]\b/);
      // 两个格式化器在万/亿分界上必须一致(≥1万 一律用万/亿)
      expect(axis.includes("万") || axis.includes("亿")).toBe(metric.includes("万") || metric.includes("亿"));
    }
    expect(fmtMetric(12345)).toBe("1.2万");
    expect(fmtAxisNumber(12345)).toBe("1.2万");
    expect(fmtAxisNumber(-12345)).toBe("-1.2万");
  });

  it("小数只留一位,不出现假精确长尾", () => {
    expect(fmtMetric(3.4285714285714286)).toBe("3.4");
    expect(fmtAxisNumber(3.4285714285714286)).toBe("3.4");
    expect(fmtMetric(5)).toBe("5");
  });

  it("未知是破折号,不是 0", () => {
    expect(fmtMetric(null)).toBe(EM_DASH);
    expect(fmtAxisNumber(undefined)).toBe(EM_DASH);
    expect(fmtAxisNumber(Number.NaN)).toBe(EM_DASH);
    expect(fmtMetric(0)).toBe("0");
  });

  it("时间统一走本地格式,空值不显示 Invalid Date", () => {
    expect(fmtDateTime(null)).toBe(EM_DASH);
    expect(fmtDateTime("2026-09-27T10:00:00.000Z")).not.toContain("Invalid");
  });
});

describe("§78 枚举必须有中文标签", () => {
  const cases: [string, readonly string[], Record<string, string>][] = [
    ["platform", PLATFORMS, PLATFORM_LABELS],
    ["contentType", CONTENT_TYPES, CONTENT_TYPE_LABELS],
    ["sourceType", SOURCE_TYPES, SOURCE_TYPE_LABELS],
    ["capability", ADAPTER_CAPABILITIES, CAPABILITY_LABELS],
    ["duplicateReason", DUPLICATE_REASONS, DUP_REASON_LABELS],
    ["duplicateStatus", DUPLICATE_STATUSES, DUP_STATUS_LABELS],
  ];
  for (const [name, values, map] of cases) {
    it(`${name} 的每个取值都有中文展示`, () => {
      for (const v of values) {
        expect(map[v], `${name}=${v}`).toBeTruthy();
        expect(map[v]).toMatch(/[一-鿿A-Z0-9]/);
      }
    });
  }

  it("运行状态 / 错误码 / 事件码 / 触发方式 / 熔断态都有中文映射", () => {
    for (const s of ["queued", "running", "completed", "partial", "failed", "cancelled"]) {
      expect(RUN_STATUS_LABELS[s]).toBeTruthy();
    }
    for (const c of ["AUTH_ERROR", "RATE_LIMITED", "NETWORK_ERROR", "TIMEOUT", "SCHEMA_DRIFT", "INTERRUPTED", "CANCELLED", "UNKNOWN"]) {
      expect(RUN_ERROR_ZH[c]).toBeTruthy();
    }
    for (const c of ["RUN_STARTED", "RUN_FAILED", "PAGE_FETCHED", "RECORD_IMPORTED", "CHECKPOINT_SAVED", "RETRY"]) {
      expect(RUN_EVENT_ZH[c]).toBeTruthy();
    }
    for (const c of ["manual", "schedule", "resume"]) expect(TRIGGER_LABELS[c]).toBeTruthy();
    for (const c of ["closed", "open", "half_open"]) expect(BREAKER_STATE_LABELS[c]).toBeTruthy();
    for (const c of ["api", "browser", "file", "mock", "other"]) expect(CONNECTOR_TYPE_LABELS[c]).toBeTruthy();
    for (const q of ["complete", "partial", "minimal", "invalid"]) expect(QUALITY_LABELS[q]).toBeTruthy();
  });

  it("连接器能力取值不会漂出中文映射之外", () => {
    // 采集运行错误码是集合封闭的:出现没映射的新 code,这条会红
    expect(Object.keys(RUN_ERROR_ZH).length).toBeGreaterThanOrEqual(9);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

describe("CSS 类名与布局容器(2026-09-29 报告页窄栏事故)", () => {
  const css = readFileSync(path.resolve(root, "src/styles/global.css"), "utf8");
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  it("页面里写的 class 必须在样式表里有定义(不存在的 class = 静默丢布局)", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(path.resolve(root, "src"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
        for (const tok of m[1].split(/\s+/).filter(Boolean)) {
          if (!defined.has(tok)) offenders.push(`${rel(f)} → .${tok}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("只有 App 可以套 .shell / .content(页面自己再套一次会被挤进侧栏那一列)", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(path.resolve(root, "src/pages"))) {
      const src = readFileSync(f, "utf8");
      if (/className="(shell|content|sidebar)"/.test(src)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });
});
